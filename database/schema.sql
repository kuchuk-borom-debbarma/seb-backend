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
	"subject_user_id" text,
	"application_id" text,
	"payload" jsonb,
	"payload_version" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "core_audit_event_outcome_check" CHECK ("core_audit_event"."outcome" IN ('SUCCESS', 'FAILURE')),
	CONSTRAINT "core_audit_event_payload_version_check" CHECK ("core_audit_event"."payload_version" IN (0, 1)),
	CONSTRAINT "core_audit_event_payload_generation_check" CHECK (("core_audit_event"."payload_version" = 1 AND "core_audit_event"."payload" IS NOT NULL AND "core_audit_event"."metadata_json" IS NULL)
        OR ("core_audit_event"."payload_version" = 0 AND "core_audit_event"."payload" IS NULL))
);

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

CREATE TABLE "core_role_permission" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "core_role_permission_resource_check" CHECK ("core_role_permission"."resource" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "core_role_permission_action_check" CHECK ("core_role_permission"."action" ~ '^[a-z][a-z0-9_]{0,62}$')
);

CREATE TABLE "core_user_role_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" text,
	"granted_by_user_id" text,
	"grant_reason" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"role_id" text,
	CONSTRAINT "core_user_role_grant_target_check" CHECK (("core_user_role_grant"."role" IS NOT NULL AND "core_user_role_grant"."role_id" IS NULL)
        OR ("core_user_role_grant"."role" IS NULL AND "core_user_role_grant"."role_id" IS NOT NULL)),
	CONSTRAINT "core_user_role_grant_role_check" CHECK ("core_user_role_grant"."role" IS NULL
        OR "core_user_role_grant"."role" IN ('APPLICANT', 'SUPER_ADMIN')
        OR ("core_user_role_grant"."role" IN ('REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')
            AND "core_user_role_grant"."revoked_at" IS NOT NULL)),
	CONSTRAINT "core_user_role_grant_revocation_check" CHECK (("core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."revoked_by_user_id" IS NULL AND "core_user_role_grant"."revocation_reason" IS NULL)
        OR ("core_user_role_grant"."revoked_at" IS NOT NULL
          AND "core_user_role_grant"."revocation_reason" IS NOT NULL
          AND "core_user_role_grant"."revoked_at" >= "core_user_role_grant"."granted_at"))
);

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

CREATE TABLE "seb_application" (
	"id" text PRIMARY KEY NOT NULL,
	"applicant_user_id" text NOT NULL,
	"enterprise_id" text NOT NULL,
	"funding_case_id" text NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"application_kind" text NOT NULL,
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
	"first_submitted_at" timestamp with time zone,
	"pipeline_id" text NOT NULL,
	"pipeline_version" integer NOT NULL,
	"current_stage_key" text,
	"stage_entered_at" timestamp with time zone,
	"stage_trail" text[] DEFAULT '{}'::text[] NOT NULL,
	"status_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"recorded_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "seb_application_reference_number_unique" UNIQUE("reference_number"),
	CONSTRAINT "seb_application_id_cycle_uq" UNIQUE("id","programme_cycle_id"),
	CONSTRAINT "seb_application_case_id_uq" UNIQUE("funding_case_id","id"),
	CONSTRAINT "seb_application_owner_id_uq" UNIQUE("applicant_user_id","id"),
	CONSTRAINT "seb_application_current_version_check" CHECK ("seb_application"."current_version" >= 1),
	CONSTRAINT "seb_application_status_version_check" CHECK ("seb_application"."status_version" >= 1),
	CONSTRAINT "seb_application_kind_check" CHECK ("seb_application"."application_kind" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_application_stage_lifecycle_check" CHECK (("seb_application"."status" = 'DRAFT' AND "seb_application"."current_stage_key" IS NULL AND "seb_application"."stage_entered_at" IS NULL)
        OR ("seb_application"."status" = 'IN_PIPELINE' AND "seb_application"."current_stage_key" IS NOT NULL AND "seb_application"."stage_entered_at" IS NOT NULL)
        OR ("seb_application"."status" = 'IN_PIPELINE' AND "seb_application"."current_stage_key" IS NULL AND "seb_application"."stage_entered_at" IS NULL)),
	CONSTRAINT "seb_application_status_flags_check" CHECK (cardinality("seb_application"."status_flags") <= 32
        AND array_position("seb_application"."status_flags", NULL) IS NULL
        AND array_to_string("seb_application"."status_flags", ',') ~ '^$|^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$'),
	CONSTRAINT "seb_application_stage_trail_check" CHECK (cardinality("seb_application"."stage_trail") <= 64
        AND array_position("seb_application"."stage_trail", NULL) IS NULL
        AND array_to_string("seb_application"."stage_trail", ',') ~ '^$|^[A-Z][A-Z0-9_]{1,63}(,[A-Z][A-Z0-9_]{1,63})*$'),
	CONSTRAINT "seb_application_recorded_values_check" CHECK (jsonb_typeof("seb_application"."recorded_values") = 'object' AND octet_length("seb_application"."recorded_values"::text) <= 8192),
	CONSTRAINT "seb_application_status_check" CHECK ("seb_application"."status" IN ('DRAFT', 'IN_PIPELINE')),
	CONSTRAINT "seb_application_phase_check" CHECK ("seb_application"."phase_number" >= 1)
);

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

CREATE TABLE "seb_application_version" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"version" integer NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"application_kind" text NOT NULL,
	"phase_number" integer NOT NULL,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"declaration_accepted_at" timestamp with time zone,
	"application_category" text,
	CONSTRAINT "seb_application_version_number_uq" UNIQUE("application_id","version"),
	CONSTRAINT "seb_application_version_cycle_pin_uq" UNIQUE("id","programme_cycle_id","programme_cycle_version"),
	CONSTRAINT "seb_application_version_category_check" CHECK ("seb_application_version"."application_category" IS NULL
        OR "seb_application_version"."application_category" IN ('CATEGORY_A', 'CATEGORY_B')),
	CONSTRAINT "seb_application_version_number_check" CHECK ("seb_application_version"."version" >= 1),
	CONSTRAINT "seb_application_version_kind_check" CHECK ("seb_application_version"."application_kind" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_application_version_phase_check" CHECK ("seb_application_version"."phase_number" >= 1),
	CONSTRAINT "seb_application_version_change_type_check" CHECK ("seb_application_version"."change_type" IN ('INITIAL', 'SAVE', 'REVISION', 'SUBMISSION', 'RESUBMISSION'))
);

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

CREATE TABLE "seb_announcement_board" (
	"id" text PRIMARY KEY NOT NULL,
	"current_version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_announcement_board_singleton_check" CHECK ("seb_announcement_board"."id" = 'BOARD'),
	CONSTRAINT "seb_announcement_board_version_check" CHECK ("seb_announcement_board"."current_version" >= 1)
);

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

CREATE TABLE "seb_cycle_policy_document" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_cycle_policy_document_version_check" CHECK ("seb_cycle_policy_document"."current_version" >= 1)
);

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
        OR ("seb_programme_cycle_form_field"."role" = 'SEED_FUND_REQUESTED_PAISE' AND "seb_programme_cycle_form_field"."field_key" = 'SEED_FUND_REQUESTED_PAISE' AND "seb_programme_cycle_form_field"."field_type" = 'MONEY_PAISE')
        OR ("seb_programme_cycle_form_field"."role" = 'LOAN_REQUESTED_PAISE' AND "seb_programme_cycle_form_field"."field_key" = 'LOAN_AMOUNT_REQUESTED_PAISE' AND "seb_programme_cycle_form_field"."field_type" = 'MONEY_PAISE')),
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

CREATE TABLE "seb_programme_cycle_form_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"rule_key" text NOT NULL,
	"rule_type" text NOT NULL,
	"stage_key" text NOT NULL,
	"message" text NOT NULL,
	"limit_value" bigint,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_rule_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","rule_key"),
	CONSTRAINT "seb_programme_cycle_form_rule_key_check" CHECK ("seb_programme_cycle_form_rule"."rule_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_programme_cycle_form_rule_type_check" CHECK ("seb_programme_cycle_form_rule"."rule_type" IN ('AT_LEAST_ONE_TRUE', 'DIFFERENT_VALUES', 'SUM_AT_MOST', 'AT_MOST_FIELD')),
	CONSTRAINT "seb_programme_cycle_form_rule_message_check" CHECK (char_length("seb_programme_cycle_form_rule"."message") BETWEEN 1 AND 300),
	CONSTRAINT "seb_programme_cycle_form_rule_limit_check" CHECK (("seb_programme_cycle_form_rule"."rule_type" = 'SUM_AT_MOST' AND "seb_programme_cycle_form_rule"."limit_value" IS NOT NULL AND "seb_programme_cycle_form_rule"."limit_value" >= 0)
        OR ("seb_programme_cycle_form_rule"."rule_type" <> 'SUM_AT_MOST' AND "seb_programme_cycle_form_rule"."limit_value" IS NULL))
);

CREATE TABLE "seb_programme_cycle_form_rule_operand" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"rule_key" text NOT NULL,
	"position" integer NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text NOT NULL,
	CONSTRAINT "seb_programme_cycle_form_rule_operand_position_check" CHECK ("seb_programme_cycle_form_rule_operand"."position" >= 1)
);

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

CREATE TABLE "seb_pipeline" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"current_published_version" integer,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_user_id" text,
	"retire_reason" text,
	CONSTRAINT "seb_pipeline_key_uq" UNIQUE("key"),
	CONSTRAINT "seb_pipeline_key_check" CHECK ("seb_pipeline"."key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_pipeline_name_check" CHECK (char_length("seb_pipeline"."name") BETWEEN 1 AND 120),
	CONSTRAINT "seb_pipeline_description_check" CHECK (char_length("seb_pipeline"."description") <= 1000),
	CONSTRAINT "seb_pipeline_published_version_check" CHECK ("seb_pipeline"."current_published_version" IS NULL OR "seb_pipeline"."current_published_version" >= 1),
	CONSTRAINT "seb_pipeline_retire_group_check" CHECK (("seb_pipeline"."retired_at" IS NULL AND "seb_pipeline"."retired_by_user_id" IS NULL AND "seb_pipeline"."retire_reason" IS NULL)
        OR ("seb_pipeline"."retired_at" IS NOT NULL AND "seb_pipeline"."retired_by_user_id" IS NOT NULL AND "seb_pipeline"."retire_reason" IS NOT NULL))
);

CREATE TABLE "seb_pipeline_stage" (
	"pipeline_id" text NOT NULL,
	"stage_key" text NOT NULL,
	"owners_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_pipeline_stage_pk" PRIMARY KEY("pipeline_id","stage_key"),
	CONSTRAINT "seb_pipeline_stage_key_check" CHECK ("seb_pipeline_stage"."stage_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_pipeline_stage_owners_version_check" CHECK ("seb_pipeline_stage"."owners_version" >= 0)
);

CREATE TABLE "seb_pipeline_stage_owner" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"stage_key" text NOT NULL,
	"role_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"added_by_user_id" text NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_user_id" text,
	"removal_reason" text,
	CONSTRAINT "seb_pipeline_stage_owner_removal_check" CHECK (("seb_pipeline_stage_owner"."removed_at" IS NULL AND "seb_pipeline_stage_owner"."removed_by_user_id" IS NULL AND "seb_pipeline_stage_owner"."removal_reason" IS NULL)
        OR ("seb_pipeline_stage_owner"."removed_at" IS NOT NULL AND "seb_pipeline_stage_owner"."removed_by_user_id" IS NOT NULL AND "seb_pipeline_stage_owner"."removal_reason" IS NOT NULL
            AND "seb_pipeline_stage_owner"."removed_at" >= "seb_pipeline_stage_owner"."added_at"))
);

CREATE TABLE "seb_pipeline_version" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_schema" smallint DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" text,
	"change_note" text,
	CONSTRAINT "seb_pipeline_version_uq" UNIQUE("pipeline_id","version"),
	CONSTRAINT "seb_pipeline_version_version_check" CHECK ("seb_pipeline_version"."version" >= 1),
	CONSTRAINT "seb_pipeline_version_revision_check" CHECK ("seb_pipeline_version"."revision" >= 1),
	CONSTRAINT "seb_pipeline_version_status_check" CHECK ("seb_pipeline_version"."status" IN ('DRAFT', 'PUBLISHED')),
	CONSTRAINT "seb_pipeline_version_schema_check" CHECK ("seb_pipeline_version"."definition_schema" = 1),
	CONSTRAINT "seb_pipeline_version_definition_check" CHECK (jsonb_typeof("seb_pipeline_version"."definition") = 'object' AND octet_length("seb_pipeline_version"."definition"::text) <= 262144),
	CONSTRAINT "seb_pipeline_version_note_check" CHECK ("seb_pipeline_version"."change_note" IS NULL OR char_length("seb_pipeline_version"."change_note") <= 500),
	CONSTRAINT "seb_pipeline_version_publish_group_check" CHECK (("seb_pipeline_version"."status" = 'DRAFT' AND "seb_pipeline_version"."published_at" IS NULL AND "seb_pipeline_version"."published_by_user_id" IS NULL)
        OR ("seb_pipeline_version"."status" = 'PUBLISHED' AND "seb_pipeline_version"."published_at" IS NOT NULL AND "seb_pipeline_version"."published_by_user_id" IS NOT NULL))
);

CREATE TABLE "seb_pipeline_version_stage" (
	"pipeline_id" text NOT NULL,
	"version" integer NOT NULL,
	"stage_key" text NOT NULL,
	"position" integer NOT NULL,
	"is_initial" boolean NOT NULL,
	CONSTRAINT "seb_pipeline_version_stage_pk" PRIMARY KEY("pipeline_id","version","stage_key"),
	CONSTRAINT "seb_pipeline_version_stage_position_check" CHECK ("seb_pipeline_version_stage"."position" >= 0)
);

CREATE TABLE "seb_programme_cycle" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_code" text NOT NULL,
	"display_name" text NOT NULL,
	"cycle_year" integer NOT NULL,
	"policy_reference" text,
	"applicant_guidance" text,
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

CREATE TABLE "seb_programme_cycle_application_kind" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"kind_key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_application_kind_key_uq" UNIQUE("programme_cycle_id","programme_cycle_version","kind_key"),
	CONSTRAINT "seb_programme_cycle_application_kind_key_check" CHECK ("seb_programme_cycle_application_kind"."kind_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_programme_cycle_application_kind_label_check" CHECK (char_length("seb_programme_cycle_application_kind"."label") BETWEEN 1 AND 80
        AND ("seb_programme_cycle_application_kind"."description" IS NULL OR char_length("seb_programme_cycle_application_kind"."description") <= 500)),
	CONSTRAINT "seb_programme_cycle_application_kind_order_check" CHECK ("seb_programme_cycle_application_kind"."sort_order" >= 1)
);

CREATE TABLE "seb_programme_cycle_application_kind_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"programme_cycle_version" integer NOT NULL,
	"kind_key" text NOT NULL,
	"position" integer NOT NULL,
	"rule_type" text NOT NULL,
	"params" jsonb NOT NULL,
	CONSTRAINT "seb_programme_cycle_application_kind_rule_position_check" CHECK ("seb_programme_cycle_application_kind_rule"."position" >= 1),
	CONSTRAINT "seb_programme_cycle_application_kind_rule_type_check" CHECK ("seb_programme_cycle_application_kind_rule"."rule_type" IN ('PRIOR_APPLICATION_HAS_FLAG', 'PRIOR_RECORDED_VALUE_AT_LEAST', 'NO_OPEN_APPLICATION_OF_KIND', 'MAX_APPLICATIONS_OF_KIND', 'ENTERPRISE_AGE_AT_LEAST')),
	CONSTRAINT "seb_programme_cycle_application_kind_rule_params_check" CHECK (jsonb_typeof("seb_programme_cycle_application_kind_rule"."params") = 'object' AND octet_length("seb_programme_cycle_application_kind_rule"."params"::text) <= 4096)
);

CREATE TABLE "seb_programme_cycle_event" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_user_id" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_event_type_check" CHECK ("seb_programme_cycle_event"."event_type" IN ('OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED'))
);

CREATE TABLE "seb_programme_cycle_version" (
	"id" text PRIMARY KEY NOT NULL,
	"programme_cycle_id" text NOT NULL,
	"version" integer NOT NULL,
	"cycle_code" text NOT NULL,
	"display_name" text NOT NULL,
	"cycle_year" integer NOT NULL,
	"policy_reference" text,
	"applicant_guidance" text,
	"status" text NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"minimum_applicant_age" integer,
	"maximum_applicant_age" integer,
	"category_a_maximum_months" integer,
	"majority_ownership_required" boolean,
	"jurisdiction" text,
	"funding_ceiling_state" text,
	"funding_ceiling_amount_paise" bigint,
	"funding_ceiling_scope" text,
	"pipeline_id" text NOT NULL,
	"pipeline_version" integer,
	"change_type" text NOT NULL,
	"change_reason" text,
	"changed_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_programme_cycle_version_number_uq" UNIQUE("programme_cycle_id","version"),
	CONSTRAINT "seb_programme_cycle_version_number_check" CHECK ("seb_programme_cycle_version"."version" >= 1),
	CONSTRAINT "seb_programme_cycle_version_pipeline_pin_check" CHECK (("seb_programme_cycle_version"."status" = 'DRAFT' AND "seb_programme_cycle_version"."pipeline_version" IS NULL)
        OR ("seb_programme_cycle_version"."status" <> 'DRAFT' AND "seb_programme_cycle_version"."pipeline_version" IS NOT NULL)),
	CONSTRAINT "seb_programme_cycle_version_year_check" CHECK ("seb_programme_cycle_version"."cycle_year" >= 1),
	CONSTRAINT "seb_programme_cycle_version_status_check" CHECK ("seb_programme_cycle_version"."status" IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_version_change_type_check" CHECK ("seb_programme_cycle_version"."change_type" IN ('CREATED', 'UPDATED', 'OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_version_window_check" CHECK ("seb_programme_cycle_version"."opens_at" IS NULL OR "seb_programme_cycle_version"."closes_at" IS NULL OR "seb_programme_cycle_version"."closes_at" > "seb_programme_cycle_version"."opens_at"),
	CONSTRAINT "seb_programme_cycle_version_age_check" CHECK (("seb_programme_cycle_version"."minimum_applicant_age" IS NULL AND "seb_programme_cycle_version"."maximum_applicant_age" IS NULL)
        OR ("seb_programme_cycle_version"."minimum_applicant_age" >= 0
          AND "seb_programme_cycle_version"."maximum_applicant_age" >= "seb_programme_cycle_version"."minimum_applicant_age")),
	CONSTRAINT "seb_programme_cycle_version_months_check" CHECK ("seb_programme_cycle_version"."category_a_maximum_months" IS NULL OR "seb_programme_cycle_version"."category_a_maximum_months" >= 0),
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

CREATE TABLE "seb_application_internal_note" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"correction_of_note_id" text,
	"note" text NOT NULL,
	"authored_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_internal_note_application_id_uq" UNIQUE("application_id","id")
);

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
	"stage_action_id" text,
	CONSTRAINT "seb_application_event_stage_key_check" CHECK ("seb_application_event"."stage_key" IS NULL OR "seb_application_event"."stage_key" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "seb_application_event_from_status_check" CHECK ("seb_application_event"."from_status" IS NULL OR "seb_application_event"."from_status" IN ('DRAFT', 'IN_PIPELINE')),
	CONSTRAINT "seb_application_event_to_status_check" CHECK ("seb_application_event"."to_status" IS NULL OR "seb_application_event"."to_status" IN ('DRAFT', 'IN_PIPELINE'))
);

CREATE TABLE "seb_application_stage_action" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"pipeline_id" text NOT NULL,
	"pipeline_version" integer NOT NULL,
	"stage_key" text NOT NULL,
	"action_key" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"status_version" integer NOT NULL,
	"to_stage_key" text,
	"inputs" jsonb NOT NULL,
	"flags_added" text[] NOT NULL,
	"flags_removed" text[] NOT NULL,
	"recorded" jsonb NOT NULL,
	"revision_stage_keys" text[] NOT NULL,
	"self_review_disclosed" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seb_application_stage_action_version_uq" UNIQUE("application_id","status_version"),
	CONSTRAINT "seb_application_stage_action_application_uq" UNIQUE("application_id","id"),
	CONSTRAINT "seb_application_stage_action_version_check" CHECK ("seb_application_stage_action"."status_version" >= 2),
	CONSTRAINT "seb_application_stage_action_json_check" CHECK (jsonb_typeof("seb_application_stage_action"."inputs") = 'object' AND jsonb_typeof("seb_application_stage_action"."recorded") = 'object'
        AND octet_length("seb_application_stage_action"."inputs"::text) <= 65536)
);

CREATE TABLE "seb_revision_request" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"stage_key" text NOT NULL,
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

ALTER TABLE "core_audit_event" ADD CONSTRAINT "core_audit_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_audit_event" ADD CONSTRAINT "core_audit_event_subject_user_id_core_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_role" ADD CONSTRAINT "core_role_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_role" ADD CONSTRAINT "core_role_created_by_user_id_core_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_role_permission" ADD CONSTRAINT "core_role_permission_role_id_core_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."core_role"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_user_id_core_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_granted_by_user_id_core_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_revoked_by_user_id_core_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_user_role_grant" ADD CONSTRAINT "core_user_role_grant_role_id_core_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."core_role"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_account_challenge" ADD CONSTRAINT "core_account_challenge_user_id_core_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_session" ADD CONSTRAINT "core_session_user_id_core_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_signup_challenge" ADD CONSTRAINT "core_signup_challenge_consumed_by_user_id_core_user_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "core_user" ADD CONSTRAINT "core_user_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_owner_enterprise_fk" FOREIGN KEY ("applicant_user_id","enterprise_id") REFERENCES "public"."seb_enterprise"("portal_owner_user_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_enterprise_case_fk" FOREIGN KEY ("enterprise_id","funding_case_id") REFERENCES "public"."seb_funding_case"("enterprise_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_pipeline_version_fk" FOREIGN KEY ("pipeline_id","pipeline_version") REFERENCES "public"."seb_pipeline_version"("pipeline_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application" ADD CONSTRAINT "seb_application_current_stage_fk" FOREIGN KEY ("pipeline_id","pipeline_version","current_stage_key") REFERENCES "public"."seb_pipeline_version_stage"("pipeline_id","version","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_submission" ADD CONSTRAINT "seb_application_submission_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_submission" ADD CONSTRAINT "seb_application_submission_submitted_by_user_id_core_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_submission" ADD CONSTRAINT "seb_application_submission_version_fk" FOREIGN KEY ("application_id","application_version") REFERENCES "public"."seb_application_version"("application_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_version" ADD CONSTRAINT "seb_application_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_version" ADD CONSTRAINT "seb_application_version_application_cycle_fk" FOREIGN KEY ("application_id","programme_cycle_id") REFERENCES "public"."seb_application"("id","programme_cycle_id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_version" ADD CONSTRAINT "seb_application_version_programme_cycle_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_funding_case" ADD CONSTRAINT "seb_funding_case_enterprise_id_seb_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."seb_enterprise"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_funding_case" ADD CONSTRAINT "seb_funding_case_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_funding_case_version" ADD CONSTRAINT "seb_funding_case_version_funding_case_id_seb_funding_case_id_fk" FOREIGN KEY ("funding_case_id") REFERENCES "public"."seb_funding_case"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_funding_case_version" ADD CONSTRAINT "seb_funding_case_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_announcement" ADD CONSTRAINT "seb_announcement_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_document" ADD CONSTRAINT "seb_application_document_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_document" ADD CONSTRAINT "seb_application_document_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_document_scan" ADD CONSTRAINT "seb_application_document_scan_document_version_id_seb_application_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."seb_application_document_version"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_document_version" ADD CONSTRAINT "seb_application_document_version_document_id_seb_application_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."seb_application_document"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_document_version" ADD CONSTRAINT "seb_application_document_version_uploaded_by_user_id_core_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_submission_document" ADD CONSTRAINT "seb_application_submission_document_submission_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_submission_document" ADD CONSTRAINT "seb_application_submission_document_version_fk" FOREIGN KEY ("document_id","document_version") REFERENCES "public"."seb_application_document_version"("document_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_applicant_user_id_core_user_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_finalized_document_version_id_seb_application_document_version_id_fk" FOREIGN KEY ("finalized_document_version_id") REFERENCES "public"."seb_application_document_version"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_document_upload_intent" ADD CONSTRAINT "seb_document_upload_intent_owner_application_fk" FOREIGN KEY ("applicant_user_id","application_id") REFERENCES "public"."seb_application"("applicant_user_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_document" ADD CONSTRAINT "seb_cycle_policy_document_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_document_scan" ADD CONSTRAINT "seb_cycle_policy_document_scan_document_version_id_seb_cycle_policy_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."seb_cycle_policy_document_version"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_document_version" ADD CONSTRAINT "seb_cycle_policy_document_version_document_id_seb_cycle_policy_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."seb_cycle_policy_document"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_document_version" ADD CONSTRAINT "seb_cycle_policy_document_version_uploaded_by_user_id_core_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_issued_by_user_id_core_user_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_cycle_policy_upload_intent" ADD CONSTRAINT "seb_cycle_policy_upload_intent_finalized_document_version_id_seb_cycle_policy_document_version_id_fk" FOREIGN KEY ("finalized_document_version_id") REFERENCES "public"."seb_cycle_policy_document_version"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_version_answer" ADD CONSTRAINT "seb_application_version_answer_version_fk" FOREIGN KEY ("application_version_id","programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_application_version"("id","programme_cycle_id","programme_cycle_version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_version_answer" ADD CONSTRAINT "seb_application_version_answer_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_enterprise" ADD CONSTRAINT "seb_enterprise_portal_owner_user_id_core_user_id_fk" FOREIGN KEY ("portal_owner_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_enterprise" ADD CONSTRAINT "seb_enterprise_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_enterprise_version" ADD CONSTRAINT "seb_enterprise_version_enterprise_id_seb_enterprise_id_fk" FOREIGN KEY ("enterprise_id") REFERENCES "public"."seb_enterprise"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_enterprise_version" ADD CONSTRAINT "seb_enterprise_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field" ADD CONSTRAINT "seb_programme_cycle_form_field_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field" ADD CONSTRAINT "seb_programme_cycle_form_field_stage_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","stage_key") REFERENCES "public"."seb_programme_cycle_form_stage"("programme_cycle_id","programme_cycle_version","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field_condition" ADD CONSTRAINT "seb_programme_cycle_form_field_condition_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field_condition" ADD CONSTRAINT "seb_programme_cycle_form_field_condition_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field_condition" ADD CONSTRAINT "seb_programme_cycle_form_field_condition_source_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","source_field_key","source_field_type") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key","field_type") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field_option" ADD CONSTRAINT "seb_programme_cycle_form_field_option_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_field_option" ADD CONSTRAINT "seb_programme_cycle_form_field_option_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key","field_type") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key","field_type") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_group_definition" ADD CONSTRAINT "seb_programme_cycle_form_group_definition_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_group_definition_member" ADD CONSTRAINT "seb_programme_cycle_form_group_definition_member_definition_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","definition_key") REFERENCES "public"."seb_programme_cycle_form_group_definition"("programme_cycle_id","programme_cycle_version","definition_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_group_definition_member_option" ADD CONSTRAINT "seb_programme_cycle_form_group_definition_member_option_member_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","definition_key","member_key") REFERENCES "public"."seb_programme_cycle_form_group_definition_member"("programme_cycle_id","programme_cycle_version","definition_key","member_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_rule" ADD CONSTRAINT "seb_programme_cycle_form_rule_stage_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","stage_key") REFERENCES "public"."seb_programme_cycle_form_stage"("programme_cycle_id","programme_cycle_version","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_rule_operand" ADD CONSTRAINT "seb_programme_cycle_form_rule_operand_rule_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","rule_key") REFERENCES "public"."seb_programme_cycle_form_rule"("programme_cycle_id","programme_cycle_version","rule_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_rule_operand" ADD CONSTRAINT "seb_programme_cycle_form_rule_operand_field_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","field_key","field_type") REFERENCES "public"."seb_programme_cycle_form_field"("programme_cycle_id","programme_cycle_version","field_key","field_type") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_form_stage" ADD CONSTRAINT "seb_programme_cycle_form_stage_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline" ADD CONSTRAINT "seb_pipeline_created_by_user_id_core_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline" ADD CONSTRAINT "seb_pipeline_retired_by_user_id_core_user_id_fk" FOREIGN KEY ("retired_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_stage" ADD CONSTRAINT "seb_pipeline_stage_pipeline_id_seb_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."seb_pipeline"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_stage_owner" ADD CONSTRAINT "seb_pipeline_stage_owner_role_id_core_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."core_role"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_stage_owner" ADD CONSTRAINT "seb_pipeline_stage_owner_added_by_user_id_core_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_stage_owner" ADD CONSTRAINT "seb_pipeline_stage_owner_removed_by_user_id_core_user_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_stage_owner" ADD CONSTRAINT "seb_pipeline_stage_owner_stage_fk" FOREIGN KEY ("pipeline_id","stage_key") REFERENCES "public"."seb_pipeline_stage"("pipeline_id","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_version" ADD CONSTRAINT "seb_pipeline_version_pipeline_id_seb_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."seb_pipeline"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_version" ADD CONSTRAINT "seb_pipeline_version_created_by_user_id_core_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_version" ADD CONSTRAINT "seb_pipeline_version_published_by_user_id_core_user_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_version_stage" ADD CONSTRAINT "seb_pipeline_version_stage_version_fk" FOREIGN KEY ("pipeline_id","version") REFERENCES "public"."seb_pipeline_version"("pipeline_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_pipeline_version_stage" ADD CONSTRAINT "seb_pipeline_version_stage_stage_fk" FOREIGN KEY ("pipeline_id","stage_key") REFERENCES "public"."seb_pipeline_stage"("pipeline_id","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle" ADD CONSTRAINT "seb_programme_cycle_deleted_by_user_id_core_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_application_kind" ADD CONSTRAINT "seb_programme_cycle_application_kind_version_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version") REFERENCES "public"."seb_programme_cycle_version"("programme_cycle_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_application_kind_rule" ADD CONSTRAINT "seb_programme_cycle_application_kind_rule_kind_fk" FOREIGN KEY ("programme_cycle_id","programme_cycle_version","kind_key") REFERENCES "public"."seb_programme_cycle_application_kind"("programme_cycle_id","programme_cycle_version","kind_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_event" ADD CONSTRAINT "seb_programme_cycle_event_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_event" ADD CONSTRAINT "seb_programme_cycle_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_version" ADD CONSTRAINT "seb_programme_cycle_version_programme_cycle_id_seb_programme_cycle_id_fk" FOREIGN KEY ("programme_cycle_id") REFERENCES "public"."seb_programme_cycle"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_version" ADD CONSTRAINT "seb_programme_cycle_version_pipeline_id_seb_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."seb_pipeline"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_version" ADD CONSTRAINT "seb_programme_cycle_version_changed_by_user_id_core_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_programme_cycle_version" ADD CONSTRAINT "seb_programme_cycle_version_pipeline_version_fk" FOREIGN KEY ("pipeline_id","pipeline_version") REFERENCES "public"."seb_pipeline_version"("pipeline_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_internal_note" ADD CONSTRAINT "seb_application_internal_note_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_internal_note" ADD CONSTRAINT "seb_application_internal_note_authored_by_user_id_core_user_id_fk" FOREIGN KEY ("authored_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_internal_note" ADD CONSTRAINT "seb_application_internal_note_correction_fk" FOREIGN KEY ("application_id","correction_of_note_id") REFERENCES "public"."seb_application_internal_note"("application_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_version_fk" FOREIGN KEY ("application_id","application_version") REFERENCES "public"."seb_application_version"("application_id","version") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_submission_application_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_revision_application_fk" FOREIGN KEY ("application_id","revision_request_id") REFERENCES "public"."seb_revision_request"("application_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_event" ADD CONSTRAINT "seb_application_event_stage_action_fk" FOREIGN KEY ("application_id","stage_action_id") REFERENCES "public"."seb_application_stage_action"("application_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_stage_action" ADD CONSTRAINT "seb_application_stage_action_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_stage_action" ADD CONSTRAINT "seb_application_stage_action_actor_user_id_core_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_stage_action" ADD CONSTRAINT "seb_application_stage_action_stage_fk" FOREIGN KEY ("pipeline_id","pipeline_version","stage_key") REFERENCES "public"."seb_pipeline_version_stage"("pipeline_id","version","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_application_stage_action" ADD CONSTRAINT "seb_application_stage_action_to_stage_fk" FOREIGN KEY ("pipeline_id","pipeline_version","to_stage_key") REFERENCES "public"."seb_pipeline_version_stage"("pipeline_id","version","stage_key") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_application_id_seb_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."seb_application"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_requested_by_user_id_core_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_cancelled_by_user_id_core_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."core_user"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_submission_application_fk" FOREIGN KEY ("application_id","submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "seb_revision_request" ADD CONSTRAINT "seb_revision_request_resolution_application_fk" FOREIGN KEY ("application_id","resolved_by_submission_id") REFERENCES "public"."seb_application_submission"("application_id","id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "core_audit_event_entity_idx" ON "core_audit_event" USING btree ("entity_type","entity_id","created_at");
CREATE INDEX "core_audit_event_actor_idx" ON "core_audit_event" USING btree ("actor_user_id","created_at");
CREATE INDEX "core_audit_event_action_idx" ON "core_audit_event" USING btree ("action","created_at");
CREATE INDEX "core_audit_event_request_idx" ON "core_audit_event" USING btree ("request_id");
CREATE INDEX "core_audit_event_created_idx" ON "core_audit_event" USING btree ("created_at","id");
CREATE INDEX "core_audit_event_subject_idx" ON "core_audit_event" USING btree ("subject_user_id","created_at","id") WHERE "core_audit_event"."subject_user_id" IS NOT NULL;
CREATE INDEX "core_audit_event_application_idx" ON "core_audit_event" USING btree ("application_id","created_at","id") WHERE "core_audit_event"."application_id" IS NOT NULL;
CREATE INDEX "core_role_live_idx" ON "core_role" USING btree ("deleted_at","key");
CREATE UNIQUE INDEX "core_role_permission_pair_uq" ON "core_role_permission" USING btree ("role_id","resource","action");
CREATE INDEX "core_role_permission_role_idx" ON "core_role_permission" USING btree ("role_id");
CREATE UNIQUE INDEX "core_user_role_grant_active_uq" ON "core_user_role_grant" USING btree ("user_id","role") WHERE "core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."role" IS NOT NULL;
CREATE UNIQUE INDEX "core_user_role_grant_active_role_uq" ON "core_user_role_grant" USING btree ("user_id","role_id") WHERE "core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."role_id" IS NOT NULL;
CREATE INDEX "core_user_role_grant_user_idx" ON "core_user_role_grant" USING btree ("user_id","revoked_at");
CREATE INDEX "core_user_role_grant_role_idx" ON "core_user_role_grant" USING btree ("role","revoked_at","user_id");
CREATE INDEX "core_user_role_grant_role_id_idx" ON "core_user_role_grant" USING btree ("role_id","revoked_at","user_id");
CREATE INDEX "core_account_challenge_user_purpose_idx" ON "core_account_challenge" USING btree ("user_id","purpose","status","expires_at");
CREATE INDEX "core_account_challenge_status_expiry_idx" ON "core_account_challenge" USING btree ("status","expires_at");
CREATE INDEX "core_session_user_expiry_idx" ON "core_session" USING btree ("user_id","expires_at");
CREATE INDEX "core_session_expiry_idx" ON "core_session" USING btree ("expires_at");
CREATE INDEX "core_signup_challenge_email_status_expiry_idx" ON "core_signup_challenge" USING btree ("email","status","expires_at");
CREATE INDEX "core_signup_challenge_status_expiry_idx" ON "core_signup_challenge" USING btree ("status","expires_at");
CREATE UNIQUE INDEX "seb_application_case_cycle_phase_uq" ON "seb_application" USING btree ("funding_case_id","programme_cycle_id","phase_number");
CREATE INDEX "seb_application_owner_idx" ON "seb_application" USING btree ("applicant_user_id","updated_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_enterprise_idx" ON "seb_application" USING btree ("enterprise_id","updated_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_case_phase_idx" ON "seb_application" USING btree ("funding_case_id","phase_number");
CREATE INDEX "seb_application_cycle_idx" ON "seb_application" USING btree ("programme_cycle_id","updated_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_status_idx" ON "seb_application" USING btree ("status","updated_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_stage_queue_idx" ON "seb_application" USING btree ("pipeline_id","current_stage_key","stage_entered_at","id") WHERE "seb_application"."deleted_at" IS NULL AND "seb_application"."current_stage_key" IS NOT NULL;
CREATE INDEX "seb_application_status_flags_idx" ON "seb_application" USING gin ("status_flags") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_pipeline_status_idx" ON "seb_application" USING btree ("pipeline_id","status","status_changed_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_intake_waiting_idx" ON "seb_application" USING btree ("status_changed_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_intake_activity_idx" ON "seb_application" USING btree ("updated_at") WHERE "seb_application"."deleted_at" IS NULL;
CREATE INDEX "seb_application_reference_search_idx" ON "seb_application" USING btree (lower("reference_number") text_pattern_ops);
CREATE INDEX "seb_application_cycle_status_idx" ON "seb_application" USING btree ("programme_cycle_id","status","status_changed_at");
CREATE UNIQUE INDEX "seb_application_submission_number_uq" ON "seb_application_submission" USING btree ("application_id","submission_number");
CREATE UNIQUE INDEX "seb_application_submission_version_uq" ON "seb_application_submission" USING btree ("application_id","application_version");
CREATE INDEX "seb_application_submission_submitted_idx" ON "seb_application_submission" USING btree ("submitted_at");
CREATE INDEX "seb_application_version_category_idx" ON "seb_application_version" USING btree ("application_category") WHERE "seb_application_version"."application_category" IS NOT NULL;
CREATE INDEX "seb_funding_case_status_idx" ON "seb_funding_case" USING btree ("status","updated_at") WHERE "seb_funding_case"."deleted_at" IS NULL;
CREATE UNIQUE INDEX "seb_funding_case_version_number_uq" ON "seb_funding_case_version" USING btree ("funding_case_id","version");
CREATE INDEX "seb_announcement_public_idx" ON "seb_announcement" USING btree ("sort_order","created_at","id") WHERE deleted_at IS NULL AND published;
CREATE UNIQUE INDEX "seb_application_document_field_key_uq" ON "seb_application_document" USING btree ("application_id","field_key");
CREATE UNIQUE INDEX "seb_application_document_scan_sequence_uq" ON "seb_application_document_scan" USING btree ("document_version_id","sequence_number");
CREATE UNIQUE INDEX "seb_application_submission_document_field_key_uq" ON "seb_application_submission_document" USING btree ("submission_id","field_key");
CREATE INDEX "seb_document_upload_intent_cleanup_idx" ON "seb_document_upload_intent" USING btree ("status","expires_at");
CREATE INDEX "seb_document_upload_intent_owner_idx" ON "seb_document_upload_intent" USING btree ("applicant_user_id","application_id","created_at");
CREATE UNIQUE INDEX "seb_cycle_policy_document_cycle_uq" ON "seb_cycle_policy_document" USING btree ("programme_cycle_id");
CREATE UNIQUE INDEX "seb_cycle_policy_document_scan_sequence_uq" ON "seb_cycle_policy_document_scan" USING btree ("document_version_id","sequence_number");
CREATE INDEX "seb_cycle_policy_upload_intent_cleanup_idx" ON "seb_cycle_policy_upload_intent" USING btree ("status","expires_at");
CREATE INDEX "seb_application_version_answer_field_value_idx" ON "seb_application_version_answer" USING btree ("field_key","value_text","application_version_id");
CREATE INDEX "seb_application_version_answer_version_idx" ON "seb_application_version_answer" USING btree ("application_version_id","field_key","entry_index","value_ordinal");
CREATE UNIQUE INDEX "seb_enterprise_registration_uq" ON "seb_enterprise" USING btree ("registration_type","registration_number");
CREATE UNIQUE INDEX "seb_enterprise_owner_name_uq" ON "seb_enterprise" USING btree ("portal_owner_user_id",lower("current_name") text_pattern_ops) WHERE "seb_enterprise"."deleted_at" IS NULL;
CREATE INDEX "seb_enterprise_owner_idx" ON "seb_enterprise" USING btree ("portal_owner_user_id","updated_at") WHERE "seb_enterprise"."deleted_at" IS NULL;
CREATE UNIQUE INDEX "seb_enterprise_version_number_uq" ON "seb_enterprise_version" USING btree ("enterprise_id","version");
CREATE INDEX "seb_enterprise_version_sector_idx" ON "seb_enterprise_version" USING btree ("business_sector");
CREATE INDEX "seb_enterprise_version_district_idx" ON "seb_enterprise_version" USING btree ("business_district");
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_order_uq" ON "seb_programme_cycle_form_field" USING btree ("programme_cycle_id","programme_cycle_version","stage_key",coalesce("parent_field_key", ''),"sort_order");
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_role_uq" ON "seb_programme_cycle_form_field" USING btree ("programme_cycle_id","programme_cycle_version","role") WHERE "seb_programme_cycle_form_field"."role" IS NOT NULL;
CREATE INDEX "seb_programme_cycle_form_field_stage_idx" ON "seb_programme_cycle_form_field" USING btree ("programme_cycle_id","programme_cycle_version","stage_key","sort_order");
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_condition_uq" ON "seb_programme_cycle_form_field_condition" USING btree ("programme_cycle_id","programme_cycle_version","field_key","effect","group_number","sequence_number");
CREATE INDEX "seb_programme_cycle_form_field_condition_field_idx" ON "seb_programme_cycle_form_field_condition" USING btree ("programme_cycle_id","programme_cycle_version","field_key");
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_option_value_uq" ON "seb_programme_cycle_form_field_option" USING btree ("programme_cycle_id","programme_cycle_version","field_key","option_value");
CREATE UNIQUE INDEX "seb_programme_cycle_form_field_option_order_uq" ON "seb_programme_cycle_form_field_option" USING btree ("programme_cycle_id","programme_cycle_version","field_key","sort_order");
CREATE UNIQUE INDEX "seb_programme_cycle_form_group_definition_member_order_uq" ON "seb_programme_cycle_form_group_definition_member" USING btree ("programme_cycle_id","programme_cycle_version","definition_key","sort_order");
CREATE UNIQUE INDEX "seb_programme_cycle_form_group_definition_member_option_uq" ON "seb_programme_cycle_form_group_definition_member_option" USING btree ("programme_cycle_id","programme_cycle_version","definition_key","member_key","option_value");
CREATE UNIQUE INDEX "seb_programme_cycle_form_rule_operand_position_uq" ON "seb_programme_cycle_form_rule_operand" USING btree ("programme_cycle_id","programme_cycle_version","rule_key","position");
CREATE UNIQUE INDEX "seb_programme_cycle_form_rule_operand_field_uq" ON "seb_programme_cycle_form_rule_operand" USING btree ("programme_cycle_id","programme_cycle_version","rule_key","field_key");
CREATE UNIQUE INDEX "seb_programme_cycle_form_stage_order_uq" ON "seb_programme_cycle_form_stage" USING btree ("programme_cycle_id","programme_cycle_version","sort_order");
CREATE UNIQUE INDEX "seb_pipeline_stage_owner_live_uq" ON "seb_pipeline_stage_owner" USING btree ("pipeline_id","stage_key","role_id") WHERE "seb_pipeline_stage_owner"."removed_at" IS NULL;
CREATE INDEX "seb_pipeline_stage_owner_role_idx" ON "seb_pipeline_stage_owner" USING btree ("role_id") WHERE "seb_pipeline_stage_owner"."removed_at" IS NULL;
CREATE UNIQUE INDEX "seb_pipeline_version_one_draft_uq" ON "seb_pipeline_version" USING btree ("pipeline_id") WHERE "seb_pipeline_version"."status" = 'DRAFT';
CREATE UNIQUE INDEX "seb_pipeline_version_stage_initial_uq" ON "seb_pipeline_version_stage" USING btree ("pipeline_id","version") WHERE "seb_pipeline_version_stage"."is_initial";
CREATE INDEX "seb_programme_cycle_updated_idx" ON "seb_programme_cycle" USING btree ("updated_at") WHERE "seb_programme_cycle"."deleted_at" IS NULL;
CREATE INDEX "seb_programme_cycle_status_updated_idx" ON "seb_programme_cycle" USING btree ("status","updated_at") WHERE "seb_programme_cycle"."deleted_at" IS NULL;
CREATE INDEX "seb_programme_cycle_code_search_idx" ON "seb_programme_cycle" USING btree (lower("cycle_code") text_pattern_ops);
CREATE INDEX "seb_programme_cycle_status_idx" ON "seb_programme_cycle" USING btree ("status","opens_at","closes_at") WHERE "seb_programme_cycle"."deleted_at" IS NULL;
CREATE UNIQUE INDEX "seb_programme_cycle_application_kind_order_uq" ON "seb_programme_cycle_application_kind" USING btree ("programme_cycle_id","programme_cycle_version","sort_order");
CREATE UNIQUE INDEX "seb_programme_cycle_application_kind_rule_position_uq" ON "seb_programme_cycle_application_kind_rule" USING btree ("programme_cycle_id","programme_cycle_version","kind_key","position");
CREATE INDEX "seb_programme_cycle_event_cycle_idx" ON "seb_programme_cycle_event" USING btree ("programme_cycle_id","created_at");
CREATE UNIQUE INDEX "seb_application_internal_note_one_correction_uq" ON "seb_application_internal_note" USING btree ("correction_of_note_id");
CREATE INDEX "seb_application_internal_note_application_idx" ON "seb_application_internal_note" USING btree ("application_id","created_at");
CREATE INDEX "seb_application_event_application_idx" ON "seb_application_event" USING btree ("application_id","created_at");
CREATE INDEX "seb_application_stage_action_history_idx" ON "seb_application_stage_action" USING btree ("application_id","created_at");
CREATE INDEX "seb_application_stage_action_actor_idx" ON "seb_application_stage_action" USING btree ("actor_user_id","application_id");
CREATE INDEX "seb_revision_request_application_idx" ON "seb_revision_request" USING btree ("application_id","resolved_at","cancelled_at","requested_at");
CREATE UNIQUE INDEX "seb_revision_request_open_stage_uq" ON "seb_revision_request" USING btree ("application_id","stage_key") WHERE "seb_revision_request"."resolved_at" IS NULL AND "seb_revision_request"."cancelled_at" IS NULL;
