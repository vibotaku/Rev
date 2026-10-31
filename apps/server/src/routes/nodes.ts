// Nodes: computers running `rev node`. A node registers with an enrollment key, then
// long-polls for jobs. Its owner (or an admin) asks it to create workspaces, each with
// its own agent, and to start or stop a Claude Code session in them. A node only ever
// runs the fixed jobs in NODE_JOB_KINDS, never commands sent from the web.
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  NODE_ONLINE_MS,
  nodeJobResultBody,
  nodeRegisterBody,
  nodeStateBody,
  nodeUpdateBody,
  workspaceCreateBody,
  type NodeAgentGrant,
  type NodeInfo,
  type NodeJob,
  type NodeJobKind,
  type NodeRegistration,
  type SessionState,
  type WorkspaceInfo,
} from "@rev/shared";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { apiTokens, nodeJobs, nodes, projectMembers, projects, users, workspaces } from "../db/schema";
import { isWriter, loadProject } from "../lib/access";
import { requireHuman, requireNode, type Actor } from "../lib/auth";
import { newApiToken, newNodeToken } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound, parse } from "../lib/errors";
import { loadUsers, userSummary } from "../lib/serialize";
import { claimKeyUse, findUsableKey } from "./enrollment";
import { createProject } from "./projects";

type NodeRow = typeof nodes.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type JobRow = typeof nodeJobs.$inferSelect;

const registerLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };
/** Longest a node's job request is held open waiting for work (proxies often cut at 60 s). */
const MAX_WAIT_S = 25;
const SESSION_KINDS: NodeJobKind[] = ["session.start", "session.stop"];

/** Owners run their own nodes; admins may run anyone's. */
const canOperate = (actor: Actor, node: NodeRow) => node.ownerId === actor.id || actor.role === "admin";

/** Agent names are unique per linked human: `claude-<node>-<workspace>`, numbered if taken. */
async function freeAgentName(db: Db, ownerId: string, base: string) {
  const taken = new Set(
    (await db.select({ name: users.name }).from(users).where(and(eq(users.kind, "agent"), eq(users.ownerId, ownerId)))).map((u) =>
      u.name.toLowerCase(),
    ),
  );
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "node";

export default async function nodeRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Wakes a node's pending job request as soon as work is queued for it. */
  const waiters = new Map<string, Set<() => void>>();
  const wake = (nodeId: string) => waiters.get(nodeId)?.forEach((w) => w());

  async function describe(rows: NodeRow[]): Promise<NodeInfo[]> {
    if (!rows.length) return [];
    const ids = rows.map((n) => n.id);
    const spaces = await ctx.db.select().from(workspaces).where(inArray(workspaces.nodeId, ids)).orderBy(asc(workspaces.name));
    const spaceIds = spaces.map((w) => w.id);
    const projectIds = [...new Set(spaces.map((w) => w.projectId).filter((p): p is string => !!p))];
    const [people, projectRows, sessionJobs] = await Promise.all([
      loadUsers(ctx.db, [...rows.map((n) => n.ownerId), ...spaces.flatMap((w) => [w.agentId, w.createdBy])]),
      projectIds.length
        ? ctx.db.select({ id: projects.id, key: projects.key, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
        : Promise.resolve([]),
      spaceIds.length
        ? ctx.db
            .select()
            .from(nodeJobs)
            .where(and(inArray(nodeJobs.workspaceId, spaceIds), inArray(nodeJobs.kind, SESSION_KINDS)))
            .orderBy(desc(nodeJobs.createdAt))
        : Promise.resolve([] as JobRow[]),
    ]);
    const projectBy = new Map(projectRows.map((p) => [p.id, p]));
    const now = Date.now();

    const workspaceInfo = (w: WorkspaceRow): WorkspaceInfo => {
      const jobs = sessionJobs.filter((j) => j.workspaceId === w.id);
      const pending = jobs.find((j) => j.status === "queued" || j.status === "running");
      const last = jobs.find((j) => j.status === "succeeded" || j.status === "failed");
      const session: SessionState = pending
        ? pending.kind === "session.start"
          ? "starting"
          : "stopping"
        : w.sessionRunning
          ? "running"
          : "stopped";
      const project = w.projectId ? projectBy.get(w.projectId) : undefined;
      return {
        id: w.id,
        nodeId: w.nodeId,
        name: w.name,
        path: w.path,
        repoUrl: w.repoUrl,
        project: project ? { key: project.key, name: project.name } : null,
        agent: w.agentId ? (people.get(w.agentId) ?? null) : null,
        status: w.status,
        error: w.error,
        session,
        sessionError: !pending && last?.status === "failed" ? last.error : null,
        createdBy: w.createdBy ? (people.get(w.createdBy) ?? null) : null,
        createdAt: w.createdAt.toISOString(),
      };
    };

    return rows.map((n) => ({
      id: n.id,
      name: n.name,
      owner: people.get(n.ownerId)!,
      hostname: n.hostname,
      platform: n.platform,
      arch: n.arch,
      version: n.version,
      workspaceRoot: n.workspaceRoot,
      capabilities: n.capabilities ?? null,
      online: !!n.lastSeenAt && now - n.lastSeenAt.getTime() < NODE_ONLINE_MS,
      lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
      disabled: !!n.disabledAt,
      createdAt: n.createdAt.toISOString(),
      workspaces: spaces.filter((w) => w.nodeId === n.id).map(workspaceInfo),
    }));
  }

  async function loadNode(actor: Actor, id: string) {
    const [node] = await ctx.db.select().from(nodes).where(eq(nodes.id, id));
    // Nodes you cannot operate are invisible, like projects you are not in.
    if (!node || !canOperate(actor, node)) throw notFound("Node");
    return node;
  }

  async function loadWorkspace(actor: Actor, id: string) {
    const [row] = await ctx.db
      .select({ workspace: workspaces, node: nodes })
      .from(workspaces)
      .innerJoin(nodes, eq(nodes.id, workspaces.nodeId))
      .where(eq(workspaces.id, id));
    if (!row || !canOperate(actor, row.node)) throw notFound("Workspace");
    return row;
  }

  async function queue(node: NodeRow, w: WorkspaceRow, kind: NodeJobKind, actor: Actor) {
    const project = w.projectId ? (await ctx.db.select({ key: projects.key }).from(projects).where(eq(projects.id, w.projectId)))[0] : undefined;
    await ctx.db.insert(nodeJobs).values({
      nodeId: node.id,
      workspaceId: w.id,
      kind,
      payload: { name: w.name, repoUrl: w.repoUrl, projectKey: project?.key ?? null, path: w.path },
      createdBy: actor.id,
    });
  }

  const one = async (node: NodeRow) => (await describe([node]))[0]!;
  const reload = async (id: string) => one((await ctx.db.select().from(nodes).where(eq(nodes.id, id)))[0]!);

  // ---------------------------------------------------------------------------
  // For people

  app.get<{ Querystring: { all?: string } }>("/api/nodes", async (req) => {
    const actor = requireHuman(req, "manage nodes");
    const all = req.query.all === "1" && actor.role === "admin";
    const rows = await ctx.db
      .select()
      .from(nodes)
      .where(all ? undefined : eq(nodes.ownerId, actor.id))
      .orderBy(asc(nodes.name));
    return describe(rows);
  });

  app.patch<{ Params: { id: string } }>("/api/nodes/:id", async (req) => {
    const actor = requireHuman(req, "manage nodes");
    const node = await loadNode(actor, req.params.id);
    const body = parse(nodeUpdateBody, req.body);
    const [updated] = await ctx.db
      .update(nodes)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? (node.disabledAt ?? new Date()) : null } : {}),
      })
      .where(eq(nodes.id, node.id))
      .returning();
    return one(updated!);
  });

  /** Forgets a node. The agents it created are disabled; files on the machine are left alone. */
  app.delete<{ Params: { id: string } }>("/api/nodes/:id", async (req) => {
    const actor = requireHuman(req, "manage nodes");
    const node = await loadNode(actor, req.params.id);
    await ctx.db.transaction(async (tx) => {
      const agentIds = (await tx.select({ id: workspaces.agentId }).from(workspaces).where(eq(workspaces.nodeId, node.id)))
        .map((w) => w.id)
        .filter((id): id is string => !!id);
      if (agentIds.length) {
        await tx
          .update(users)
          .set({ disabledAt: new Date(), disabledReason: "admin" })
          .where(and(inArray(users.id, agentIds), isNull(users.disabledAt)));
      }
      await tx.delete(nodes).where(eq(nodes.id, node.id));
    });
    wake(node.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/nodes/:id/workspaces", async (req) => {
    const actor = requireHuman(req, "create workspaces");
    const node = await loadNode(actor, req.params.id);
    if (node.disabledAt) throw badRequest(`${node.name} is disabled`);
    const body = parse(workspaceCreateBody, req.body);
    const [taken] = await ctx.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.nodeId, node.id), eq(workspaces.name, body.name)));
    if (taken) throw conflict(`${node.name} already has a workspace named "${body.name}"`);

    let projectId: string;
    if (body.projectKey) {
      const { project, role } = await loadProject(ctx.db, actor, body.projectKey);
      if (!isWriter(role)) throw forbidden(`You need to be an owner or member of ${project.key} to add an agent to it`);
      if (project.archivedAt) throw badRequest(`${project.key} is archived`);
      projectId = project.id;
    } else {
      projectId = (await createProject(ctx.db, actor, body.newProject!)).id;
    }

    const [w] = await ctx.db
      .insert(workspaces)
      .values({ nodeId: node.id, name: body.name, projectId, repoUrl: body.repoUrl, createdBy: actor.id })
      .returning();
    await queue(node, w!, "workspace.create", actor);
    if (body.start) await queue(node, w!, "session.start", actor);
    wake(node.id);
    return reload(node.id);
  });

  for (const [action, kind] of [
    ["start", "session.start"],
    ["stop", "session.stop"],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/api/workspaces/:id/${action}`, async (req) => {
      const actor = requireHuman(req, `${action} agents`);
      const { workspace: w, node } = await loadWorkspace(actor, req.params.id);
      if (node.disabledAt) throw badRequest(`${node.name} is disabled`);
      if (kind === "session.start") {
        if (w.status !== "ready") throw badRequest(w.status === "failed" ? "This workspace failed to set up" : "This workspace is still being set up");
        if (!w.agentId) throw badRequest("This workspace has no agent");
        const missing = (["tmux", "claude"] as const).filter((tool) => node.capabilities && !node.capabilities[tool]);
        if (missing.length) throw badRequest(`${node.name} needs ${missing.join(" and ")} to start agents`);
      }
      const [pending] = await ctx.db
        .select({ kind: nodeJobs.kind })
        .from(nodeJobs)
        .where(and(eq(nodeJobs.workspaceId, w.id), inArray(nodeJobs.kind, SESSION_KINDS), inArray(nodeJobs.status, ["queued", "running"])))
        .orderBy(desc(nodeJobs.createdAt))
        .limit(1);
      if (pending?.kind !== kind) {
        await queue(node, w, kind, actor);
        wake(node.id);
      }
      return reload(node.id);
    });
  }

  /** Forgets a workspace: its agent is disabled and its session stopped. Its folder stays on the node. */
  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (req) => {
    const actor = requireHuman(req, "remove workspaces");
    const { workspace: w, node } = await loadWorkspace(actor, req.params.id);
    await ctx.db.transaction(async (tx) => {
      if (w.agentId) {
        await tx
          .update(users)
          .set({ disabledAt: new Date(), disabledReason: "admin" })
          .where(and(eq(users.id, w.agentId), isNull(users.disabledAt)));
      }
      // Queued after the delete so it outlives the workspace row (its workspaceId becomes null).
      await tx.delete(nodeJobs).where(and(eq(nodeJobs.workspaceId, w.id), eq(nodeJobs.status, "queued")));
      await tx.delete(workspaces).where(eq(workspaces.id, w.id));
      await tx.insert(nodeJobs).values({
        nodeId: node.id,
        workspaceId: null,
        kind: "session.stop",
        payload: { name: w.name, repoUrl: w.repoUrl, projectKey: null, path: w.path },
        createdBy: actor.id,
      });
    });
    wake(node.id);
    return reload(node.id);
  });

  // ---------------------------------------------------------------------------
  // For nodes (node token)

  app.post("/api/nodes/register", { config: registerLimit }, async (req): Promise<NodeRegistration> => {
    const body = parse(nodeRegisterBody, req.body);
    const { key, owner } = await findUsableKey(ctx.db, body.key);
    const { token, hash, prefix } = newNodeToken();
    const node = await ctx.db.transaction(async (tx) => {
      await claimKeyUse(tx as unknown as Db, key.id);
      const { key: _key, ...facts } = body;
      const [row] = await tx
        .insert(nodes)
        .values({ ...facts, ownerId: owner.id, tokenHash: hash, tokenPrefix: prefix, enrolledVia: key.id, lastSeenAt: new Date() })
        .returning();
      return row!;
    });
    req.log.info({ nodeId: node.id, keyId: key.id }, "node registered");
    return { token, node: { id: node.id, name: node.name, owner: userSummary(owner) } };
  });

  /** Check-in: the node's facts, and which workspaces have a running session. */
  app.put("/api/node/state", async (req) => {
    const me = requireNode(req);
    const { sessions, ...facts } = parse(nodeStateBody, req.body);
    await ctx.db.update(nodes).set({ ...facts, lastSeenAt: new Date() }).where(eq(nodes.id, me.id));
    await ctx.db
      .update(workspaces)
      .set({ sessionRunning: sessions.length ? inArray(workspaces.id, sessions) : sql`false` })
      .where(eq(workspaces.nodeId, me.id));
    const [row] = await ctx.db.select().from(nodes).where(eq(nodes.id, me.id));
    return { node: { id: row!.id, name: row!.name } };
  });

  async function claimNext(nodeId: string): Promise<NodeJob | null> {
    for (;;) {
      const [next] = await ctx.db
        .select()
        .from(nodeJobs)
        .where(and(eq(nodeJobs.nodeId, nodeId), eq(nodeJobs.status, "queued")))
        .orderBy(asc(nodeJobs.createdAt))
        .limit(1);
      if (!next) return null;
      const [job] = await ctx.db
        .update(nodeJobs)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(nodeJobs.id, next.id), eq(nodeJobs.status, "queued")))
        .returning();
      if (!job) continue;
      // Starting a session only makes sense once its workspace was set up.
      if (job.kind === "session.start" && job.workspaceId) {
        const [w] = await ctx.db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, job.workspaceId));
        if (w?.status !== "ready") {
          await ctx.db
            .update(nodeJobs)
            .set({ status: "failed", error: "The workspace was not set up", finishedAt: new Date() })
            .where(eq(nodeJobs.id, job.id));
          continue;
        }
      }
      return { id: job.id, kind: job.kind, workspaceId: job.workspaceId, payload: job.payload };
    }
  }

  /**
   * The next job for this node, waiting up to `wait` seconds for one (long poll).
   * Nodes run one job at a time, so a job still marked running was interrupted.
   */
  app.get<{ Querystring: { wait?: string } }>("/api/node/jobs/next", async (req, reply) => {
    const me = requireNode(req);
    await ctx.db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, me.id));
    const interrupted = "Interrupted: the node stopped before finishing it";
    const abandoned = await ctx.db
      .update(nodeJobs)
      .set({ status: "failed", error: interrupted, finishedAt: new Date() })
      .where(and(eq(nodeJobs.nodeId, me.id), eq(nodeJobs.status, "running")))
      .returning();
    const unfinished = abandoned.filter((j) => j.kind === "workspace.create" && j.workspaceId).map((j) => j.workspaceId!);
    if (unfinished.length) {
      await ctx.db
        .update(workspaces)
        .set({ status: "failed", error: interrupted })
        .where(and(inArray(workspaces.id, unfinished), eq(workspaces.status, "pending")));
    }

    const deadline = Date.now() + Math.min(Math.max(Number(req.query.wait) || 0, 0), MAX_WAIT_S) * 1000;
    let job = await claimNext(me.id);
    while (!job && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const set = waiters.get(me.id) ?? new Set();
        waiters.set(me.id, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          req.raw.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, deadline - Date.now());
        set.add(done);
        req.raw.on("close", done);
      });
      if (req.raw.destroyed) return reply;
      job = await claimNext(me.id);
    }
    if (!job) return reply.code(204).send();
    return job;
  });

  app.post<{ Params: { id: string } }>("/api/node/jobs/:id/result", async (req) => {
    const me = requireNode(req);
    const body = parse(nodeJobResultBody, req.body);
    const [job] = await ctx.db
      .select()
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, req.params.id), eq(nodeJobs.nodeId, me.id)));
    if (!job) throw notFound("Job");
    if (job.status !== "running") throw conflict(`This job is already ${job.status}`);
    const error = body.ok ? null : (body.error?.trim() || "Failed").slice(0, 5000);
    await ctx.db
      .update(nodeJobs)
      .set({ status: body.ok ? "succeeded" : "failed", error, finishedAt: new Date() })
      .where(eq(nodeJobs.id, job.id));
    if (job.workspaceId) {
      if (job.kind === "workspace.create") {
        await ctx.db
          .update(workspaces)
          .set(body.ok ? { status: "ready", error: null, ...(body.path ? { path: body.path } : {}) } : { status: "failed", error })
          .where(eq(workspaces.id, job.workspaceId));
      } else if (body.ok) {
        await ctx.db
          .update(workspaces)
          .set({ sessionRunning: job.kind === "session.start" })
          .where(eq(workspaces.id, job.workspaceId));
      }
    }
    return { ok: true };
  });

  /**
   * Creates the agent for a workspace this node is setting up: linked to the node's
   * owner and a member of the workspace's project. The token goes only to the node.
   */
  app.post<{ Params: { id: string } }>("/api/node/workspaces/:id/agent", async (req): Promise<NodeAgentGrant> => {
    const me = requireNode(req);
    const [w] = await ctx.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, req.params.id), eq(workspaces.nodeId, me.id)));
    if (!w) throw notFound("Workspace");
    if (w.agentId) throw conflict("This workspace already has an agent");
    const [project] = w.projectId ? await ctx.db.select().from(projects).where(eq(projects.id, w.projectId)) : [];
    const name = await freeAgentName(ctx.db, me.ownerId, `claude-${slug(me.name)}-${w.name}`);
    const { token, hash, prefix } = newApiToken();
    const agent = await ctx.db.transaction(async (tx) => {
      const [a] = await tx
        .insert(users)
        .values({
          name,
          description: `Claude Code in workspace ${w.name} on node ${me.name}`,
          kind: "agent",
          role: "member",
          ownerId: me.ownerId,
        })
        .returning();
      await tx.insert(apiTokens).values({ userId: a!.id, name: `node ${me.name}`, tokenHash: hash, prefix, createdBy: me.ownerId });
      if (project && !project.archivedAt) {
        await tx.insert(projectMembers).values({ projectId: project.id, userId: a!.id, role: "member" }).onConflictDoNothing();
      }
      await tx.update(workspaces).set({ agentId: a!.id }).where(eq(workspaces.id, w.id));
      return a!;
    });
    req.log.info({ nodeId: me.id, workspaceId: w.id, agentId: agent.id }, "node created an agent");
    return {
      token,
      agent: { id: agent.id, name: agent.name },
      project: project && !project.archivedAt ? { key: project.key, name: project.name } : null,
    };
  });
}
