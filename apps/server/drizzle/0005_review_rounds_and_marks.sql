CREATE TABLE "review_round_tasks" (
	"round_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	CONSTRAINT "review_round_tasks_round_id_task_id_pk" PRIMARY KEY("round_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "review_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review_assets" ADD COLUMN "round_id" uuid;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "round_id" uuid;--> statement-breakpoint
-- Every existing review becomes round 1 of itself; its media and comments belong to that round.
INSERT INTO "review_rounds" ("review_id", "number", "created_by", "created_at", "submitted_at")
SELECT "id", 1, "created_by", "created_at",
       COALESCE("published_at", CASE WHEN "status" <> 'draft' THEN "created_at" END)
FROM "reviews";--> statement-breakpoint
UPDATE "review_assets" a SET "round_id" = r."id" FROM "review_rounds" r WHERE r."review_id" = a."review_id" AND r."number" = 1;--> statement-breakpoint
UPDATE "review_comments" c SET "round_id" = r."id" FROM "review_rounds" r WHERE r."review_id" = c."review_id" AND r."number" = 1;--> statement-breakpoint
ALTER TABLE "review_assets" ALTER COLUMN "round_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ALTER COLUMN "round_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "mark_of" uuid;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "mark_index" integer;--> statement-breakpoint
ALTER TABLE "review_round_tasks" ADD CONSTRAINT "review_round_tasks_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_round_tasks" ADD CONSTRAINT "review_round_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_round_tasks_task_idx" ON "review_round_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_rounds_review_number_idx" ON "review_rounds" USING btree ("review_id","number");--> statement-breakpoint
ALTER TABLE "review_assets" ADD CONSTRAINT "review_assets_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_mark_of_review_comments_id_fk" FOREIGN KEY ("mark_of") REFERENCES "public"."review_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_comments_mark_of_idx" ON "review_comments" USING btree ("mark_of");