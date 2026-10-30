import { access } from "node:fs/promises";
import path from "node:path";
import { MEDIA_EXTENSIONS, type ReviewCommentInfo, type ReviewDetail, type ReviewRoundInfo } from "@rev/shared";
import type { RevApi } from "./api";

export interface ReviewKitInput {
  project: string;
  title: string;
  description?: string;
  taskRef?: string;
  files: string[];
  /** Per-file captions, aligned with `files`. */
  captions?: (string | undefined)[];
  publish?: boolean;
  onProgress?: (message: string) => void;
}

/** Fails fast, before anything is created on the server, if a file is missing or not a supported type. */
async function checkFiles(files: string[]) {
  for (const f of files) {
    if (!MEDIA_EXTENSIONS[path.extname(f).toLowerCase()]) {
      throw new Error(`Unsupported file type: ${f} (use png/jpg/webp/gif images or mp4/webm/mov/mkv videos)`);
    }
    await access(f).catch(() => {
      throw new Error(`File not found: ${f}`);
    });
  }
}

/** Creates a draft review, uploads every file, then publishes (unless asked not to). */
export async function createReviewKit(api: RevApi, input: ReviewKitInput): Promise<ReviewDetail> {
  await checkFiles(input.files);
  const draft = await api.createReview(input.project, {
    title: input.title,
    description: input.description ?? "",
    taskRef: input.taskRef,
    publish: false,
  });
  input.onProgress?.(`Created draft ${draft.ref}`);
  for (const [i, file] of input.files.entries()) {
    input.onProgress?.(`Uploading ${path.basename(file)} (${i + 1}/${input.files.length})`);
    await api.uploadAsset(draft.ref, file, input.captions?.[i]);
  }
  if (input.publish === false) return api.review(draft.ref);
  return api.updateReviewStatus(draft.ref, "open");
}

export interface ReviewRoundInput {
  /** What changed since the previous round (markdown). */
  notes?: string;
  files: string[];
  /** Per-file captions, aligned with `files`. */
  captions?: (string | undefined)[];
  /** Tasks this round addresses; omitted = your open tasks from this review. */
  taskRefs?: string[];
  onProgress?: (message: string) => void;
}

/**
 * Submits the next round of an existing review: creates a draft round, uploads
 * the files into it and submits it. If anything fails after the draft exists,
 * the draft is deleted so a retry starts clean.
 */
export async function submitReviewRound(
  api: RevApi,
  reviewRef: string,
  input: ReviewRoundInput,
): Promise<{ review: ReviewDetail; round: ReviewRoundInfo }> {
  if (!input.files.length) throw new Error("A round needs at least one screenshot or video");
  await checkFiles(input.files);
  const drafted = await api.createRound(reviewRef, { notes: input.notes ?? "", taskRefs: input.taskRefs });
  const number = drafted.rounds.at(-1)!.number;
  input.onProgress?.(`Started draft round ${number} of ${drafted.ref}`);
  try {
    for (const [i, file] of input.files.entries()) {
      input.onProgress?.(`Uploading ${path.basename(file)} (${i + 1}/${input.files.length})`);
      await api.uploadAsset(drafted.ref, file, input.captions?.[i], number);
    }
    const review = await api.submitRound(drafted.ref, number);
    return { review, round: review.rounds.find((r) => r.number === number)! };
  } catch (err) {
    await api.deleteRound(drafted.ref, number).catch(() => undefined);
    throw err;
  }
}

export interface Snapshot {
  comment: ReviewCommentInfo;
  data: Buffer;
  mime: string;
}

/** Downloads annotated comment snapshots, stopping at the given count / byte budget. */
export async function fetchSnapshots(api: RevApi, comments: ReviewCommentInfo[], maxImages = 4, maxBytes = 5 * 1024 * 1024) {
  const out: Snapshot[] = [];
  let bytes = 0;
  for (const c of comments) {
    if (!c.snapshotUrl || out.length >= maxImages) continue;
    const { data, mime } = await api.download(c.snapshotUrl);
    if (bytes + data.length > maxBytes) continue;
    bytes += data.length;
    out.push({ comment: c, data, mime });
  }
  return out;
}

/** Map of asset id -> filename for a review, used to label comments. */
export async function assetNamesFor(api: RevApi, reviewRef: string | undefined) {
  if (!reviewRef) return new Map<string, string>();
  try {
    const review = await api.review(reviewRef);
    return new Map(review.assets.map((a) => [a.id, a.filename]));
  } catch {
    return new Map<string, string>();
  }
}
