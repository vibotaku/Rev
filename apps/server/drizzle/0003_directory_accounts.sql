ALTER TABLE "users" ADD COLUMN "auth_source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_external_id_unique" UNIQUE("external_id");--> statement-breakpoint
-- Accounts disabled before disable reasons existed were disabled by an admin.
UPDATE "users" SET "disabled_reason" = 'admin' WHERE "disabled_at" IS NOT NULL;
