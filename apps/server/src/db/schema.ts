import {
  type AnyPgColumn,
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Annotation,
  AuthSource,
  DisabledReason,
  AssetKind,
  AssetStatus,
  CommentStatus,
  GlobalRole,
  ProjectRole,
  ReviewStatus,
  TaskActivityInfo,
  TaskPriority,
  TaskStatus,
  UserKind,
} from "@rev/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

/** Humans and agents share one table so either can author reviews, comments and tasks. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").unique(),
    name: text("name").notNull(),
    kind: text("kind").$type<UserKind>().notNull(),
    role: text("role").$type<GlobalRole>().notNull().default("member"),
    passwordHash: text("password_hash"),
    /** For agents: the human the agent is linked to and acts on behalf of. */
    ownerId: uuid("owner_id").references((): AnyPgColumn => users.id),
    description: text("description").notNull().default(""),
    /** For self-registered agents: the enrollment key they registered with. */
    enrolledVia: uuid("enrolled_via").references((): AnyPgColumn => enrollmentKeys.id, { onDelete: "set null" }),
    /** "ldap" for Active Directory accounts (created on first sign-in), else "local". */
    authSource: text("auth_source").$type<AuthSource>().notNull().default("local"),
    /** Directory object id (AD objectGUID, hex) for ldap accounts. */
    externalId: text("external_id").unique(),
    /** Directory login name (sAMAccountName). */
    username: text("username"),
    disabledAt: ts("disabled_at"),
    /** "admin": disabled in Rev. "directory": suspended because AD no longer allows the account (lifted automatically). */
    disabledReason: text("disabled_reason").$type<DisabledReason>(),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
  },
  (t) => [index("users_owner_idx").on(t.ownerId)],
);

/**
 * Lets agents register themselves. Agents enrolled with a key are linked to the
 * human who created it and join the key's projects.
 */
export const enrollmentKeys = pgTable(
  "enrollment_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: "cascade" }),
    projects: jsonb("projects").$type<{ projectId: string; role: "member" | "viewer" }[]>().notNull().default([]),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("enrollment_keys_created_by_idx").on(t.createdBy)],
);

/** Server-wide settings edited in the admin UI (e.g. Active Directory). Secrets inside are encrypted. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedBy: uuid("updated_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the cookie token; the raw token is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

/** Invitation links and admin-issued password reset links. */
export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<"invite" | "reset">().notNull(),
  email: text("email").notNull(),
  role: text("role").$type<GlobalRole>().notNull().default("member"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  taskSeq: integer("task_seq").notNull().default(0),
  reviewSeq: integer("review_seq").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  archivedAt: ts("archived_at"),
});

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<ProjectRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("project_members_user_idx").on(t.userId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<TaskStatus>().notNull().default("todo"),
    priority: text("priority").$type<TaskPriority>().notNull().default("none"),
    position: doublePrecision("position").notNull().default(0),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** Review the task was created from (via accepted comments or the review itself). */
    sourceReviewId: uuid("source_review_id").references((): AnyPgColumn => reviews.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    /** When the task entered done/cancelled (column predates cancelled closures). */
    closedAt: ts("completed_at"),
    /** Who closed it: a human, or an agent closing its own task. */
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    /** The human who reviewed the closure; null means only an agent has looked at it. */
    humanReviewedBy: uuid("human_reviewed_by").references(() => users.id, { onDelete: "set null" }),
    humanReviewedAt: ts("human_reviewed_at"),
  },
  (t) => [
    uniqueIndex("tasks_project_number_idx").on(t.projectId, t.number),
    index("tasks_closed_by_idx").on(t.closedBy),
    index("tasks_project_status_idx").on(t.projectId, t.status),
    index("tasks_assignee_idx").on(t.assigneeId),
  ],
);

export const taskActivity = pgTable(
  "task_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").$type<TaskActivityInfo["kind"]>().notNull(),
    body: text("body").notNull().default(""),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("task_activity_task_idx").on(t.taskId, t.createdAt)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<ReviewStatus>().notNull().default("draft"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** Human who decides on the review: accepts comments and turns them into tasks. */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    /** Task this review delivers (agent submitting work for an assigned task). */
    taskId: uuid("task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    publishedAt: ts("published_at"),
  },
  (t) => [
    uniqueIndex("reviews_project_number_idx").on(t.projectId, t.number),
    index("reviews_project_status_idx").on(t.projectId, t.status),
    index("reviews_owner_idx").on(t.ownerId),
    index("reviews_task_idx").on(t.taskId),
  ],
);

export const reviewAssets = pgTable(
  "review_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AssetKind>().notNull(),
    status: text("status").$type<AssetStatus>().notNull().default("processing"),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    /** Browser-playable transcode, when the original is not. */
    playbackKey: text("playback_key"),
    posterKey: text("poster_key"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    caption: text("caption").notNull().default(""),
    position: integer("position").notNull().default(0),
    error: text("error"),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("review_assets_review_idx").on(t.reviewId, t.position)],
);

export const reviewComments = pgTable(
  "review_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => reviewAssets.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => reviewComments.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    timestampMs: integer("timestamp_ms"),
    annotation: jsonb("annotation").$type<Annotation>(),
    /** Rendered frame + annotation (PNG) so agents can see exactly what was marked. */
    snapshotKey: text("snapshot_key"),
    status: text("status").$type<CommentStatus>().notNull().default("open"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: ts("decided_at"),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("review_comments_review_idx").on(t.reviewId, t.createdAt), index("review_comments_task_idx").on(t.taskId)],
);
