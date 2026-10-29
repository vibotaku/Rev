import type { FastifyInstance } from "fastify";
import { and, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  memberAddBody,
  memberUpdateBody,
  projectCreateBody,
  projectUpdateBody,
  type ProjectInfo,
  type ProjectMemberInfo,
  type ProjectRole,
} from "@rev/shared";
import type { AppContext } from "../context";
import type { Tx } from "../db";
import { projectMembers, projects, reviews, tasks, users } from "../db/schema";
import { isWriter, loadProject, projectPerms } from "../lib/access";
import { requireActor, requireHuman, type Actor } from "../lib/auth";
import { badRequest, conflict, forbidden, notFound, parse } from "../lib/errors";
import { userSummary } from "../lib/serialize";

type ProjectRow = typeof projects.$inferSelect;

export async function describeProjects(
  ctx: AppContext,
  actor: Actor,
  rows: { project: ProjectRow; role: ProjectRole }[],
): Promise<ProjectInfo[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.project.id);
  const [taskCounts, reviewCounts, memberCounts] = await Promise.all([
    ctx.db
      .select({ id: tasks.projectId, n: count() })
      .from(tasks)
      .where(and(inArray(tasks.projectId, ids), notInArray(tasks.status, ["done", "cancelled"])))
      .groupBy(tasks.projectId),
    ctx.db
      .select({ id: reviews.projectId, n: count() })
      .from(reviews)
      .where(and(inArray(reviews.projectId, ids), inArray(reviews.status, ["open", "changes_requested"])))
      .groupBy(reviews.projectId),
    ctx.db
      .select({ id: projectMembers.projectId, n: count() })
      .from(projectMembers)
      .where(inArray(projectMembers.projectId, ids))
      .groupBy(projectMembers.projectId),
  ]);
  const get = (list: { id: string; n: number }[], id: string) => Number(list.find((x) => x.id === id)?.n ?? 0);
  return rows.map(({ project, role }) => ({
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    archived: !!project.archivedAt,
    createdAt: project.createdAt.toISOString(),
    myRole: role,
    counts: {
      openTasks: get(taskCounts, project.id),
      openReviews: get(reviewCounts, project.id),
      members: get(memberCounts, project.id),
    },
    can: projectPerms(actor, role, project),
  }));
}

export default async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/projects", async (req) => {
    const actor = requireActor(req);
    let rows: { project: ProjectRow; role: ProjectRole }[];
    if (actor.kind === "human" && actor.role === "admin") {
      const all = await ctx.db.select().from(projects).orderBy(projects.name);
      rows = all.map((project) => ({ project, role: "owner" as const }));
    } else {
      rows = await ctx.db
        .select({ project: projects, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(eq(projectMembers.userId, actor.id))
        .orderBy(projects.name);
    }
    return describeProjects(ctx, actor, rows);
  });

  app.post("/api/projects", async (req) => {
    const actor = requireHuman(req, "create projects");
    const body = parse(projectCreateBody, req.body);
    const [existing] = await ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.key, body.key));
    if (existing) throw conflict(`Project key ${body.key} is already taken`);
    const project = await ctx.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({ key: body.key, name: body.name, description: body.description, createdBy: actor.id })
        .returning();
      await tx.insert(projectMembers).values({ projectId: p!.id, userId: actor.id, role: "owner" });
      return p!;
    });
    return (await describeProjects(ctx, actor, [{ project, role: "owner" }]))[0];
  });

  app.get<{ Params: { key: string } }>("/api/projects/:key", async (req) => {
    const actor = requireActor(req);
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    return (await describeProjects(ctx, actor, [{ project, role }]))[0];
  });

  app.patch<{ Params: { key: string } }>("/api/projects/:key", async (req) => {
    const actor = requireActor(req);
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    if (!projectPerms(actor, role, project).manage) throw forbidden("Only project owners can edit the project");
    const body = parse(projectUpdateBody, req.body);
    const [updated] = await ctx.db
      .update(projects)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.archived !== undefined ? { archivedAt: body.archived ? new Date() : null } : {}),
      })
      .where(eq(projects.id, project.id))
      .returning();
    return (await describeProjects(ctx, actor, [{ project: updated!, role }]))[0];
  });

  app.get<{ Params: { key: string } }>("/api/projects/:key/members", async (req) => {
    const actor = requireActor(req);
    const { project } = await loadProject(ctx.db, actor, req.params.key);
    const rows = await ctx.db
      .select({ user: users, role: projectMembers.role, createdAt: projectMembers.createdAt })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, project.id), isNull(users.disabledAt)))
      .orderBy(sql`case ${projectMembers.role} when 'owner' then 0 when 'member' then 1 else 2 end`, users.kind, users.name);
    return rows.map(
      (r): ProjectMemberInfo => ({ user: userSummary(r.user), role: r.role, createdAt: r.createdAt.toISOString() }),
    );
  });

  // Owners add anyone. Other members may link their own agents to the project.
  app.post<{ Params: { key: string } }>("/api/projects/:key/members", async (req) => {
    const actor = requireHuman(req, "manage project members");
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    const body = parse(memberAddBody, req.body);
    const [target] = await ctx.db.select().from(users).where(eq(users.id, body.userId));
    if (!target || target.disabledAt) throw notFound("User");
    const ownsAgent = target.kind === "agent" && target.ownerId === actor.id;
    if (role !== "owner" && !(isWriter(role) && ownsAgent)) {
      throw forbidden("Only project owners can add members (members may add their own agents)");
    }
    if (target.kind === "agent" && body.role === "owner") throw badRequest("Agents cannot be project owners");
    await ctx.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: target.id, role: body.role })
      .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: body.role } });
    return { ok: true };
  });

  app.patch<{ Params: { key: string; userId: string } }>("/api/projects/:key/members/:userId", async (req) => {
    const actor = requireHuman(req, "manage project members");
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    if (role !== "owner") throw forbidden("Only project owners can change roles");
    const body = parse(memberUpdateBody, req.body);
    const [target] = await ctx.db.select().from(users).where(eq(users.id, req.params.userId));
    if (!target) throw notFound("Member");
    if (target.kind === "agent" && body.role === "owner") throw badRequest("Agents cannot be project owners");
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(projectMembers)
        .set({ role: body.role })
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.id)));
      await assertHasOwner(tx, project.id);
    });
    return { ok: true };
  });

  app.delete<{ Params: { key: string; userId: string } }>("/api/projects/:key/members/:userId", async (req) => {
    const actor = requireHuman(req, "manage project members");
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    const [target] = await ctx.db.select().from(users).where(eq(users.id, req.params.userId));
    if (!target) throw notFound("Member");
    const self = target.id === actor.id;
    const ownsAgent = target.kind === "agent" && target.ownerId === actor.id;
    if (role !== "owner" && !self && !ownsAgent) throw forbidden("Only project owners can remove members");
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.id)));
      await assertHasOwner(tx, project.id);
    });
    return { ok: true };
  });
}

async function assertHasOwner(tx: Tx, projectId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "owner")));
  if (Number(row?.n ?? 0) === 0) throw badRequest("A project needs at least one owner");
}
