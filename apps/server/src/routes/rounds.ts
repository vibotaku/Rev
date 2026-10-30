// Review rounds: after the accepted feedback is addressed, the next round is
// submitted on the same review with new media. Flow: create (draft) → upload
// media with ?round=N → submit.
import type { FastifyInstance } from "fastify";
import { count, eq } from "drizzle-orm";
import { reviewRoundCreateBody, reviewRoundUpdateBody } from "@rev/shared";
import type { AppContext } from "../context";
import { reviewAssets, reviewRounds, reviewRoundTasks, tasks } from "../db/schema";
import { assertCan } from "../lib/access";
import { requireActor } from "../lib/auth";
import { badRequest, conflict, forbidden, parse } from "../lib/errors";
import { resolveReview, resolveTask } from "../lib/refs";
import { canAddRound, loadRound, mayChangeRound, onRoundSubmitted, openTasksFromReview, roundsOf } from "../lib/rounds";
import { reviewDetail } from "./reviews";

type Params = { ref: string; number: string };

export default async function roundRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Starts the next round as a draft, recording the tasks it addresses. */
  app.post<{ Params: { ref: string } }>("/api/reviews/:ref/rounds", async (req) => {
    const actor = requireActor(req);
    const { review, project, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    if (review.status === "draft") throw badRequest("Publish the review (round 1) before starting another round");
    assertCan(
      await canAddRound(ctx.db, actor, review, perms),
      "Only the review's author or owner, or an agent working on a task from this review, can start a new round",
    );
    const body = parse(reviewRoundCreateBody, req.body);
    const last = (await roundsOf(ctx.db, review.id)).at(-1)!;
    if (!last.submittedAt) throw conflict(`Round ${last.number} is still a draft: submit or delete it first`);

    let addressed: (typeof tasks.$inferSelect)[];
    if (body.taskRefs) {
      addressed = [];
      for (const ref of body.taskRefs) {
        const { task } = await resolveTask(ctx.db, actor, ref);
        if (task.projectId !== project.id) throw badRequest(`${ref} belongs to a different project`);
        if (actor.kind === "agent" && task.assigneeId !== actor.id) throw forbidden(`Agents can only address tasks assigned to them (${ref})`);
        if (!addressed.some((t) => t.id === task.id)) addressed.push(task);
      }
    } else {
      addressed = await openTasksFromReview(ctx.db, review.id, actor.kind === "agent" ? actor.id : undefined);
    }

    await ctx.db.transaction(async (tx) => {
      const [round] = await tx
        .insert(reviewRounds)
        .values({ reviewId: review.id, number: last.number + 1, notes: body.notes, createdBy: actor.id })
        .returning();
      if (addressed.length) {
        await tx.insert(reviewRoundTasks).values(addressed.map((t) => ({ roundId: round!.id, taskId: t.id })));
      }
    });
    return reviewDetail(ctx, actor, review.id);
  });

  app.patch<{ Params: Params }>("/api/reviews/:ref/rounds/:number", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    const round = await loadRound(ctx.db, review.id, Number(req.params.number), actor, perms);
    assertCan(mayChangeRound(round, actor, perms), "Only the round's author can edit its notes");
    const body = parse(reviewRoundUpdateBody, req.body);
    await ctx.db.update(reviewRounds).set({ notes: body.notes }).where(eq(reviewRounds.id, round.id));
    return reviewDetail(ctx, actor, review.id);
  });

  /** Submits a draft round: the review reopens for the owner and the addressed tasks move to in_review. */
  app.post<{ Params: Params }>("/api/reviews/:ref/rounds/:number/submit", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    const round = await loadRound(ctx.db, review.id, Number(req.params.number), actor, perms);
    if (round.number === 1) throw badRequest("Round 1 is submitted by publishing the review");
    if (round.submittedAt) throw conflict(`Round ${round.number} was already submitted`);
    assertCan(mayChangeRound(round, actor, perms), "Only the round's author can submit it");
    const [{ n }] = (await ctx.db.select({ n: count() }).from(reviewAssets).where(eq(reviewAssets.roundId, round.id))) as [{ n: number }];
    if (Number(n) === 0) throw badRequest("Add at least one screenshot or video to the round before submitting it");
    await ctx.db.transaction((tx) => onRoundSubmitted(tx, actor, review, round));
    return reviewDetail(ctx, actor, review.id);
  });

  /** Discards a draft round and its media. */
  app.delete<{ Params: Params }>("/api/reviews/:ref/rounds/:number", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    const round = await loadRound(ctx.db, review.id, Number(req.params.number), actor, perms);
    if (round.submittedAt || round.number === 1) throw conflict("Only draft rounds can be deleted");
    assertCan(mayChangeRound(round, actor, perms), "Only the round's author can delete it");
    const assets = await ctx.db.select({ id: reviewAssets.id }).from(reviewAssets).where(eq(reviewAssets.roundId, round.id));
    await ctx.db.delete(reviewRounds).where(eq(reviewRounds.id, round.id));
    for (const a of assets) await ctx.storage.removePrefix(`assets/${a.id}`);
    return reviewDetail(ctx, actor, review.id);
  });
}
