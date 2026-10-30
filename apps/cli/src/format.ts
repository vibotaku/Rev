// Plain-text renderings shared by the CLI and the MCP server.
import {
  formatTimestamp,
  REVIEW_STATUS_LABELS,
  TASK_STATUS_LABELS,
  type Annotation,
  type ReviewCommentInfo,
  type ReviewDetail,
  type TaskDetail,
  type TaskInfo,
  type UserSummary,
} from "@rev/shared";
import type { RevApi } from "./api";

const pct = (n: number) => `${Math.round(n * 100)}%`;

function who(u: UserSummary | null) {
  if (!u) return "unassigned";
  return u.kind === "agent" ? `${u.name} (agent)` : u.name;
}

/** Describes shapes in words so agents without image input still know where to look. */
export function describeAnnotation(annotation: Annotation | null) {
  if (!annotation?.shapes.length) return null;
  return annotation.shapes
    .map((s) => {
      switch (s.type) {
        case "pin":
          return `pin at (${pct(s.x)}, ${pct(s.y)})`;
        case "rect":
          return `box at (${pct(s.x)}, ${pct(s.y)}) size ${pct(s.w)}×${pct(s.h)}`;
        case "arrow":
          return `arrow from (${pct(s.x1)}, ${pct(s.y1)}) to (${pct(s.x2)}, ${pct(s.y2)})`;
        case "pen": {
          const xs = s.points.map((p) => p[0]);
          const ys = s.points.map((p) => p[1]);
          return `freehand mark around (${pct(Math.min(...xs))}-${pct(Math.max(...xs))}, ${pct(Math.min(...ys))}-${pct(Math.max(...ys))})`;
        }
      }
    })
    .join("; ");
}

/** "Done", "Done (agent-closed, not reviewed)" or "Done (reviewed by Alice)". */
export function statusLabel(t: Pick<TaskInfo, "status" | "closure">) {
  const label = TASK_STATUS_LABELS[t.status];
  if (!t.closure) return label;
  if (t.closure.review === "agent") return `${label} (agent-closed, not reviewed)`;
  return t.closure.by.id === t.closure.reviewedBy?.id ? label : `${label} (reviewed by ${t.closure.reviewedBy?.name})`;
}

export function formatTaskLine(t: TaskInfo) {
  const prio = t.priority !== "none" ? ` [${t.priority}]` : "";
  return `${t.ref.padEnd(10)} ${statusLabel(t).padEnd(12)}${prio} ${t.title}`;
}

function commentHeader(c: ReviewCommentInfo, assetNames: Map<string, string>) {
  return [
    c.assetId ? (assetNames.get(c.assetId) ?? "asset") : null,
    c.timestampMs != null ? `@ ${formatTimestamp(c.timestampMs, true)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** "9 frames (3×3, row by row) from 0:02.400 to 0:04.400, 0.25 s apart; the commented moment 0:03.400 is frame 5, outlined in red". */
export function describeFrames(f: NonNullable<ReviewCommentInfo["frames"]>) {
  const t = f.timesMs;
  const step = t.length > 1 ? `, ${Number(((t[1]! - t[0]!) / 1000).toFixed(3))} s apart` : "";
  return (
    `${t.length} frames (3×3, row by row) from ${formatTimestamp(t[0]!, true)} to ${formatTimestamp(t.at(-1)!, true)}${step}; ` +
    `the commented moment ${formatTimestamp(t[f.markedIndex]!, true)} is frame ${f.markedIndex + 1}, outlined in red`
  );
}

/** Lines shared by overall comments and mark comments: annotation, snapshot, frames, task. */
function commentDetails(api: RevApi, c: ReviewCommentInfo, indent: string, withFrames = true) {
  const lines: string[] = [];
  const shapes = describeAnnotation(c.annotation);
  if (shapes) lines.push(`${indent}annotation: ${shapes}`);
  if (c.snapshotUrl) lines.push(`${indent}snapshot: ${api.url(c.snapshotUrl)}`);
  if (c.frames && withFrames) lines.push(`${indent}frames: ${api.url(c.frames.url)} (${describeFrames(c.frames)})`);
  if (c.task) {
    const agentClosed = c.task.closureReview === "agent" ? ", agent-closed" : "";
    lines.push(`${indent}task: ${c.task.ref} (${TASK_STATUS_LABELS[c.task.status]}${agentClosed})`);
  }
  return lines;
}

const replyLine = (r: ReviewCommentInfo, indent: string) => `${indent}↳ ${who(r.author)}: ${r.body.replace(/\n+/g, " ")} (comment ${r.id})`;

/**
 * One comment. A mark comment (a note on a single pin/box/…) is labelled with
 * its mark number and the overall comment it belongs to. `marks` are rendered
 * nested as "#n [status] note"; `all` supplies the replies to each.
 */
export function formatComment(
  api: RevApi,
  c: ReviewCommentInfo,
  assetNames: Map<string, string>,
  replies: ReviewCommentInfo[] = [],
  indent = "",
  marks: ReviewCommentInfo[] = [],
  all: ReviewCommentInfo[] = [],
) {
  const where = commentHeader(c, assetNames);
  const mark = c.markIndex != null ? `mark #${c.markIndex} of comment ${c.markOf}: ` : "";
  const lines = [`${indent}- [${c.status}] ${mark}${who(c.author)}${where ? ` on ${where}` : ""} (comment ${c.id})`];
  for (const l of c.body.split("\n")) lines.push(`${indent}    ${l}`);
  lines.push(...commentDetails(api, c, `${indent}    `));
  for (const r of replies) lines.push(replyLine(r, `${indent}    `));
  for (const m of marks) {
    lines.push(`${indent}    #${m.markIndex} [${m.status}] ${m.body.replace(/\n+/g, " ")} (comment ${m.id})`);
    // A mark shares its overall comment's moment, so its frames were listed above.
    lines.push(...commentDetails(api, m, `${indent}        `, false));
    for (const r of all.filter((x) => x.parentId === m.id)) lines.push(replyLine(r, `${indent}        `));
  }
  return lines.join("\n");
}

/** An overall comment with its mark comments and every reply, nested. */
function formatThread(api: RevApi, c: ReviewCommentInfo, all: ReviewCommentInfo[], assetNames: Map<string, string>, indent = "") {
  const marks = all.filter((x) => x.markOf === c.id).sort((a, b) => (a.markIndex ?? 0) - (b.markIndex ?? 0));
  return formatComment(api, c, assetNames, all.filter((x) => x.parentId === c.id), indent, marks, all);
}

export function formatTask(api: RevApi, t: TaskDetail, assetNames = new Map<string, string>()) {
  const lines = [
    `${t.ref}: ${t.title}`,
    `Status: ${statusLabel(t)} · Priority: ${t.priority} · Assignee: ${who(t.assignee)} · Created by: ${who(t.createdBy)}`,
    `URL: ${api.webUrl("tasks", t.projectKey, t.number)}`,
  ];
  if (t.sourceReview) lines.push(`From review: ${t.sourceReview.ref} — ${t.sourceReview.title}`);
  lines.push("", t.description.trim() || "(no description)");
  if (t.sourceComments.length) {
    lines.push("", `Review feedback to address (${t.sourceComments.length}):`);
    for (const c of t.sourceComments) {
      const marks = t.sourceMarks.filter((m) => m.markOf === c.id);
      lines.push(formatComment(api, c, assetNames, [], "", marks));
    }
    if (t.sourceMarks.some((m) => m.status === "rejected")) {
      lines.push("", "Mark notes shown as [rejected] were turned down by the review owner: leave those alone.");
    }
  }
  if (t.deliveries.length) {
    lines.push("", "Reviews submitted for this task:");
    for (const d of t.deliveries) {
      lines.push(`- ${d.ref}${d.round ? ` round ${d.round}` : ""} ${d.title} (${REVIEW_STATUS_LABELS[d.status]})`);
    }
  }
  const notes = t.activity.filter((a) => a.kind === "comment");
  if (notes.length) {
    lines.push("", "Discussion:");
    for (const a of notes) lines.push(`- ${who(a.actor)} (${a.createdAt.slice(0, 16).replace("T", " ")}): ${a.body}`);
  }
  return lines.join("\n");
}

export function formatReview(api: RevApi, r: ReviewDetail) {
  const assetNames = new Map(r.assets.map((a) => [a.id, a.filename]));
  const rounds = r.rounds?.length ? r.rounds : [{ number: 1, notes: "", createdBy: r.createdBy, submittedAt: r.publishedAt, addressedTasks: [] }];
  const lines = [
    `${r.ref}: ${r.title}`,
    `Status: ${REVIEW_STATUS_LABELS[r.status]} · Owner: ${who(r.owner)} · Submitted by: ${who(r.createdBy)} · Round ${r.currentRound ?? 1} of ${rounds.length}`,
    `URL: ${api.webUrl("reviews", r.projectKey, r.number)}`,
  ];
  if (r.task) lines.push(`Delivers task: ${r.task.ref} — ${r.task.title}`);
  if (r.description.trim()) lines.push("", r.description.trim());

  for (const round of rounds) {
    const state = round.submittedAt ? `submitted ${round.submittedAt.slice(0, 16).replace("T", " ")}` : "draft (not submitted yet)";
    lines.push("", `== Round ${round.number} — by ${who(round.createdBy)}, ${state}`);
    if (round.notes.trim()) lines.push(...round.notes.trim().split("\n").map((l) => `  ${l}`));
    if (round.addressedTasks.length) {
      lines.push(`  Addresses: ${round.addressedTasks.map((t) => `${t.ref} ${t.title} (${TASK_STATUS_LABELS[t.status]})`).join("; ")}`);
    }
    const assets = r.assets.filter((a) => (a.roundNumber ?? 1) === round.number);
    lines.push(`  Assets (${assets.length}):`);
    for (const a of assets) {
      const dims = a.width && a.height ? ` ${a.width}×${a.height}` : "";
      const dur = a.durationMs != null ? ` ${formatTimestamp(a.durationMs)}` : "";
      const cap = a.caption ? ` — ${a.caption}` : "";
      const err = a.error ? ` (error: ${a.error})` : "";
      lines.push(`  - ${a.filename} [${a.kind}, ${a.status}${dims}${dur}]${cap}${err}`);
    }
    const inRound = r.comments.filter((c) => (c.roundNumber ?? 1) === round.number);
    const top = inRound.filter((c) => !c.parentId && !c.markOf);
    const decisions = inRound.filter((c) => !c.parentId).length;
    lines.push(`  Comments (${top.length}, ${decisions} to decide incl. mark notes):`);
    for (const c of top) lines.push(formatThread(api, c, inRound, assetNames, "  "));
  }
  if (r.tasks.length) {
    lines.push("", "Tasks created from this review:");
    for (const t of r.tasks) lines.push(`- ${t.ref} ${t.title} (${TASK_STATUS_LABELS[t.status]}, ${who(t.assignee)})`);
  }
  return lines.join("\n");
}
