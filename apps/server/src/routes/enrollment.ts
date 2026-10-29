import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentRegisterBody,
  enrollmentKeyCreateBody,
  type AgentRegistration,
  type EnrollmentKeyInfo,
  type ProjectRole,
} from "@rev/shared";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { apiTokens, enrollmentKeys, projectMembers, projects, users } from "../db/schema";
import { isWriter, loadProject, projectRole } from "../lib/access";
import { requireHuman, type Actor } from "../lib/auth";
import { newApiToken, randomToken, sha256 } from "../lib/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from "../lib/errors";
import { loadUsers, userSummary } from "../lib/serialize";

type KeyRow = typeof enrollmentKeys.$inferSelect;

const registerLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

function isActive(k: KeyRow, now = new Date()) {
  return !k.revokedAt && (!k.expiresAt || k.expiresAt > now) && (k.maxUses == null || k.uses < k.maxUses);
}

/** Agent names are unique per linked human so people can tell their agents apart. */
export async function assertAgentNameFree(db: Db, ownerId: string, name: string) {
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.kind, "agent"), eq(users.ownerId, ownerId), sql`lower(${users.name}) = lower(${name})`));
  if (taken) throw conflict(`An agent named "${name}" already exists for this owner; choose another name`);
}

async function describeKeys(db: Db, rows: KeyRow[]): Promise<EnrollmentKeyInfo[]> {
  if (!rows.length) return [];
  const projectIds = [...new Set(rows.flatMap((k) => k.projects.map((p) => p.projectId)))];
  const [owners, projectRows, agentRows] = await Promise.all([
    loadUsers(db, rows.map((k) => k.createdBy)),
    projectIds.length
      ? db.select({ id: projects.id, key: projects.key, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
      : Promise.resolve([]),
    db
      .select({ id: users.id, name: users.name, disabledAt: users.disabledAt, enrolledVia: users.enrolledVia })
      .from(users)
      .where(inArray(users.enrolledVia, rows.map((k) => k.id))),
  ]);
  const projectBy = new Map(projectRows.map((p) => [p.id, p]));
  return rows.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdBy: owners.get(k.createdBy)!,
    projects: k.projects
      .map((p) => {
        const project = projectBy.get(p.projectId);
        return project ? { key: project.key, name: project.name, role: p.role } : null;
      })
      .filter((p) => p !== null),
    maxUses: k.maxUses,
    uses: k.uses,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
    active: isActive(k),
    agents: agentRows.filter((a) => a.enrolledVia === k.id).map((a) => ({ id: a.id, name: a.name, disabled: !!a.disabledAt })),
  }));
}

export default async function enrollmentRoutes(app: FastifyInstance, ctx: AppContext) {
  async function loadKey(actor: Actor, id: string) {
    const [key] = await ctx.db.select().from(enrollmentKeys).where(eq(enrollmentKeys.id, id));
    if (!key) throw notFound("Enrollment key");
    if (key.createdBy !== actor.id && actor.role !== "admin") throw forbidden("Only the key's creator can manage it");
    return key;
  }

  app.get<{ Querystring: { all?: string } }>("/api/enrollment-keys", async (req) => {
    const actor = requireHuman(req, "manage enrollment keys");
    const all = req.query.all === "1" && actor.role === "admin";
    const rows = await ctx.db
      .select()
      .from(enrollmentKeys)
      .where(all ? undefined : eq(enrollmentKeys.createdBy, actor.id))
      .orderBy(desc(enrollmentKeys.createdAt));
    return describeKeys(ctx.db, rows);
  });

  app.post("/api/enrollment-keys", async (req) => {
    const actor = requireHuman(req, "create enrollment keys");
    const body = parse(enrollmentKeyCreateBody, req.body);
    const keyProjects: KeyRow["projects"] = [];
    for (const p of body.projects) {
      const { project, role } = await loadProject(ctx.db, actor, p.key);
      // Same rule as adding your own agent to a project by hand.
      if (!isWriter(role)) throw forbidden(`You need to be an owner or member of ${project.key} to enrol agents into it`);
      if (project.archivedAt) throw badRequest(`${project.key} is archived`);
      if (!keyProjects.some((k) => k.projectId === project.id)) keyProjects.push({ projectId: project.id, role: p.role });
    }
    const key = `rev_enroll_${randomToken(32)}`;
    const [row] = await ctx.db
      .insert(enrollmentKeys)
      .values({
        name: body.name,
        keyHash: sha256(key),
        prefix: key.slice(0, 18),
        createdBy: actor.id,
        projects: keyProjects,
        maxUses: body.maxUses,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
      })
      .returning();
    // The raw key is only ever returned here.
    return { key, info: (await describeKeys(ctx.db, [row!]))[0] };
  });

  /** Revoke a key. `?disableAgents=1` also disables every agent that registered with it (e.g. a leaked key). */
  app.delete<{ Params: { id: string }; Querystring: { disableAgents?: string } }>("/api/enrollment-keys/:id", async (req) => {
    const actor = requireHuman(req, "manage enrollment keys");
    const key = await loadKey(actor, req.params.id);
    await ctx.db.transaction(async (tx) => {
      await tx.update(enrollmentKeys).set({ revokedAt: key.revokedAt ?? new Date() }).where(eq(enrollmentKeys.id, key.id));
      if (req.query.disableAgents === "1") {
        await tx
          .update(users)
          .set({ disabledAt: new Date(), disabledReason: "admin" })
          .where(and(eq(users.enrolledVia, key.id), isNull(users.disabledAt)));
      }
    });
    const [row] = await ctx.db.select().from(enrollmentKeys).where(eq(enrollmentKeys.id, key.id));
    return (await describeKeys(ctx.db, [row!]))[0];
  });

  /** Self-registration: an agent holding an enrollment key creates its own account and token. */
  app.post("/api/agents/register", { config: registerLimit }, async (req): Promise<AgentRegistration> => {
    const body = parse(agentRegisterBody, req.body);
    const [found] = await ctx.db.select().from(enrollmentKeys).where(eq(enrollmentKeys.keyHash, sha256(body.key)));
    if (!found) throw new HttpError(401, "unauthorized", "Invalid enrollment key");
    if (found.revokedAt) throw forbidden("This enrollment key has been revoked");
    if (found.expiresAt && found.expiresAt <= new Date()) throw forbidden("This enrollment key has expired");
    if (found.maxUses != null && found.uses >= found.maxUses) throw forbidden("This enrollment key has no registrations left");

    const [owner] = await ctx.db.select().from(users).where(eq(users.id, found.createdBy));
    if (!owner || owner.disabledAt) throw forbidden("The owner of this enrollment key is disabled");
    const ownerActor: Actor = { id: owner.id, name: owner.name, email: owner.email, kind: "human", role: owner.role, ownerId: null };
    await assertAgentNameFree(ctx.db, owner.id, body.name);

    const { token, hash, prefix } = newApiToken();
    const result = await ctx.db.transaction(async (tx) => {
      // Claim a use atomically so concurrent registrations cannot exceed maxUses.
      const [claimed] = await tx
        .update(enrollmentKeys)
        .set({ uses: sql`${enrollmentKeys.uses} + 1`, lastUsedAt: new Date() })
        .where(
          and(
            eq(enrollmentKeys.id, found.id),
            isNull(enrollmentKeys.revokedAt),
            sql`(${enrollmentKeys.maxUses} is null or ${enrollmentKeys.uses} < ${enrollmentKeys.maxUses})`,
          ),
        )
        .returning();
      if (!claimed) throw forbidden("This enrollment key has no registrations left");

      const [agent] = await tx
        .insert(users)
        .values({
          name: body.name,
          description: body.description,
          kind: "agent",
          role: "member",
          ownerId: owner.id,
          enrolledVia: found.id,
        })
        .returning();
      await tx.insert(apiTokens).values({
        userId: agent!.id,
        name: `enrolled via "${found.name}"`,
        tokenHash: hash,
        prefix,
        createdBy: owner.id,
      });

      // Join the key's projects, as long as its creator may still add agents there.
      const joined: AgentRegistration["projects"] = [];
      for (const p of found.projects) {
        const [project] = await tx.select().from(projects).where(eq(projects.id, p.projectId));
        if (!project || project.archivedAt) continue;
        if (!isWriter(await projectRole(tx as unknown as Db, project.id, ownerActor))) continue;
        await tx
          .insert(projectMembers)
          .values({ projectId: project.id, userId: agent!.id, role: p.role })
          .onConflictDoNothing();
        joined.push({ key: project.key, name: project.name, role: p.role as ProjectRole });
      }
      return { agent: agent!, joined };
    });

    req.log.info({ agentId: result.agent.id, keyId: found.id }, "agent self-registered");
    return {
      token,
      agent: { id: result.agent.id, name: result.agent.name, owner: userSummary(owner) },
      projects: result.joined,
    };
  });
}
