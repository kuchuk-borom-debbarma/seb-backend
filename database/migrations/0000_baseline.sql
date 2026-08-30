-- The baseline: the whole schema in one migration, generated from
-- `src/db/schema/**` — the same generator that writes `database/schema.sql`,
-- so the two are twins (this file adds only statement breakpoints, these
-- comments, and the one seed row at the end). The earlier three-link chain
-- was collapsed into this file while the programme was still in development
-- and every database could be converged first; from here the chain grows
-- normally and is never rewritten again.
--
-- Reading order: every CREATE TABLE first (in the schema modules' discovery
-- order, so domains interleave), then every foreign key, then every index.
-- That ordering is the generator's and it is load-bearing — tables exist
-- before anything references them. The reasoning behind each table lives as
-- prose in its Drizzle schema file; `database/schema.sql` is byte-checked by
-- `db:schema:check` and cannot carry commentary, so this is the one SQL file
-- that explains itself.

CREATE TABLE "core_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"outcome" text NOT NULL,
	"request_id" text,
	"ip_address" text,
	"user_agent" text,
	"changes_json" text,
	"metadata_json" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "core_audit_event_outcome_check" CHECK ("core_audit_event"."outcome" IN ('SUCCESS', 'FAILURE'))
);
--> statement-breakpoint
CREATE TABLE "core_account_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"challenge_digest" text NOT NULL,
	"otp_digest" text NOT NULL,
	"attempts_remaining" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "core_account_challenge_challenge_digest_unique" UNIQUE("challenge_digest"),
	CONSTRAINT "core_account_challenge_attempts_check" CHECK ("core_account_challenge"."attempts_remaining" BETWEEN 0 AND 20),
	CONSTRAINT "core_account_challenge_purpose_check" CHECK ("core_account_challenge"."purpose" IN ('PASSWORD_RESET', 'EMAIL_CHANGE')),
	CONSTRAINT "core_account_challenge_status_check" CHECK ("core_account_challenge"."status" IN ('PENDING', 'CONSUMED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED'))
);
--> statement-breakpoint
CREATE TABLE "core_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "core_session_token_digest_unique" UNIQUE("token_digest")
);
--> statement-breakpoint
CREATE TABLE "core_signup_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"challenge_digest" text NOT NULL,
	"otp_digest" text NOT NULL,
	"attempts_remaining" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"consumed_by_user_id" text,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "core_signup_challenge_challenge_digest_unique" UNIQUE("challenge_digest"),
	CONSTRAINT "core_signup_challenge_attempts_check" CHECK ("core_signup_challenge"."attempts_remaining" BETWEEN 0 AND 20),
	CONSTRAINT "core_signup_challenge_status_check" CHECK ("core_signup_challenge"."status" IN ('PENDING', 'CONSUMED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED'))
);
--> statement-breakpoint
CREATE TABLE "core_user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	"display_name" text,
	CONSTRAINT "core_user_email_unique" UNIQUE("email"),
	CONSTRAINT "core_user_row_version_check" CHECK ("core_user"."row_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "core_user_role_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" text,
	"grant_reason" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "core_user_role_grant_role_check" CHECK ("core_user_role_grant"."role" IN ('APPLICANT', 'REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER', 'SUPER_ADMIN')),
	CONSTRAINT "core_user_role_grant_revocation_check" CHECK (("core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."revoked_by_user_id" IS NULL AND "core_user_role_grant"."revocation_reason" IS NULL)
        OR ("core_user_role_grant"."revoked_at" IS NOT NULL
          AND "core_user_role_grant"."revocation_reason" IS NOT NULL
          AND "core_user_role_grant"."revoked_at" >= "core_user_role_grant"."granted_at"))
);
--> statement-breakpoint
CREATE TABLE "seb_application" (
	"id" text PRIMARY KEY NOT NULL,
	"applicant_user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"funding_case_id" text NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"application_type" text DEFAULT 'INITIAL' NOT NULL,
	"phase_number" integer DEFAULT 1 NOT NULL,
	"reference_number" text,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	"assigned_to_user_id" text,
	"assigned_at" timestamp with time zone,
	"assignment_version" integer DEFAULT 0 NOT NULL,
	"first_submitted_at" timestamp with time zone,
	CONSTRAINT "seb_application_reference_number_unique" UNIQUE("reference_number"),
	CONSTRAINT "seb_application_id_cycle_uq" UNIQUE("id","programme_cycle_id"),
	CONSTRAINT "seb_application_case_id_uq" UNIQUE("funding_case_id","id"),
	CONSTRAINT "seb_application_owner_id_uq" UNIQUE("applicant_user_id","id"),
	CONSTRAINT "seb_application_current_version_check" CHECK ("seb_application"."current_version" >= 1),
	CONSTRAINT "seb_application_status_version_check" CHECK ("seb_application"."status_version" >= 1),
	CONSTRAINT "seb_application_assignment_version_check" CHECK ("seb_application"."assignment_version" >= 0),
	CONSTRAINT "seb_application_assignment_group_check" CHECK (("seb_application"."assigned_to_user_id" IS NULL AND "seb_application"."assigned_at" IS NULL)
        OR ("seb_application"."assigned_to_user_id" IS NOT NULL AND "seb_application"."assigned_at" IS NOT NULL)),
	CONSTRAINT "seb_application_status_check" CHECK ("seb_application"."status" IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'AWAITING_DECISION', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED', 'CANCELLED')),
	CONSTRAINT "seb_application_type_check" CHECK ("seb_application"."application_type" IN ('INITIAL', 'EXPANSION')),
	CONSTRAINT "seb_application_phase_check" CHECK (("seb_application"."application_type" = 'INITIAL' AND "seb_application"."phase_number" = 1)
        OR ("seb_application"."application_type" = 'EXPANSION' AND "seb_application"."phase_number" >= 2))
);
--> statement-breakpoint
CREATE TABLE "seb_application_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_number" integer NOT NULL,
	"application_version" integer NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_submission_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_application_submission_number_check" CHECK ("seb_application_submission"."submission_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "seb_application_version" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"version" integer NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"application_type" text NOT NULL,
	"phase_number" integer NOT NULL,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"prior_sanction_order_number" text,
	"prior_sanction_date" date,
	"prior_net_disbursed_amount_paise" bigint,
	"continuous_operation_months" integer,
	"declaration_accepted_at" timestamp with time zone,
	"application_category" text,
	CONSTRAINT "seb_application_version_number_uq" UNIQUE("application_id","version"),
	CONSTRAINT "seb_application_version_cycle_pin_uq" UNIQUE("id","programme_cycle_id","programme_cycle_version"),
	CONSTRAINT "seb_application_version_category_check" CHECK ("seb_application_version"."application_category" IS NULL
        OR "seb_application_version"."application_category" IN ('CATEGORY_A', 'CATEGORY_B')),
	CONSTRAINT "seb_application_version_number_check" CHECK ("seb_application_version"."version" >= 1),
	CONSTRAINT "seb_application_version_type_check" CHECK ("seb_application_version"."application_type" IN ('INITIAL', 'EXPANSION')),
	CONSTRAINT "seb_application_version_phase_check" CHECK (("seb_application_version"."application_type" = 'INITIAL' AND "seb_application_version"."phase_number" = 1)
        OR ("seb_application_version"."application_type" = 'EXPANSION' AND "seb_application_version"."phase_number" >= 2)),
	CONSTRAINT "seb_application_version_change_type_check" CHECK ("seb_application_version"."change_type" IN ('INITIAL', 'SAVE', 'REVISION', 'SUBMISSION', 'RESUBMISSION')),
	CONSTRAINT "seb_application_version_prior_award_check" CHECK (("seb_application_version"."prior_net_disbursed_amount_paise" IS NULL
          OR ("seb_application_version"."prior_net_disbursed_amount_paise" >= 0
              AND "seb_application_version"."prior_net_disbursed_amount_paise" <= 9007199254740991))
        AND ("seb_application_version"."continuous_operation_months" IS NULL OR "seb_application_version"."continuous_operation_months" >= 0))
);
--> statement-breakpoint
CREATE TABLE "seb_funding_case" (
	"id" text PRIMARY KEY NOT NULL,
	"enterprise_id" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_funding_case_enterprise_id_unique" UNIQUE("enterprise_id"),
	CONSTRAINT "seb_funding_case_enterprise_id_uq" UNIQUE("enterprise_id","id"),
	CONSTRAINT "seb_funding_case_current_version_check" CHECK ("seb_funding_case"."current_version" >= 1),
	CONSTRAINT "seb_funding_case_status_check" CHECK ("seb_funding_case"."status" IN ('OPEN', 'CLOSED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "seb_funding_case_version" (
	"id" text PRIMARY KEY NOT NULL,
	"funding_case_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_funding_case_version_number_check" CHECK ("seb_funding_case_version"."version" >= 1),
	CONSTRAINT "seb_funding_case_version_status_check" CHECK ("seb_funding_case_version"."status" IN ('OPEN', 'CLOSED', 'CANCELLED')),
	CONSTRAINT "seb_funding_case_version_change_type_check" CHECK ("seb_funding_case_version"."change_type" IN ('CREATED', 'STATUS_CHANGED', 'CORRECTED'))
);
--> statement-breakpoint
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
CREATE TABLE "seb_application_document" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"field_key" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_application_document_version_check" CHECK ("seb_application_document"."current_version" >= 1),
	CONSTRAINT "seb_application_document_field_key_check" CHECK ("seb_application_document"."field_key" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "seb_application_document_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"document_version_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"status" text NOT NULL,
	"scanner_reference" text,
	"safe_message" text,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_document_scan_sequence_check" CHECK ("seb_application_document_scan"."sequence_number" >= 1),
	CONSTRAINT "seb_application_document_scan_status_check" CHECK ("seb_application_document_scan"."status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'ERROR')),
	CONSTRAINT "seb_application_document_scan_lifecycle_check" CHECK (("seb_application_document_scan"."status" = 'PENDING' AND "seb_application_document_scan"."scanned_at" IS NULL)
        OR ("seb_application_document_scan"."status" <> 'PENDING' AND "seb_application_document_scan"."scanned_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_application_document_version" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"operation" text NOT NULL,
	"r2_object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_document_version_r2_object_key_unique" UNIQUE("r2_object_key"),
	CONSTRAINT "seb_application_document_version_number_uq" UNIQUE("document_id","version"),
	CONSTRAINT "seb_application_document_version_number_check" CHECK ("seb_application_document_version"."version" >= 1),
	CONSTRAINT "seb_application_document_size_check" CHECK ("seb_application_document_version"."size_bytes" >= 0),
	CONSTRAINT "seb_application_document_operation_check" CHECK ("seb_application_document_version"."operation" IN ('UPLOAD', 'REPLACE'))
);
--> statement-breakpoint
CREATE TABLE "seb_application_submission_document" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"document_id" text NOT NULL,
	"document_version" integer NOT NULL,
	"field_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_submission_document_field_key_check" CHECK ("seb_application_submission_document"."field_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_application_submission_document_version_check" CHECK ("seb_application_submission_document"."document_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "seb_document_upload_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"applicant_user_id" text NOT NULL,
	"field_key" text NOT NULL,
	"expected_document_version" integer NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"cleanup_target_status" text,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_document_version_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_document_upload_intent_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "seb_document_upload_intent_field_key_check" CHECK ("seb_document_upload_intent"."field_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_document_upload_intent_status_check" CHECK ("seb_document_upload_intent"."status" IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')),
	CONSTRAINT "seb_document_upload_intent_expected_version_check" CHECK ("seb_document_upload_intent"."expected_document_version" >= 0),
	CONSTRAINT "seb_document_upload_intent_size_check" CHECK ("seb_document_upload_intent"."size_bytes" > 0 AND "seb_document_upload_intent"."size_bytes" <= 5242880),
	CONSTRAINT "seb_document_upload_intent_lifecycle_check" CHECK (("seb_document_upload_intent"."status" = 'FINALIZED'
          AND "seb_document_upload_intent"."finalized_document_version_id" IS NOT NULL
          AND "seb_document_upload_intent"."cleanup_target_status" IS NULL)
        OR ("seb_document_upload_intent"."status" = 'CLEANUP_PENDING'
          AND "seb_document_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_document_upload_intent"."cleanup_target_status" IN ('REJECTED', 'EXPIRED'))
        OR ("seb_document_upload_intent"."status" NOT IN ('FINALIZED', 'CLEANUP_PENDING')
          AND "seb_document_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_document_upload_intent"."cleanup_target_status" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_document" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_version_check" CHECK ("seb_cycle_policy_document"."current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_document_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"document_version_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"status" text NOT NULL,
	"scanner_reference" text,
	"safe_message" text,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_scan_sequence_check" CHECK ("seb_cycle_policy_document_scan"."sequence_number" >= 1),
	CONSTRAINT "seb_cycle_policy_document_scan_status_check" CHECK ("seb_cycle_policy_document_scan"."status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'ERROR')),
	CONSTRAINT "seb_cycle_policy_document_scan_lifecycle_check" CHECK (("seb_cycle_policy_document_scan"."status" = 'PENDING' AND "seb_cycle_policy_document_scan"."scanned_at" IS NULL)
        OR ("seb_cycle_policy_document_scan"."status" <> 'PENDING' AND "seb_cycle_policy_document_scan"."scanned_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_document_version" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"operation" text NOT NULL,
	"r2_object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_version_r2_object_key_unique" UNIQUE("r2_object_key"),
	CONSTRAINT "seb_cycle_policy_document_version_number_uq" UNIQUE("document_id","version"),
	CONSTRAINT "seb_cycle_policy_document_version_number_check" CHECK ("seb_cycle_policy_document_version"."version" >= 1),
	CONSTRAINT "seb_cycle_policy_document_size_check" CHECK ("seb_cycle_policy_document_version"."size_bytes" >= 0),
	CONSTRAINT "seb_cycle_policy_document_operation_check" CHECK ("seb_cycle_policy_document_version"."operation" IN ('UPLOAD', 'REPLACE'))
);
--> statement-breakpoint
CREATE TABLE "seb_cycle_policy_upload_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"expected_document_version" integer NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"cleanup_target_status" text,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_document_version_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_upload_intent_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "seb_cycle_policy_upload_intent_status_check" CHECK ("seb_cycle_policy_upload_intent"."status" IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')),
	CONSTRAINT "seb_cycle_policy_upload_intent_expected_version_check" CHECK ("seb_cycle_policy_upload_intent"."expected_document_version" >= 0),
	CONSTRAINT "seb_cycle_policy_upload_intent_size_check" CHECK ("seb_cycle_policy_upload_intent"."size_bytes" > 0 AND "seb_cycle_policy_upload_intent"."size_bytes" <= 5242880),
	CONSTRAINT "seb_cycle_policy_upload_intent_lifecycle_check" CHECK (("seb_cycle_policy_upload_intent"."status" = 'FINALIZED'
          AND "seb_cycle_policy_upload_intent"."finalized_document_version_id" IS NOT NULL
          AND "seb_cycle_policy_upload_intent"."cleanup_target_status" IS NULL)
        OR ("seb_cycle_policy_upload_intent"."status" = 'CLEANUP_PENDING'
          AND "seb_cycle_policy_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_cycle_policy_upload_intent"."cleanup_target_status" IN ('REJECTED', 'EXPIRED'))
        OR ("seb_cycle_policy_upload_intent"."status" NOT IN ('FINALIZED', 'CLEANUP_PENDING')
          AND "seb_cycle_policy_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_cycle_policy_upload_intent"."cleanup_target_status" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_partner_bank_outcome" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"referral_id" text NOT NULL,
	"outcome_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"decision_reference" text NOT NULL,
	"decision_date" date NOT NULL,
	"available_loan_amount_paise" bigint,
	"applicant_summary" text NOT NULL,
	"internal_note" text,
	"supersedes_outcome_id" text,
	"correction_reason_category_id" text,
	"correction_reason" text,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_partner_bank_outcome_referral_id_uq" UNIQUE("referral_id","id"),
	CONSTRAINT "seb_partner_bank_outcome_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_partner_bank_outcome_number_check" CHECK ("seb_partner_bank_outcome"."outcome_number" >= 1),
	CONSTRAINT "seb_partner_bank_outcome_type_check" CHECK ("seb_partner_bank_outcome"."outcome" IN ('RECOMMENDED', 'NOT_RECOMMENDED', 'MORE_INFORMATION_REQUIRED')),
	CONSTRAINT "seb_partner_bank_outcome_amount_check" CHECK ("seb_partner_bank_outcome"."available_loan_amount_paise" IS NULL
        OR ("seb_partner_bank_outcome"."available_loan_amount_paise" >= 0
            AND "seb_partner_bank_outcome"."available_loan_amount_paise" <= 9007199254740991)),
	CONSTRAINT "seb_partner_bank_outcome_correction_check" CHECK (("seb_partner_bank_outcome"."supersedes_outcome_id" IS NULL
          AND "seb_partner_bank_outcome"."correction_reason_category_id" IS NULL
          AND "seb_partner_bank_outcome"."correction_reason" IS NULL)
        OR ("seb_partner_bank_outcome"."supersedes_outcome_id" IS NOT NULL
          AND "seb_partner_bank_outcome"."correction_reason_category_id" IS NOT NULL
          AND "seb_partner_bank_outcome"."correction_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_partner_bank_referral" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"desk_review_id" text NOT NULL,
	"bank_name" text NOT NULL,
	"bank_branch" text,
	"referral_reference" text NOT NULL,
	"referral_date" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"internal_note" text,
	"referred_by_user_id" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_partner_bank_referral_referral_reference_unique" UNIQUE("referral_reference"),
	CONSTRAINT "seb_partner_bank_referral_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_partner_bank_referral_version_check" CHECK ("seb_partner_bank_referral"."current_version" >= 1),
	CONSTRAINT "seb_partner_bank_referral_status_check" CHECK ("seb_partner_bank_referral"."status" IN ('OPEN', 'RESPONDED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "seb_partner_bank_referral_version" (
	"id" text PRIMARY KEY NOT NULL,
	"referral_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"change_type" text NOT NULL,
	"reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_partner_bank_referral_version_check" CHECK ("seb_partner_bank_referral_version"."version" >= 1),
	CONSTRAINT "seb_partner_bank_referral_version_status_check" CHECK ("seb_partner_bank_referral_version"."status" IN ('OPEN', 'RESPONDED', 'CANCELLED')),
	CONSTRAINT "seb_partner_bank_referral_version_change_type_check" CHECK ("seb_partner_bank_referral_version"."change_type" IN ('REFERRED', 'RESPONDED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_decision" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"bank_outcome_id" text,
	"decision_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"decision_reference" text NOT NULL,
	"decision_date" date NOT NULL,
	"approved_amount_paise" bigint,
	"applicant_conditions" text,
	"reason_category_id" text,
	"applicant_message" text NOT NULL,
	"supersedes_decision_id" text,
	"correction_reason_category_id" text,
	"correction_reason" text,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"conflict_acknowledged" boolean DEFAULT false NOT NULL,
	CONSTRAINT "seb_programme_decision_decision_reference_unique" UNIQUE("decision_reference"),
	CONSTRAINT "seb_programme_decision_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_programme_decision_number_check" CHECK ("seb_programme_decision"."decision_number" >= 1),
	CONSTRAINT "seb_programme_decision_outcome_check" CHECK ("seb_programme_decision"."outcome" IN ('APPROVED', 'REJECTED', 'REVISION_REQUIRED')),
	CONSTRAINT "seb_programme_decision_amount_check" CHECK (("seb_programme_decision"."outcome" = 'APPROVED' AND "seb_programme_decision"."approved_amount_paise" > 0
          AND "seb_programme_decision"."approved_amount_paise" <= 9007199254740991)
        OR ("seb_programme_decision"."outcome" <> 'APPROVED' AND "seb_programme_decision"."approved_amount_paise" IS NULL)),
	CONSTRAINT "seb_programme_decision_reason_check" CHECK (("seb_programme_decision"."outcome" = 'APPROVED' AND "seb_programme_decision"."reason_category_id" IS NULL)
        OR ("seb_programme_decision"."outcome" <> 'APPROVED' AND "seb_programme_decision"."reason_category_id" IS NOT NULL)),
	CONSTRAINT "seb_programme_decision_correction_check" CHECK (("seb_programme_decision"."supersedes_decision_id" IS NULL
          AND "seb_programme_decision"."correction_reason_category_id" IS NULL
          AND "seb_programme_decision"."correction_reason" IS NULL)
        OR ("seb_programme_decision"."supersedes_decision_id" IS NOT NULL
          AND "seb_programme_decision"."correction_reason_category_id" IS NOT NULL
          AND "seb_programme_decision"."correction_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_application_version_answer" (
	"id" text PRIMARY KEY NOT NULL,
	"application_version_id" text NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"field_key" text NOT NULL,
	"entry_index" integer DEFAULT 0 NOT NULL,
	"value_ordinal" integer DEFAULT 0 NOT NULL,
	"value_text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_version_answer_slot_uq" UNIQUE("application_version_id","field_key","entry_index","value_ordinal"),
	CONSTRAINT "seb_application_version_answer_entry_check" CHECK ("seb_application_version_answer"."entry_index" >= 0 AND "seb_application_version_answer"."value_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seb_enterprise" (
	"id" text PRIMARY KEY NOT NULL,
	"portal_owner_user_id" text NOT NULL,
	"current_name" text NOT NULL,
	"registration_type" text NOT NULL,
	"registration_number" text,
	"gstin" text,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_enterprise_gstin_unique" UNIQUE("gstin"),
	CONSTRAINT "seb_enterprise_owner_id_uq" UNIQUE("portal_owner_user_id","id"),
	CONSTRAINT "seb_enterprise_current_version_check" CHECK ("seb_enterprise"."current_version" >= 1),
	CONSTRAINT "seb_enterprise_status_check" CHECK ("seb_enterprise"."status" IN ('PROPOSED', 'ACTIVE', 'INACTIVE')),
	CONSTRAINT "seb_enterprise_registration_check" CHECK (("seb_enterprise"."registration_type" = 'SOLE_PROPRIETORSHIP')
        OR ("seb_enterprise"."registration_type" IN ('PRIVATE_LIMITED', 'LLP', 'OPC') AND "seb_enterprise"."registration_number" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_enterprise_version" (
	"id" text PRIMARY KEY NOT NULL,
	"enterprise_id" text NOT NULL,
	"version" integer NOT NULL,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"establishment_date" date,
	"registration_type" text NOT NULL,
	"registration_number" text,
	"gstin" text,
	"business_sector" text,
	"other_business_sector" text,
	"business_block_or_village" text,
	"business_district" text,
	"business_pin_code" text,
	"contact_number" text,
	"contact_email" text,
	"status" text NOT NULL,
	CONSTRAINT "seb_enterprise_version_number_check" CHECK ("seb_enterprise_version"."version" >= 1),
	CONSTRAINT "seb_enterprise_version_change_type_check" CHECK ("seb_enterprise_version"."change_type" IN ('CREATED', 'UPDATED', 'CORRECTED')),
	CONSTRAINT "seb_enterprise_version_status_check" CHECK ("seb_enterprise_version"."status" IN ('PROPOSED', 'ACTIVE', 'INACTIVE')),
	CONSTRAINT "seb_enterprise_version_registration_check" CHECK (("seb_enterprise_version"."registration_type" = 'SOLE_PROPRIETORSHIP')
        OR ("seb_enterprise_version"."registration_type" IN ('PRIVATE_LIMITED', 'LLP', 'OPC') AND "seb_enterprise_version"."registration_number" IS NOT NULL)),
	CONSTRAINT "seb_enterprise_version_district_check" CHECK ("seb_enterprise_version"."business_district" IS NULL OR "seb_enterprise_version"."business_district" IN ('DHALAI', 'GOMATI', 'KHOWAI', 'NORTH_TRIPURA', 'SEPAHIJALA', 'SOUTH_TRIPURA', 'UNAKOTI', 'WEST_TRIPURA')),
	CONSTRAINT "seb_enterprise_version_sector_check" CHECK ("seb_enterprise_version"."business_sector" IS NULL OR "seb_enterprise_version"."business_sector" IN ('AGRICULTURE_AND_ALLIED', 'HANDLOOM_TEXTILE_AND_HANDICRAFTS', 'FOOD_PROCESSING', 'TOURISM_AND_HOSPITALITY', 'INFORMATION_TECHNOLOGY', 'MANUFACTURING_AND_SERVICES', 'OTHER'))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_field" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"stage_key" text NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text NOT NULL,
	"role" text,
	"parent_field_key" text,
	"parent_field_type" text,
	"group_definition_key" text,
	"sort_order" integer NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"placeholder" text,
	"note" text,
	"tone" text,
	"width_hint" text,
	"prefix_text" text,
	"suffix_text" text,
	"autocomplete_hint" text,
	"show_char_count" boolean DEFAULT false NOT NULL,
	"textarea_rows" integer,
	"choice_style" text,
	"requirement" text NOT NULL,
	"source" text DEFAULT 'APPLICANT' NOT NULL,
	"repeat_min" integer,
	"repeat_max" integer,
	"min_length" integer,
	"max_length" integer,
	"pattern" text,
	"pattern_message" text,
	"min_value" bigint,
	"max_value" bigint,
	"min_date" date,
	"max_date" date,
	"relative_date_bound" text,
	"max_file_bytes" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_field_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","field_key"),
	CONSTRAINT "seb_programme_cycle_form_field_typed_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","field_key","field_type"),
	CONSTRAINT "seb_programme_cycle_form_field_key_check" CHECK ("seb_programme_cycle_form_field"."field_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_programme_cycle_form_field_type_check" CHECK ("seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE', 'BOOLEAN', 'ATTESTATION', 'STATEMENT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'FILE', 'REPEAT_GROUP')),
	CONSTRAINT "seb_programme_cycle_form_field_requirement_check" CHECK ("seb_programme_cycle_form_field"."requirement" IN ('REQUIRED', 'OPTIONAL', 'CONDITIONAL')),
	CONSTRAINT "seb_programme_cycle_form_field_source_check" CHECK ("seb_programme_cycle_form_field"."source" IN ('APPLICANT', 'SERVER_DERIVED')
        AND ("seb_programme_cycle_form_field"."source" = 'APPLICANT' OR "seb_programme_cycle_form_field"."parent_field_key" IS NULL)
        AND ("seb_programme_cycle_form_field"."role" IS NULL OR "seb_programme_cycle_form_field"."parent_field_key" IS NULL
          OR "seb_programme_cycle_form_field"."role" = 'APPLICANT_DATE_OF_BIRTH')),
	CONSTRAINT "seb_programme_cycle_form_field_order_check" CHECK ("seb_programme_cycle_form_field"."sort_order" >= 1),
	CONSTRAINT "seb_programme_cycle_form_field_role_check" CHECK ("seb_programme_cycle_form_field"."role" IS NULL
        OR ("seb_programme_cycle_form_field"."role" = 'APPLICANT_DATE_OF_BIRTH' AND "seb_programme_cycle_form_field"."field_type" = 'DATE')
        OR ("seb_programme_cycle_form_field"."role" = 'SEED_FUND_REQUESTED_PAISE' AND "seb_programme_cycle_form_field"."field_key" = 'SEED_FUND_REQUESTED_PAISE' AND "seb_programme_cycle_form_field"."field_type" = 'MONEY_PAISE')),
	CONSTRAINT "seb_programme_cycle_form_field_parent_check" CHECK (("seb_programme_cycle_form_field"."parent_field_key" IS NULL AND "seb_programme_cycle_form_field"."parent_field_type" IS NULL)
        OR ("seb_programme_cycle_form_field"."parent_field_key" IS NOT NULL AND "seb_programme_cycle_form_field"."parent_field_type" = 'REPEAT_GROUP')),
	CONSTRAINT "seb_programme_cycle_form_field_definition_use_check" CHECK ("seb_programme_cycle_form_field"."group_definition_key" IS NULL OR "seb_programme_cycle_form_field"."field_type" = 'REPEAT_GROUP'),
	CONSTRAINT "seb_programme_cycle_form_field_nesting_check" CHECK ("seb_programme_cycle_form_field"."field_type" <> 'REPEAT_GROUP' OR "seb_programme_cycle_form_field"."parent_field_key" IS NULL),
	CONSTRAINT "seb_programme_cycle_form_field_repeat_check" CHECK (("seb_programme_cycle_form_field"."field_type" <> 'REPEAT_GROUP'
          AND "seb_programme_cycle_form_field"."repeat_min" IS NULL AND "seb_programme_cycle_form_field"."repeat_max" IS NULL)
        OR ("seb_programme_cycle_form_field"."field_type" = 'REPEAT_GROUP'
          AND "seb_programme_cycle_form_field"."repeat_min" IS NOT NULL AND "seb_programme_cycle_form_field"."repeat_max" IS NOT NULL
          AND "seb_programme_cycle_form_field"."repeat_min" >= 0
          AND "seb_programme_cycle_form_field"."repeat_max" >= greatest("seb_programme_cycle_form_field"."repeat_min", 1)
          AND "seb_programme_cycle_form_field"."repeat_max" <= 20)),
	CONSTRAINT "seb_programme_cycle_form_field_length_check" CHECK (("seb_programme_cycle_form_field"."field_type" NOT IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'MULTI_CHOICE')
          AND "seb_programme_cycle_form_field"."min_length" IS NULL AND "seb_programme_cycle_form_field"."max_length" IS NULL)
        OR ("seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'MULTI_CHOICE')
          AND ("seb_programme_cycle_form_field"."min_length" IS NULL OR "seb_programme_cycle_form_field"."min_length" >= 0)
          AND ("seb_programme_cycle_form_field"."max_length" IS NULL OR "seb_programme_cycle_form_field"."max_length" >= 1)
          AND ("seb_programme_cycle_form_field"."min_length" IS NULL OR "seb_programme_cycle_form_field"."max_length" IS NULL
               OR "seb_programme_cycle_form_field"."max_length" >= "seb_programme_cycle_form_field"."min_length"))),
	CONSTRAINT "seb_programme_cycle_form_field_pattern_check" CHECK (("seb_programme_cycle_form_field"."field_type" NOT IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE')
          AND "seb_programme_cycle_form_field"."pattern" IS NULL AND "seb_programme_cycle_form_field"."pattern_message" IS NULL)
        OR ("seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE')
          AND ("seb_programme_cycle_form_field"."pattern" IS NOT NULL OR "seb_programme_cycle_form_field"."pattern_message" IS NULL)
          AND ("seb_programme_cycle_form_field"."pattern" IS NULL OR "seb_programme_cycle_form_field"."max_length" IS NOT NULL))),
	CONSTRAINT "seb_programme_cycle_form_field_numeric_check" CHECK (("seb_programme_cycle_form_field"."field_type" NOT IN ('INTEGER', 'MONEY_PAISE')
          AND "seb_programme_cycle_form_field"."min_value" IS NULL AND "seb_programme_cycle_form_field"."max_value" IS NULL)
        OR ("seb_programme_cycle_form_field"."field_type" = 'INTEGER'
          AND ("seb_programme_cycle_form_field"."min_value" IS NULL OR "seb_programme_cycle_form_field"."max_value" IS NULL
               OR "seb_programme_cycle_form_field"."max_value" >= "seb_programme_cycle_form_field"."min_value"))
        OR ("seb_programme_cycle_form_field"."field_type" = 'MONEY_PAISE'
          AND "seb_programme_cycle_form_field"."min_value" IS NOT NULL AND "seb_programme_cycle_form_field"."min_value" >= 0
          AND ("seb_programme_cycle_form_field"."max_value" IS NULL
               OR ("seb_programme_cycle_form_field"."max_value" >= "seb_programme_cycle_form_field"."min_value"
                   AND "seb_programme_cycle_form_field"."max_value" <= 9007199254740991)))),
	CONSTRAINT "seb_programme_cycle_form_field_date_check" CHECK (("seb_programme_cycle_form_field"."field_type" <> 'DATE'
          AND "seb_programme_cycle_form_field"."min_date" IS NULL AND "seb_programme_cycle_form_field"."max_date" IS NULL
          AND "seb_programme_cycle_form_field"."relative_date_bound" IS NULL)
        OR ("seb_programme_cycle_form_field"."field_type" = 'DATE'
          AND ("seb_programme_cycle_form_field"."min_date" IS NULL OR "seb_programme_cycle_form_field"."max_date" IS NULL
               OR "seb_programme_cycle_form_field"."max_date" >= "seb_programme_cycle_form_field"."min_date"))),
	CONSTRAINT "seb_programme_cycle_form_field_relative_date_check" CHECK ("seb_programme_cycle_form_field"."relative_date_bound" IS NULL
        OR "seb_programme_cycle_form_field"."relative_date_bound" IN ('NOT_FUTURE', 'NOT_PAST')),
	CONSTRAINT "seb_programme_cycle_form_field_file_check" CHECK (("seb_programme_cycle_form_field"."field_type" <> 'FILE' AND "seb_programme_cycle_form_field"."max_file_bytes" IS NULL)
        OR ("seb_programme_cycle_form_field"."field_type" = 'FILE'
          AND ("seb_programme_cycle_form_field"."max_file_bytes" IS NULL
               OR ("seb_programme_cycle_form_field"."max_file_bytes" > 0 AND "seb_programme_cycle_form_field"."max_file_bytes" <= 5242880)))),
	CONSTRAINT "seb_programme_cycle_form_field_placeholder_check" CHECK ("seb_programme_cycle_form_field"."placeholder" IS NULL
        OR (char_length("seb_programme_cycle_form_field"."placeholder") <= 200
          AND "seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE'))),
	CONSTRAINT "seb_programme_cycle_form_field_note_check" CHECK ("seb_programme_cycle_form_field"."note" IS NULL OR char_length("seb_programme_cycle_form_field"."note") <= 500),
	CONSTRAINT "seb_programme_cycle_form_field_tone_check" CHECK ("seb_programme_cycle_form_field"."tone" IS NULL
        OR "seb_programme_cycle_form_field"."tone" IN ('INFO', 'WARNING', 'SUCCESS', 'DANGER')),
	CONSTRAINT "seb_programme_cycle_form_field_width_check" CHECK ("seb_programme_cycle_form_field"."width_hint" IS NULL
        OR "seb_programme_cycle_form_field"."width_hint" IN ('FULL', 'TWO_THIRDS', 'ONE_HALF', 'ONE_THIRD', 'CHAR_2', 'CHAR_4', 'CHAR_10', 'CHAR_20')),
	CONSTRAINT "seb_programme_cycle_form_field_affix_check" CHECK (("seb_programme_cycle_form_field"."prefix_text" IS NULL
          OR (char_length("seb_programme_cycle_form_field"."prefix_text") BETWEEN 1 AND 8
            AND "seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'INTEGER', 'MONEY_PAISE')))
        AND ("seb_programme_cycle_form_field"."suffix_text" IS NULL
          OR (char_length("seb_programme_cycle_form_field"."suffix_text") BETWEEN 1 AND 8
            AND "seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'INTEGER', 'MONEY_PAISE')))),
	CONSTRAINT "seb_programme_cycle_form_field_autocomplete_check" CHECK ("seb_programme_cycle_form_field"."autocomplete_hint" IS NULL
        OR ("seb_programme_cycle_form_field"."autocomplete_hint" IN ('name', 'given-name', 'family-name', 'email', 'tel', 'postal-code', 'street-address', 'address-line1', 'address-line2', 'address-level1', 'address-level2', 'bday', 'organization', 'off')
          AND "seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER'))),
	CONSTRAINT "seb_programme_cycle_form_field_char_count_check" CHECK (NOT "seb_programme_cycle_form_field"."show_char_count"
        OR ("seb_programme_cycle_form_field"."field_type" IN ('TEXT', 'LONG_TEXT') AND "seb_programme_cycle_form_field"."max_length" IS NOT NULL)),
	CONSTRAINT "seb_programme_cycle_form_field_rows_check" CHECK ("seb_programme_cycle_form_field"."textarea_rows" IS NULL
        OR ("seb_programme_cycle_form_field"."field_type" = 'LONG_TEXT'
          AND "seb_programme_cycle_form_field"."textarea_rows" >= 2 AND "seb_programme_cycle_form_field"."textarea_rows" <= 20)),
	CONSTRAINT "seb_programme_cycle_form_field_choice_style_check" CHECK ("seb_programme_cycle_form_field"."choice_style" IS NULL
        OR ("seb_programme_cycle_form_field"."field_type" = 'SINGLE_CHOICE'
          AND "seb_programme_cycle_form_field"."choice_style" IN ('RADIO', 'DROPDOWN', 'SEGMENTED', 'CARD'))
        OR ("seb_programme_cycle_form_field"."field_type" = 'MULTI_CHOICE'
          AND "seb_programme_cycle_form_field"."choice_style" IN ('CHECKBOX_LIST', 'MULTISELECT'))),
	CONSTRAINT "seb_programme_cycle_form_field_statement_check" CHECK ("seb_programme_cycle_form_field"."field_type" <> 'STATEMENT'
        OR ("seb_programme_cycle_form_field"."requirement" = 'OPTIONAL'
          AND "seb_programme_cycle_form_field"."role" IS NULL
          AND "seb_programme_cycle_form_field"."parent_field_key" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_field_condition" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"field_key" text NOT NULL,
	"effect" text NOT NULL,
	"group_number" integer NOT NULL,
	"sequence_number" integer NOT NULL,
	"source_field_key" text NOT NULL,
	"source_field_type" text NOT NULL,
	"operator" text NOT NULL,
	"comparison_value" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_field_condition_effect_check" CHECK ("seb_programme_cycle_form_field_condition"."effect" IN ('VISIBLE_WHEN', 'REQUIRED_WHEN')),
	CONSTRAINT "seb_programme_cycle_form_field_condition_operator_check" CHECK ("seb_programme_cycle_form_field_condition"."operator" IN ('EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'GREATER_OR_EQUAL', 'LESS_THAN', 'LESS_OR_EQUAL', 'IS_PRESENT', 'IS_ABSENT')),
	CONSTRAINT "seb_programme_cycle_form_field_condition_group_check" CHECK ("seb_programme_cycle_form_field_condition"."group_number" >= 1 AND "seb_programme_cycle_form_field_condition"."sequence_number" >= 1),
	CONSTRAINT "seb_programme_cycle_form_field_condition_self_check" CHECK ("seb_programme_cycle_form_field_condition"."source_field_key" <> "seb_programme_cycle_form_field_condition"."field_key"),
	CONSTRAINT "seb_programme_cycle_form_field_condition_value_check" CHECK (("seb_programme_cycle_form_field_condition"."operator" IN ('IS_PRESENT', 'IS_ABSENT') AND "seb_programme_cycle_form_field_condition"."comparison_value" IS NULL)
        OR ("seb_programme_cycle_form_field_condition"."operator" NOT IN ('IS_PRESENT', 'IS_ABSENT') AND "seb_programme_cycle_form_field_condition"."comparison_value" IS NOT NULL)),
	CONSTRAINT "seb_programme_cycle_form_field_condition_source_check" CHECK ("seb_programme_cycle_form_field_condition"."source_field_type" <> 'REPEAT_GROUP'
        AND ("seb_programme_cycle_form_field_condition"."source_field_type" <> 'FILE' OR "seb_programme_cycle_form_field_condition"."operator" IN ('IS_PRESENT', 'IS_ABSENT'))
        AND ("seb_programme_cycle_form_field_condition"."operator" NOT IN ('GREATER_THAN', 'GREATER_OR_EQUAL', 'LESS_THAN', 'LESS_OR_EQUAL')
             OR "seb_programme_cycle_form_field_condition"."source_field_type" IN ('INTEGER', 'MONEY_PAISE', 'DATE')))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_field_option" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text NOT NULL,
	"option_value" text NOT NULL,
	"option_label" text NOT NULL,
	"option_description" text,
	"icon_name" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_field_option_order_check" CHECK ("seb_programme_cycle_form_field_option"."sort_order" >= 1),
	CONSTRAINT "seb_programme_cycle_form_field_option_presentation_check" CHECK (("seb_programme_cycle_form_field_option"."option_description" IS NULL
          OR (char_length("seb_programme_cycle_form_field_option"."option_description") <= 200
            AND "seb_programme_cycle_form_field_option"."field_type" IN ('SINGLE_CHOICE', 'MULTI_CHOICE')))
        AND ("seb_programme_cycle_form_field_option"."icon_name" IS NULL
          OR ("seb_programme_cycle_form_field_option"."icon_name" ~ '^[a-z0-9-]{1,32}$'
            AND "seb_programme_cycle_form_field_option"."field_type" IN ('SINGLE_CHOICE', 'MULTI_CHOICE')))),
	CONSTRAINT "seb_programme_cycle_form_field_option_value_check" CHECK (("seb_programme_cycle_form_field_option"."field_type" IN ('SINGLE_CHOICE', 'MULTI_CHOICE')
          AND "seb_programme_cycle_form_field_option"."option_value" ~ '^[A-Z][A-Z0-9_]{1,63}$')
        OR ("seb_programme_cycle_form_field_option"."field_type" = 'FILE'
          AND "seb_programme_cycle_form_field_option"."option_value" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_group_definition" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"definition_key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_group_definition_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","definition_key"),
	CONSTRAINT "seb_programme_cycle_form_group_definition_key_check" CHECK ("seb_programme_cycle_form_group_definition"."definition_key" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_group_definition_member" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"definition_key" text NOT NULL,
	"member_key" text NOT NULL,
	"field_type" text NOT NULL,
	"role" text,
	"sort_order" integer NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"placeholder" text,
	"note" text,
	"tone" text,
	"width_hint" text,
	"prefix_text" text,
	"suffix_text" text,
	"autocomplete_hint" text,
	"show_char_count" boolean DEFAULT false NOT NULL,
	"textarea_rows" integer,
	"choice_style" text,
	"requirement" text NOT NULL,
	"min_length" integer,
	"max_length" integer,
	"pattern" text,
	"pattern_message" text,
	"min_value" bigint,
	"max_value" bigint,
	"min_date" date,
	"max_date" date,
	"relative_date_bound" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","definition_key","member_key"),
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_key_check" CHECK ("seb_programme_cycle_form_group_definition_member"."member_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_order_check" CHECK ("seb_programme_cycle_form_group_definition_member"."sort_order" >= 1),
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_type_check" CHECK ("seb_programme_cycle_form_group_definition_member"."field_type" NOT IN ('REPEAT_GROUP', 'FILE', 'STATEMENT')
        AND "seb_programme_cycle_form_group_definition_member"."field_type" IN ('TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'INTEGER', 'MONEY_PAISE', 'BOOLEAN', 'ATTESTATION', 'SINGLE_CHOICE', 'MULTI_CHOICE')),
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_role_check" CHECK ("seb_programme_cycle_form_group_definition_member"."role" IS NULL
        OR ("seb_programme_cycle_form_group_definition_member"."role" = 'APPLICANT_DATE_OF_BIRTH' AND "seb_programme_cycle_form_group_definition_member"."field_type" = 'DATE')),
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_requirement_check" CHECK ("seb_programme_cycle_form_group_definition_member"."requirement" IN ('REQUIRED', 'OPTIONAL', 'CONDITIONAL'))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_group_definition_member_option" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"definition_key" text NOT NULL,
	"member_key" text NOT NULL,
	"option_value" text NOT NULL,
	"option_label" text NOT NULL,
	"option_description" text,
	"icon_name" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_option_order_check" CHECK ("seb_programme_cycle_form_group_definition_member_option"."sort_order" >= 1),
	CONSTRAINT "seb_programme_cycle_form_group_definition_member_option_value_check" CHECK ("seb_programme_cycle_form_group_definition_member_option"."option_value" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_form_stage" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"stage_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"icon_name" text,
	"estimated_minutes" integer,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_stage_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","stage_key"),
	CONSTRAINT "seb_programme_cycle_form_stage_key_check" CHECK ("seb_programme_cycle_form_stage"."stage_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_programme_cycle_form_stage_order_check" CHECK ("seb_programme_cycle_form_stage"."sort_order" >= 1),
	CONSTRAINT "seb_programme_cycle_form_stage_description_check" CHECK ("seb_programme_cycle_form_stage"."description" IS NULL OR char_length("seb_programme_cycle_form_stage"."description") <= 500),
	CONSTRAINT "seb_programme_cycle_form_stage_icon_check" CHECK ("seb_programme_cycle_form_stage"."icon_name" IS NULL OR "seb_programme_cycle_form_stage"."icon_name" ~ '^[a-z0-9-]{1,32}$'),
	CONSTRAINT "seb_programme_cycle_form_stage_minutes_check" CHECK ("seb_programme_cycle_form_stage"."estimated_minutes" IS NULL
        OR ("seb_programme_cycle_form_stage"."estimated_minutes" >= 1 AND "seb_programme_cycle_form_stage"."estimated_minutes" <= 120))
);
--> statement-breakpoint
CREATE TABLE "seb_application_qualifying_award" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"funding_case_id" text NOT NULL,
	"current_funding_award_id" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"current_version" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" text,
	"cancellation_reason" text,
	CONSTRAINT "seb_application_qualifying_award_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "seb_application_qualifying_award_id_case_uq" UNIQUE("id","funding_case_id"),
	CONSTRAINT "seb_application_qualifying_award_version_check" CHECK ("seb_application_qualifying_award"."current_version" >= 1),
	CONSTRAINT "seb_application_qualifying_award_status_check" CHECK ("seb_application_qualifying_award"."status" IN ('ACTIVE', 'CANCELLED')),
	CONSTRAINT "seb_application_qualifying_award_lifecycle_check" CHECK (("seb_application_qualifying_award"."status" = 'ACTIVE'
          AND "seb_application_qualifying_award"."current_funding_award_id" IS NOT NULL
          AND "seb_application_qualifying_award"."cancelled_at" IS NULL
          AND "seb_application_qualifying_award"."cancelled_by_user_id" IS NULL
          AND "seb_application_qualifying_award"."cancellation_reason" IS NULL)
        OR ("seb_application_qualifying_award"."status" = 'CANCELLED'
          AND "seb_application_qualifying_award"."current_funding_award_id" IS NULL
          AND "seb_application_qualifying_award"."cancelled_at" IS NOT NULL
          AND "seb_application_qualifying_award"."cancelled_by_user_id" IS NOT NULL
          AND "seb_application_qualifying_award"."cancellation_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_application_qualifying_award_version" (
	"id" text PRIMARY KEY NOT NULL,
	"qualifying_award_link_id" text NOT NULL,
	"funding_case_id" text NOT NULL,
	"version" integer NOT NULL,
	"funding_award_id" text NOT NULL,
	"status" text NOT NULL,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_qualifying_award_version_number_check" CHECK ("seb_application_qualifying_award_version"."version" >= 1),
	CONSTRAINT "seb_application_qualifying_award_version_status_check" CHECK ("seb_application_qualifying_award_version"."status" IN ('ACTIVE', 'CANCELLED')),
	CONSTRAINT "seb_application_qualifying_award_version_change_type_check" CHECK ("seb_application_qualifying_award_version"."change_type" IN ('LINKED', 'CORRECTED', 'CANCELLED')),
	CONSTRAINT "seb_application_qualifying_award_version_state_check" CHECK (("seb_application_qualifying_award_version"."change_type" IN ('LINKED', 'CORRECTED') AND "seb_application_qualifying_award_version"."status" = 'ACTIVE')
        OR ("seb_application_qualifying_award_version"."change_type" = 'CANCELLED' AND "seb_application_qualifying_award_version"."status" = 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "seb_award_assessment" (
	"id" text PRIMARY KEY NOT NULL,
	"funding_award_id" text NOT NULL,
	"assessment_type" text NOT NULL,
	"assessment_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"utilization_obligation_id" text,
	"evidence_reference" text NOT NULL,
	"applicant_summary" text NOT NULL,
	"internal_note" text,
	"assessed_by_user_id" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_award_assessment_number_check" CHECK ("seb_award_assessment"."assessment_number" >= 1),
	CONSTRAINT "seb_award_assessment_type_check" CHECK ("seb_award_assessment"."assessment_type" IN ('UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT')),
	CONSTRAINT "seb_award_assessment_outcome_check" CHECK ("seb_award_assessment"."outcome" IN ('PASSED', 'FAILED')),
	CONSTRAINT "seb_award_assessment_scope_check" CHECK (("seb_award_assessment"."assessment_type" = 'UTILIZATION' AND "seb_award_assessment"."utilization_obligation_id" IS NOT NULL)
        OR ("seb_award_assessment"."assessment_type" IN ('PERFORMANCE', 'FINANCIAL_AUDIT') AND "seb_award_assessment"."utilization_obligation_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_disbursement" (
	"id" text PRIMARY KEY NOT NULL,
	"funding_award_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"entry_type" text NOT NULL,
	"related_disbursement_id" text,
	"amount_paise" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"external_reference" text,
	"approval_reference" text,
	"approval_date" date,
	"bank_account_verified_at" timestamp with time zone,
	"performance_agreement_reference" text,
	"performance_agreement_executed_at" timestamp with time zone,
	"physical_verification_required" boolean,
	"physical_verification_reference" text,
	"physical_verification_completed_at" timestamp with time zone,
	"reason_category_id" text,
	"applicant_message" text,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_disbursement_external_reference_unique" UNIQUE("external_reference"),
	CONSTRAINT "seb_disbursement_award_id_uq" UNIQUE("funding_award_id","id"),
	CONSTRAINT "seb_disbursement_sequence_check" CHECK ("seb_disbursement"."sequence_number" >= 1),
	CONSTRAINT "seb_disbursement_amount_check" CHECK ("seb_disbursement"."amount_paise" > 0 AND "seb_disbursement"."amount_paise" <= 9007199254740991),
	CONSTRAINT "seb_disbursement_entry_type_check" CHECK ("seb_disbursement"."entry_type" IN ('RELEASE', 'REVERSAL')),
	CONSTRAINT "seb_disbursement_relation_check" CHECK (("seb_disbursement"."entry_type" = 'RELEASE' AND "seb_disbursement"."related_disbursement_id" IS NULL)
        OR ("seb_disbursement"."entry_type" = 'REVERSAL' AND "seb_disbursement"."related_disbursement_id" IS NOT NULL)),
	CONSTRAINT "seb_disbursement_release_evidence_check" CHECK (("seb_disbursement"."entry_type" = 'RELEASE'
          AND "seb_disbursement"."approval_reference" IS NOT NULL
          AND "seb_disbursement"."approval_date" IS NOT NULL
          AND "seb_disbursement"."bank_account_verified_at" IS NOT NULL
          AND "seb_disbursement"."performance_agreement_reference" IS NOT NULL
          AND "seb_disbursement"."performance_agreement_executed_at" IS NOT NULL
          AND (("seb_disbursement"."physical_verification_required" = false
              AND "seb_disbursement"."physical_verification_reference" IS NULL
              AND "seb_disbursement"."physical_verification_completed_at" IS NULL)
            OR ("seb_disbursement"."physical_verification_required" = true
              AND "seb_disbursement"."physical_verification_reference" IS NOT NULL
              AND "seb_disbursement"."physical_verification_completed_at" IS NOT NULL)))
        OR ("seb_disbursement"."entry_type" = 'REVERSAL'
          AND "seb_disbursement"."approval_reference" IS NULL
          AND "seb_disbursement"."approval_date" IS NULL
          AND "seb_disbursement"."bank_account_verified_at" IS NULL
          AND "seb_disbursement"."performance_agreement_reference" IS NULL
          AND "seb_disbursement"."performance_agreement_executed_at" IS NULL
          AND "seb_disbursement"."physical_verification_required" IS NULL
          AND "seb_disbursement"."physical_verification_reference" IS NULL
          AND "seb_disbursement"."physical_verification_completed_at" IS NULL
          AND "seb_disbursement"."reason_category_id" IS NOT NULL
          AND "seb_disbursement"."applicant_message" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_funding_award" (
	"id" text PRIMARY KEY NOT NULL,
	"funding_case_id" text NOT NULL,
	"application_id" text NOT NULL,
	"sanction_order_number" text NOT NULL,
	"sanction_date" date NOT NULL,
	"sanctioned_amount_paise" bigint NOT NULL,
	"applicant_conditions" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"closure_disposition" text,
	"ledger_version" integer DEFAULT 0 NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_funding_award_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "seb_funding_award_sanction_order_number_unique" UNIQUE("sanction_order_number"),
	CONSTRAINT "seb_funding_award_case_id_uq" UNIQUE("funding_case_id","id"),
	CONSTRAINT "seb_funding_award_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_funding_award_current_version_check" CHECK ("seb_funding_award"."current_version" >= 1),
	CONSTRAINT "seb_funding_award_ledger_version_check" CHECK ("seb_funding_award"."ledger_version" >= 0),
	CONSTRAINT "seb_funding_award_amount_check" CHECK ("seb_funding_award"."sanctioned_amount_paise" > 0 AND "seb_funding_award"."sanctioned_amount_paise" <= 9007199254740991),
	CONSTRAINT "seb_funding_award_status_check" CHECK ("seb_funding_award"."status" IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED')),
	CONSTRAINT "seb_funding_award_closure_disposition_check" CHECK (("seb_funding_award"."status" = 'CLOSED' AND "seb_funding_award"."closure_disposition" IS NOT NULL
          AND "seb_funding_award"."closure_disposition" IN ('RELEASES_COMPLETE', 'REMAINDER_NOT_RELEASED'))
        OR ("seb_funding_award"."status" <> 'CLOSED' AND "seb_funding_award"."closure_disposition" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_funding_award_version" (
	"id" text PRIMARY KEY NOT NULL,
	"funding_award_id" text NOT NULL,
	"version" integer NOT NULL,
	"sanction_order_number" text NOT NULL,
	"sanction_date" date NOT NULL,
	"sanctioned_amount_paise" bigint NOT NULL,
	"applicant_conditions" text,
	"status" text NOT NULL,
	"closure_disposition" text,
	"change_type" text NOT NULL,
	"reason_category_id" text,
	"change_reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_funding_award_version_number_check" CHECK ("seb_funding_award_version"."version" >= 1),
	CONSTRAINT "seb_funding_award_version_amount_check" CHECK ("seb_funding_award_version"."sanctioned_amount_paise" > 0 AND "seb_funding_award_version"."sanctioned_amount_paise" <= 9007199254740991),
	CONSTRAINT "seb_funding_award_version_status_check" CHECK ("seb_funding_award_version"."status" IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED')),
	CONSTRAINT "seb_funding_award_version_closure_disposition_check" CHECK (("seb_funding_award_version"."status" = 'CLOSED' AND "seb_funding_award_version"."closure_disposition" IS NOT NULL
          AND "seb_funding_award_version"."closure_disposition" IN ('RELEASES_COMPLETE', 'REMAINDER_NOT_RELEASED'))
        OR ("seb_funding_award_version"."status" <> 'CLOSED' AND "seb_funding_award_version"."closure_disposition" IS NULL)),
	CONSTRAINT "seb_funding_award_version_change_type_check" CHECK ("seb_funding_award_version"."change_type" IN ('CREATED', 'AMENDED', 'STATUS_CHANGED', 'CORRECTED')),
	CONSTRAINT "seb_funding_award_version_reason_check" CHECK (("seb_funding_award_version"."change_type" = 'CREATED' AND "seb_funding_award_version"."reason_category_id" IS NULL)
        OR ("seb_funding_award_version"."change_type" <> 'CREATED' AND "seb_funding_award_version"."reason_category_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_utilization_obligation" (
	"id" text PRIMARY KEY NOT NULL,
	"funding_award_id" text NOT NULL,
	"release_disbursement_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_utilization_obligation_release_disbursement_id_unique" UNIQUE("release_disbursement_id"),
	CONSTRAINT "seb_utilization_obligation_award_id_uq" UNIQUE("funding_award_id","id")
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_code" text NOT NULL,
	"display_name" text NOT NULL,
	"cycle_year" integer NOT NULL,
	"policy_reference" text,
	"applicant_guidance" text,
	"partner_bank_guidance" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_programme_cycle_cycle_code_unique" UNIQUE("cycle_code"),
	CONSTRAINT "seb_programme_cycle_year_check" CHECK ("seb_programme_cycle"."cycle_year" >= 1),
	CONSTRAINT "seb_programme_cycle_current_version_check" CHECK ("seb_programme_cycle"."current_version" >= 1),
	CONSTRAINT "seb_programme_cycle_status_check" CHECK ("seb_programme_cycle"."status" IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_window_check" CHECK ("seb_programme_cycle"."opens_at" IS NULL OR "seb_programme_cycle"."closes_at" IS NULL OR "seb_programme_cycle"."closes_at" > "seb_programme_cycle"."opens_at")
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_assessment_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"assessment_type" text NOT NULL,
	"required_outcome" text DEFAULT 'PASSED' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_assessment_rule_type_check" CHECK ("seb_programme_cycle_assessment_rule"."assessment_type" IN ('UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT')),
	CONSTRAINT "seb_programme_cycle_assessment_rule_outcome_check" CHECK ("seb_programme_cycle_assessment_rule"."required_outcome" = 'PASSED')
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_event" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_event_type_check" CHECK ("seb_programme_cycle_event"."event_type" IN ('OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_identifier_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"kind" text NOT NULL,
	"requirement" text NOT NULL,
	"duplicate_policy" text NOT NULL,
	"check_type" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_identifier_rule_kind_check" CHECK ("seb_programme_cycle_identifier_rule"."kind" IN ('ST_CERTIFICATE', 'IDENTITY_DOCUMENT', 'BANK_ACCOUNT', 'BUSINESS_REGISTRATION')),
	CONSTRAINT "seb_programme_cycle_identifier_rule_requirement_check" CHECK ("seb_programme_cycle_identifier_rule"."requirement" IN ('REQUIRED_ON_PASS', 'OPTIONAL', 'OFF')),
	CONSTRAINT "seb_programme_cycle_identifier_rule_duplicate_check" CHECK ("seb_programme_cycle_identifier_rule"."duplicate_policy" IN ('CHECKED', 'NOT_CHECKED')),
	CONSTRAINT "seb_programme_cycle_identifier_rule_check_type_check" CHECK (("seb_programme_cycle_identifier_rule"."requirement" <> 'REQUIRED_ON_PASS' AND "seb_programme_cycle_identifier_rule"."check_type" IS NULL)
        OR ("seb_programme_cycle_identifier_rule"."requirement" = 'REQUIRED_ON_PASS' AND "seb_programme_cycle_identifier_rule"."check_type" IN (
          'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
          'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
          'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE')))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_reason" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"context" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"applicant_message_template" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_reason_context_check" CHECK ("seb_programme_cycle_reason"."context" IN ('CYCLE_CLOSE', 'REVISION', 'REJECTION', 'BANK_REFERRAL_CANCEL', 'BANK_OUTCOME_CORRECTION', 'DECISION_CORRECTION', 'AWARD_AMENDMENT', 'AWARD_SUSPENSION', 'AWARD_CANCELLATION', 'AWARD_CLOSURE', 'RELEASE_REVERSAL', 'RECOVERY', 'RECOVERY_WAIVER'))
);
--> statement-breakpoint
CREATE TABLE "seb_programme_cycle_version" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"version" integer NOT NULL,
	"cycle_code" text NOT NULL,
	"display_name" text NOT NULL,
	"cycle_year" integer NOT NULL,
	"policy_reference" text,
	"applicant_guidance" text,
	"partner_bank_guidance" text,
	"status" text NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"minimum_applicant_age" integer,
	"maximum_applicant_age" integer,
	"category_a_maximum_months" integer,
	"expansion_wait_months" integer,
	"majority_ownership_required" boolean,
	"jurisdiction" text,
	"funding_ceiling_state" text,
	"funding_ceiling_amount_paise" bigint,
	"funding_ceiling_scope" text,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_version_number_uq" UNIQUE("programme_cycle_id","version"),
	CONSTRAINT "seb_programme_cycle_version_number_check" CHECK ("seb_programme_cycle_version"."version" >= 1),
	CONSTRAINT "seb_programme_cycle_version_year_check" CHECK ("seb_programme_cycle_version"."cycle_year" >= 1),
	CONSTRAINT "seb_programme_cycle_version_status_check" CHECK ("seb_programme_cycle_version"."status" IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_version_change_type_check" CHECK ("seb_programme_cycle_version"."change_type" IN ('CREATED', 'UPDATED', 'OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_version_window_check" CHECK ("seb_programme_cycle_version"."opens_at" IS NULL OR "seb_programme_cycle_version"."closes_at" IS NULL OR "seb_programme_cycle_version"."closes_at" > "seb_programme_cycle_version"."opens_at"),
	CONSTRAINT "seb_programme_cycle_version_age_check" CHECK (("seb_programme_cycle_version"."minimum_applicant_age" IS NULL AND "seb_programme_cycle_version"."maximum_applicant_age" IS NULL)
        OR ("seb_programme_cycle_version"."minimum_applicant_age" >= 0
          AND "seb_programme_cycle_version"."maximum_applicant_age" >= "seb_programme_cycle_version"."minimum_applicant_age")),
	CONSTRAINT "seb_programme_cycle_version_months_check" CHECK (("seb_programme_cycle_version"."category_a_maximum_months" IS NULL OR "seb_programme_cycle_version"."category_a_maximum_months" >= 0)
        AND ("seb_programme_cycle_version"."expansion_wait_months" IS NULL OR "seb_programme_cycle_version"."expansion_wait_months" >= 1)),
	CONSTRAINT "seb_programme_cycle_version_jurisdiction_check" CHECK ("seb_programme_cycle_version"."jurisdiction" IS NULL OR "seb_programme_cycle_version"."jurisdiction" IN ('TRIPURA', 'TTAADC')),
	CONSTRAINT "seb_programme_cycle_version_ceiling_check" CHECK (("seb_programme_cycle_version"."funding_ceiling_state" IS NULL
          AND "seb_programme_cycle_version"."funding_ceiling_amount_paise" IS NULL
          AND "seb_programme_cycle_version"."funding_ceiling_scope" IS NULL)
        OR ("seb_programme_cycle_version"."funding_ceiling_state" = 'UNRESOLVED'
          AND "seb_programme_cycle_version"."funding_ceiling_amount_paise" IS NULL
          AND "seb_programme_cycle_version"."funding_ceiling_scope" IS NULL)
        OR ("seb_programme_cycle_version"."funding_ceiling_state" = 'RESOLVED'
          AND "seb_programme_cycle_version"."funding_ceiling_amount_paise" > 0
          AND "seb_programme_cycle_version"."funding_ceiling_amount_paise" <= 9007199254740991
          AND "seb_programme_cycle_version"."funding_ceiling_scope" IN ('APPLICATION', 'PHASE', 'ENTERPRISE', 'FUNDING_CASE')))
);
--> statement-breakpoint
CREATE TABLE "seb_recovery_case" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"funding_award_id" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"ledger_version" integer DEFAULT 0 NOT NULL,
	"official_decision_reference" text NOT NULL,
	"official_decision_date" date NOT NULL,
	"reason_category_id" text NOT NULL,
	"applicant_message" text NOT NULL,
	"opened_by_user_id" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" text,
	"delete_reason" text,
	CONSTRAINT "seb_recovery_case_version_check" CHECK ("seb_recovery_case"."current_version" >= 1),
	CONSTRAINT "seb_recovery_case_ledger_version_check" CHECK ("seb_recovery_case"."ledger_version" >= 0),
	CONSTRAINT "seb_recovery_case_status_check" CHECK ("seb_recovery_case"."status" IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "seb_recovery_case_version" (
	"id" text PRIMARY KEY NOT NULL,
	"recovery_case_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"change_type" text NOT NULL,
	"reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_recovery_case_version_number_check" CHECK ("seb_recovery_case_version"."version" >= 1),
	CONSTRAINT "seb_recovery_case_version_status_check" CHECK ("seb_recovery_case_version"."status" IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED', 'CLOSED')),
	CONSTRAINT "seb_recovery_case_version_change_type_check" CHECK ("seb_recovery_case_version"."change_type" IN ('OPENED', 'STATUS_CHANGED', 'CANCELLED', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "seb_recovery_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"recovery_case_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"entry_type" text NOT NULL,
	"component" text NOT NULL,
	"related_entry_id" text,
	"amount_paise" bigint NOT NULL,
	"external_reference" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reason_category_id" text,
	"applicant_message" text NOT NULL,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_recovery_entry_external_reference_unique" UNIQUE("external_reference"),
	CONSTRAINT "seb_recovery_entry_case_id_uq" UNIQUE("recovery_case_id","id"),
	CONSTRAINT "seb_recovery_entry_sequence_check" CHECK ("seb_recovery_entry"."sequence_number" >= 1),
	CONSTRAINT "seb_recovery_entry_amount_check" CHECK ("seb_recovery_entry"."amount_paise" > 0 AND "seb_recovery_entry"."amount_paise" <= 9007199254740991),
	CONSTRAINT "seb_recovery_entry_type_check" CHECK ("seb_recovery_entry"."entry_type" IN ('DEMAND', 'RECEIPT', 'WAIVER', 'REVERSAL')),
	CONSTRAINT "seb_recovery_entry_component_check" CHECK ("seb_recovery_entry"."component" IN ('PRINCIPAL', 'PENAL_INTEREST')),
	CONSTRAINT "seb_recovery_entry_relation_check" CHECK (("seb_recovery_entry"."entry_type" = 'REVERSAL' AND "seb_recovery_entry"."related_entry_id" IS NOT NULL)
        OR ("seb_recovery_entry"."entry_type" <> 'REVERSAL' AND "seb_recovery_entry"."related_entry_id" IS NULL)),
	CONSTRAINT "seb_recovery_entry_reason_check" CHECK (("seb_recovery_entry"."entry_type" IN ('WAIVER', 'REVERSAL') AND "seb_recovery_entry"."reason_category_id" IS NOT NULL)
        OR ("seb_recovery_entry"."entry_type" IN ('DEMAND', 'RECEIPT')))
);
--> statement-breakpoint
CREATE TABLE "seb_application_assignment_event" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"event_type" text NOT NULL,
	"assignment_version" integer NOT NULL,
	"from_user_id" text,
	"to_user_id" text,
	"reason_category_id" text,
	"reason" text,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_assignment_event_type_check" CHECK ("seb_application_assignment_event"."event_type" IN ('CLAIMED', 'RELEASED', 'REASSIGNED')),
	CONSTRAINT "seb_application_assignment_event_version_check" CHECK ("seb_application_assignment_event"."assignment_version" >= 1),
	CONSTRAINT "seb_application_assignment_event_state_check" CHECK (("seb_application_assignment_event"."event_type" = 'CLAIMED' AND "seb_application_assignment_event"."from_user_id" IS NULL AND "seb_application_assignment_event"."to_user_id" IS NOT NULL)
        OR ("seb_application_assignment_event"."event_type" = 'RELEASED' AND "seb_application_assignment_event"."from_user_id" IS NOT NULL AND "seb_application_assignment_event"."to_user_id" IS NULL)
        OR ("seb_application_assignment_event"."event_type" = 'REASSIGNED' AND "seb_application_assignment_event"."from_user_id" IS NOT NULL AND "seb_application_assignment_event"."to_user_id" IS NOT NULL AND "seb_application_assignment_event"."from_user_id" <> "seb_application_assignment_event"."to_user_id"))
);
--> statement-breakpoint
CREATE TABLE "seb_application_internal_note" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"correction_of_note_id" text,
	"note" text NOT NULL,
	"authored_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_internal_note_application_id_uq" UNIQUE("application_id","id")
);
--> statement-breakpoint
CREATE TABLE "seb_desk_review" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_category_id" text,
	"applicant_message" text,
	"reviewed_by_user_id" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"conflict_acknowledged" boolean DEFAULT false NOT NULL,
	CONSTRAINT "seb_desk_review_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_desk_review_outcome_check" CHECK ("seb_desk_review"."outcome" IN ('ADVANCE_TO_BANK', 'REQUEST_REVISION', 'REJECT')),
	CONSTRAINT "seb_desk_review_reason_check" CHECK (("seb_desk_review"."outcome" = 'ADVANCE_TO_BANK'
          AND "seb_desk_review"."reason_category_id" IS NULL
          AND "seb_desk_review"."applicant_message" IS NULL)
        OR ("seb_desk_review"."outcome" IN ('REQUEST_REVISION', 'REJECT')
          AND "seb_desk_review"."reason_category_id" IS NOT NULL
          AND "seb_desk_review"."applicant_message" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "seb_desk_review_check" (
	"id" text PRIMARY KEY NOT NULL,
	"desk_review_id" text NOT NULL,
	"check_type" text NOT NULL,
	"result" text NOT NULL,
	"internal_note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_desk_review_check_type_check" CHECK ("seb_desk_review_check"."check_type" IN ('IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION', 'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY', 'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE')),
	CONSTRAINT "seb_desk_review_check_result_check" CHECK ("seb_desk_review_check"."result" IN ('PASS', 'FAIL', 'NOT_APPLICABLE'))
);
--> statement-breakpoint
CREATE TABLE "seb_desk_review_identifier" (
	"id" text PRIMARY KEY NOT NULL,
	"desk_review_id" text NOT NULL,
	"funding_case_id" text NOT NULL,
	"kind" text NOT NULL,
	"comparable_value" text NOT NULL,
	"last_four" text NOT NULL,
	"matched_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_desk_review_identifier_kind_check" CHECK ("seb_desk_review_identifier"."kind" IN ('ST_CERTIFICATE', 'IDENTITY_DOCUMENT', 'BANK_ACCOUNT', 'BUSINESS_REGISTRATION'))
);
--> statement-breakpoint
CREATE TABLE "seb_application_event" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" text,
	"application_version" integer,
	"submission_id" text,
	"revision_request_id" text,
	"from_status" text,
	"to_status" text,
	"stage_key" text,
	"message" text,
	"metadata_json" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_event_stage_key_check" CHECK ("seb_application_event"."stage_key" IS NULL OR "seb_application_event"."stage_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_application_event_from_status_check" CHECK ("seb_application_event"."from_status" IS NULL OR "seb_application_event"."from_status" IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'AWAITING_DECISION', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED', 'CANCELLED')),
	CONSTRAINT "seb_application_event_to_status_check" CHECK ("seb_application_event"."to_status" IS NULL OR "seb_application_event"."to_status" IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'AWAITING_DECISION', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "seb_revision_request" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"stage_key" text NOT NULL,
	"reason_category_id" text,
	"note" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"resolved_by_submission_id" text,
	"resolved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" text,
	"cancellation_reason" text,
	CONSTRAINT "seb_revision_request_application_id_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_revision_request_stage_key_check" CHECK ("seb_revision_request"."stage_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_revision_request_resolution_fields_check" CHECK (("seb_revision_request"."resolved_by_submission_id" IS NULL AND "seb_revision_request"."resolved_at" IS NULL)
        OR ("seb_revision_request"."resolved_by_submission_id" IS NOT NULL AND "seb_revision_request"."resolved_at" IS NOT NULL)),
	CONSTRAINT "seb_revision_request_cancellation_fields_check" CHECK (("seb_revision_request"."cancelled_at" IS NULL AND "seb_revision_request"."cancelled_by_user_id" IS NULL AND "seb_revision_request"."cancellation_reason" IS NULL)
        OR ("seb_revision_request"."cancelled_at" IS NOT NULL AND "seb_revision_request"."cancelled_by_user_id" IS NOT NULL AND "seb_revision_request"."cancellation_reason" IS NOT NULL)),
	CONSTRAINT "seb_revision_request_terminal_state_check" CHECK (NOT ("seb_revision_request"."resolved_at" IS NOT NULL AND "seb_revision_request"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
-- Every foreign key, now that every table exists. All of them RESTRICT on
-- delete: rows are never hard-deleted here, and the constraint enforces it.
ALTER TABLE "core_audit_event" ADD CONSTRAINT "core_audit_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_account_challenge" ADD CONSTRAINT "core_account_challenge_user_id_core_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_session" ADD CONSTRAINT "core_session_user_id_core_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_signup_challenge" ADD CONSTRAINT "core_signup_challenge_consumed_by_user_id_core_user_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_user" ADD CONSTRAINT "core_user_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_user_id_core_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_granted_by_user_id_core_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_revoked_by_user_id_core_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_assigned_to_user_id_core_user_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_owner_enterprise_fk" FOREIGN KEY ("applicant_user_id","enterprise_id") REFERENCES "public"."seb_enterprise"("portal_owner_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_enterprise_case_fk" FOREIGN KEY ("enterprise_id","funding_case_id") REFERENCES "public"."seb_funding_case"("enterprise_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_submission" ADD CONSTRAINT "seb_application_submission_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_submission" ADD CONSTRAINT "seb_application_submission_submitted_by_user_id_core_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_submission" ADD CONSTRAINT "seb_application_submission_version_fk" FOREIGN KEY ("application_id","application_version") REFERENCES "public"."seb_application_version"("application_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_version" ADD CONSTRAINT "seb_application_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_version" ADD CONSTRAINT "seb_application_version_application_cycle_fk" FOREIGN KEY ("application_id","programme_cycle_id") REFERENCES "public"."seb_application"("id","programme_cycle_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_version" ADD CONSTRAINT "seb_application_version_programme_cycle_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_case" ADD CONSTRAINT "seb_funding_case_enterprise_id_seb_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."seb_enterprise"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_case" ADD CONSTRAINT "seb_funding_case_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_case_version" ADD CONSTRAINT "seb_funding_case_version_funding_case_id_seb_funding_case_id_fk" FOREIGN KEY ("funding_case_id") REFERENCES "public"."seb_funding_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_case_version" ADD CONSTRAINT "seb_funding_case_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_announcement" ADD CONSTRAINT "seb_announcement_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_document" ADD CONSTRAINT "seb_application_document_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_document" ADD CONSTRAINT "seb_application_document_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_document_scan" ADD CONSTRAINT "seb_application_document_scan_document_version_id_seb_application_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."seb_application_document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_document_version" ADD CONSTRAINT "seb_application_document_version_document_id_seb_application_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."seb_application_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_document_version" ADD CONSTRAINT "seb_application_document_version_uploaded_by_user_id_core_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_submission_document" ADD CONSTRAINT "seb_application_submission_document_submission_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_submission_document" ADD CONSTRAINT "seb_application_submission_document_version_fk" FOREIGN KEY ("document_id","document_version") REFERENCES "public"."seb_application_document_version"("document_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_applicant_user_id_core_user_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_finalized_document_version_id_seb_application_document_version_id_fk" FOREIGN KEY ("finalized_document_version_id") REFERENCES "public"."seb_application_document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_owner_application_fk" FOREIGN KEY ("applicant_user_id","application_id") REFERENCES "public"."seb_application"("applicant_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document" ADD CONSTRAINT "seb_cycle_policy_document_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document_scan" ADD CONSTRAINT "seb_cycle_policy_document_scan_document_version_id_seb_cycle_policy_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."seb_cycle_policy_document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document_version" ADD CONSTRAINT "seb_cycle_policy_document_version_document_id_seb_cycle_policy_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."seb_cycle_policy_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_document_version" ADD CONSTRAINT "seb_cycle_policy_document_version_uploaded_by_user_id_core_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_issued_by_user_id_core_user_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_finalized_document_version_id_seb_cycle_policy_document_version_id_fk" FOREIGN KEY ("finalized_document_version_id") REFERENCES "public"."seb_cycle_policy_document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_outcome" ADD CONSTRAINT "seb_partner_bank_outcome_correction_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("correction_reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_outcome" ADD CONSTRAINT "seb_partner_bank_outcome_recorded_by_user_id_core_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_outcome" ADD CONSTRAINT "seb_partner_bank_outcome_referral_fk" FOREIGN KEY ("application_id","referral_id") REFERENCES "public"."seb_partner_bank_referral"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_outcome" ADD CONSTRAINT "seb_partner_bank_outcome_supersedes_fk" FOREIGN KEY ("referral_id","supersedes_outcome_id") REFERENCES "public"."seb_partner_bank_outcome"("referral_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_referral" ADD CONSTRAINT "seb_partner_bank_referral_referred_by_user_id_core_user_id_fk" FOREIGN KEY ("referred_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_referral" ADD CONSTRAINT "seb_partner_bank_referral_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_referral" ADD CONSTRAINT "seb_partner_bank_referral_submission_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_referral" ADD CONSTRAINT "seb_partner_bank_referral_review_fk" FOREIGN KEY ("application_id","desk_review_id") REFERENCES "public"."seb_desk_review"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_referral_version" ADD CONSTRAINT "seb_partner_bank_referral_version_referral_id_seb_partner_bank_referral_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."seb_partner_bank_referral"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_partner_bank_referral_version" ADD CONSTRAINT "seb_partner_bank_referral_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_decision" ADD CONSTRAINT "seb_programme_decision_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_decision" ADD CONSTRAINT "seb_programme_decision_correction_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("correction_reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_decision" ADD CONSTRAINT "seb_programme_decision_recorded_by_user_id_core_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_decision" ADD CONSTRAINT "seb_programme_decision_submission_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_decision" ADD CONSTRAINT "seb_programme_decision_bank_outcome_fk" FOREIGN KEY ("application_id","bank_outcome_id") REFERENCES "public"."seb_partner_bank_outcome"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_decision" ADD CONSTRAINT "seb_programme_decision_supersedes_fk" FOREIGN KEY ("application_id","supersedes_decision_id") REFERENCES "public"."seb_programme_decision"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_version_answer" ADD CONSTRAINT "seb_application_version_answer_version_fk" FOREIGN KEY ("application_version_id","programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_application_version"("id","programme_cycle_id","programme_cycle_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_version_answer" ADD CONSTRAINT "seb_application_version_answer_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_enterprise" ADD CONSTRAINT "seb_enterprise_portal_owner_user_id_core_user_id_fk" FOREIGN KEY ("portal_owner_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_enterprise" ADD CONSTRAINT "seb_enterprise_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_enterprise_version" ADD CONSTRAINT "seb_enterprise_version_enterprise_id_seb_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."seb_enterprise"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_enterprise_version" ADD CONSTRAINT "seb_enterprise_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field" ADD CONSTRAINT "seb_programme_cycle_form_field_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field" ADD CONSTRAINT "seb_programme_cycle_form_field_stage_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","stage_key") REFERENCES "public"."seb_programme_cycle_form_stage"("programme_cycle_id","programme_cycle_version","stage_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field_condition" ADD CONSTRAINT "seb_programme_cycle_form_field_condition_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field_condition" ADD CONSTRAINT "seb_programme_cycle_form_field_condition_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field_condition" ADD CONSTRAINT "seb_programme_cycle_form_field_condition_source_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","source_field_key","source_field_type") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key","field_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field_option" ADD CONSTRAINT "seb_programme_cycle_form_field_option_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_field_option" ADD CONSTRAINT "seb_programme_cycle_form_field_option_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key","field_type") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key","field_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_group_definition" ADD CONSTRAINT "seb_programme_cycle_form_group_definition_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_group_definition_member" ADD CONSTRAINT "seb_programme_cycle_form_group_definition_member_definition_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","definition_key") REFERENCES "public"."seb_programme_cycle_form_group_definition"("programme_cycle_id","programme_cycle_version","definition_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_group_definition_member_option" ADD CONSTRAINT "seb_programme_cycle_form_group_definition_member_option_member_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","definition_key","member_key") REFERENCES "public"."seb_programme_cycle_form_group_definition_member"("programme_cycle_id","programme_cycle_version","definition_key","member_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_form_stage" ADD CONSTRAINT "seb_programme_cycle_form_stage_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award" ADD CONSTRAINT "seb_application_qualifying_award_created_by_user_id_core_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award" ADD CONSTRAINT "seb_application_qualifying_award_cancelled_by_user_id_core_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award" ADD CONSTRAINT "seb_application_qualifying_award_case_application_fk" FOREIGN KEY ("funding_case_id","application_id") REFERENCES "public"."seb_application"("funding_case_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award" ADD CONSTRAINT "seb_application_qualifying_award_case_award_fk" FOREIGN KEY ("funding_case_id","current_funding_award_id") REFERENCES "public"."seb_funding_award"("funding_case_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award_version" ADD CONSTRAINT "seb_application_qualifying_award_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award_version" ADD CONSTRAINT "seb_application_qualifying_award_version_link_case_fk" FOREIGN KEY ("qualifying_award_link_id","funding_case_id") REFERENCES "public"."seb_application_qualifying_award"("id","funding_case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_qualifying_award_version" ADD CONSTRAINT "seb_application_qualifying_award_version_case_award_fk" FOREIGN KEY ("funding_case_id","funding_award_id") REFERENCES "public"."seb_funding_award"("funding_case_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_award_assessment" ADD CONSTRAINT "seb_award_assessment_funding_award_id_seb_funding_award_id_fk" FOREIGN KEY ("funding_award_id") REFERENCES "public"."seb_funding_award"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_award_assessment" ADD CONSTRAINT "seb_award_assessment_assessed_by_user_id_core_user_id_fk" FOREIGN KEY ("assessed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_award_assessment" ADD CONSTRAINT "seb_award_assessment_utilization_obligation_fk" FOREIGN KEY ("funding_award_id","utilization_obligation_id") REFERENCES "public"."seb_utilization_obligation"("funding_award_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_disbursement" ADD CONSTRAINT "seb_disbursement_funding_award_id_seb_funding_award_id_fk" FOREIGN KEY ("funding_award_id") REFERENCES "public"."seb_funding_award"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_disbursement" ADD CONSTRAINT "seb_disbursement_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_disbursement" ADD CONSTRAINT "seb_disbursement_recorded_by_user_id_core_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_disbursement" ADD CONSTRAINT "seb_disbursement_related_award_fk" FOREIGN KEY ("funding_award_id","related_disbursement_id") REFERENCES "public"."seb_disbursement"("funding_award_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_award" ADD CONSTRAINT "seb_funding_award_funding_case_id_seb_funding_case_id_fk" FOREIGN KEY ("funding_case_id") REFERENCES "public"."seb_funding_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_award" ADD CONSTRAINT "seb_funding_award_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_award" ADD CONSTRAINT "seb_funding_award_case_application_fk" FOREIGN KEY ("funding_case_id","application_id") REFERENCES "public"."seb_application"("funding_case_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_award_version" ADD CONSTRAINT "seb_funding_award_version_funding_award_id_seb_funding_award_id_fk" FOREIGN KEY ("funding_award_id") REFERENCES "public"."seb_funding_award"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_award_version" ADD CONSTRAINT "seb_funding_award_version_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_funding_award_version" ADD CONSTRAINT "seb_funding_award_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_utilization_obligation" ADD CONSTRAINT "seb_utilization_obligation_release_fk" FOREIGN KEY ("funding_award_id","release_disbursement_id") REFERENCES "public"."seb_disbursement"("funding_award_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle" ADD CONSTRAINT "seb_programme_cycle_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_assessment_rule" ADD CONSTRAINT "seb_programme_cycle_assessment_rule_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_event" ADD CONSTRAINT "seb_programme_cycle_event_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_event" ADD CONSTRAINT "seb_programme_cycle_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_identifier_rule" ADD CONSTRAINT "seb_programme_cycle_identifier_rule_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_reason" ADD CONSTRAINT "seb_programme_cycle_reason_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_version" ADD CONSTRAINT "seb_programme_cycle_version_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_programme_cycle_version" ADD CONSTRAINT "seb_programme_cycle_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case" ADD CONSTRAINT "seb_recovery_case_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case" ADD CONSTRAINT "seb_recovery_case_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case" ADD CONSTRAINT "seb_recovery_case_opened_by_user_id_core_user_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case" ADD CONSTRAINT "seb_recovery_case_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case" ADD CONSTRAINT "seb_recovery_case_application_award_fk" FOREIGN KEY ("application_id","funding_award_id") REFERENCES "public"."seb_funding_award"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case_version" ADD CONSTRAINT "seb_recovery_case_version_recovery_case_id_seb_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "public"."seb_recovery_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_case_version" ADD CONSTRAINT "seb_recovery_case_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_entry" ADD CONSTRAINT "seb_recovery_entry_recovery_case_id_seb_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "public"."seb_recovery_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_entry" ADD CONSTRAINT "seb_recovery_entry_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_entry" ADD CONSTRAINT "seb_recovery_entry_recorded_by_user_id_core_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_recovery_entry" ADD CONSTRAINT "seb_recovery_entry_related_case_fk" FOREIGN KEY ("recovery_case_id","related_entry_id") REFERENCES "public"."seb_recovery_entry"("recovery_case_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_assignment_event" ADD CONSTRAINT "seb_application_assignment_event_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_assignment_event" ADD CONSTRAINT "seb_application_assignment_event_from_user_id_core_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_assignment_event" ADD CONSTRAINT "seb_application_assignment_event_to_user_id_core_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_assignment_event" ADD CONSTRAINT "seb_application_assignment_event_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_assignment_event" ADD CONSTRAINT "seb_application_assignment_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_internal_note" ADD CONSTRAINT "seb_application_internal_note_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_internal_note" ADD CONSTRAINT "seb_application_internal_note_authored_by_user_id_core_user_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_internal_note" ADD CONSTRAINT "seb_application_internal_note_correction_fk" FOREIGN KEY ("application_id","correction_of_note_id") REFERENCES "public"."seb_application_internal_note"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_desk_review" ADD CONSTRAINT "seb_desk_review_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_desk_review" ADD CONSTRAINT "seb_desk_review_reviewed_by_user_id_core_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_desk_review" ADD CONSTRAINT "seb_desk_review_submission_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_desk_review_check" ADD CONSTRAINT "seb_desk_review_check_desk_review_id_seb_desk_review_id_fk" FOREIGN KEY ("desk_review_id") REFERENCES "public"."seb_desk_review"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_desk_review_identifier" ADD CONSTRAINT "seb_desk_review_identifier_desk_review_id_seb_desk_review_id_fk" FOREIGN KEY ("desk_review_id") REFERENCES "public"."seb_desk_review"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_version_fk" FOREIGN KEY ("application_id","application_version") REFERENCES "public"."seb_application_version"("application_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_submission_application_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_revision_application_fk" FOREIGN KEY ("application_id","revision_request_id") REFERENCES "public"."seb_revision_request"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_reason_category_id_seb_programme_cycle_reason_id_fk" FOREIGN KEY ("reason_category_id") REFERENCES "public"."seb_programme_cycle_reason"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_requested_by_user_id_core_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_cancelled_by_user_id_core_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_submission_application_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_resolution_application_fk" FOREIGN KEY ("application_id","resolved_by_submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Every index. The partial UNIQUE ones are where invariants live — "one open
-- row per key" shapes like one unrevoked grant per user and role, one open
-- referral per application, one live recovery case per award — so their
-- WHERE clauses are as deliberate as any CHECK above.
CREATE INDEX "core_audit_event_entity_idx" ON "core_audit_event" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "core_audit_event_actor_idx" ON "core_audit_event" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "core_audit_event_action_idx" ON "core_audit_event" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "core_audit_event_request_idx" ON "core_audit_event" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "core_audit_event_created_idx" ON "core_audit_event" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "core_account_challenge_user_purpose_idx" ON "core_account_challenge" USING btree ("user_id","purpose","status","expires_at");--> statement-breakpoint
CREATE INDEX "core_account_challenge_status_expiry_idx" ON "core_account_challenge" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "core_session_user_expiry_idx" ON "core_session" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "core_session_expiry_idx" ON "core_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "core_signup_challenge_email_status_expiry_idx" ON "core_signup_challenge" USING btree ("email","status","expires_at");--> statement-breakpoint
CREATE INDEX "core_signup_challenge_status_expiry_idx" ON "core_signup_challenge" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_user_role_grant_active_uq" ON "core_user_role_grant" USING btree ("user_id","role") WHERE "core_user_role_grant"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "core_user_role_grant_user_idx" ON "core_user_role_grant" USING btree ("user_id","revoked_at","role");--> statement-breakpoint
CREATE INDEX "core_user_role_grant_role_idx" ON "core_user_role_grant" USING btree ("role","revoked_at","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_case_cycle_phase_uq" ON "seb_application" USING btree ("funding_case_id","programme_cycle_id","phase_number");--> statement-breakpoint
CREATE INDEX "seb_application_owner_idx" ON "seb_application" USING btree ("applicant_user_id","updated_at") WHERE "seb_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_application_enterprise_idx" ON "seb_application" USING btree ("enterprise_id","updated_at") WHERE "seb_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_application_case_phase_idx" ON "seb_application" USING btree ("funding_case_id","phase_number");--> statement-breakpoint
CREATE INDEX "seb_application_cycle_idx" ON "seb_application" USING btree ("programme_cycle_id","updated_at") WHERE "seb_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_application_status_idx" ON "seb_application" USING btree ("status","updated_at") WHERE "seb_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_application_assignment_idx" ON "seb_application" USING btree ("assigned_to_user_id","status","status_changed_at");--> statement-breakpoint
CREATE INDEX "seb_application_intake_waiting_idx" ON "seb_application" USING btree ("status_changed_at") WHERE "seb_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_application_intake_activity_idx" ON "seb_application" USING btree ("updated_at") WHERE "seb_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_application_reference_search_idx" ON "seb_application" USING btree (lower("reference_number") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "seb_application_cycle_status_idx" ON "seb_application" USING btree ("programme_cycle_id","status","status_changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_submission_number_uq" ON "seb_application_submission" USING btree ("application_id","submission_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_submission_version_uq" ON "seb_application_submission" USING btree ("application_id","application_version");--> statement-breakpoint
CREATE INDEX "seb_application_submission_submitted_idx" ON "seb_application_submission" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "seb_application_version_category_idx" ON "seb_application_version" USING btree ("application_category") WHERE "seb_application_version"."application_category" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "seb_funding_case_status_idx" ON "seb_funding_case" USING btree ("status","updated_at") WHERE "seb_funding_case"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_funding_case_version_number_uq" ON "seb_funding_case_version" USING btree ("funding_case_id","version");--> statement-breakpoint
CREATE INDEX "seb_announcement_public_idx" ON "seb_announcement" USING btree ("sort_order","created_at","id") WHERE deleted_at IS NULL AND published;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_document_field_key_uq" ON "seb_application_document" USING btree ("application_id","field_key");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_document_scan_sequence_uq" ON "seb_application_document_scan" USING btree ("document_version_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_submission_document_field_key_uq" ON "seb_application_submission_document" USING btree ("submission_id","field_key");--> statement-breakpoint
CREATE INDEX "seb_document_upload_intent_cleanup_idx" ON "seb_document_upload_intent" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "seb_document_upload_intent_owner_idx" ON "seb_document_upload_intent" USING btree ("applicant_user_id","application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_cycle_policy_document_cycle_uq" ON "seb_cycle_policy_document" USING btree ("programme_cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_cycle_policy_document_scan_sequence_uq" ON "seb_cycle_policy_document_scan" USING btree ("document_version_id","sequence_number");--> statement-breakpoint
CREATE INDEX "seb_cycle_policy_upload_intent_cleanup_idx" ON "seb_cycle_policy_upload_intent" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_partner_bank_outcome_number_uq" ON "seb_partner_bank_outcome" USING btree ("referral_id","outcome_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_partner_bank_outcome_one_correction_uq" ON "seb_partner_bank_outcome" USING btree ("supersedes_outcome_id");--> statement-breakpoint
CREATE INDEX "seb_partner_bank_outcome_application_idx" ON "seb_partner_bank_outcome" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_partner_bank_referral_active_application_uq" ON "seb_partner_bank_referral" USING btree ("application_id") WHERE "seb_partner_bank_referral"."status" = 'OPEN' AND "seb_partner_bank_referral"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_partner_bank_referral_application_idx" ON "seb_partner_bank_referral" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_partner_bank_referral_version_number_uq" ON "seb_partner_bank_referral_version" USING btree ("referral_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_decision_number_uq" ON "seb_programme_decision" USING btree ("application_id","decision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_decision_one_correction_uq" ON "seb_programme_decision" USING btree ("supersedes_decision_id");--> statement-breakpoint
CREATE INDEX "seb_programme_decision_application_idx" ON "seb_programme_decision" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "seb_application_version_answer_field_value_idx" ON "seb_application_version_answer" USING btree ("field_key","value_text","application_version_id");--> statement-breakpoint
CREATE INDEX "seb_application_version_answer_version_idx" ON "seb_application_version_answer" USING btree ("application_version_id","field_key","entry_index","value_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_enterprise_registration_uq" ON "seb_enterprise" USING btree ("registration_type","registration_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_enterprise_owner_name_uq" ON "seb_enterprise" USING btree ("portal_owner_user_id",lower("current_name") text_pattern_ops) WHERE "seb_enterprise"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_enterprise_owner_idx" ON "seb_enterprise" USING btree ("portal_owner_user_id","updated_at") WHERE "seb_enterprise"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_enterprise_version_number_uq" ON "seb_enterprise_version" USING btree ("enterprise_id","version");--> statement-breakpoint
CREATE INDEX "seb_enterprise_version_sector_idx" ON "seb_enterprise_version" USING btree ("business_sector");--> statement-breakpoint
CREATE INDEX "seb_enterprise_version_district_idx" ON "seb_enterprise_version" USING btree ("business_district");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_order_uq" ON "seb_programme_cycle_form_field" USING btree ("programme_cycle_id","programme_cycle_version","stage_key",coalesce("parent_field_key", ''),"sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_role_uq" ON "seb_programme_cycle_form_field" USING btree ("programme_cycle_id","programme_cycle_version","role") WHERE "seb_programme_cycle_form_field"."role" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_form_field_stage_idx" ON "seb_programme_cycle_form_field" USING btree ("programme_cycle_id","programme_cycle_version","stage_key","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_condition_uq" ON "seb_programme_cycle_form_field_condition" USING btree ("programme_cycle_id","programme_cycle_version","field_key","effect","group_number","sequence_number");--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_form_field_condition_field_idx" ON "seb_programme_cycle_form_field_condition" USING btree ("programme_cycle_id","programme_cycle_version","field_key");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_option_value_uq" ON "seb_programme_cycle_form_field_option" USING btree ("programme_cycle_id","programme_cycle_version","field_key","option_value");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_option_order_uq" ON "seb_programme_cycle_form_field_option" USING btree ("programme_cycle_id","programme_cycle_version","field_key","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_group_definition_member_order_uq" ON "seb_programme_cycle_form_group_definition_member" USING btree ("programme_cycle_id","programme_cycle_version","definition_key","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_group_definition_member_option_uq" ON "seb_programme_cycle_form_group_definition_member_option" USING btree ("programme_cycle_id","programme_cycle_version","definition_key","member_key","option_value");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_form_stage_order_uq" ON "seb_programme_cycle_form_stage" USING btree ("programme_cycle_id","programme_cycle_version","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_qualifying_award_current_award_uq" ON "seb_application_qualifying_award" USING btree ("current_funding_award_id");--> statement-breakpoint
CREATE INDEX "seb_application_qualifying_award_case_idx" ON "seb_application_qualifying_award" USING btree ("funding_case_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_qualifying_award_version_number_uq" ON "seb_application_qualifying_award_version" USING btree ("qualifying_award_link_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_award_assessment_award_number_uq" ON "seb_award_assessment" USING btree ("funding_award_id","assessment_type","assessment_number") WHERE "seb_award_assessment"."utilization_obligation_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_award_assessment_utilization_number_uq" ON "seb_award_assessment" USING btree ("funding_award_id","utilization_obligation_id","assessment_number") WHERE "seb_award_assessment"."utilization_obligation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "seb_award_assessment_latest_idx" ON "seb_award_assessment" USING btree ("funding_award_id","assessment_type","utilization_obligation_id","assessment_number");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_disbursement_award_sequence_uq" ON "seb_disbursement" USING btree ("funding_award_id","sequence_number");--> statement-breakpoint
CREATE INDEX "seb_disbursement_award_occurred_idx" ON "seb_disbursement" USING btree ("funding_award_id","occurred_at");--> statement-breakpoint
CREATE INDEX "seb_funding_award_case_idx" ON "seb_funding_award" USING btree ("funding_case_id","sanction_date") WHERE "seb_funding_award"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_funding_award_status_idx" ON "seb_funding_award" USING btree ("status","updated_at") WHERE "seb_funding_award"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_funding_award_version_number_uq" ON "seb_funding_award_version" USING btree ("funding_award_id","version");--> statement-breakpoint
CREATE INDEX "seb_utilization_obligation_due_idx" ON "seb_utilization_obligation" USING btree ("funding_award_id","due_at");--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_updated_idx" ON "seb_programme_cycle" USING btree ("updated_at") WHERE "seb_programme_cycle"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_status_updated_idx" ON "seb_programme_cycle" USING btree ("status","updated_at") WHERE "seb_programme_cycle"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_code_search_idx" ON "seb_programme_cycle" USING btree (lower("cycle_code") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_status_idx" ON "seb_programme_cycle" USING btree ("status","opens_at","closes_at") WHERE "seb_programme_cycle"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_assessment_rule_type_uq" ON "seb_programme_cycle_assessment_rule" USING btree ("programme_cycle_id","programme_cycle_version","assessment_type");--> statement-breakpoint
CREATE INDEX "seb_programme_cycle_event_cycle_idx" ON "seb_programme_cycle_event" USING btree ("programme_cycle_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_identifier_rule_kind_uq" ON "seb_programme_cycle_identifier_rule" USING btree ("programme_cycle_id","programme_cycle_version","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_reason_code_uq" ON "seb_programme_cycle_reason" USING btree ("programme_cycle_id","programme_cycle_version","context","code");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_programme_cycle_reason_cycle_id_uq" ON "seb_programme_cycle_reason" USING btree ("programme_cycle_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_recovery_case_award_id_uq" ON "seb_recovery_case" USING btree ("funding_award_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_recovery_case_active_award_uq" ON "seb_recovery_case" USING btree ("funding_award_id") WHERE "seb_recovery_case"."status" IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED') AND "seb_recovery_case"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "seb_recovery_case_status_idx" ON "seb_recovery_case" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "seb_recovery_case_award_idx" ON "seb_recovery_case" USING btree ("funding_award_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_recovery_case_version_number_uq" ON "seb_recovery_case_version" USING btree ("recovery_case_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_recovery_entry_sequence_uq" ON "seb_recovery_entry" USING btree ("recovery_case_id","sequence_number");--> statement-breakpoint
CREATE INDEX "seb_recovery_entry_case_occurred_idx" ON "seb_recovery_entry" USING btree ("recovery_case_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_assignment_event_version_uq" ON "seb_application_assignment_event" USING btree ("application_id","assignment_version");--> statement-breakpoint
CREATE INDEX "seb_application_assignment_event_application_idx" ON "seb_application_assignment_event" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_application_internal_note_one_correction_uq" ON "seb_application_internal_note" USING btree ("correction_of_note_id");--> statement-breakpoint
CREATE INDEX "seb_application_internal_note_application_idx" ON "seb_application_internal_note" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_desk_review_submission_uq" ON "seb_desk_review" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "seb_desk_review_application_idx" ON "seb_desk_review" USING btree ("application_id","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_desk_review_check_type_uq" ON "seb_desk_review_check" USING btree ("desk_review_id","check_type");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_desk_review_identifier_kind_uq" ON "seb_desk_review_identifier" USING btree ("desk_review_id","kind");--> statement-breakpoint
CREATE INDEX "seb_desk_review_identifier_match_idx" ON "seb_desk_review_identifier" USING btree ("kind","comparable_value","funding_case_id");--> statement-breakpoint
CREATE INDEX "seb_application_event_application_idx" ON "seb_application_event" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "seb_revision_request_application_idx" ON "seb_revision_request" USING btree ("application_id","resolved_at","cancelled_at","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seb_revision_request_open_stage_uq" ON "seb_revision_request" USING btree ("application_id","stage_key") WHERE "seb_revision_request"."resolved_at" IS NULL AND "seb_revision_request"."cancelled_at" IS NULL;--> statement-breakpoint
-- The announcement board's one row, seeded here so reads stay read-only: a
-- lazy insert-on-first-read would put a write on the public path. The same
-- statement lives in `scripts/board-seed.mjs` for every bootstrap path that
-- builds a database from `schema.sql` instead of this chain.
INSERT INTO "seb_announcement_board" ("id", "current_version", "updated_at") VALUES ('BOARD', 1, now()) ON CONFLICT DO NOTHING;
