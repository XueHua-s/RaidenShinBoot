ALTER TABLE "telegram_chats" ADD COLUMN "reply_mode" text DEFAULT 'social' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_users" ADD COLUMN "privacy_mode" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
CREATE INDEX "telegram_chats_reply_mode_idx" ON "telegram_chats" USING btree ("reply_mode");