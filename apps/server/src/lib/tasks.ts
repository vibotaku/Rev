import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  isClosedStatus,
  MAX_TASK_DEPTH,
  type ClosureReview,
  type ProjectRole,
  type taskCreateBody,
  type TaskPriority,
  type TaskStatus,
} from "@rev/shared";
import type { Db, Tx } from "../db";
import { projects, reviewComments, taskActivity, tasks } from "../db/schema";
import { assertAssignable } from "./access";
import type { Actor } from "./auth";
import { badRequest, forbidden } from "./errors";

type Project = typeof projects.$inferSelect;
type Task = typeof tasks.$inferSelect;

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
    parentId?: string | null;
    labels?: string[];
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
      parentId: input.parentId ?? null,
      labels: input.labels ?? [],
      position: number * 1000,
      ...closureFields(actor, input.status, new Date()),
    })
    .returning();
  await tx.insert(taskActivity).values({
    taskId: task!.id,
    actorId: actor.id,
    kind: "created",
    data:
      input.assigneeId || input.status === "proposed"
        ? { ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}), ...(input.status === "proposed" ? { proposed: true } : {}) }
        : null,
  });
  return task!;
}

const TASK_REF = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/;

/** A parent named by ref ("WEB-3"), which must be in the same project. */
export async function findParent(db: Db | Tx, project: Project, ref: string): Promise<Task> {
  const m = TASK_REF.exec(ref);
  if (!m) throw badRequest(`Parent "${ref}" is not a task like ${project.key}-3`);
  if (m[1]!.toUpperCase() !== project.key) throw badRequest(`Parent ${ref} is in a different project`);
  const [parent] = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(m[2]))));
  if (!parent) throw badRequest(`Parent ${ref} does not exist`);
  return parent;
}

/** The ids above a task, nearest first (bounded, so a bad row cannot loop forever). */
export async function ancestorIds(db: Db | Tx, taskId: string) {
  const ids: string[] = [];
  let id: string | null = taskId;
  while (id && ids.length <= MAX_TASK_DEPTH) {
    const [row]: { parentId: string | null }[] = await db.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, id));
    id = row?.parentId ?? null;
    if (id) ids.push(id);
  }
  return ids;
}

export type TaskInput = z.output<typeof taskCreateBody> & { key?: string };

/**
 * Creates tasks in order in one transaction. Agents' tasks are proposals assigned
 * to themselves or nobody. An item's `parent` may be the `key` of an earlier item.
 */
export async function createTasks(db: Db, actor: Actor, project: Project, role: ProjectRole, items: TaskInput[]) {
  const human = actor.kind === "human";
  const label = (i: number) => (items.length > 1 ? `Task ${i + 1}${items[i]!.key ? ` (${items[i]!.key})` : ""}: ` : "");
  const keys = new Set<string>();
  for (const [i, item] of items.entries()) {
    if (item.key) {
      if (keys.has(item.key)) throw badRequest(`${label(i)}the key "${item.key}" is used twice`);
      keys.add(item.key);
    }
    if (human) {
      await assertAssignable(db, project.id, actor, role, item.assigneeId);
      continue;
    }
    if (item.status && item.status !== "proposed") throw forbidden(`${label(i)}agents can only propose tasks; a human accepts them`);
    if (item.assigneeId && item.assigneeId !== actor.id) throw forbidden(`${label(i)}agents can only assign their proposals to themselves`);
  }
  return db.transaction(async (tx) => {
    const byKey = new Map<string, { id: string; depth: number }>();
    const created: Task[] = [];
    for (const [i, item] of items.entries()) {
      let parentId: string | null = null;
      let depth = 1;
      if (item.parent) {
        const local = byKey.get(item.parent);
        if (local) {
          parentId = local.id;
          depth = local.depth + 1;
        } else {
          if (keys.has(item.parent)) throw badRequest(`${label(i)}the parent "${item.parent}" must come before its sub-tasks`);
          const parent = await findParent(tx, project, item.parent);
          parentId = parent.id;
          depth = (await ancestorIds(tx, parent.id)).length + 2;
        }
        if (depth > MAX_TASK_DEPTH) throw badRequest(`${label(i)}sub-tasks can be nested at most ${MAX_TASK_DEPTH} levels deep`);
      }
      const status = item.status ?? (human ? "todo" : "proposed");
      const task = await insertTask(tx, project.id, actor, { ...item, status, parentId });
      if (item.key) byKey.set(item.key, { id: task.id, depth });
      created.push(task);
    }
    return created;
  });
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
