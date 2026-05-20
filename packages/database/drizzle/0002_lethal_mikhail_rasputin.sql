CREATE TABLE "runtime_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"encrypted" boolean DEFAULT false NOT NULL,
	"updated_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_settings" ADD CONSTRAINT "runtime_settings_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_settings_updated_by_idx" ON "runtime_settings" USING btree ("updated_by_admin_id");--> statement-breakpoint
CREATE INDEX "runtime_settings_updated_idx" ON "runtime_settings" USING btree ("updated_at");