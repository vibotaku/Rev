CREATE TABLE "enrollment_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" uuid NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "enrolled_via" uuid;--> statement-breakpoint
ALTER TABLE "enrollment_keys" ADD CONSTRAINT "enrollment_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollment_keys_created_by_idx" ON "enrollment_keys" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_enrolled_via_enrollment_keys_id_fk" FOREIGN KEY ("enrolled_via") REFERENCES "public"."enrollment_keys"("id") ON DELETE set null ON UPDATE no action;