import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { FRAME_SHEET, frameTimes } from "@rev/shared";
import type { Config } from "../config";
import type { Db } from "../db";
import { reviewAssets } from "../db/schema";
import type { Storage } from "./storage";

const run = promisify(execFile);

const PLAYABLE_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const PLAYABLE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis"]);
const PLAYABLE_CONTAINERS = new Set(["video/mp4", "video/webm"]);

interface Probe {
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  format?: { duration?: string };
}

/**
 * Probes uploads with ffprobe, renders a poster/thumbnail, and transcodes
 * videos browsers cannot play (e.g. .mov/.mkv, HEVC) to H.264 MP4.
 * Work runs one asset at a time in-process; unfinished work resumes on boot.
 */
type AssetRow = typeof reviewAssets.$inferSelect;

/** Box one frame of a sheet fits in (keeping the video's shape); the marked one gets a red border instead of a grey one. */
const SHEET_TILE = { w: 480, h: 360, border: 4 };

export class MediaProcessor {
  private queue: Promise<void> = Promise.resolve();
  private missingTools = false;
  private sheets = new Map<string, Promise<string | null>>();

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  enqueue(assetId: string) {
    this.queue = this.queue
      .then(() => this.process(assetId))
      .catch((err) => this.log.error({ err, assetId }, "media processing crashed"));
  }

  /** Resolves when everything queued so far has finished (used by tests and shutdown). */
  idle() {
    return this.queue;
  }

  async resume() {
    const pending = await this.db
      .select({ id: reviewAssets.id })
      .from(reviewAssets)
      .where(eq(reviewAssets.status, "processing"));
    for (const a of pending) this.enqueue(a.id);
  }

  private async process(assetId: string) {
    const [asset] = await this.db.select().from(reviewAssets).where(eq(reviewAssets.id, assetId));
    if (!asset || asset.status !== "processing") return;
    const input = this.storage.pathOf(asset.storageKey);
    const dir = asset.storageKey.slice(0, asset.storageKey.lastIndexOf("/"));

    if (this.missingTools) {
      await this.db.update(reviewAssets).set({ status: "ready" }).where(eq(reviewAssets.id, assetId));
      return;
    }

    try {
      const probe = await this.probe(input);
      const video = probe.streams?.find((s) => s.codec_type === "video");
      const audio = probe.streams?.find((s) => s.codec_type === "audio");
      if (!video) throw new Error("No image or video stream found in upload");
      const durationSec = Number(probe.format?.duration);
      const isVideo = asset.kind === "video";
      const update: Partial<typeof reviewAssets.$inferInsert> = {
        width: video.width ?? null,
        height: video.height ?? null,
        durationMs: isVideo && Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
      };

      const posterKey = `${dir}/poster.jpg`;
      const seek = isVideo && Number.isFinite(durationSec) ? Math.min(1, durationSec / 2) : 0;
      await this.ffmpeg([
        ...(seek ? ["-ss", seek.toFixed(2)] : []),
        "-i", input,
        "-frames:v", "1",
        "-vf", "scale='min(640,iw)':-2",
        "-q:v", "4",
        this.storage.pathOf(posterKey),
      ]);
      update.posterKey = posterKey;

      if (isVideo) {
        const playable =
          PLAYABLE_CONTAINERS.has(asset.mime) &&
          PLAYABLE_VIDEO.has(video.codec_name ?? "") &&
          (!audio || PLAYABLE_AUDIO.has(audio.codec_name ?? ""));
        if (!playable) {
          const playbackKey = `${dir}/playback.mp4`;
          await this.ffmpeg(
            [
              "-i", input,
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
              "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
              "-c:a", "aac", "-b:a", "128k",
              "-movflags", "+faststart",
              this.storage.pathOf(playbackKey),
            ],
            60 * 60_000,
          );
          update.playbackKey = playbackKey;
        }
      }

      await this.db
        .update(reviewAssets)
        .set({ ...update, status: "ready", error: null })
        .where(eq(reviewAssets.id, assetId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.missingTools = true;
        this.log.warn("ffmpeg/ffprobe not found: uploads are served as-is without posters or transcoding");
        await this.db.update(reviewAssets).set({ status: "ready" }).where(eq(reviewAssets.id, assetId));
        return;
      }
      this.log.warn({ err, assetId }, "media processing failed");
      await this.db
        .update(reviewAssets)
        .set({ status: "failed", error: String((err as Error).message ?? err).slice(0, 500) })
        .where(eq(reviewAssets.id, assetId));
      await rm(this.storage.pathOf(`${dir}/playback.mp4`), { force: true });
    }
  }

  /**
   * The storage key of a 3×3 sheet of frames around `atMs` in a video (see `frameTimes`),
   * rendered on first use and cached next to the asset. Null when ffmpeg is unavailable.
   */
  frameSheet(asset: AssetRow, atMs: number): Promise<string | null> {
    const key = `assets/${asset.id}/frames-${Math.round(atMs)}.jpg`;
    let pending = this.sheets.get(key);
    if (!pending) {
      pending = this.renderSheet(asset, atMs, key).finally(() => this.sheets.delete(key));
      this.sheets.set(key, pending);
    }
    return pending;
  }

  private async renderSheet(asset: AssetRow, atMs: number, key: string) {
    const out = this.storage.pathOf(key);
    if (await access(out).then(() => true, () => false)) return key;
    if (this.missingTools) return null;
    const input = this.storage.pathOf(asset.playbackKey ?? asset.storageKey);
    const { timesMs, markedIndex } = frameTimes(atMs, asset.durationMs);
    const { w, h, border } = SHEET_TILE;
    // Every input is the same video, so the tiles come out the same size.
    const tiles = timesMs.map(
      (_, i) =>
        `[${i}:v]scale=${w - 2 * border}:${h - 2 * border}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,` +
        `pad=iw+${2 * border}:ih+${2 * border}:${border}:${border}:color=${i === markedIndex ? "0xef4444" : "0x3f3f46"},setsar=1[t${i}]`,
    );
    const rows = Array.from({ length: FRAME_SHEET.rows }, (_, r) => {
      const ids = Array.from({ length: FRAME_SHEET.cols }, (_, c) => `[t${r * FRAME_SHEET.cols + c}]`).join("");
      return `${ids}hstack=${FRAME_SHEET.cols}[r${r}]`;
    });
    const stack = `${rows.map((_, r) => `[r${r}]`).join("")}vstack=${FRAME_SHEET.rows}[sheet]`;
    const tmp = this.storage.tempPath(".jpg");
    try {
      await this.ffmpeg(
        [
          ...timesMs.flatMap((t) => ["-ss", (t / 1000).toFixed(3), "-i", input]),
          "-filter_complex", [...tiles, ...rows, stack].join(";"),
          "-map", "[sheet]",
          "-frames:v", "1",
          "-q:v", "4",
          tmp,
        ],
        60_000,
      );
      await this.storage.moveIn(tmp, key);
      return key;
    } catch (err) {
      await rm(tmp, { force: true });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.missingTools = true;
        return null;
      }
      throw err;
    }
  }

  private async probe(file: string): Promise<Probe> {
    const { stdout } = await run(
      this.config.ffprobePath,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as Probe;
  }

  private async ffmpeg(args: string[], timeout = 120_000) {
    await run(this.config.ffmpegPath, ["-y", "-v", "error", ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });
  }
}
