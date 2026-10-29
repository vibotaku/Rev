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

export function formatComment(
  api: RevApi,
  c: ReviewCommentInfo,
  assetNames: Map<string, string>,
  replies: ReviewCommentInfo[] = [],
  indent = "",
) {
  const where = [
    c.assetId ? (assetNames.get(c.assetId) ?? "asset") : null,
    c.timestampMs != null ? `@ ${formatTimestamp(c.timestampMs)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [`${indent}- [${c.status}] ${who(c.author)}${where ? ` on ${where}` : ""} (comment ${c.id})`];
  for (const l of c.body.split("\n")) lines.push(`${indent}    ${l}`);
  const shapes = describeAnnotation(c.annotation);
  if (shapes) lines.push(`${indent}    annotation: ${shapes}`);
  if (c.snapshotUrl) lines.push(`${indent}    snapshot: ${api.url(c.snapshotUrl)}`);
  if (c.task) {
    const agentClosed = c.task.closureReview === "agent" ? ", agent-closed" : "";
    lines.push(`${indent}    task: ${c.task.ref} (${TASK_STATUS_LABELS[c.task.status]}${agentClosed})`);
  }
  for (const r of replies) {
    lines.push(`${indent}    ↳ ${who(r.author)}: ${r.body.replace(/\n+/g, " ")} (comment ${r.id})`);
  }
  return lines.join("\n");
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
    for (const c of t.sourceComments) lines.push(formatComment(api, c, assetNames));
  }
  if (t.deliveries.length) {
    lines.push("", "Reviews submitted for this task:");
    for (const d of t.deliveries) lines.push(`- ${d.ref} ${d.title} (${REVIEW_STATUS_LABELS[d.status]})`);
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
  const lines = [
    `${r.ref}: ${r.title}`,
    `Status: ${REVIEW_STATUS_LABELS[r.status]} · Owner: ${who(r.owner)} · Submitted by: ${who(r.createdBy)}`,
    `URL: ${api.webUrl("reviews", r.projectKey, r.number)}`,
  ];
  if (r.task) lines.push(`Delivers task: ${r.task.ref} — ${r.task.title}`);
  if (r.description.trim()) lines.push("", r.description.trim());
  lines.push("", `Assets (${r.assets.length}):`);
  for (const a of r.assets) {
    const dims = a.width && a.height ? ` ${a.width}×${a.height}` : "";
    const dur = a.durationMs != null ? ` ${formatTimestamp(a.durationMs)}` : "";
    const cap = a.caption ? ` — ${a.caption}` : "";
    const err = a.error ? ` (error: ${a.error})` : "";
    lines.push(`- ${a.filename} [${a.kind}, ${a.status}${dims}${dur}]${cap}${err}`);
  }
  const top = r.comments.filter((c) => !c.parentId);
  lines.push("", `Comments (${top.length}):`);
  for (const c of top) {
    lines.push(formatComment(api, c, assetNames, r.comments.filter((x) => x.parentId === c.id)));
  }
  if (r.tasks.length) {
    lines.push("", "Tasks created from this review:");
    for (const t of r.tasks) lines.push(`- ${t.ref} ${t.title} (${TASK_STATUS_LABELS[t.status]}, ${who(t.assignee)})`);
  }
  return lines.join("\n");
}
