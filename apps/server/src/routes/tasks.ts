import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import {
  reviewRef,
  TASK_STATUSES,
  taskCommentBody,
  taskCreateBody,
  taskUpdateBody,
  type TaskActivityInfo,
  type TaskDetail,
  type TaskStatus,
} from "@rev/shared";
import type { AppContext } from "../context";
import { projectMembers, projects, reviewComments, reviewRoundTasks, reviewRounds, reviews, taskActivity, tasks } from "../db/schema";
import { assertAssignable, assertCan, assignableUserIds, loadProject, projectPerms, taskPerms } from "../lib/access";
import { requireActor, type Actor } from "../lib/auth";
import { badRequest, conflict, forbidden, parse } from "../lib/errors";
import { resolveTask } from "../lib/refs";
import { loadUsers, serializeComments, serializeTasks } from "../lib/serialize";
import { closureFields, insertTask, syncSourceComments } from "../lib/tasks";

function statusFilter(raw: string | undefined): TaskStatus[] | null {
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()) as TaskStatus[];
  for (const s of list) if (!TASK_STATUSES.includes(s)) throw badRequest(`Unknown status: ${s}`);
  return list;
}

export async function taskDetail(ctx: AppContext, actor: Actor, ref: string): Promise<TaskDetail> {
  const { task, project, role } = await resolveTask(ctx.db, actor, ref);
  const [[info], commentRows, deliveryRows, activityRows, assignable] = await Promise.all([
    serializeTasks(ctx.db, [task]),
    ctx.db.select().from(reviewComments).where(eq(reviewComments.taskId, task.id)).orderBy(asc(reviewComments.createdAt)),
    ctx.db
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.taskId, task.id),
          or(ne(reviews.status, "draft"), eq(reviews.createdBy, actor.id), eq(reviews.ownerId, actor.id)),
        ),
      )
      .orderBy(desc(reviews.createdAt)),
    ctx.db.select().from(taskActivity).where(eq(taskActivity.taskId, task.id)).orderBy(asc(taskActivity.createdAt)),
    assignableUserIds(ctx.db, project.id, actor, role),
  ]);
  // Later rounds of a review that say they address this task.
  const roundDeliveries = await ctx.db
    .select({ review: reviews, round: reviewRounds })
    .from(reviewRoundTasks)
    .innerJoin(reviewRounds, eq(reviewRounds.id, reviewRoundTasks.roundId))
    .innerJoin(reviews, eq(reviews.id, reviewRounds.reviewId))
    .where(and(eq(reviewRoundTasks.taskId, task.id), isNotNull(reviewRounds.submittedAt)))
    .orderBy(desc(reviewRounds.submittedAt));
  const actors = await loadUsers(ctx.db, activityRows.map((a) => a.actorId));
  const activity: TaskActivityInfo[] = activityRows.map((a) => ({
    id: a.id,
    kind: a.kind,
    actor: actors.get(a.actorId)!,
    body: a.body,
    data: a.data ?? null,
    createdAt: a.createdAt.toISOString(),
  }));
  // Notes on single marks of the source comments travel with them, so the numbers on a snapshot mean something.
  const sourceIds = new Set(commentRows.map((c) => c.id));
  const overallIds = commentRows.filter((c) => c.markOf == null && c.parentId == null).map((c) => c.id);
  const markRows = overallIds.length
    ? (
        await ctx.db
          .select()
          .from(reviewComments)
          .where(inArray(reviewComments.markOf, overallIds))
          .orderBy(asc(reviewComments.markIndex))
      ).filter((m) => !sourceIds.has(m.id))
    : [];
  const perms = taskPerms(actor, role, task);
  return {
    ...info!,
    sourceComments: await serializeComments(ctx.db, commentRows),
    sourceMarks: await serializeComments(ctx.db, markRows),
    deliveries: [
      ...roundDeliveries.map(({ review: r, round }) => ({
        id: r.id,
        ref: reviewRef(project.key, r.number),
        title: r.title,
        status: r.status,
        createdAt: round.submittedAt!.toISOString(),
        round: round.number,
      })),
      ...deliveryRows.map((r) => ({
        id: r.id,
        ref: reviewRef(project.key, r.number),
        title: r.title,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        round: null,
      })),
    ],
    activity,
    can: { ...perms, assignableUserIds: perms.edit ? assignable : [] },
  };
}

export default async function taskRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { key: string }; Querystring: { status?: string; assignee?: string } }>(
    "/api/projects/:key/tasks",
    async (req) => {
      const actor = requireActor(req);
      const { project } = await loadProject(ctx.db, actor, req.params.key);
      const statuses = statusFilter(req.query.status);
      const conds: SQL[] = [eq(tasks.projectId, project.id)];
      if (statuses) conds.push(inArray(tasks.status, statuses));
      if (req.query.assignee === "me") conds.push(eq(tasks.assigneeId, actor.id));
      else if (req.query.assignee === "none") conds.push(isNull(tasks.assigneeId));
      else if (req.query.assignee) conds.push(eq(tasks.assigneeId, req.query.assignee));
      const rows = await ctx.db
        .select()
        .from(tasks)
        .where(and(...conds))
        .orderBy(asc(tasks.position), asc(tasks.number));
      return serializeTasks(ctx.db, rows);
    },
  );

  app.post<{ Params: { key: string } }>("/api/projects/:key/tasks", async (req) => {
    const actor = requireActor(req);
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    assertCan(projectPerms(actor, role, project).createTask, "You cannot create tasks in this project");
    const body = parse(taskCreateBody, req.body);
    await assertAssignable(ctx.db, project.id, actor, role, body.assigneeId);
    const task = await ctx.db.transaction((tx) => insertTask(tx, project.id, actor, body));
    return taskDetail(ctx, actor, task.id);
  });

  /** Cross-project task list. Agents poll this with the default `assignee=me`. */
  app.get<{ Querystring: { status?: string; assignee?: string } }>("/api/tasks", async (req) => {
    const actor = requireActor(req);
    const statuses = statusFilter(req.query.status) ?? ["todo", "in_progress", "in_review"];
    const assignee = req.query.assignee ?? "me";
    if (assignee !== "me" && assignee !== actor.id) throw badRequest("Only assignee=me is supported");
    const visible = await ctx.db
      .select({ id: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actor.id));
    if (!visible.length) return [];
    const rows = await ctx.db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(tasks.assigneeId, actor.id),
          inArray(tasks.status, statuses),
          inArray(
            tasks.projectId,
            visible.map((v) => v.id),
          ),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(tasks.createdAt));
    return serializeTasks(
      ctx.db,
      rows.map((r) => r.task),
    );
  });

  app.get<{ Params: { ref: string } }>("/api/tasks/:ref", async (req) => taskDetail(ctx, requireActor(req), req.params.ref));

  app.patch<{ Params: { ref: string } }>("/api/tasks/:ref", async (req) => {
    const actor = requireActor(req);
    const { task, project, role } = await resolveTask(ctx.db, actor, req.params.ref);
    const perms = taskPerms(actor, role, task);
    const body = parse(taskUpdateBody, req.body);
    const onlyStatus = Object.keys(body).every((k) => k === "status");
    if (!perms.edit && !(onlyStatus && perms.updateStatus)) {
      throw forbidden(actor.kind === "agent" ? "Agents can only update the status of tasks assigned to them" : undefined);
    }
    if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId) {
      await assertAssignable(ctx.db, project.id, actor, role, body.assigneeId);
    }

    await ctx.db.transaction(async (tx) => {
      const now = new Date();
      const statusChanged = body.status !== undefined && body.status !== task.status;
      await tx
        .update(tasks)
        .set({
          ...body,
          updatedAt: now,
          ...(statusChanged ? closureFields(actor, body.status!, now) : {}),
        })
        .where(eq(tasks.id, task.id));

      const events: (typeof taskActivity.$inferInsert)[] = [];
      if (statusChanged) {
        events.push({
          taskId: task.id,
          actorId: actor.id,
          kind: "status",
          data: { from: task.status, to: body.status, byKind: actor.kind },
        });
        await syncSourceComments(tx, task.id, body.status!);
      }
      if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId) {
        events.push({
          taskId: task.id,
          actorId: actor.id,
          kind: "assign",
          data: { from: task.assigneeId, to: body.assigneeId },
        });
      }
      if (body.priority !== undefined && body.priority !== task.priority) {
        events.push({ taskId: task.id, actorId: actor.id, kind: "priority", data: { from: task.priority, to: body.priority } });
      }
      if (events.length) await tx.insert(taskActivity).values(events);
    });
    return taskDetail(ctx, actor, task.id);
  });

  /** A human confirms a task an agent closed; the closure then counts as human-reviewed. */
  app.post<{ Params: { ref: string } }>("/api/tasks/:ref/review-closure", async (req) => {
    const actor = requireActor(req);
    const { task, role } = await resolveTask(ctx.db, actor, req.params.ref);
    if (actor.kind !== "human") throw forbidden("Only humans can review a closure");
    if (task.status !== "done" && task.status !== "cancelled") throw badRequest("The task is not closed");
    if (task.humanReviewedBy) throw conflict("A human has already reviewed this closure");
    assertCan(taskPerms(actor, role, task).reviewClosure, "You cannot review tasks in this project");
    const body = parse(taskCommentBody.partial(), req.body ?? {});
    await ctx.db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(tasks).set({ humanReviewedBy: actor.id, humanReviewedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
      await tx.insert(taskActivity).values({
        taskId: task.id,
        actorId: actor.id,
        kind: "closure_reviewed",
        body: body.body ?? "",
        data: { closedBy: task.closedBy, status: task.status },
      });
    });
    return taskDetail(ctx, actor, task.id);
  });

  app.post<{ Params: { ref: string } }>("/api/tasks/:ref/comments", async (req) => {
    const actor = requireActor(req);
    const { task, role } = await resolveTask(ctx.db, actor, req.params.ref);
    assertCan(taskPerms(actor, role, task).comment, "You cannot comment on this task");
    const body = parse(taskCommentBody, req.body);
    await ctx.db.insert(taskActivity).values({ taskId: task.id, actorId: actor.id, kind: "comment", body: body.body });
    await ctx.db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, task.id));
    return taskDetail(ctx, actor, task.id);
  });
}
