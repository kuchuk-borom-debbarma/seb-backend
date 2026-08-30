CREATE TABLE "seb_announcement" (
	"id" text PRIMARY KEY NOT NULL,
	"tag" text NOT NULL,
	"date_label" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"icon" text NOT NULL,
	"link_kind" text,
	"link_target" text,
	"ends_at" timestamp with time zone,
	"published" boolean NOT NULL,
	"sort_order" integer NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_announcement_icon_check" CHECK ("seb_announcement"."icon" IN ('SEEDLING', 'FILE_TEXT', 'SHIELD_CHECK', 'LANDMARK', 'HELP_CIRCLE', 'MEGAPHONE', 'CALENDAR', 'INDIAN_RUPEE')),
	CONSTRAINT "seb_announcement_link_check" CHECK (("seb_announcement"."link_kind" IS NULL AND "seb_announcement"."link_target" IS NULL)
        OR ("seb_announcement"."link_kind" IN ('EXTERNAL', 'ROUTE', 'ANCHOR') AND "seb_announcement"."link_target" IS NOT NULL)),
	CONSTRAINT "seb_announcement_version_check" CHECK ("seb_announcement"."current_version" >= 1),
	CONSTRAINT "seb_announcement_sort_order_check" CHECK ("seb_announcement"."sort_order" >= 1)
);
--> statement-breakpoint
CREATE TABLE "seb_announcement_board" (
	"id" text PRIMARY KEY NOT NULL,
	"current_version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_announcement_board_singleton_check" CHECK ("seb_announcement_board"."id" = 'BOARD'),
	CONSTRAINT "seb_announcement_board_version_check" CHECK ("seb_announcement_board"."current_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "core_user_role_grant" DROP CONSTRAINT "core_user_role_grant_role_check";--> statement-breakpoint
ALTER TABLE "seb_announcement" ADD CONSTRAINT "seb_announcement_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seb_announcement_public_idx" ON "seb_announcement" USING btree ("sort_order","created_at","id") WHERE deleted_at IS NULL AND published;--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_role_check" CHECK ("core_user_role_grant"."role" IN ('APPLICANT', 'REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER', 'SUPER_ADMIN'));--> statement-breakpoint
-- The board's one row, seeded here so reads stay read-only: a lazy
-- insert-on-first-read would put a write on the public path.
INSERT INTO "seb_announcement_board" ("id", "current_version", "updated_at") VALUES ('BOARD', 1, now()) ON CONFLICT DO NOTHING;
