CREATE TABLE "chat_model_preferences" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
