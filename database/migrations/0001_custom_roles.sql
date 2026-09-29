CREATE TABLE "core_role" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	"created_by_user_id" text NOT NULL,
	CONSTRAINT "core_role_key_uq" UNIQUE("key"),
	CONSTRAINT "core_role_key_check" CHECK ("core_role"."key" ~ '^[A-Z][A-Z0-9_]{1,62}$'),
	CONSTRAINT "core_role_key_reserved_check" CHECK ("core_role"."key" NOT IN ('APPLICANT', 'SUPER_ADMIN', 'REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')),
	CONSTRAINT "core_role_current_version_check" CHECK ("core_role"."current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "core_role_permission" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "core_role_permission_resource_check" CHECK ("core_role_permission"."resource" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "core_role_permission_action_check" CHECK ("core_role_permission"."action" ~ '^[a-z][a-z0-9_]{0,62}$')
);
--> statement-breakpoint
ALTER TABLE "core_user_role_grant" DROP CONSTRAINT "core_user_role_grant_role_check";--> statement-breakpoint
DROP INDEX "core_user_role_grant_active_uq";--> statement-breakpoint
DROP INDEX "core_user_role_grant_user_idx";--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD COLUMN "role_id" text;--> statement-breakpoint
ALTER TABLE "core_role" ADD CONSTRAINT "core_role_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_role" ADD CONSTRAINT "core_role_created_by_user_id_core_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_role_permission" ADD CONSTRAINT "core_role_permission_role_id_core_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."core_role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_role_live_idx" ON "core_role" USING btree ("deleted_at","key");--> statement-breakpoint
CREATE UNIQUE INDEX "core_role_permission_pair_uq" ON "core_role_permission" USING btree ("role_id","resource","action");--> statement-breakpoint
CREATE INDEX "core_role_permission_role_idx" ON "core_role_permission" USING btree ("role_id");--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_role_id_core_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."core_role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_user_role_grant_active_role_uq" ON "core_user_role_grant" USING btree ("user_id","role_id") WHERE "core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."role_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "core_user_role_grant_role_id_idx" ON "core_user_role_grant" USING btree ("role_id","revoked_at","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_user_role_grant_active_uq" ON "core_user_role_grant" USING btree ("user_id","role") WHERE "core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."role" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "core_user_role_grant_user_idx" ON "core_user_role_grant" USING btree ("user_id","revoked_at");--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_target_check" CHECK (("core_user_role_grant"."role" IS NOT NULL AND "core_user_role_grant"."role_id" IS NULL)
        OR ("core_user_role_grant"."role" IS NULL AND "core_user_role_grant"."role_id" IS NOT NULL));--> statement-breakpoint
-- HAND-WRITTEN, and it must stay above the CHECK that follows it.
--
-- The four fixed staff roles are replaced by roles a super administrator
-- composes. Their grants are closed rather than deleted: a grant is retained
-- history, and an audit row naming what somebody did as an administrator is
-- unreadable once the authority behind it has vanished.
--
-- Ordering is the whole point. The next statement permits one of these four
-- values only on a row that is already revoked, so running it first would
-- refuse every active administrator this statement is here to close.
--
-- `APPLICANT` and `SUPER_ADMIN` are deliberately untouched. In particular every
-- historical `SUPER_ADMIN` row keeps its column and its value, which is what
-- the permanent bootstrap lock reads — see `firstSuperAdminNeverGranted`. This
-- migration moves no super-administrator data at all, so that lock cannot be
-- reopened by it.
UPDATE "core_user_role_grant"
   SET "revoked_at" = now(),
       "revocation_reason" = 'ROLE_MODEL_REPLACED'
 WHERE "role" IN ('REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')
   AND "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_role_check" CHECK ("core_user_role_grant"."role" IS NULL
        OR "core_user_role_grant"."role" IN ('APPLICANT', 'SUPER_ADMIN')
        OR ("core_user_role_grant"."role" IN ('REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')
            AND "core_user_role_grant"."revoked_at" IS NOT NULL));