import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { projects, reviews, tasks } from "../db/schema";
import { loadProjectById, reviewPerms } from "./access";
import type { Actor } from "./auth";
import { notFound } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_REF = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/;
const REVIEW_REF = /^([A-Za-z][A-Za-z0-9]{1,9})-R(\d+)$/i;

/** Resolves a task by id or "KEY-12", hiding tasks in projects the actor cannot see. */
export async function resolveTask(db: Db, actor: Actor, ref: string) {
  let task: typeof tasks.$inferSelect | undefined;
  if (UUID.test(ref)) {
    [task] = await db.select().from(tasks).where(eq(tasks.id, ref));
  } else {
    const m = TASK_REF.exec(ref);
    if (m) {
      const [row] = await db
        .select({ task: tasks })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(eq(projects.key, m[1]!.toUpperCase()), eq(tasks.number, Number(m[2]))));
      task = row?.task;
    }
  }
  if (!task) throw notFound("Task");
  const { project, role } = await loadProjectById(db, actor, task.projectId).catch(() => {
    throw notFound("Task");
  });
  return { task, project, role };
}

/** Resolves a review by id or "KEY-R3"; drafts are only visible to the people involved. */
export async function resolveReview(db: Db, actor: Actor, ref: string) {
  let review: typeof reviews.$inferSelect | undefined;
  if (UUID.test(ref)) {
    [review] = await db.select().from(reviews).where(eq(reviews.id, ref));
  } else {
    const m = REVIEW_REF.exec(ref);
    if (m) {
      const [row] = await db
        .select({ review: reviews })
        .from(reviews)
        .innerJoin(projects, eq(projects.id, reviews.projectId))
        .where(and(eq(projects.key, m[1]!.toUpperCase()), eq(reviews.number, Number(m[2]))));
      review = row?.review;
    }
  }
  if (!review) throw notFound("Review");
  const { project, role } = await loadProjectById(db, actor, review.projectId).catch(() => {
    throw notFound("Review");
  });
  const perms = reviewPerms(actor, role, review);
  if (!perms.view) throw notFound("Review");
  return { review, project, role, perms };
}
