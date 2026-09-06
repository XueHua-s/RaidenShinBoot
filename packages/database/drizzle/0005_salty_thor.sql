CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "embedding" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "protocol" text DEFAULT 'telegram' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "persona_version" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "persona_hash" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_local" halfvec(512);--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_revision" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_dimensions" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_normalized" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "scope" text DEFAULT 'user_private' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "kind" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_thread_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "subject_user_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confidence" integer DEFAULT 70 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "telegram_thread_id" text;--> statement-breakpoint
UPDATE "conversations" SET "scope_key" = 'legacy:' || "id"::text WHERE "scope_key" IS NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "scope_key" SET NOT NULL;--> statement-breakpoint
UPDATE "memories" AS "memory"
SET
	"subject_user_id" = "memory"."telegram_user_id",
	"source_chat_id" = "message"."telegram_chat_id",
	"content_hash" = md5("memory"."summary")
FROM "messages" AS "message"
WHERE "memory"."source_message_id" = "message"."id";--> statement-breakpoint
UPDATE "memories"
SET
	"subject_user_id" = COALESCE("subject_user_id", "telegram_user_id"),
	"content_hash" = COALESCE("content_hash", md5("summary"));--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_scope_key_idx" ON "conversations" USING btree ("scope_key");--> statement-breakpoint
CREATE INDEX "conversations_chat_thread_idx" ON "conversations" USING btree ("protocol","chat_id","thread_id");--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("scope","source_chat_id","telegram_user_id");--> statement-breakpoint
CREATE INDEX "memories_content_hash_idx" ON "memories" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "memories_embedding_local_hnsw_idx" ON "memories" USING hnsw ("embedding_local" halfvec_cosine_ops);
