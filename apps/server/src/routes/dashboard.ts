import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import type { DashboardInfo, TaskStatus } from "@rev/shared";
import type { AppContext } from "../context";
import { projectMembers, reviews, tasks, users } from "../db/schema";
import { requireHuman } from "../lib/auth";
import { serializeReviews, serializeTasks } from "../lib/serialize";

const CLOSED: TaskStatus[] = ["done", "cancelled"];

export default async function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/dashboard", async (req): Promise<DashboardInfo> => {
    const actor = requireHuman(req, "use the dashboard");
    const memberOf = (
      await ctx.db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, actor.id))
    ).map((m) => m.id);
    const agentIds = (
      await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.kind, "agent"), eq(users.ownerId, actor.id)))
    ).map((a) => a.id);

    const [myTasks, toDecide, agentTasks, recent, agentClosures] = await Promise.all([
      ctx.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.assigneeId, actor.id), notInArray(tasks.status, CLOSED)))
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
            .where(and(inArray(tasks.assigneeId, agentIds), notInArray(tasks.status, CLOSED)))
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
            .where(and(inArray(tasks.closedBy, agentIds), inArray(tasks.status, CLOSED), isNull(tasks.humanReviewedBy)))
            .orderBy(desc(tasks.closedAt))
            .limit(50)
        : Promise.resolve([]),
    ]);

    return {
      myTasks: await serializeTasks(ctx.db, myTasks),
      reviewsToDecide: await serializeReviews(ctx.db, toDecide),
      myAgentsTasks: await serializeTasks(ctx.db, agentTasks),
      agentClosuresToReview: await serializeTasks(ctx.db, agentClosures),
      recentReviews: await serializeReviews(ctx.db, recent),
    };
  });
}
