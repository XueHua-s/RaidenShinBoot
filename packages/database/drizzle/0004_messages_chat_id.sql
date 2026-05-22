DELETE FROM "telegram_command_permissions" WHERE "command" = 'model';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_telegram_message_idx" ON "messages" USING btree ("telegram_chat_id","telegram_message_id") WHERE "messages"."telegram_chat_id" is not null and "messages"."telegram_message_id" is not null and "messages"."role" = 'user';
