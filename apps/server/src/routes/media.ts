import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { reviewAssets, reviewComments } from "../db/schema";
import { requireActor } from "../lib/auth";
import { notFound } from "../lib/errors";
import { resolveReview } from "../lib/refs";
import { assertRoundVisible } from "../lib/rounds";

/** Media is served only to people who can see the review; Range requests are supported for video seeking. */
export default async function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  function send(reply: FastifyReply, key: string, downloadName?: string) {
    reply.header("cache-control", "private, max-age=86400");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    if (downloadName) {
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    }
    return reply.sendFile(key, ctx.storage.root, { cacheControl: false });
  }

  async function loadAsset(req: Parameters<typeof requireActor>[0], id: string) {
    const actor = requireActor(req);
    const [asset] = await ctx.db.select().from(reviewAssets).where(eq(reviewAssets.id, id));
    if (!asset) throw notFound("Asset");
    const { perms } = await resolveReview(ctx.db, actor, asset.reviewId);
    await assertRoundVisible(ctx.db, asset.roundId, actor, perms);
    return asset;
  }

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/media/assets/:id", async (req, reply) => {
    const asset = await loadAsset(req, req.params.id);
    if (req.query.download === "1") return send(reply, asset.storageKey, asset.filename);
    return send(reply, asset.playbackKey ?? asset.storageKey);
  });

  app.get<{ Params: { id: string } }>("/api/media/assets/:id/poster", async (req, reply) => {
    const asset = await loadAsset(req, req.params.id);
    if (!asset.posterKey) throw notFound("Poster");
    return send(reply, asset.posterKey);
  });

  app.get<{ Params: { id: string } }>("/api/media/snapshots/:id", async (req, reply) => {
    const actor = requireActor(req);
    const [comment] = await ctx.db.select().from(reviewComments).where(eq(reviewComments.id, req.params.id));
    if (!comment?.snapshotKey) throw notFound("Snapshot");
    const { perms } = await resolveReview(ctx.db, actor, comment.reviewId);
    await assertRoundVisible(ctx.db, comment.roundId, actor, perms);
    return send(reply, comment.snapshotKey);
  });

  /** Frames around a video comment's moment, rendered on first request (see `frameTimes`). */
  app.get<{ Params: { id: string } }>("/api/media/frames/:id", async (req, reply) => {
    const actor = requireActor(req);
    const [comment] = await ctx.db.select().from(reviewComments).where(eq(reviewComments.id, req.params.id));
    if (!comment?.assetId || comment.timestampMs == null) throw notFound("Frames");
    const { perms } = await resolveReview(ctx.db, actor, comment.reviewId);
    await assertRoundVisible(ctx.db, comment.roundId, actor, perms);
    const [asset] = await ctx.db.select().from(reviewAssets).where(eq(reviewAssets.id, comment.assetId));
    if (asset?.kind !== "video" || asset.status !== "ready") throw notFound("Frames");
    const key = await ctx.processor.frameSheet(asset, comment.timestampMs);
    if (!key) throw notFound("Frames");
    return send(reply, key);
  });
}
