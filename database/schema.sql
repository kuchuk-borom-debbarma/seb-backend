-- Canonical schema for a new Mission SEP D1 database.
-- This is a base schema, not an incremental migration.
PRAGMA foreign_keys = ON;

CREATE TABLE `core_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`outcome` text NOT NULL,
	`request_id` text,
	`ip_address` text,
	`user_agent` text,
	`changes_json` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "core_audit_event_outcome_check" CHECK("core_audit_event"."outcome" IN ('SUCCESS', 'FAILURE'))
);

CREATE INDEX `core_audit_event_entity_idx` ON `core_audit_event` (`entity_type`,`entity_id`,`created_at`);
CREATE INDEX `core_audit_event_actor_idx` ON `core_audit_event` (`actor_user_id`,`created_at`);
CREATE INDEX `core_audit_event_action_idx` ON `core_audit_event` (`action`,`created_at`);
CREATE INDEX `core_audit_event_request_idx` ON `core_audit_event` (`request_id`);
CREATE TABLE `core_session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict
);

CREATE UNIQUE INDEX `core_session_token_digest_unique` ON `core_session` (`token_digest`);
CREATE INDEX `core_session_user_expiry_idx` ON `core_session` (`user_id`,`expires_at`);
CREATE INDEX `core_session_expiry_idx` ON `core_session` (`expires_at`);
CREATE TABLE `core_signup_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`challenge_digest` text NOT NULL,
	`otp_digest` text NOT NULL,
	`attempts_remaining` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`consumed_by_user_id` text,
	`invalidated_at` integer,
	`invalidation_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`consumed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "core_signup_challenge_attempts_check" CHECK("core_signup_challenge"."attempts_remaining" BETWEEN 0 AND 20),
	CONSTRAINT "core_signup_challenge_status_check" CHECK("core_signup_challenge"."status" IN ('PENDING', 'CONSUMED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED'))
);

CREATE UNIQUE INDEX `core_signup_challenge_challenge_digest_unique` ON `core_signup_challenge` (`challenge_digest`);
CREATE INDEX `core_signup_challenge_email_status_expiry_idx` ON `core_signup_challenge` (`email`,`status`,`expires_at`);
CREATE INDEX `core_signup_challenge_status_expiry_idx` ON `core_signup_challenge` (`status`,`expires_at`);
CREATE TABLE `core_user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`email_verified_at` integer,
	`row_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "core_user_row_version_check" CHECK("core_user"."row_version" >= 1)
);

CREATE UNIQUE INDEX `core_user_email_unique` ON `core_user` (`email`);
CREATE TABLE `core_user_role_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by_user_id` text,
	`grant_reason` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_by_user_id` text,
	`revoked_at` integer,
	`revocation_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`granted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "core_user_role_grant_role_check" CHECK("core_user_role_grant"."role" IN ('APPLICANT', 'ADMIN', 'SUPER_ADMIN')),
	CONSTRAINT "core_user_role_grant_revocation_check" CHECK(("core_user_role_grant"."revoked_at" IS NULL AND "core_user_role_grant"."revoked_by_user_id" IS NULL AND "core_user_role_grant"."revocation_reason" IS NULL)
        OR ("core_user_role_grant"."revoked_at" IS NOT NULL
          AND "core_user_role_grant"."revocation_reason" IS NOT NULL
          AND "core_user_role_grant"."revoked_at" >= "core_user_role_grant"."granted_at"))
);

CREATE UNIQUE INDEX `core_user_role_grant_active_uq` ON `core_user_role_grant` (`user_id`,`role`) WHERE "core_user_role_grant"."revoked_at" IS NULL;
CREATE INDEX `core_user_role_grant_user_idx` ON `core_user_role_grant` (`user_id`,`revoked_at`,`role`);
CREATE INDEX `core_user_role_grant_role_idx` ON `core_user_role_grant` (`role`,`revoked_at`,`user_id`);
CREATE TABLE `seb_application` (
	`id` text PRIMARY KEY NOT NULL,
	`applicant_user_id` text NOT NULL,
	`enterprise_id` text NOT NULL,
	`funding_case_id` text NOT NULL,
	`programme_cycle_id` text NOT NULL,
	`application_type` text DEFAULT 'INITIAL' NOT NULL,
	`phase_number` integer DEFAULT 1 NOT NULL,
	`reference_number` text,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`status_version` integer DEFAULT 1 NOT NULL,
	`first_submitted_at` integer,
	FOREIGN KEY (`programme_cycle_id`) REFERENCES `seb_programme_cycle`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applicant_user_id`,`enterprise_id`) REFERENCES `seb_enterprise`(`portal_owner_user_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`enterprise_id`,`funding_case_id`) REFERENCES `seb_funding_case`(`enterprise_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_current_version_check" CHECK("seb_application"."current_version" >= 1),
	CONSTRAINT "seb_application_status_version_check" CHECK("seb_application"."status_version" >= 1),
	CONSTRAINT "seb_application_status_check" CHECK("seb_application"."status" IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED')),
	CONSTRAINT "seb_application_type_check" CHECK("seb_application"."application_type" IN ('INITIAL', 'EXPANSION')),
	CONSTRAINT "seb_application_phase_check" CHECK(("seb_application"."application_type" = 'INITIAL' AND "seb_application"."phase_number" = 1)
        OR ("seb_application"."application_type" = 'EXPANSION' AND "seb_application"."phase_number" >= 2))
);

CREATE UNIQUE INDEX `seb_application_reference_number_unique` ON `seb_application` (`reference_number`);
CREATE UNIQUE INDEX `seb_application_id_cycle_uq` ON `seb_application` (`id`,`programme_cycle_id`);
CREATE UNIQUE INDEX `seb_application_case_id_uq` ON `seb_application` (`funding_case_id`,`id`);
CREATE UNIQUE INDEX `seb_application_owner_id_uq` ON `seb_application` (`applicant_user_id`,`id`);
CREATE UNIQUE INDEX `seb_application_case_cycle_phase_uq` ON `seb_application` (`funding_case_id`,`programme_cycle_id`,`phase_number`);
CREATE INDEX `seb_application_owner_idx` ON `seb_application` (`applicant_user_id`,`deleted_at`,`updated_at`);
CREATE INDEX `seb_application_enterprise_idx` ON `seb_application` (`enterprise_id`,`deleted_at`,`updated_at`);
CREATE INDEX `seb_application_case_phase_idx` ON `seb_application` (`funding_case_id`,`phase_number`);
CREATE INDEX `seb_application_cycle_idx` ON `seb_application` (`programme_cycle_id`,`deleted_at`,`updated_at`);
CREATE INDEX `seb_application_status_idx` ON `seb_application` (`status`,`deleted_at`,`updated_at`);
CREATE TABLE `seb_application_submission` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`submission_number` integer NOT NULL,
	`application_version` integer NOT NULL,
	`submitted_by_user_id` text NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `seb_application`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`application_version`) REFERENCES `seb_application_version`(`application_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_submission_number_check" CHECK("seb_application_submission"."submission_number" >= 1)
);

CREATE UNIQUE INDEX `seb_application_submission_number_uq` ON `seb_application_submission` (`application_id`,`submission_number`);
CREATE UNIQUE INDEX `seb_application_submission_version_uq` ON `seb_application_submission` (`application_id`,`application_version`);
CREATE UNIQUE INDEX `seb_application_submission_application_id_uq` ON `seb_application_submission` (`application_id`,`id`);
CREATE TABLE `seb_application_version` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`version` integer NOT NULL,
	`programme_cycle_id` text NOT NULL,
	`programme_cycle_version` integer NOT NULL,
	`application_type` text NOT NULL,
	`phase_number` integer NOT NULL,
	`change_type` text NOT NULL,
	`change_reason` text,
	`changed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`business_name` text,
	`establishment_date` text,
	`registration_type` text,
	`registration_number` text,
	`gstin` text,
	`business_sector` text,
	`other_business_sector` text,
	`application_category` text,
	`majority_ownership_confirmed` integer,
	`primary_applicant_name` text,
	`designation` text,
	`date_of_birth` text,
	`gender` text,
	`business_block_or_village` text,
	`business_district` text,
	`business_pin_code` text,
	`contact_number` text,
	`contact_email` text,
	`total_project_cost_paise` integer,
	`seed_fund_requested_paise` integer,
	`bank_loan_proposed_paise` integer,
	`promoter_contribution_paise` integer,
	`received_government_funding` integer,
	`government_scheme_name` text,
	`government_funding_amount_paise` integer,
	`government_funding_sanction_year` integer,
	`has_existing_bank_credit` integer,
	`existing_bank_name` text,
	`existing_credit_amount_paise` integer,
	`existing_credit_status` text,
	`prior_sanction_order_number` text,
	`prior_sanction_date` text,
	`prior_net_disbursed_amount_paise` integer,
	`continuous_operation_months` integer,
	`noc_required` integer,
	`relationship_type` text,
	`related_person_name` text,
	`declaration_accepted` integer,
	`declaration_accepted_at` integer,
	`declaration_place` text,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`programme_cycle_id`) REFERENCES `seb_application`(`id`,`programme_cycle_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`programme_cycle_id`,`programme_cycle_version`) REFERENCES `seb_programme_cycle_version`(`programme_cycle_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_version_number_check" CHECK("seb_application_version"."version" >= 1),
	CONSTRAINT "seb_application_version_type_check" CHECK("seb_application_version"."application_type" IN ('INITIAL', 'EXPANSION')),
	CONSTRAINT "seb_application_version_phase_check" CHECK(("seb_application_version"."application_type" = 'INITIAL' AND "seb_application_version"."phase_number" = 1)
        OR ("seb_application_version"."application_type" = 'EXPANSION' AND "seb_application_version"."phase_number" >= 2)),
	CONSTRAINT "seb_application_version_change_type_check" CHECK("seb_application_version"."change_type" IN ('INITIAL', 'SAVE', 'REVISION', 'SUBMISSION', 'RESUBMISSION')),
	CONSTRAINT "seb_application_version_registration_type_check" CHECK("seb_application_version"."registration_type" IS NULL OR "seb_application_version"."registration_type" IN ('NONE', 'CIN', 'UDYAM')),
	CONSTRAINT "seb_application_version_sector_check" CHECK("seb_application_version"."business_sector" IS NULL OR "seb_application_version"."business_sector" IN ('AGRICULTURE_AND_ALLIED', 'HANDLOOM_TEXTILE_AND_HANDICRAFTS', 'FOOD_PROCESSING', 'TOURISM_AND_HOSPITALITY', 'INFORMATION_TECHNOLOGY', 'MANUFACTURING_AND_SERVICES', 'OTHER')),
	CONSTRAINT "seb_application_version_category_check" CHECK("seb_application_version"."application_category" IS NULL OR "seb_application_version"."application_category" IN ('CATEGORY_A', 'CATEGORY_B')),
	CONSTRAINT "seb_application_version_designation_check" CHECK("seb_application_version"."designation" IS NULL OR "seb_application_version"."designation" IN ('PROPRIETOR', 'MANAGING_PARTNER', 'DIRECTOR', 'AUTHORIZED_SIGNATORY')),
	CONSTRAINT "seb_application_version_gender_check" CHECK("seb_application_version"."gender" IS NULL OR "seb_application_version"."gender" IN ('MALE', 'FEMALE', 'OTHER')),
	CONSTRAINT "seb_application_version_credit_status_check" CHECK("seb_application_version"."existing_credit_status" IS NULL OR "seb_application_version"."existing_credit_status" IN ('STANDARD', 'NPA')),
	CONSTRAINT "seb_application_version_relationship_check" CHECK("seb_application_version"."relationship_type" IS NULL OR "seb_application_version"."relationship_type" IN ('SON_OF', 'DAUGHTER_OF', 'WIFE_OF')),
	CONSTRAINT "seb_application_version_money_check" CHECK(("seb_application_version"."total_project_cost_paise" IS NULL OR "seb_application_version"."total_project_cost_paise" >= 0)
        AND ("seb_application_version"."seed_fund_requested_paise" IS NULL OR "seb_application_version"."seed_fund_requested_paise" >= 0)
        AND ("seb_application_version"."bank_loan_proposed_paise" IS NULL OR "seb_application_version"."bank_loan_proposed_paise" >= 0)
        AND ("seb_application_version"."promoter_contribution_paise" IS NULL OR "seb_application_version"."promoter_contribution_paise" >= 0)
        AND ("seb_application_version"."government_funding_amount_paise" IS NULL OR "seb_application_version"."government_funding_amount_paise" >= 0)
        AND ("seb_application_version"."existing_credit_amount_paise" IS NULL OR "seb_application_version"."existing_credit_amount_paise" >= 0)
        AND ("seb_application_version"."prior_net_disbursed_amount_paise" IS NULL OR "seb_application_version"."prior_net_disbursed_amount_paise" >= 0)),
	CONSTRAINT "seb_application_version_boolean_check" CHECK(("seb_application_version"."majority_ownership_confirmed" IS NULL OR "seb_application_version"."majority_ownership_confirmed" IN (0, 1))
        AND ("seb_application_version"."received_government_funding" IS NULL OR "seb_application_version"."received_government_funding" IN (0, 1))
        AND ("seb_application_version"."has_existing_bank_credit" IS NULL OR "seb_application_version"."has_existing_bank_credit" IN (0, 1))
        AND ("seb_application_version"."noc_required" IS NULL OR "seb_application_version"."noc_required" IN (0, 1))
        AND ("seb_application_version"."declaration_accepted" IS NULL OR "seb_application_version"."declaration_accepted" IN (0, 1))),
	CONSTRAINT "seb_application_version_operation_months_check" CHECK("seb_application_version"."continuous_operation_months" IS NULL OR "seb_application_version"."continuous_operation_months" >= 0)
);

CREATE UNIQUE INDEX `seb_application_version_number_uq` ON `seb_application_version` (`application_id`,`version`);
CREATE TABLE `seb_funding_case` (
	`id` text PRIMARY KEY NOT NULL,
	`enterprise_id` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	FOREIGN KEY (`enterprise_id`) REFERENCES `seb_enterprise`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_funding_case_current_version_check" CHECK("seb_funding_case"."current_version" >= 1),
	CONSTRAINT "seb_funding_case_status_check" CHECK("seb_funding_case"."status" IN ('OPEN', 'CLOSED', 'CANCELLED'))
);

CREATE UNIQUE INDEX `seb_funding_case_enterprise_id_unique` ON `seb_funding_case` (`enterprise_id`);
CREATE UNIQUE INDEX `seb_funding_case_enterprise_id_uq` ON `seb_funding_case` (`enterprise_id`,`id`);
CREATE INDEX `seb_funding_case_status_idx` ON `seb_funding_case` (`status`,`deleted_at`,`updated_at`);
CREATE TABLE `seb_funding_case_version` (
	`id` text PRIMARY KEY NOT NULL,
	`funding_case_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`change_type` text NOT NULL,
	`change_reason` text,
	`changed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`funding_case_id`) REFERENCES `seb_funding_case`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_funding_case_version_number_check" CHECK("seb_funding_case_version"."version" >= 1),
	CONSTRAINT "seb_funding_case_version_status_check" CHECK("seb_funding_case_version"."status" IN ('OPEN', 'CLOSED', 'CANCELLED')),
	CONSTRAINT "seb_funding_case_version_change_type_check" CHECK("seb_funding_case_version"."change_type" IN ('CREATED', 'STATUS_CHANGED', 'CORRECTED'))
);

CREATE UNIQUE INDEX `seb_funding_case_version_number_uq` ON `seb_funding_case_version` (`funding_case_id`,`version`);
CREATE TABLE `seb_application_document` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`document_type` text NOT NULL,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	FOREIGN KEY (`application_id`) REFERENCES `seb_application`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_document_version_check" CHECK("seb_application_document"."current_version" >= 1),
	CONSTRAINT "seb_application_document_type_check" CHECK("seb_application_document"."document_type" IN ('IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF', 'BUSINESS_REGISTRATION', 'GST_REGISTRATION', 'DPR', 'BANK_DETAILS', 'NOC'))
);

CREATE UNIQUE INDEX `seb_application_document_type_uq` ON `seb_application_document` (`application_id`,`document_type`);
CREATE TABLE `seb_application_document_version` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`operation` text NOT NULL,
	`r2_object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text NOT NULL,
	`uploaded_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `seb_application_document`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_document_version_number_check" CHECK("seb_application_document_version"."version" >= 1),
	CONSTRAINT "seb_application_document_size_check" CHECK("seb_application_document_version"."size_bytes" >= 0),
	CONSTRAINT "seb_application_document_operation_check" CHECK("seb_application_document_version"."operation" IN ('UPLOAD', 'REPLACE'))
);

CREATE UNIQUE INDEX `seb_application_document_version_r2_object_key_unique` ON `seb_application_document_version` (`r2_object_key`);
CREATE UNIQUE INDEX `seb_application_document_version_number_uq` ON `seb_application_document_version` (`document_id`,`version`);
CREATE TABLE `seb_document_upload_intent` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`applicant_user_id` text NOT NULL,
	`document_type` text NOT NULL,
	`expected_document_version` integer NOT NULL,
	`object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`cleanup_target_status` text,
	`expires_at` integer NOT NULL,
	`finalized_document_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `seb_application`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applicant_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`finalized_document_version_id`) REFERENCES `seb_application_document_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applicant_user_id`,`application_id`) REFERENCES `seb_application`(`applicant_user_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_document_upload_intent_type_check" CHECK("seb_document_upload_intent"."document_type" IN ('IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF', 'BUSINESS_REGISTRATION', 'GST_REGISTRATION', 'DPR', 'BANK_DETAILS', 'NOC')),
	CONSTRAINT "seb_document_upload_intent_status_check" CHECK("seb_document_upload_intent"."status" IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')),
	CONSTRAINT "seb_document_upload_intent_expected_version_check" CHECK("seb_document_upload_intent"."expected_document_version" >= 0),
	CONSTRAINT "seb_document_upload_intent_size_check" CHECK("seb_document_upload_intent"."size_bytes" > 0 AND "seb_document_upload_intent"."size_bytes" <= 10485760),
	CONSTRAINT "seb_document_upload_intent_lifecycle_check" CHECK(("seb_document_upload_intent"."status" = 'FINALIZED'
          AND "seb_document_upload_intent"."finalized_document_version_id" IS NOT NULL
          AND "seb_document_upload_intent"."cleanup_target_status" IS NULL)
        OR ("seb_document_upload_intent"."status" = 'CLEANUP_PENDING'
          AND "seb_document_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_document_upload_intent"."cleanup_target_status" IN ('REJECTED', 'EXPIRED'))
        OR ("seb_document_upload_intent"."status" NOT IN ('FINALIZED', 'CLEANUP_PENDING')
          AND "seb_document_upload_intent"."finalized_document_version_id" IS NULL
          AND "seb_document_upload_intent"."cleanup_target_status" IS NULL))
);

CREATE UNIQUE INDEX `seb_document_upload_intent_object_key_unique` ON `seb_document_upload_intent` (`object_key`);
CREATE INDEX `seb_document_upload_intent_cleanup_idx` ON `seb_document_upload_intent` (`status`,`expires_at`);
CREATE INDEX `seb_document_upload_intent_owner_idx` ON `seb_document_upload_intent` (`applicant_user_id`,`application_id`,`created_at`);
CREATE TABLE `seb_enterprise` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_owner_user_id` text NOT NULL,
	`current_name` text NOT NULL,
	`registration_type` text DEFAULT 'NONE' NOT NULL,
	`registration_number` text,
	`gstin` text,
	`status` text DEFAULT 'PROPOSED' NOT NULL,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	FOREIGN KEY (`portal_owner_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_enterprise_current_version_check" CHECK("seb_enterprise"."current_version" >= 1),
	CONSTRAINT "seb_enterprise_status_check" CHECK("seb_enterprise"."status" IN ('PROPOSED', 'ACTIVE', 'INACTIVE')),
	CONSTRAINT "seb_enterprise_registration_check" CHECK(("seb_enterprise"."registration_type" = 'NONE' AND "seb_enterprise"."registration_number" IS NULL)
        OR ("seb_enterprise"."registration_type" IN ('CIN', 'UDYAM') AND "seb_enterprise"."registration_number" IS NOT NULL))
);

CREATE UNIQUE INDEX `seb_enterprise_gstin_unique` ON `seb_enterprise` (`gstin`);
CREATE UNIQUE INDEX `seb_enterprise_owner_id_uq` ON `seb_enterprise` (`portal_owner_user_id`,`id`);
CREATE UNIQUE INDEX `seb_enterprise_registration_uq` ON `seb_enterprise` (`registration_type`,`registration_number`);
CREATE INDEX `seb_enterprise_owner_idx` ON `seb_enterprise` (`portal_owner_user_id`,`deleted_at`,`updated_at`);
CREATE TABLE `seb_enterprise_version` (
	`id` text PRIMARY KEY NOT NULL,
	`enterprise_id` text NOT NULL,
	`version` integer NOT NULL,
	`change_type` text NOT NULL,
	`change_reason` text,
	`changed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`name` text NOT NULL,
	`establishment_date` text,
	`registration_type` text NOT NULL,
	`registration_number` text,
	`gstin` text,
	`business_sector` text,
	`other_business_sector` text,
	`business_block_or_village` text,
	`business_district` text,
	`business_pin_code` text,
	`contact_number` text,
	`contact_email` text,
	`status` text NOT NULL,
	FOREIGN KEY (`enterprise_id`) REFERENCES `seb_enterprise`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_enterprise_version_number_check" CHECK("seb_enterprise_version"."version" >= 1),
	CONSTRAINT "seb_enterprise_version_change_type_check" CHECK("seb_enterprise_version"."change_type" IN ('CREATED', 'UPDATED', 'CORRECTED')),
	CONSTRAINT "seb_enterprise_version_status_check" CHECK("seb_enterprise_version"."status" IN ('PROPOSED', 'ACTIVE', 'INACTIVE')),
	CONSTRAINT "seb_enterprise_version_registration_check" CHECK(("seb_enterprise_version"."registration_type" = 'NONE' AND "seb_enterprise_version"."registration_number" IS NULL)
        OR ("seb_enterprise_version"."registration_type" IN ('CIN', 'UDYAM') AND "seb_enterprise_version"."registration_number" IS NOT NULL)),
	CONSTRAINT "seb_enterprise_version_sector_check" CHECK("seb_enterprise_version"."business_sector" IS NULL OR "seb_enterprise_version"."business_sector" IN ('AGRICULTURE_AND_ALLIED', 'HANDLOOM_TEXTILE_AND_HANDICRAFTS', 'FOOD_PROCESSING', 'TOURISM_AND_HOSPITALITY', 'INFORMATION_TECHNOLOGY', 'MANUFACTURING_AND_SERVICES', 'OTHER'))
);

CREATE UNIQUE INDEX `seb_enterprise_version_number_uq` ON `seb_enterprise_version` (`enterprise_id`,`version`);
CREATE TABLE `seb_application_qualifying_award` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`funding_case_id` text NOT NULL,
	`current_funding_award_id` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`current_version` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`cancelled_at` integer,
	`cancelled_by_user_id` text,
	`cancellation_reason` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`funding_case_id`,`application_id`) REFERENCES `seb_application`(`funding_case_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`funding_case_id`,`current_funding_award_id`) REFERENCES `seb_funding_award`(`funding_case_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_qualifying_award_version_check" CHECK("seb_application_qualifying_award"."current_version" >= 1),
	CONSTRAINT "seb_application_qualifying_award_status_check" CHECK("seb_application_qualifying_award"."status" IN ('ACTIVE', 'CANCELLED')),
	CONSTRAINT "seb_application_qualifying_award_lifecycle_check" CHECK(("seb_application_qualifying_award"."status" = 'ACTIVE'
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

CREATE UNIQUE INDEX `seb_application_qualifying_award_application_id_unique` ON `seb_application_qualifying_award` (`application_id`);
CREATE UNIQUE INDEX `seb_application_qualifying_award_id_case_uq` ON `seb_application_qualifying_award` (`id`,`funding_case_id`);
CREATE UNIQUE INDEX `seb_application_qualifying_award_current_award_uq` ON `seb_application_qualifying_award` (`current_funding_award_id`);
CREATE INDEX `seb_application_qualifying_award_case_idx` ON `seb_application_qualifying_award` (`funding_case_id`,`status`,`updated_at`);
CREATE TABLE `seb_application_qualifying_award_version` (
	`id` text PRIMARY KEY NOT NULL,
	`qualifying_award_link_id` text NOT NULL,
	`funding_case_id` text NOT NULL,
	`version` integer NOT NULL,
	`funding_award_id` text NOT NULL,
	`status` text NOT NULL,
	`change_type` text NOT NULL,
	`change_reason` text,
	`changed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`qualifying_award_link_id`,`funding_case_id`) REFERENCES `seb_application_qualifying_award`(`id`,`funding_case_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`funding_case_id`,`funding_award_id`) REFERENCES `seb_funding_award`(`funding_case_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_qualifying_award_version_number_check" CHECK("seb_application_qualifying_award_version"."version" >= 1),
	CONSTRAINT "seb_application_qualifying_award_version_status_check" CHECK("seb_application_qualifying_award_version"."status" IN ('ACTIVE', 'CANCELLED')),
	CONSTRAINT "seb_application_qualifying_award_version_change_type_check" CHECK("seb_application_qualifying_award_version"."change_type" IN ('LINKED', 'CORRECTED', 'CANCELLED')),
	CONSTRAINT "seb_application_qualifying_award_version_state_check" CHECK(("seb_application_qualifying_award_version"."change_type" IN ('LINKED', 'CORRECTED') AND "seb_application_qualifying_award_version"."status" = 'ACTIVE')
        OR ("seb_application_qualifying_award_version"."change_type" = 'CANCELLED' AND "seb_application_qualifying_award_version"."status" = 'CANCELLED'))
);

CREATE UNIQUE INDEX `seb_application_qualifying_award_version_number_uq` ON `seb_application_qualifying_award_version` (`qualifying_award_link_id`,`version`);
CREATE TABLE `seb_award_assessment` (
	`id` text PRIMARY KEY NOT NULL,
	`funding_award_id` text NOT NULL,
	`assessment_type` text NOT NULL,
	`assessment_number` integer NOT NULL,
	`outcome` text NOT NULL,
	`note` text,
	`assessed_by_user_id` text NOT NULL,
	`assessed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`funding_award_id`) REFERENCES `seb_funding_award`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assessed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_award_assessment_number_check" CHECK("seb_award_assessment"."assessment_number" >= 1),
	CONSTRAINT "seb_award_assessment_type_check" CHECK("seb_award_assessment"."assessment_type" IN ('UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT')),
	CONSTRAINT "seb_award_assessment_outcome_check" CHECK("seb_award_assessment"."outcome" IN ('PASSED', 'FAILED'))
);

CREATE UNIQUE INDEX `seb_award_assessment_number_uq` ON `seb_award_assessment` (`funding_award_id`,`assessment_type`,`assessment_number`);
CREATE TABLE `seb_disbursement` (
	`id` text PRIMARY KEY NOT NULL,
	`funding_award_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`entry_type` text NOT NULL,
	`related_disbursement_id` text,
	`amount_paise` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`external_reference` text,
	`recorded_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`funding_award_id`) REFERENCES `seb_funding_award`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recorded_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`funding_award_id`,`related_disbursement_id`) REFERENCES `seb_disbursement`(`funding_award_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_disbursement_sequence_check" CHECK("seb_disbursement"."sequence_number" >= 1),
	CONSTRAINT "seb_disbursement_amount_check" CHECK("seb_disbursement"."amount_paise" > 0),
	CONSTRAINT "seb_disbursement_entry_type_check" CHECK("seb_disbursement"."entry_type" IN ('RELEASE', 'REVERSAL')),
	CONSTRAINT "seb_disbursement_relation_check" CHECK(("seb_disbursement"."entry_type" = 'RELEASE' AND "seb_disbursement"."related_disbursement_id" IS NULL)
        OR ("seb_disbursement"."entry_type" = 'REVERSAL' AND "seb_disbursement"."related_disbursement_id" IS NOT NULL))
);

CREATE UNIQUE INDEX `seb_disbursement_external_reference_unique` ON `seb_disbursement` (`external_reference`);
CREATE UNIQUE INDEX `seb_disbursement_award_sequence_uq` ON `seb_disbursement` (`funding_award_id`,`sequence_number`);
CREATE UNIQUE INDEX `seb_disbursement_award_id_uq` ON `seb_disbursement` (`funding_award_id`,`id`);
CREATE INDEX `seb_disbursement_award_occurred_idx` ON `seb_disbursement` (`funding_award_id`,`occurred_at`);
CREATE TABLE `seb_funding_award` (
	`id` text PRIMARY KEY NOT NULL,
	`funding_case_id` text NOT NULL,
	`application_id` text NOT NULL,
	`sanction_order_number` text NOT NULL,
	`sanction_date` text NOT NULL,
	`sanctioned_amount_paise` integer NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	FOREIGN KEY (`funding_case_id`) REFERENCES `seb_funding_case`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`funding_case_id`,`application_id`) REFERENCES `seb_application`(`funding_case_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_funding_award_current_version_check" CHECK("seb_funding_award"."current_version" >= 1),
	CONSTRAINT "seb_funding_award_amount_check" CHECK("seb_funding_award"."sanctioned_amount_paise" > 0),
	CONSTRAINT "seb_funding_award_status_check" CHECK("seb_funding_award"."status" IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED'))
);

CREATE UNIQUE INDEX `seb_funding_award_application_id_unique` ON `seb_funding_award` (`application_id`);
CREATE UNIQUE INDEX `seb_funding_award_sanction_order_number_unique` ON `seb_funding_award` (`sanction_order_number`);
CREATE UNIQUE INDEX `seb_funding_award_case_id_uq` ON `seb_funding_award` (`funding_case_id`,`id`);
CREATE INDEX `seb_funding_award_case_idx` ON `seb_funding_award` (`funding_case_id`,`deleted_at`,`sanction_date`);
CREATE INDEX `seb_funding_award_status_idx` ON `seb_funding_award` (`status`,`deleted_at`,`updated_at`);
CREATE TABLE `seb_funding_award_version` (
	`id` text PRIMARY KEY NOT NULL,
	`funding_award_id` text NOT NULL,
	`version` integer NOT NULL,
	`sanction_order_number` text NOT NULL,
	`sanction_date` text NOT NULL,
	`sanctioned_amount_paise` integer NOT NULL,
	`status` text NOT NULL,
	`change_type` text NOT NULL,
	`change_reason` text,
	`changed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`funding_award_id`) REFERENCES `seb_funding_award`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_funding_award_version_number_check" CHECK("seb_funding_award_version"."version" >= 1),
	CONSTRAINT "seb_funding_award_version_amount_check" CHECK("seb_funding_award_version"."sanctioned_amount_paise" > 0),
	CONSTRAINT "seb_funding_award_version_status_check" CHECK("seb_funding_award_version"."status" IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED')),
	CONSTRAINT "seb_funding_award_version_change_type_check" CHECK("seb_funding_award_version"."change_type" IN ('CREATED', 'AMENDED', 'STATUS_CHANGED', 'CORRECTED'))
);

CREATE UNIQUE INDEX `seb_funding_award_version_number_uq` ON `seb_funding_award_version` (`funding_award_id`,`version`);
CREATE TABLE `seb_programme_cycle` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_code` text NOT NULL,
	`cycle_year` integer NOT NULL,
	`policy_reference` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by_user_id` text,
	`delete_reason` text,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_programme_cycle_year_check" CHECK("seb_programme_cycle"."cycle_year" >= 1),
	CONSTRAINT "seb_programme_cycle_current_version_check" CHECK("seb_programme_cycle"."current_version" >= 1),
	CONSTRAINT "seb_programme_cycle_status_check" CHECK("seb_programme_cycle"."status" IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_window_check" CHECK("seb_programme_cycle"."opens_at" IS NULL OR "seb_programme_cycle"."closes_at" IS NULL OR "seb_programme_cycle"."closes_at" > "seb_programme_cycle"."opens_at")
);

CREATE UNIQUE INDEX `seb_programme_cycle_cycle_code_unique` ON `seb_programme_cycle` (`cycle_code`);
CREATE INDEX `seb_programme_cycle_status_idx` ON `seb_programme_cycle` (`status`,`deleted_at`,`opens_at`);
CREATE TABLE `seb_programme_cycle_version` (
	`id` text PRIMARY KEY NOT NULL,
	`programme_cycle_id` text NOT NULL,
	`version` integer NOT NULL,
	`cycle_code` text NOT NULL,
	`cycle_year` integer NOT NULL,
	`policy_reference` text,
	`status` text NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`change_type` text NOT NULL,
	`change_reason` text,
	`changed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`programme_cycle_id`) REFERENCES `seb_programme_cycle`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_programme_cycle_version_number_check" CHECK("seb_programme_cycle_version"."version" >= 1),
	CONSTRAINT "seb_programme_cycle_version_year_check" CHECK("seb_programme_cycle_version"."cycle_year" >= 1),
	CONSTRAINT "seb_programme_cycle_version_status_check" CHECK("seb_programme_cycle_version"."status" IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')),
	CONSTRAINT "seb_programme_cycle_version_change_type_check" CHECK("seb_programme_cycle_version"."change_type" IN ('CREATED', 'UPDATED', 'CORRECTED')),
	CONSTRAINT "seb_programme_cycle_version_window_check" CHECK("seb_programme_cycle_version"."opens_at" IS NULL OR "seb_programme_cycle_version"."closes_at" IS NULL OR "seb_programme_cycle_version"."closes_at" > "seb_programme_cycle_version"."opens_at")
);

CREATE UNIQUE INDEX `seb_programme_cycle_version_number_uq` ON `seb_programme_cycle_version` (`programme_cycle_id`,`version`);
CREATE TABLE `seb_application_event` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text,
	`application_version` integer,
	`submission_id` text,
	`revision_request_id` text,
	`from_status` text,
	`to_status` text,
	`section` text,
	`message` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `seb_application`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`application_version`) REFERENCES `seb_application_version`(`application_id`,`version`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`submission_id`) REFERENCES `seb_application_submission`(`application_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`revision_request_id`) REFERENCES `seb_revision_request`(`application_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_application_event_section_check" CHECK("seb_application_event"."section" IS NULL OR "seb_application_event"."section" IN ('ENTERPRISE', 'APPLICANT_PROFILE', 'FINANCIAL', 'PRIOR_FUNDING', 'EXPANSION', 'DOCUMENTS', 'DECLARATION')),
	CONSTRAINT "seb_application_event_from_status_check" CHECK("seb_application_event"."from_status" IS NULL OR "seb_application_event"."from_status" IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED')),
	CONSTRAINT "seb_application_event_to_status_check" CHECK("seb_application_event"."to_status" IS NULL OR "seb_application_event"."to_status" IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED'))
);

CREATE INDEX `seb_application_event_application_idx` ON `seb_application_event` (`application_id`,`created_at`);
CREATE TABLE `seb_revision_request` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`section` text NOT NULL,
	`note` text NOT NULL,
	`requested_by_user_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`resolved_by_submission_id` text,
	`resolved_at` integer,
	`cancelled_at` integer,
	`cancelled_by_user_id` text,
	`cancellation_reason` text,
	FOREIGN KEY (`application_id`) REFERENCES `seb_application`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`submission_id`) REFERENCES `seb_application_submission`(`application_id`,`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`application_id`,`resolved_by_submission_id`) REFERENCES `seb_application_submission`(`application_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_revision_request_section_check" CHECK("seb_revision_request"."section" IN ('ENTERPRISE', 'APPLICANT_PROFILE', 'FINANCIAL', 'PRIOR_FUNDING', 'EXPANSION', 'DOCUMENTS', 'DECLARATION')),
	CONSTRAINT "seb_revision_request_resolution_fields_check" CHECK(("seb_revision_request"."resolved_by_submission_id" IS NULL AND "seb_revision_request"."resolved_at" IS NULL)
        OR ("seb_revision_request"."resolved_by_submission_id" IS NOT NULL AND "seb_revision_request"."resolved_at" IS NOT NULL)),
	CONSTRAINT "seb_revision_request_cancellation_fields_check" CHECK(("seb_revision_request"."cancelled_at" IS NULL AND "seb_revision_request"."cancelled_by_user_id" IS NULL AND "seb_revision_request"."cancellation_reason" IS NULL)
        OR ("seb_revision_request"."cancelled_at" IS NOT NULL AND "seb_revision_request"."cancelled_by_user_id" IS NOT NULL AND "seb_revision_request"."cancellation_reason" IS NOT NULL)),
	CONSTRAINT "seb_revision_request_terminal_state_check" CHECK(NOT ("seb_revision_request"."resolved_at" IS NOT NULL AND "seb_revision_request"."cancelled_at" IS NOT NULL))
);

CREATE INDEX `seb_revision_request_application_idx` ON `seb_revision_request` (`application_id`,`resolved_at`,`cancelled_at`,`requested_at`);
CREATE UNIQUE INDEX `seb_revision_request_application_id_uq` ON `seb_revision_request` (`application_id`,`id`);
