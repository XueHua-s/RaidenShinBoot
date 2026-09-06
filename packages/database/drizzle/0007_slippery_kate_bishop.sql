ALTER TABLE "conversations" DROP CONSTRAINT "conversations_telegram_user_id_telegram_users_telegram_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "telegram_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_telegram_user_id_telegram_users_telegram_id_fk" FOREIGN KEY ("telegram_user_id") REFERENCES "public"."telegram_users"("telegram_id") ON DELETE set null ON UPDATE no action;