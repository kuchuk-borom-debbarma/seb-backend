-- 0002 · Typed activity history
--
-- Adds what the activity history needs to say who an event was about, which
-- application it belongs to, and what it recorded in a declared shape — and
-- fills the first two for every existing row where they can be derived exactly.
--
-- Three properties this file must keep, and why:
--
-- * Additive only. The history is append-only evidence, so nothing recorded is
--   rewritten: `metadata_json` stays byte-for-byte as it was and is how a
--   legacy row (payload_version 0) is read. The backfill only ever writes a
--   column that is still NULL.
--
-- * Safe for the Worker that is live while this runs. That Worker names twelve
--   columns in its inserts, and each of those inserts shares a transaction with
--   the business write it records. Every new column is therefore nullable or
--   defaulted, so its inserts keep landing — and are correctly marked as
--   legacy by the default — until the new Worker replaces it.
--
-- * Idempotent. Every statement checks before it acts, so running the file a
--   second time changes nothing except rows that became derivable in between.
--   That is the supported way to fill the rows the old Worker wrote during the
--   deploy: run this file again once the new Worker is live.
--
-- drizzle applies pending migrations inside one transaction, so the file lands
-- whole or not at all. Names match `src/db/schema/core/audit.ts` and the 0002
-- snapshot exactly; `npm run db:schema:check` and `check:migration` hold them to
-- that.

-- 1. Columns ------------------------------------------------------------------

ALTER TABLE "core_audit_event" ADD COLUMN IF NOT EXISTS "subject_user_id" text;--> statement-breakpoint
ALTER TABLE "core_audit_event" ADD COLUMN IF NOT EXISTS "application_id" text;--> statement-breakpoint
ALTER TABLE "core_audit_event" ADD COLUMN IF NOT EXISTS "payload" jsonb;--> statement-breakpoint
-- A constant default is stored in the catalog, not written into every row, so
-- this is instant however large the table is.
ALTER TABLE "core_audit_event" ADD COLUMN IF NOT EXISTS "payload_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- 2. Constraints --------------------------------------------------------------
--
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each is added only when
-- the catalog does not already hold it by name.
--
-- The foreign key is added NOT VALID: it holds for every new row at once, and
-- the scan of existing rows happens in step 4, after the backfill has written
-- the values it will check.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'core_audit_event_subject_user_id_core_user_id_fk') THEN
    ALTER TABLE "core_audit_event"
      ADD CONSTRAINT "core_audit_event_subject_user_id_core_user_id_fk"
      FOREIGN KEY ("subject_user_id") REFERENCES "public"."core_user"("id")
      ON DELETE restrict ON UPDATE no action NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'core_audit_event_payload_version_check') THEN
    ALTER TABLE "core_audit_event"
      ADD CONSTRAINT "core_audit_event_payload_version_check"
      CHECK ("core_audit_event"."payload_version" IN (0, 1));
  END IF;
  -- A typed row carries its payload and nothing in the legacy column; a legacy
  -- row carries no typed payload. Mixed, a reader could not say which was the
  -- evidence. Every existing row is legacy with a NULL payload, so this holds.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'core_audit_event_payload_generation_check') THEN
    ALTER TABLE "core_audit_event"
      ADD CONSTRAINT "core_audit_event_payload_generation_check"
      CHECK (("core_audit_event"."payload_version" = 1 AND "core_audit_event"."payload" IS NOT NULL AND "core_audit_event"."metadata_json" IS NULL)
        OR ("core_audit_event"."payload_version" = 0 AND "core_audit_event"."payload" IS NULL));
  END IF;
END
$$;--> statement-breakpoint

-- 3. Backfill -----------------------------------------------------------------
--
-- Exact derivations only. Each joins the row's own (entity_type, entity_id) to
-- the table that entity lives in, so an id pointing at a row that no longer
-- exists — or never did — matches nothing and stays NULL. A guess would be
-- worse than a gap: the history would then say something the record never did.

-- 3a. The application an event belongs to: the entity's own `application_id`,
--     or, for a payment or an assessment, the application of its award.
UPDATE "core_audit_event" AS event
   SET "application_id" = link.application_id
  FROM (
    SELECT 'SEB_APPLICATION' AS entity_type, "id" AS entity_id, "id" AS application_id FROM "seb_application"
    UNION ALL SELECT 'SEB_APPLICATION_DOCUMENT', "id", "application_id" FROM "seb_application_document"
    UNION ALL SELECT 'SEB_DOCUMENT_UPLOAD_INTENT', "id", "application_id" FROM "seb_document_upload_intent"
    UNION ALL SELECT 'SEB_APPLICATION_INTERNAL_NOTE', "id", "application_id" FROM "seb_application_internal_note"
    UNION ALL SELECT 'SEB_DESK_REVIEW', "id", "application_id" FROM "seb_desk_review"
    UNION ALL SELECT 'SEB_PARTNER_BANK_REFERRAL', "id", "application_id" FROM "seb_partner_bank_referral"
    UNION ALL SELECT 'SEB_PARTNER_BANK_OUTCOME', "id", "application_id" FROM "seb_partner_bank_outcome"
    UNION ALL SELECT 'SEB_PROGRAMME_DECISION', "id", "application_id" FROM "seb_programme_decision"
    UNION ALL SELECT 'SEB_FUNDING_AWARD', "id", "application_id" FROM "seb_funding_award"
    UNION ALL SELECT 'SEB_RECOVERY_CASE', "id", "application_id" FROM "seb_recovery_case"
    UNION ALL SELECT 'SEB_DISBURSEMENT', disbursement."id", award."application_id"
      FROM "seb_disbursement" AS disbursement
      JOIN "seb_funding_award" AS award ON award."id" = disbursement."funding_award_id"
    UNION ALL SELECT 'SEB_AWARD_ASSESSMENT', assessment."id", award."application_id"
      FROM "seb_award_assessment" AS assessment
      JOIN "seb_funding_award" AS award ON award."id" = assessment."funding_award_id"
  ) AS link
 WHERE event."application_id" IS NULL
   AND event."entity_type" = link.entity_type
   AND event."entity_id" = link.entity_id;--> statement-breakpoint

-- 3b. Who an event was about, where its entity names a person: the user
--     itself, the holder of a grant, the owner of an enterprise.
UPDATE "core_audit_event" AS event
   SET "subject_user_id" = link.subject_user_id
  FROM (
    SELECT 'CORE_USER' AS entity_type, "id" AS entity_id, "id" AS subject_user_id FROM "core_user"
    UNION ALL SELECT 'CORE_USER_ROLE_GRANT', "id", "user_id" FROM "core_user_role_grant"
    UNION ALL SELECT 'SEB_ENTERPRISE', "id", "portal_owner_user_id" FROM "seb_enterprise"
  ) AS link
 WHERE event."subject_user_id" IS NULL
   AND event."entity_type" = link.entity_type
   AND event."entity_id" = link.entity_id;--> statement-breakpoint

-- 3c. A session or an account challenge belongs to the person who acted on it:
--     the only writer of those rows is their owner.
UPDATE "core_audit_event"
   SET "subject_user_id" = "actor_user_id"
 WHERE "subject_user_id" IS NULL
   AND "actor_user_id" IS NOT NULL
   AND "entity_type" IN ('CORE_SESSION', 'CORE_ACCOUNT_CHALLENGE');--> statement-breakpoint

-- 3d. Anything that happened to an application was about its applicant. Runs
--     after 3a, which is what gives these rows their application.
UPDATE "core_audit_event" AS event
   SET "subject_user_id" = application."applicant_user_id"
  FROM "seb_application" AS application
 WHERE event."subject_user_id" IS NULL
   AND event."application_id" = application."id";--> statement-breakpoint

-- 4. Validate the foreign key ---------------------------------------------------
--
-- Every value 3b–3d wrote was read from a column that itself references
-- `core_user`, so this cannot fail; it is here so the constraint is trusted by
-- the planner and reported as valid. Validating an already valid constraint
-- is a no-op, which keeps a second run harmless.
ALTER TABLE "core_audit_event" VALIDATE CONSTRAINT "core_audit_event_subject_user_id_core_user_id_fk";--> statement-breakpoint

-- 5. Indexes ------------------------------------------------------------------
--
-- "Everything done to this person" and "everything that happened to this
-- application", in the history's cursor order. Partial, because most rows have
-- neither and an index of NULLs would cost every insert and serve no read.
-- Built after the backfill so each is written once.

CREATE INDEX IF NOT EXISTS "core_audit_event_subject_idx" ON "core_audit_event" USING btree ("subject_user_id","created_at","id") WHERE "core_audit_event"."subject_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "core_audit_event_application_idx" ON "core_audit_event" USING btree ("application_id","created_at","id") WHERE "core_audit_event"."application_id" IS NOT NULL;
