import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, max, ne, or, type SQL } from "drizzle-orm";
import {
  ACCEPTED_MEDIA,
  assetUpdateBody,
  formatTimestamp,
  MEDIA_EXTENSIONS,
  REVIEW_STATUSES,
  reviewCommentCreateBody,
  reviewCommentUpdateBody,
  reviewCreateBody,
  reviewRef,
  reviewUpdateBody,
  taskFromReviewBody,
  taskRef,
  type ReviewDetail,
  type ReviewStatus,
} from "@rev/shared";
import type { AppContext } from "../context";
import type { Tx } from "../db";
import { projectMembers, projects, reviewAssets, reviewComments, reviewRounds, reviewRoundTasks, reviews, taskActivity, tasks, users } from "../db/schema";
import { assertAssignable, assertCan, assignableUserIds, isWriter, loadProject, projectPerms, reviewPerms } from "../lib/access";
import { requireActor, type Actor } from "../lib/auth";
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from "../lib/errors";
import { resolveReview, resolveTask } from "../lib/refs";
import { canAddRound, mayChangeRound, roundsOf, roundVisible } from "../lib/rounds";
import { serializeAsset, serializeComments, serializeReviews, reviewAssetsOf, loadUsers, roundNumbers } from "../lib/serialize";
import { closureReviewOf, insertTask, nextNumber } from "../lib/tasks";
import { taskDetail } from "./tasks";

const SNAPSHOT_MAX_BYTES = 15 * 1024 * 1024;

export async function reviewDetail(ctx: AppContext, actor: Actor, ref: string): Promise<ReviewDetail> {
  const { review, project, role, perms } = await resolveReview(ctx.db, actor, ref);
  const [[info], allAssets, allComments, taskRows, assignable, allRounds, addRound] = await Promise.all([
    serializeReviews(ctx.db, [review]),
    reviewAssetsOf(ctx.db, review.id),
    ctx.db.select().from(reviewComments).where(eq(reviewComments.reviewId, review.id)).orderBy(asc(reviewComments.createdAt)),
    ctx.db.select().from(tasks).where(eq(tasks.sourceReviewId, review.id)).orderBy(asc(tasks.number)),
    perms.decide ? assignableUserIds(ctx.db, project.id, actor, role) : Promise.resolve([]),
    roundsOf(ctx.db, review.id),
    canAddRound(ctx.db, actor, review, perms),
  ]);
  // Draft rounds are hidden from people who are not putting them together.
  const rounds = allRounds.filter((r) => roundVisible(r, actor, perms));
  const visible = new Set(rounds.map((r) => r.id));
  const assets = allAssets.filter((a) => visible.has(a.roundId));
  const commentRows = allComments.filter((c) => visible.has(c.roundId));
  const roundNumber = new Map(rounds.map((r) => [r.id, r.number]));
  const addressed = rounds.length
    ? await ctx.db
        .select({ roundId: reviewRoundTasks.roundId, task: tasks, key: projects.key })
        .from(reviewRoundTasks)
        .innerJoin(tasks, eq(tasks.id, reviewRoundTasks.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(inArray(reviewRoundTasks.roundId, rounds.map((r) => r.id)))
    : [];
  const people = await loadUsers(ctx.db, [...taskRows.map((t) => t.assigneeId), ...rounds.map((r) => r.createdBy)]);
  return {
    ...info!,
    rounds: rounds.map((r) => ({
      id: r.id,
      number: r.number,
      notes: r.notes,
      createdBy: people.get(r.createdBy)!,
      createdAt: r.createdAt.toISOString(),
      submittedAt: r.submittedAt?.toISOString() ?? null,
      addressedTasks: addressed
        .filter((a) => a.roundId === r.id)
        .map(({ task: t, key }) => ({ id: t.id, ref: taskRef(key, t.number), title: t.title, status: t.status, closureReview: closureReviewOf(t) })),
      assetCount: assets.filter((a) => a.roundId === r.id).length,
    })),
    assets: assets.map((a) => serializeAsset(a, roundNumber.get(a.roundId) ?? 1)),
    comments: await serializeComments(ctx.db, commentRows),
    tasks: taskRows.map((t) => ({
      id: t.id,
      ref: taskRef(project.key, t.number),
      title: t.title,
      status: t.status,
      closureReview: closureReviewOf(t),
      assignee: t.assigneeId ? (people.get(t.assigneeId) ?? null) : null,
    })),
    can: { ...perms, addRound, assignableUserIds: assignable },
  };
}

/** Allowed review status transitions and who may make them. */
function assertTransition(
  perms: ReturnType<typeof reviewPerms>,
  actor: Actor,
  review: typeof reviews.$inferSelect,
  to: ReviewStatus,
) {
  const from = review.status;
  if (from === to) return;
  if (to === "draft") throw badRequest("A published review cannot return to draft");
  if (from === "draft") {
    if (to !== "open") throw badRequest("Publish the review before deciding on it");
    assertCan(perms.publish, "You cannot publish this review");
    return;
  }
  if (to === "closed" && review.createdBy === actor.id) return; // submitters may withdraw
  assertCan(perms.decide, "Only the review owner or a project owner can change the review status");
}

async function onPublished(tx: Tx, actor: Actor, review: typeof reviews.$inferSelect) {
  if (!review.taskId) return;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, review.taskId));
  if (!task) return;
  await tx.insert(taskActivity).values({ taskId: task.id, actorId: actor.id, kind: "review", data: { reviewId: review.id } });
  // Submitting work for a task moves it into review.
  if (task.status === "todo" || task.status === "in_progress") {
    await tx.update(tasks).set({ status: "in_review", updatedAt: new Date() }).where(eq(tasks.id, task.id));
    await tx
      .insert(taskActivity)
      .values({ taskId: task.id, actorId: actor.id, kind: "status", data: { from: task.status, to: "in_review" } });
  }
}

function composeTaskDescription(
  reviewRefStr: string,
  reviewTitle: string,
  comments: (typeof reviewComments.$inferSelect)[],
  assetNames: Map<string, string>,
) {
  const lines = [`From review **${reviewRefStr}** — ${reviewTitle}`, ""];
  for (const c of comments) {
    const where = [c.assetId ? assetNames.get(c.assetId) : null, c.timestampMs != null ? `@ ${formatTimestamp(c.timestampMs)}` : null]
      .filter(Boolean)
      .join(" ");
    const mark = c.markIndex != null ? `mark #${c.markIndex}: ` : "";
    lines.push(`- ${where ? `*${where}*: ` : ""}${mark}${c.body.replace(/\n+/g, " ")}`);
  }
  return lines.join("\n");
}

export default async function reviewRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { key: string }; Querystring: { status?: string } }>("/api/projects/:key/reviews", async (req) => {
    const actor = requireActor(req);
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    const conds: SQL[] = [eq(reviews.projectId, project.id)];
    if (req.query.status) {
      const list = req.query.status.split(",") as ReviewStatus[];
      for (const s of list) if (!REVIEW_STATUSES.includes(s)) throw badRequest(`Unknown status: ${s}`);
      conds.push(inArray(reviews.status, list));
    }
    if (!(actor.kind === "human" && role === "owner")) {
      conds.push(or(ne(reviews.status, "draft"), eq(reviews.createdBy, actor.id), eq(reviews.ownerId, actor.id))!);
    }
    const rows = await ctx.db.select().from(reviews).where(and(...conds)).orderBy(desc(reviews.createdAt));
    return serializeReviews(ctx.db, rows);
  });

  app.post<{ Params: { key: string } }>("/api/projects/:key/reviews", async (req) => {
    const actor = requireActor(req);
    const { project, role } = await loadProject(ctx.db, actor, req.params.key);
    assertCan(projectPerms(actor, role, project).createReview, "You cannot create reviews in this project");
    const body = parse(reviewCreateBody, req.body);

    let taskId: string | null = null;
    if (body.taskRef) {
      const { task } = await resolveTask(ctx.db, actor, body.taskRef);
      if (task.projectId !== project.id) throw badRequest("The task belongs to a different project");
      if (actor.kind === "agent" && task.assigneeId !== actor.id) {
        throw forbidden("Agents can only submit reviews for tasks assigned to them");
      }
      taskId = task.id;
    }
    // A review submitted by an agent is owned by the human the agent is linked to.
    const ownerId = actor.kind === "agent" ? actor.ownerId! : actor.id;

    const review = await ctx.db.transaction(async (tx) => {
      const number = await nextNumber(tx, project.id, "review");
      const now = new Date();
      const [r] = await tx
        .insert(reviews)
        .values({
          projectId: project.id,
          number,
          title: body.title,
          description: body.description,
          status: body.publish ? "open" : "draft",
          createdBy: actor.id,
          ownerId,
          taskId,
          publishedAt: body.publish ? now : null,
        })
        .returning();
      await tx.insert(reviewRounds).values({ reviewId: r!.id, number: 1, createdBy: actor.id, submittedAt: body.publish ? now : null });
      if (body.publish) await onPublished(tx, actor, r!);
      return r!;
    });
    return reviewDetail(ctx, actor, review.id);
  });

  app.get<{ Params: { ref: string } }>("/api/reviews/:ref", async (req) => reviewDetail(ctx, requireActor(req), req.params.ref));

  app.patch<{ Params: { ref: string } }>("/api/reviews/:ref", async (req) => {
    const actor = requireActor(req);
    const { review, project, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    const body = parse(reviewUpdateBody, req.body);
    if ((body.title !== undefined || body.description !== undefined) && !perms.edit) {
      throw forbidden("You cannot edit this review");
    }
    if (body.ownerId && body.ownerId !== review.ownerId) {
      assertCan(perms.decide, "Only the review owner or a project owner can hand the review over");
      const [m] = await ctx.db
        .select({ role: projectMembers.role, kind: users.kind })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, body.ownerId)));
      if (!m || m.kind !== "human" || !isWriter(m.role)) {
        throw badRequest("The review owner must be a human member of the project");
      }
    }
    if (body.status) assertTransition(perms, actor, review, body.status);

    await ctx.db.transaction(async (tx) => {
      const publishing = review.status === "draft" && body.status === "open";
      const [updated] = await tx
        .update(reviews)
        .set({ ...body, updatedAt: new Date(), ...(publishing ? { publishedAt: new Date() } : {}) })
        .where(eq(reviews.id, review.id))
        .returning();
      if (publishing) {
        await tx
          .update(reviewRounds)
          .set({ submittedAt: new Date() })
          .where(and(eq(reviewRounds.reviewId, review.id), eq(reviewRounds.number, 1)));
        await onPublished(tx, actor, updated!);
      }
    });
    return reviewDetail(ctx, actor, review.id);
  });

  app.delete<{ Params: { ref: string } }>("/api/reviews/:ref", async (req) => {
    const actor = requireActor(req);
    const { review, role } = await resolveReview(ctx.db, actor, req.params.ref);
    const mayDelete = (review.status === "draft" && review.createdBy === actor.id) || (actor.kind === "human" && role === "owner");
    assertCan(mayDelete, "Only drafts can be deleted by their author; project owners can delete any review");
    const assets = await reviewAssetsOf(ctx.db, review.id);
    await ctx.db.delete(reviews).where(eq(reviews.id, review.id));
    for (const a of assets) await ctx.storage.removePrefix(`assets/${a.id}`);
    return { ok: true };
  });

  // ---- Assets --------------------------------------------------------------

  /** Upload into a round (`?round=N`, default: the latest). Draft rounds take uploads from their author. */
  app.post<{ Params: { ref: string }; Querystring: { caption?: string; round?: string } }>("/api/reviews/:ref/assets", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    const rounds = await roundsOf(ctx.db, review.id);
    const round = req.query.round ? rounds.find((r) => r.number === Number(req.query.round)) : rounds.at(-1);
    if (!round || !roundVisible(round, actor, perms)) throw notFound("Round");
    assertCan(round.submittedAt ? perms.edit : mayChangeRound(round, actor, perms), "You cannot add media to this round");
    if (!req.isMultipart()) throw badRequest("Expected a multipart upload with a `file` field");
    const file = await req.file({ limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });
    if (!file) throw badRequest("No file uploaded");

    const ext = path.extname(file.filename).toLowerCase();
    const mime = ACCEPTED_MEDIA[file.mimetype] ? file.mimetype : MEDIA_EXTENSIONS[ext];
    const kind = mime ? ACCEPTED_MEDIA[mime] : undefined;
    if (!mime || !kind) {
      file.file.resume();
      throw badRequest(`Unsupported file type ${file.mimetype} (${ext || "no extension"}). Use PNG/JPEG/WebP/GIF images or MP4/WebM/MOV/MKV video.`);
    }
    const safeExt = Object.entries(MEDIA_EXTENSIONS).find(([, m]) => m === mime)![0];

    const id = crypto.randomUUID();
    const key = `assets/${id}/original${safeExt}`;
    await ctx.storage.writeStream(key, file.file);
    if (file.file.truncated) {
      await ctx.storage.removePrefix(`assets/${id}`);
      throw new HttpError(413, "too_large", `File exceeds the ${Math.round(ctx.config.maxUploadBytes / 1048576)} MB upload limit`);
    }
    const size = await ctx.storage.size(key);
    const [{ pos }] = (await ctx.db
      .select({ pos: max(reviewAssets.position) })
      .from(reviewAssets)
      .where(eq(reviewAssets.roundId, round.id))) as [{ pos: number | null }];
    const [asset] = await ctx.db
      .insert(reviewAssets)
      .values({
        id,
        reviewId: review.id,
        roundId: round.id,
        kind,
        filename: path.basename(file.filename).slice(0, 255) || `upload${safeExt}`,
        mime,
        size,
        storageKey: key,
        caption: (req.query.caption ?? "").slice(0, 500),
        position: (pos ?? -1) + 1,
        uploadedBy: actor.id,
      })
      .returning();
    await ctx.db.update(reviews).set({ updatedAt: new Date() }).where(eq(reviews.id, review.id));
    ctx.processor.enqueue(asset!.id);
    return serializeAsset(asset!, round.number);
  });

  /** Media in a submitted round can be changed by the review's editors; in a draft round, by the round's author or a decider. */
  async function assertAssetEditable(actor: Actor, perms: ReturnType<typeof reviewPerms>, reviewId: string, assetId: string) {
    const [row] = await ctx.db
      .select({ round: reviewRounds })
      .from(reviewAssets)
      .innerJoin(reviewRounds, eq(reviewRounds.id, reviewAssets.roundId))
      .where(and(eq(reviewAssets.id, assetId), eq(reviewAssets.reviewId, reviewId)));
    if (!row) throw notFound("Asset");
    assertCan(row.round.submittedAt ? perms.edit : mayChangeRound(row.round, actor, perms), "You cannot edit this media");
  }

  app.patch<{ Params: { ref: string; assetId: string } }>("/api/reviews/:ref/assets/:assetId", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    await assertAssetEditable(actor, perms, review.id, req.params.assetId);
    const body = parse(assetUpdateBody, req.body);
    const [asset] = await ctx.db
      .update(reviewAssets)
      .set(body)
      .where(and(eq(reviewAssets.id, req.params.assetId), eq(reviewAssets.reviewId, review.id)))
      .returning();
    if (!asset) throw notFound("Asset");
    return serializeAsset(asset, (await roundNumbers(ctx.db, [asset.roundId])).get(asset.roundId) ?? 1);
  });

  app.delete<{ Params: { ref: string; assetId: string } }>("/api/reviews/:ref/assets/:assetId", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    await assertAssetEditable(actor, perms, review.id, req.params.assetId);
    const [asset] = await ctx.db
      .delete(reviewAssets)
      .where(and(eq(reviewAssets.id, req.params.assetId), eq(reviewAssets.reviewId, review.id)))
      .returning();
    if (!asset) throw notFound("Asset");
    await ctx.storage.removePrefix(`assets/${asset.id}`);
    return { ok: true };
  });

  // ---- Comments ------------------------------------------------------------

  app.post<{ Params: { ref: string } }>("/api/reviews/:ref/comments", async (req) => {
    const actor = requireActor(req);
    const { review, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    assertCan(perms.comment, "You cannot comment on this review");
    const body = parse(reviewCommentCreateBody, req.body);
    const rounds = (await roundsOf(ctx.db, review.id)).filter((r) => roundVisible(r, actor, perms));

    let assetId = body.assetId;
    let roundId: string;
    if (body.parentId) {
      const [parent] = await ctx.db
        .select()
        .from(reviewComments)
        .where(and(eq(reviewComments.id, body.parentId), eq(reviewComments.reviewId, review.id)));
      if (!parent || !rounds.some((r) => r.id === parent.roundId)) throw badRequest("Parent comment not found in this review");
      if (parent.parentId) throw badRequest("Replies cannot be nested");
      if (body.annotation || body.timestampMs != null || body.marks.length) throw badRequest("Replies cannot carry annotations");
      assetId = parent.assetId;
      roundId = parent.roundId;
    } else if (assetId) {
      const [asset] = await ctx.db
        .select()
        .from(reviewAssets)
        .where(and(eq(reviewAssets.id, assetId), eq(reviewAssets.reviewId, review.id)));
      if (!asset || !rounds.some((r) => r.id === asset.roundId)) throw badRequest("Asset not found in this review");
      if (body.timestampMs != null && asset.kind !== "video") throw badRequest("Timestamps only apply to videos");
      roundId = asset.roundId;
    } else {
      if (body.annotation || body.timestampMs != null || body.marks.length) throw badRequest("Annotations and timestamps need an assetId");
      // General comments go on the requested round, else the latest one the commenter can see.
      const round = body.round ? rounds.find((r) => r.number === body.round) : rounds.findLast((r) => r.submittedAt) ?? rounds.at(-1);
      if (!round) throw badRequest(`Round ${body.round} not found`);
      roundId = round.id;
    }

    // Each mark (pin, box, …) may carry its own note, decided on separately from the overall comment.
    const shapes = body.annotation?.shapes ?? [];
    const seen = new Set<number>();
    for (const m of body.marks) {
      if (m.index >= shapes.length) throw badRequest(`marks: there is no mark #${m.index + 1} in the annotation`);
      if (seen.has(m.index)) throw badRequest(`marks: mark #${m.index + 1} has more than one note`);
      seen.add(m.index);
    }

    const created = await ctx.db.transaction(async (tx) => {
      const [comment] = await tx
        .insert(reviewComments)
        .values({
          reviewId: review.id,
          roundId,
          assetId,
          parentId: body.parentId,
          authorId: actor.id,
          body: body.body,
          timestampMs: body.parentId ? null : body.timestampMs,
          annotation: body.parentId ? null : body.annotation,
        })
        .returning();
      const marks = body.marks.length
        ? await tx
            .insert(reviewComments)
            .values(
              [...body.marks]
                .sort((a, b) => a.index - b.index)
                .map((m) => ({
                  reviewId: review.id,
                  roundId,
                  assetId,
                  authorId: actor.id,
                  body: m.body,
                  timestampMs: body.timestampMs,
                  annotation: { shapes: [shapes[m.index]!] },
                  markOf: comment!.id,
                  markIndex: m.index + 1,
                })),
            )
            .returning()
        : [];
      await tx.update(reviews).set({ updatedAt: new Date() }).where(eq(reviews.id, review.id));
      return [comment!, ...marks];
    });
    // The overall comment comes first, followed by its mark comments.
    const [comment, ...marks] = await serializeComments(ctx.db, created);
    return { ...comment!, marks };
  });

  async function loadComment(actor: Actor, id: string) {
    const [comment] = await ctx.db.select().from(reviewComments).where(eq(reviewComments.id, id));
    if (!comment) throw notFound("Comment");
    const resolved = await resolveReview(ctx.db, actor, comment.reviewId);
    return { comment, ...resolved };
  }

  /** Attach the rendered frame+annotation image a browser produced for its comment. */
  app.post<{ Params: { id: string } }>("/api/comments/:id/snapshot", async (req) => {
    const actor = requireActor(req);
    const { comment } = await loadComment(actor, req.params.id);
    if (comment.authorId !== actor.id) throw forbidden("Only the author can attach a snapshot");
    if (!req.isMultipart()) throw badRequest("Expected a multipart upload with a `file` field");
    const file = await req.file({ limits: { fileSize: SNAPSHOT_MAX_BYTES, files: 1 } });
    if (!file) throw badRequest("No file uploaded");
    const ext = file.mimetype === "image/png" ? ".png" : file.mimetype === "image/jpeg" ? ".jpg" : null;
    if (!ext) {
      file.file.resume();
      throw badRequest("Snapshots must be PNG or JPEG");
    }
    const key = `snapshots/${comment.id}${ext}`;
    await ctx.storage.writeStream(key, file.file);
    if (file.file.truncated) {
      await ctx.storage.removePrefix(key);
      throw new HttpError(413, "too_large", "Snapshot too large");
    }
    await ctx.db.update(reviewComments).set({ snapshotKey: key }).where(eq(reviewComments.id, comment.id));
    return { ok: true, snapshotUrl: `/api/media/snapshots/${comment.id}` };
  });

  app.patch<{ Params: { id: string } }>("/api/comments/:id", async (req) => {
    const actor = requireActor(req);
    const { comment, perms } = await loadComment(actor, req.params.id);
    const body = parse(reviewCommentUpdateBody, req.body);
    if (body.body !== undefined && comment.authorId !== actor.id) throw forbidden("Only the author can edit a comment");
    if (body.status !== undefined && body.status !== comment.status) {
      assertCan(perms.decide, "Only the review owner or a project owner can accept or reject comments");
      if (comment.parentId) throw badRequest("Replies do not have a status");
      if (comment.taskId && body.status === "rejected") throw conflict("This comment already has a task; cancel the task instead");
    }
    const deciding = body.status !== undefined && body.status !== comment.status;
    const [updated] = await ctx.db
      .update(reviewComments)
      .set({
        ...body,
        updatedAt: new Date(),
        ...(deciding ? { decidedBy: body.status === "open" ? null : actor.id, decidedAt: body.status === "open" ? null : new Date() } : {}),
      })
      .where(eq(reviewComments.id, comment.id))
      .returning();
    return (await serializeComments(ctx.db, [updated!]))[0];
  });

  app.delete<{ Params: { id: string } }>("/api/comments/:id", async (req) => {
    const actor = requireActor(req);
    const { comment, role } = await loadComment(actor, req.params.id);
    const mayDelete = comment.authorId === actor.id || (actor.kind === "human" && role === "owner");
    assertCan(mayDelete, "You cannot delete this comment");
    if (comment.taskId) throw conflict("This comment has a task; it cannot be deleted");
    // Deleting an overall comment deletes the notes on its marks too.
    const marks = await ctx.db.select().from(reviewComments).where(eq(reviewComments.markOf, comment.id));
    if (marks.some((m) => m.taskId)) throw conflict("A mark on this comment has a task; it cannot be deleted");
    await ctx.db.delete(reviewComments).where(eq(reviewComments.id, comment.id));
    for (const key of [comment.snapshotKey, ...marks.map((m) => m.snapshotKey)]) {
      if (key) await ctx.storage.removePrefix(key);
    }
    return { ok: true };
  });

  // ---- Review -> task ------------------------------------------------------

  /**
   * The review owner turns accepted comments (or the review as a whole) into a
   * task and assigns it, typically to the agent that submitted the review.
   * Open comments included here are accepted as part of the same action.
   */
  app.post<{ Params: { ref: string } }>("/api/reviews/:ref/tasks", async (req) => {
    const actor = requireActor(req);
    const { review, project, role, perms } = await resolveReview(ctx.db, actor, req.params.ref);
    assertCan(perms.decide, "Only the review owner or a project owner can create tasks from a review");
    if (review.status === "draft") throw badRequest("Publish the review first");
    const body = parse(taskFromReviewBody, req.body);
    await assertAssignable(ctx.db, project.id, actor, role, body.assigneeId);

    const comments = body.commentIds.length
      ? await ctx.db
          .select()
          .from(reviewComments)
          .where(and(eq(reviewComments.reviewId, review.id), inArray(reviewComments.id, body.commentIds)))
          .orderBy(asc(reviewComments.createdAt))
      : [];
    if (comments.length !== new Set(body.commentIds).size) throw badRequest("Some comments are not part of this review");
    for (const c of comments) {
      if (c.parentId) throw badRequest("Replies cannot be turned into tasks; use the top-level comment");
      if (c.status === "rejected") throw conflict("Rejected comments cannot be turned into tasks");
      if (c.taskId) throw conflict("A selected comment already has a task");
    }

    let description = body.description;
    if (!description.trim()) {
      const assets = await reviewAssetsOf(ctx.db, review.id);
      description = composeTaskDescription(
        reviewRef(project.key, review.number),
        review.title,
        comments,
        new Map(assets.map((a) => [a.id, a.filename])),
      );
    }

    const task = await ctx.db.transaction(async (tx) => {
      const t = await insertTask(tx, project.id, actor, {
        title: body.title,
        description,
        status: "todo",
        priority: body.priority,
        assigneeId: body.assigneeId,
        sourceReviewId: review.id,
      });
      if (comments.length) {
        await tx
          .update(reviewComments)
          .set({ taskId: t.id, status: "accepted", decidedBy: actor.id, decidedAt: new Date(), updatedAt: new Date() })
          .where(inArray(reviewComments.id, comments.map((c) => c.id)));
      }
      return t;
    });
    return taskDetail(ctx, actor, task.id);
  });
}
