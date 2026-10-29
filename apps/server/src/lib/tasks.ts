import { and, eq, inArray, sql } from "drizzle-orm";
import type { TaskPriority, TaskStatus } from "@rev/shared";
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
      completedAt: input.status === "done" ? new Date() : null,
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
