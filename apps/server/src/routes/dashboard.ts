import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import type { DashboardInfo, TaskStatus } from "@rev/shared";
import type { AppContext } from "../context";
import { projectMembers, projects, reviews, tasks, users } from "../db/schema";
import { requireHuman } from "../lib/auth";
import { loadUsers, serializeReviews, serializeTasks } from "../lib/serialize";

/** Not open work: closed, or still a proposal. */
const NOT_OPEN: TaskStatus[] = ["done", "cancelled", "proposed"];

export default async function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/dashboard", async (req): Promise<DashboardInfo> => {
    const actor = requireHuman(req, "use the dashboard");
    const memberships = await ctx.db
      .select({ id: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actor.id));
    const memberOf = memberships.map((m) => m.id);
    const writerOf = memberships.filter((m) => m.role !== "viewer").map((m) => m.id);
    const agentIds = (
      await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.kind, "agent"), eq(users.ownerId, actor.id)))
    ).map((a) => a.id);

    const [myTasks, toDecide, agentTasks, recent, agentClosures, proposed] = await Promise.all([
      ctx.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.assigneeId, actor.id), notInArray(tasks.status, NOT_OPEN)))
        .orderBy(desc(tasks.updatedAt))
        .limit(50),
      ctx.db
        .select()
        .from(reviews)
        .where(and(eq(reviews.ownerId, actor.id), inArray(reviews.status, ["open"])))
        .orderBy(desc(reviews.updatedAt))
        .limit(50),
      agentIds.length
        ? ctx.db
            .select()
            .from(tasks)
            .where(and(inArray(tasks.assigneeId, agentIds), notInArray(tasks.status, NOT_OPEN)))
            .orderBy(desc(tasks.updatedAt))
            .limit(50)
        : Promise.resolve([]),
      memberOf.length
        ? ctx.db
            .select()
            .from(reviews)
            .where(and(inArray(reviews.projectId, memberOf), ne(reviews.status, "draft")))
            .orderBy(desc(reviews.updatedAt))
            .limit(10)
        : Promise.resolve([]),
      agentIds.length
        ? ctx.db
            .select()
            .from(tasks)
            .where(and(inArray(tasks.closedBy, agentIds), inArray(tasks.status, ["done", "cancelled"]), isNull(tasks.humanReviewedBy)))
            .orderBy(desc(tasks.closedAt))
            .limit(50)
        : Promise.resolve([]),
      writerOf.length
        ? ctx.db
            .select({ projectKey: projects.key, projectName: projects.name, createdBy: tasks.createdBy, n: count() })
            .from(tasks)
            .innerJoin(projects, eq(projects.id, tasks.projectId))
            .where(and(inArray(tasks.projectId, writerOf), eq(tasks.status, "proposed"), isNull(projects.archivedAt)))
            .groupBy(projects.key, projects.name, tasks.createdBy)
            .orderBy(asc(projects.key))
        : Promise.resolve([]),
    ]);
    const proposers = await loadUsers(ctx.db, proposed.map((p) => p.createdBy));
    const proposals: DashboardInfo["proposals"] = [];
    for (const p of proposed) {
      let entry = proposals.find((e) => e.projectKey === p.projectKey);
      if (!entry) proposals.push((entry = { projectKey: p.projectKey, projectName: p.projectName, count: 0, proposedBy: [] }));
      entry.count += Number(p.n);
      const who = proposers.get(p.createdBy);
      if (who) entry.proposedBy.push(who);
    }

    return {
      myTasks: await serializeTasks(ctx.db, myTasks),
      proposals,
      reviewsToDecide: await serializeReviews(ctx.db, toDecide),
      myAgentsTasks: await serializeTasks(ctx.db, agentTasks),
      agentClosuresToReview: await serializeTasks(ctx.db, agentClosures),
      recentReviews: await serializeReviews(ctx.db, recent),
    };
  });
}
