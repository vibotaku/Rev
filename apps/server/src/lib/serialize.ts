// Row -> DTO conversion. List serializers batch their lookups to avoid N+1 queries.
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  frameTimes,
  reviewRef,
  taskRef,
  type ReviewAssetInfo,
  type ReviewCommentInfo,
  type ReviewInfo,
  type TaskInfo,
  type UserDetail,
  type UserSummary,
} from "@rev/shared";
import type { Db } from "../db";
import { closureReviewOf } from "./tasks";
import { projects, reviewAssets, reviewComments, reviewRounds, reviews, tasks, users } from "../db/schema";

type UserRow = typeof users.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;
type AssetRow = typeof reviewAssets.$inferSelect;
type CommentRow = typeof reviewComments.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const unique = <T>(xs: (T | null | undefined)[]) => [...new Set(xs.filter((x): x is T => x != null))];

export function userSummary(u: UserRow): UserSummary {
  return { id: u.id, name: u.name, kind: u.kind, email: u.email, ownerId: u.ownerId };
}

export function userDetail(u: UserRow): UserDetail {
  return {
    ...userSummary(u),
    role: u.role,
    disabled: !!u.disabledAt,
    disabledReason: u.disabledAt ? (u.disabledReason ?? "admin") : null,
    authSource: u.authSource,
    username: u.username,
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: u.createdAt.toISOString(),
  };
}

const unknownUser = (id: string): UserSummary => ({ id, name: "Unknown", kind: "human", email: null, ownerId: null });

export async function loadUsers(db: Db, ids: (string | null | undefined)[]) {
  const list = unique(ids);
  const map = new Map<string, UserSummary>();
  if (!list.length) return map;
  const rows = await db.select().from(users).where(inArray(users.id, list));
  for (const r of rows) map.set(r.id, userSummary(r));
  return map;
}

async function projectKeys(db: Db, ids: string[]) {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const rows = await db.select({ id: projects.id, key: projects.key }).from(projects).where(inArray(projects.id, ids));
  for (const r of rows) map.set(r.id, r.key);
  return map;
}

export async function serializeTasks(db: Db, rows: TaskRow[]): Promise<TaskInfo[]> {
  if (!rows.length) return [];
  const [userMap, keys] = await Promise.all([
    loadUsers(db, rows.flatMap((t) => [t.assigneeId, t.createdBy, t.closedBy, t.humanReviewedBy])),
    projectKeys(db, unique(rows.map((t) => t.projectId))),
  ]);
  const reviewIds = unique(rows.map((t) => t.sourceReviewId));
  const sourceReviews = new Map<string, { id: string; ref: string; title: string }>();
  if (reviewIds.length) {
    const rs = await db
      .select({ id: reviews.id, number: reviews.number, title: reviews.title, key: projects.key })
      .from(reviews)
      .innerJoin(projects, eq(projects.id, reviews.projectId))
      .where(inArray(reviews.id, reviewIds));
    for (const r of rs) sourceReviews.set(r.id, { id: r.id, ref: reviewRef(r.key, r.number), title: r.title });
  }
  return rows.map((t) => {
    const key = keys.get(t.projectId) ?? "?";
    return {
      id: t.id,
      ref: taskRef(key, t.number),
      projectKey: key,
      number: t.number,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      position: t.position,
      assignee: t.assigneeId ? (userMap.get(t.assigneeId) ?? unknownUser(t.assigneeId)) : null,
      createdBy: userMap.get(t.createdBy) ?? unknownUser(t.createdBy),
      sourceReview: t.sourceReviewId ? (sourceReviews.get(t.sourceReviewId) ?? null) : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      closure:
        t.closedAt && closureReviewOf(t)
          ? {
              by: t.closedBy ? (userMap.get(t.closedBy) ?? unknownUser(t.closedBy)) : unknownUser(""),
              at: t.closedAt.toISOString(),
              review: closureReviewOf(t)!,
              reviewedBy: t.humanReviewedBy ? (userMap.get(t.humanReviewedBy) ?? unknownUser(t.humanReviewedBy)) : null,
              reviewedAt: iso(t.humanReviewedAt),
            }
          : null,
    };
  });
}

/** roundId -> round number, for the given round ids. */
export async function roundNumbers(db: Db, roundIds: (string | null | undefined)[]) {
  const ids = unique(roundIds);
  const map = new Map<string, number>();
  if (!ids.length) return map;
  const rows = await db.select({ id: reviewRounds.id, number: reviewRounds.number }).from(reviewRounds).where(inArray(reviewRounds.id, ids));
  for (const r of rows) map.set(r.id, r.number);
  return map;
}

export function serializeAsset(a: AssetRow, roundNumber: number): ReviewAssetInfo {
  return {
    id: a.id,
    roundId: a.roundId,
    roundNumber,
    kind: a.kind,
    status: a.status,
    filename: a.filename,
    mime: a.playbackKey ? "video/mp4" : a.mime,
    size: a.size,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    caption: a.caption,
    position: a.position,
    error: a.error,
    url: `/api/media/assets/${a.id}`,
    posterUrl: a.posterKey ? `/api/media/assets/${a.id}/poster` : null,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function serializeReviews(db: Db, rows: ReviewRow[]): Promise<ReviewInfo[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [userMap, keys, assetStats, commentStats, linkedTasks, roundStats] = await Promise.all([
    loadUsers(db, rows.flatMap((r) => [r.createdBy, r.ownerId])),
    projectKeys(db, unique(rows.map((r) => r.projectId))),
    db
      .select({
        reviewId: reviewAssets.reviewId,
        n: count(),
        firstPoster: sql<string | null>`(array_agg(${reviewAssets.id} order by ${reviewAssets.position}) filter (where ${reviewAssets.posterKey} is not null))[1]`,
      })
      .from(reviewAssets)
      .where(inArray(reviewAssets.reviewId, ids))
      .groupBy(reviewAssets.reviewId),
    db
      .select({
        reviewId: reviewComments.reviewId,
        n: count(),
        open: sql<number>`count(*) filter (where ${reviewComments.status} = 'open' and ${reviewComments.parentId} is null)`,
      })
      .from(reviewComments)
      .where(inArray(reviewComments.reviewId, ids))
      .groupBy(reviewComments.reviewId),
    (async () => {
      const taskIds = unique(rows.map((r) => r.taskId));
      if (!taskIds.length) return [];
      return db
        .select({
          id: tasks.id,
          number: tasks.number,
          title: tasks.title,
          status: tasks.status,
          humanReviewedBy: tasks.humanReviewedBy,
          key: projects.key,
        })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(inArray(tasks.id, taskIds));
    })(),
    db
      .select({ reviewId: reviewRounds.reviewId, current: sql<number | null>`max(${reviewRounds.number}) filter (where ${reviewRounds.submittedAt} is not null)` })
      .from(reviewRounds)
      .where(inArray(reviewRounds.reviewId, ids))
      .groupBy(reviewRounds.reviewId),
  ]);
  const currentRoundBy = new Map(roundStats.map((s) => [s.reviewId, Number(s.current ?? 1)]));
  const assetsBy = new Map(assetStats.map((s) => [s.reviewId, s]));
  const commentsBy = new Map(commentStats.map((s) => [s.reviewId, s]));
  const taskBy = new Map(linkedTasks.map((t) => [t.id, t]));
  return rows.map((r) => {
    const key = keys.get(r.projectId) ?? "?";
    const a = assetsBy.get(r.id);
    const c = commentsBy.get(r.id);
    const t = r.taskId ? taskBy.get(r.taskId) : undefined;
    return {
      id: r.id,
      ref: reviewRef(key, r.number),
      projectKey: key,
      number: r.number,
      title: r.title,
      description: r.description,
      status: r.status,
      createdBy: userMap.get(r.createdBy) ?? unknownUser(r.createdBy),
      owner: userMap.get(r.ownerId) ?? unknownUser(r.ownerId),
      task: t
        ? { id: t.id, ref: taskRef(t.key, t.number), title: t.title, status: t.status, closureReview: closureReviewOf(t) }
        : null,
      assetCount: Number(a?.n ?? 0),
      commentCount: Number(c?.n ?? 0),
      openCommentCount: Number(c?.open ?? 0),
      currentRound: currentRoundBy.get(r.id) ?? 1,
      thumbnailUrl: a?.firstPoster ? `/api/media/assets/${a.firstPoster}/poster` : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      publishedAt: iso(r.publishedAt),
    };
  });
}

export async function serializeComments(db: Db, rows: CommentRow[]): Promise<ReviewCommentInfo[]> {
  if (!rows.length) return [];
  const reviewIds = unique(rows.map((c) => c.reviewId));
  const taskIds = unique(rows.map((c) => c.taskId));
  const assetIds = unique(rows.map((c) => (c.timestampMs != null ? c.assetId : null)));
  const [userMap, reviewRows, taskRows, rounds, videoRows] = await Promise.all([
    loadUsers(db, rows.flatMap((c) => [c.authorId, c.decidedBy])),
    db
      .select({ id: reviews.id, number: reviews.number, key: projects.key })
      .from(reviews)
      .innerJoin(projects, eq(projects.id, reviews.projectId))
      .where(inArray(reviews.id, reviewIds)),
    taskIds.length
      ? db
          .select({
            id: tasks.id,
            number: tasks.number,
            status: tasks.status,
            humanReviewedBy: tasks.humanReviewedBy,
            key: projects.key,
          })
          .from(tasks)
          .innerJoin(projects, eq(projects.id, tasks.projectId))
          .where(inArray(tasks.id, taskIds))
      : Promise.resolve([]),
    roundNumbers(db, rows.map((c) => c.roundId)),
    assetIds.length
      ? db
          .select({ id: reviewAssets.id, durationMs: reviewAssets.durationMs })
          .from(reviewAssets)
          .where(and(inArray(reviewAssets.id, assetIds), eq(reviewAssets.kind, "video")))
      : Promise.resolve([]),
  ]);
  const videos = new Map(videoRows.map((a) => [a.id, a]));
  const refBy = new Map(reviewRows.map((r) => [r.id, reviewRef(r.key, r.number)]));
  const taskBy = new Map(
    taskRows.map((t) => [t.id, { id: t.id, ref: taskRef(t.key, t.number), status: t.status, closureReview: closureReviewOf(t) }]),
  );
  return rows.map((c) => ({
    id: c.id,
    reviewId: c.reviewId,
    reviewRef: refBy.get(c.reviewId) ?? "?",
    roundNumber: rounds.get(c.roundId) ?? 1,
    assetId: c.assetId,
    parentId: c.parentId,
    markOf: c.markOf,
    markIndex: c.markIndex,
    author: userMap.get(c.authorId) ?? unknownUser(c.authorId),
    body: c.body,
    timestampMs: c.timestampMs,
    annotation: c.annotation ?? null,
    snapshotUrl: c.snapshotKey ? `/api/media/snapshots/${c.id}` : null,
    // A mark shares its overall comment's moment, so both point at the same sheet.
    frames:
      c.assetId && c.timestampMs != null && videos.has(c.assetId)
        ? { url: `/api/media/frames/${c.markOf ?? c.id}`, ...frameTimes(c.timestampMs, videos.get(c.assetId)!.durationMs) }
        : null,
    status: c.status,
    decidedBy: c.decidedBy ? (userMap.get(c.decidedBy) ?? unknownUser(c.decidedBy)) : null,
    decidedAt: iso(c.decidedAt),
    task: c.taskId ? (taskBy.get(c.taskId) ?? null) : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));
}

export async function reviewAssetsOf(db: Db, reviewId: string) {
  return db.select().from(reviewAssets).where(eq(reviewAssets.reviewId, reviewId)).orderBy(asc(reviewAssets.position), asc(reviewAssets.createdAt));
}
