import { and, eq, inArray, sql } from "drizzle-orm";
import { isClosedStatus, type ClosureReview, type TaskPriority, type TaskStatus } from "@rev/shared";
import type { Tx } from "../db";
import { projects, reviewComments, taskActivity, tasks } from "../db/schema";
import type { Actor } from "./auth";

export async function nextNumber(tx: Tx, projectId: string, column: "task" | "review") {
  const col = column === "task" ? projects.taskSeq : projects.reviewSeq;
  const [row] = await tx
    .update(projects)
    .set(column === "task" ? { taskSeq: sql`${projects.taskSeq} + 1` } : { reviewSeq: sql`${projects.reviewSeq} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ n: col });
  return row!.n;
}

/**
 * Closure bookkeeping for a status change. Closing records who closed the task;
 * a human closing it is also its human review. Reopening clears the closure
 * (the activity log keeps the history).
 */
export function closureFields(actor: Actor, status: TaskStatus, now: Date) {
  if (!isClosedStatus(status)) {
    return { closedAt: null, closedBy: null, humanReviewedBy: null, humanReviewedAt: null };
  }
  const human = actor.kind === "human";
  return {
    closedAt: now,
    closedBy: actor.id,
    humanReviewedBy: human ? actor.id : null,
    humanReviewedAt: human ? now : null,
  };
}

export function closureReviewOf(t: { status: TaskStatus; humanReviewedBy: string | null }): ClosureReview | null {
  if (!isClosedStatus(t.status)) return null;
  return t.humanReviewedBy ? "human" : "agent";
}

export async function insertTask(
  tx: Tx,
  projectId: string,
  actor: Actor,
  input: {
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeId: string | null;
    sourceReviewId?: string | null;
  },
) {
  const number = await nextNumber(tx, projectId, "task");
  const [task] = await tx
    .insert(tasks)
    .values({
      projectId,
      number,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId,
      createdBy: actor.id,
      sourceReviewId: input.sourceReviewId ?? null,
      position: number * 1000,
      ...closureFields(actor, input.status, new Date()),
    })
    .returning();
  await tx.insert(taskActivity).values({
    taskId: task!.id,
    actorId: actor.id,
    kind: "created",
    data: input.assigneeId ? { assigneeId: input.assigneeId } : null,
  });
  return task!;
}

/** Keeps the comments a task came from in step with the task: done resolves them, reopening un-resolves. */
export async function syncSourceComments(tx: Tx, taskId: string, status: TaskStatus) {
  if (status === "done") {
    await tx
      .update(reviewComments)
      .set({ status: "resolved", updatedAt: new Date() })
      .where(and(eq(reviewComments.taskId, taskId), eq(reviewComments.status, "accepted")));
  } else if (status !== "cancelled") {
    await tx
      .update(reviewComments)
      .set({ status: "accepted", updatedAt: new Date() })
      .where(and(eq(reviewComments.taskId, taskId), inArray(reviewComments.status, ["resolved"])));
  }
}
