// Contracts shared by the Rev server, web UI and agent CLI/MCP server.
import { z } from "zod";

export const USER_KINDS = ["human", "agent"] as const;
export type UserKind = (typeof USER_KINDS)[number];

export const GLOBAL_ROLES = ["admin", "member"] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const PROJECT_ROLES = ["owner", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

export const CLOSED_TASK_STATUSES = ["done", "cancelled"] as const satisfies readonly TaskStatus[];
export const isClosedStatus = (s: TaskStatus) => s === "done" || s === "cancelled";

/**
 * Whether a closed task's closure was seen by a human. Agents may close their own
 * tasks; such closures stay "agent" until a human closes or reviews the task.
 */
export type ClosureReview = "human" | "agent";

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const REVIEW_STATUSES = ["draft", "open", "changes_requested", "approved", "closed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  draft: "Draft",
  open: "Open",
  changes_requested: "Changes requested",
  approved: "Approved",
  closed: "Closed",
};

export const COMMENT_STATUSES = ["open", "accepted", "rejected", "resolved"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const ASSET_KINDS = ["video", "image"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUSES = ["processing", "ready", "failed"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Upload types accepted for review assets. SVG is excluded on purpose (script injection). */
export const ACCEPTED_MEDIA: Record<string, AssetKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "video/x-matroska": "video",
};

export const MEDIA_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

// ---------------------------------------------------------------------------
// Annotations. Coordinates are normalised to 0..1 of the media's natural size
// so they survive any display scaling.

const unit = z.number().min(0).max(1);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const shapeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pin"), x: unit, y: unit, color }),
  z.object({ type: z.literal("rect"), x: unit, y: unit, w: unit, h: unit, color }),
  z.object({ type: z.literal("arrow"), x1: unit, y1: unit, x2: unit, y2: unit, color }),
  z.object({
    type: z.literal("pen"),
    points: z.array(z.tuple([unit, unit])).min(2).max(2000),
    color,
  }),
]);
export type Shape = z.infer<typeof shapeSchema>;

export const annotationSchema = z.object({ shapes: z.array(shapeSchema).max(50) });
export type Annotation = z.infer<typeof annotationSchema>;

// ---------------------------------------------------------------------------
// Request bodies

const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(10, "Password must be at least 10 characters").max(200);
const name = z.string().trim().min(1).max(100);
const markdown = z.string().max(50_000);

export const setupBody = z.object({ token: z.string().min(1), email, name, password });
export const loginBody = z.object({ email, password: z.string().min(1).max(200) });
export const changePasswordBody = z.object({ current: z.string().min(1), next: password });
export const updateProfileBody = z.object({ name });
export const inviteCreateBody = z.object({ email, role: z.enum(GLOBAL_ROLES).default("member") });
export const inviteAcceptBody = z.object({ name: name.optional(), password });
export const userUpdateBody = z.object({
  role: z.enum(GLOBAL_ROLES).optional(),
  disabled: z.boolean().optional(),
});

export const agentCreateBody = z.object({ name, description: z.string().max(2000).default("") });
export const agentUpdateBody = z.object({
  name: name.optional(),
  description: z.string().max(2000).optional(),
  disabled: z.boolean().optional(),
});
export const tokenCreateBody = z.object({ name: z.string().trim().min(1).max(100) });

export const enrollmentKeyCreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  /** Projects every agent registered with this key joins. */
  projects: z
    .array(z.object({ key: z.string().trim().toUpperCase(), role: z.enum(["member", "viewer"]).default("member") }))
    .max(50)
    .default([]),
  /** null = unlimited registrations. */
  maxUses: z.number().int().min(1).max(10_000).nullable().default(null),
  /** null = never expires. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(30),
});

/** Sent by an agent registering itself (unauthenticated apart from the key). */
export const agentRegisterBody = z.object({
  key: z.string().trim().min(10).max(200),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
});

export const projectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Key must be 2-10 letters/digits, starting with a letter");
export const projectCreateBody = z.object({
  key: projectKey,
  name,
  description: z.string().max(5000).default(""),
});
export const projectUpdateBody = z.object({
  name: name.optional(),
  description: z.string().max(5000).optional(),
  archived: z.boolean().optional(),
});
export const memberAddBody = z.object({ userId: z.uuid(), role: z.enum(PROJECT_ROLES).default("member") });
export const memberUpdateBody = z.object({ role: z.enum(PROJECT_ROLES) });

export const taskCreateBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: markdown.default(""),
  status: z.enum(TASK_STATUSES).default("todo"),
  priority: z.enum(TASK_PRIORITIES).default("none"),
  assigneeId: z.uuid().nullable().default(null),
});
export const taskUpdateBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: markdown.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: z.uuid().nullable().optional(),
  position: z.number().finite().optional(),
});
export const taskCommentBody = z.object({ body: z.string().trim().min(1).max(20_000) });

export const reviewCreateBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: markdown.default(""),
  /** Task this review delivers, e.g. "WEB-12". */
  taskRef: z.string().trim().max(40).optional(),
  /** Publish immediately (only useful for reviews without uploads). Defaults to draft. */
  publish: z.boolean().default(false),
});
export const reviewUpdateBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: markdown.optional(),
  status: z.enum(REVIEW_STATUSES).optional(),
  ownerId: z.uuid().optional(),
});
export const assetUpdateBody = z.object({
  caption: z.string().max(500).optional(),
  position: z.number().int().min(0).optional(),
});

export const reviewCommentCreateBody = z.object({
  body: z.string().trim().min(1).max(20_000),
  assetId: z.uuid().nullable().default(null),
  parentId: z.uuid().nullable().default(null),
  timestampMs: z.number().int().min(0).nullable().default(null),
  annotation: annotationSchema.nullable().default(null),
});
export const reviewCommentUpdateBody = z.object({
  body: z.string().trim().min(1).max(20_000).optional(),
  status: z.enum(COMMENT_STATUSES).optional(),
});
export const taskFromReviewBody = z.object({
  commentIds: z.array(z.uuid()).max(100).default([]),
  title: z.string().trim().min(1).max(300),
  description: markdown.default(""),
  priority: z.enum(TASK_PRIORITIES).default("none"),
  assigneeId: z.uuid().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Response DTOs

export interface UserSummary {
  id: string;
  name: string;
  kind: UserKind;
  email: string | null;
  /** For agents: the human the agent is linked to. */
  ownerId: string | null;
}

export interface UserDetail extends UserSummary {
  role: GlobalRole;
  disabled: boolean;
  createdAt: string;
}

export interface Me {
  user: UserDetail;
  /** Authenticated via API token rather than a browser session. */
  viaToken: boolean;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  disabled: boolean;
  owner: UserSummary;
  /** Set when the agent registered itself with an enrollment key. */
  enrolledVia: { id: string; name: string } | null;
  createdAt: string;
  tokens: ApiTokenInfo[];
  projects: { key: string; name: string; role: ProjectRole }[];
}

export interface EnrollmentKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdBy: UserSummary;
  projects: { key: string; name: string; role: "member" | "viewer" }[];
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** Usable right now: not revoked, expired or used up. */
  active: boolean;
  agents: { id: string; name: string; disabled: boolean }[];
}

export interface AgentRegistration {
  /** API token for the new agent; only returned once. */
  token: string;
  agent: { id: string; name: string; owner: UserSummary };
  projects: { key: string; name: string; role: ProjectRole }[];
}

export interface InviteInfo {
  id: string;
  kind: "invite" | "reset";
  email: string;
  role: GlobalRole;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  url?: string;
}

export interface ProjectInfo {
  id: string;
  key: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt: string;
  myRole: ProjectRole | null;
  counts: { openTasks: number; openReviews: number; members: number };
  can: { manage: boolean; createTask: boolean; createReview: boolean };
}

export interface ProjectMemberInfo {
  user: UserSummary;
  role: ProjectRole;
  createdAt: string;
}

export interface TaskInfo {
  id: string;
  ref: string;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  assignee: UserSummary | null;
  createdBy: UserSummary;
  sourceReview: { id: string; ref: string; title: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Set while the task is done or cancelled. */
  closure: TaskClosure | null;
}

export interface TaskClosure {
  by: UserSummary;
  at: string;
  review: ClosureReview;
  /** The human who closed the task, or who later reviewed an agent's closure. */
  reviewedBy: UserSummary | null;
  reviewedAt: string | null;
}

export interface TaskActivityInfo {
  id: string;
  kind: "created" | "comment" | "status" | "assign" | "priority" | "review" | "closure_reviewed";
  actor: UserSummary;
  body: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface TaskDetail extends TaskInfo {
  /** Review comments this task was created from, with their annotations. */
  sourceComments: ReviewCommentInfo[];
  /** Reviews submitted to deliver this task. */
  deliveries: { id: string; ref: string; title: string; status: ReviewStatus; createdAt: string }[];
  activity: TaskActivityInfo[];
  can: {
    edit: boolean;
    updateStatus: boolean;
    comment: boolean;
    /** Mark an agent's closure as reviewed by a human. */
    reviewClosure: boolean;
    assignableUserIds: string[];
  };
}

export interface ReviewAssetInfo {
  id: string;
  kind: AssetKind;
  status: AssetStatus;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  caption: string;
  position: number;
  error: string | null;
  url: string;
  posterUrl: string | null;
  createdAt: string;
}

export interface ReviewCommentInfo {
  id: string;
  reviewId: string;
  reviewRef: string;
  assetId: string | null;
  parentId: string | null;
  author: UserSummary;
  body: string;
  timestampMs: number | null;
  annotation: Annotation | null;
  snapshotUrl: string | null;
  status: CommentStatus;
  decidedBy: UserSummary | null;
  decidedAt: string | null;
  task: { id: string; ref: string; status: TaskStatus; closureReview: ClosureReview | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewInfo {
  id: string;
  ref: string;
  projectKey: string;
  number: number;
  title: string;
  description: string;
  status: ReviewStatus;
  createdBy: UserSummary;
  owner: UserSummary;
  task: { id: string; ref: string; title: string; status: TaskStatus; closureReview: ClosureReview | null } | null;
  assetCount: number;
  commentCount: number;
  openCommentCount: number;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface ReviewDetail extends ReviewInfo {
  assets: ReviewAssetInfo[];
  comments: ReviewCommentInfo[];
  tasks: {
    id: string;
    ref: string;
    title: string;
    status: TaskStatus;
    closureReview: ClosureReview | null;
    assignee: UserSummary | null;
  }[];
  can: {
    edit: boolean;
    comment: boolean;
    /** Approve / request changes, accept or reject comments, create tasks from them. */
    decide: boolean;
    publish: boolean;
    assignableUserIds: string[];
  };
}

export interface DashboardInfo {
  myTasks: TaskInfo[];
  /** Tasks your agents closed that no human has reviewed yet. */
  agentClosuresToReview: TaskInfo[];
  reviewsToDecide: ReviewInfo[];
  myAgentsTasks: TaskInfo[];
  recentReviews: ReviewInfo[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export function taskRef(projectKey: string, number: number) {
  return `${projectKey}-${number}`;
}

export function reviewRef(projectKey: string, number: number) {
  return `${projectKey}-R${number}`;
}

export function formatTimestamp(ms: number) {
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
