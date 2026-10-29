ALTER TABLE "tasks" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "human_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "human_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_human_reviewed_by_users_id_fk" FOREIGN KEY ("human_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_closed_by_idx" ON "tasks" USING btree ("closed_by");--> statement-breakpoint
-- Backfill tasks closed before closure tracking: the closer is whoever made the latest
-- status change into the current closed status (or the creator if it was created closed).
UPDATE "tasks" t SET
  "closed_by" = COALESCE(
    (SELECT a."actor_id" FROM "task_activity" a
      WHERE a."task_id" = t."id" AND a."kind" = 'status' AND a."data"->>'to' = t."status"
      ORDER BY a."created_at" DESC LIMIT 1),
    t."created_by"),
  "completed_at" = COALESCE(
    t."completed_at",
    (SELECT a."created_at" FROM "task_activity" a
      WHERE a."task_id" = t."id" AND a."kind" = 'status' AND a."data"->>'to' = t."status"
      ORDER BY a."created_at" DESC LIMIT 1),
    t."updated_at")
WHERE t."status" IN ('done', 'cancelled');--> statement-breakpoint
-- A closure made by a human is human-reviewed by definition.
UPDATE "tasks" t SET "human_reviewed_by" = t."closed_by", "human_reviewed_at" = t."completed_at"
FROM "users" u
WHERE u."id" = t."closed_by" AND u."kind" = 'human' AND t."status" IN ('done', 'cancelled');
