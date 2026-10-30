// Review rounds: round 1 is the original kit; later rounds carry fixes for the
// accepted feedback. A round is a draft (only its author and the people who
// can edit/decide see it) until it is submitted.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db";
import { reviewRounds, reviewRoundTasks, reviews, taskActivity, tasks } from "../db/schema";
import type { reviewPerms } from "./access";
import type { Actor } from "./auth";
import { notFound } from "./errors";

type Round = typeof reviewRounds.$inferSelect;
type Review = typeof reviews.$inferSelect;
type Perms = ReturnType<typeof reviewPerms>;

export function roundsOf(db: Db | Tx, reviewId: string) {
  return db.select().from(reviewRounds).where(eq(reviewRounds.reviewId, reviewId)).orderBy(asc(reviewRounds.number));
}

/** A draft round belongs to its author; besides them only the review's deciders (humans) may change it. */
export function mayChangeRound(round: Round, actor: Actor, perms: Perms) {
  return round.createdBy === actor.id || perms.decide;
}

export function roundVisible(round: Round, actor: Actor, perms: Perms) {
  return !!round.submittedAt || round.createdBy === actor.id || perms.edit || perms.decide;
}

export async function loadRound(db: Db, reviewId: string, number: number, actor: Actor, perms: Perms) {
  const [round] = await db
    .select()
    .from(reviewRounds)
    .where(and(eq(reviewRounds.reviewId, reviewId), eq(reviewRounds.number, number)));
  if (!round || !roundVisible(round, actor, perms)) throw notFound("Round");
  return round;
}

/** Throws 404 when the asset/comment belongs to a draft round the actor may not see. */
export async function assertRoundVisible(db: Db, roundId: string, actor: Actor, perms: Perms) {
  const [round] = await db.select().from(reviewRounds).where(eq(reviewRounds.id, roundId));
  if (!round || !roundVisible(round, actor, perms)) throw notFound("Asset");
}

/** Open tasks from this review assigned to the actor: an agent working on them may submit the next round. */
export function openTasksFromReview(db: Db, reviewId: string, assigneeId?: string) {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.sourceReviewId, reviewId),
        inArray(tasks.status, ["todo", "in_progress", "in_review"]),
        assigneeId ? eq(tasks.assigneeId, assigneeId) : undefined,
      ),
    );
}

export async function canAddRound(db: Db, actor: Actor, review: Review, perms: Perms) {
  if (review.status === "draft" || !perms.comment) return false;
  if (perms.edit) return true;
  return actor.kind === "agent" && (await openTasksFromReview(db, review.id, actor.id)).length > 0;
}

/**
 * Submitting a round reopens the review for the owner and moves the tasks it
 * addresses into review, recording which round delivered them.
 */
export async function onRoundSubmitted(tx: Tx, actor: Actor, review: Review, round: Round) {
  const now = new Date();
  await tx.update(reviewRounds).set({ submittedAt: now }).where(eq(reviewRounds.id, round.id));
  await tx
    .update(reviews)
    .set({ status: "open", updatedAt: now, ...(review.publishedAt ? {} : { publishedAt: now }) })
    .where(eq(reviews.id, review.id));
  const links = await tx.select({ taskId: reviewRoundTasks.taskId }).from(reviewRoundTasks).where(eq(reviewRoundTasks.roundId, round.id));
  if (!links.length) return;
  const linked = await tx.select().from(tasks).where(inArray(tasks.id, links.map((l) => l.taskId)));
  for (const task of linked) {
    await tx
      .insert(taskActivity)
      .values({ taskId: task.id, actorId: actor.id, kind: "review", data: { reviewId: review.id, round: round.number } });
    if (task.status === "todo" || task.status === "in_progress") {
      await tx.update(tasks).set({ status: "in_review", updatedAt: now }).where(eq(tasks.id, task.id));
      await tx.insert(taskActivity).values({
        taskId: task.id,
        actorId: actor.id,
        kind: "status",
        data: { from: task.status, to: "in_review", byKind: actor.kind },
      });
    }
  }
}
