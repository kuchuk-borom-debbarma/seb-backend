-- Lowers the accepted upload size from 10 MB to 5 MB.
--
-- Tightening a bound, so existing rows can violate the new constraint. The
-- copy below fails on any intent recorded above 5 MB rather than truncating
-- silently, which is the right failure: somebody has to decide what happens to
-- those documents before the cap can come down.
--
-- SQLite cannot ALTER a CHECK constraint, so this is the four-step rebuild:
-- create the table in its new shape, copy every row, drop the old, rename.
-- The indexes go last because they are dropped with the table they were on.
--
-- Two details that are easy to get wrong and fail only at runtime:
--
--   * The constraints below name their columns unqualified. A CHECK that
--     qualifies its own table does not survive the rename — the reference
--     keeps the temporary name and the table becomes unusable.
--   * Nothing here is guarded with IF NOT EXISTS. A guarded rebuild that ran
--     twice would skip the create and then copy rows out of a table that is
--     already the new one. The guard belongs on a baseline; what makes this
--     run exactly once is the ledger row written in the same batch.

PRAGMA foreign_keys = OFF;

CREATE TABLE `seb_document_upload_intent__new` (
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
	CONSTRAINT "seb_document_upload_intent_type_check" CHECK("document_type" IN ('IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF', 'BUSINESS_REGISTRATION', 'GST_REGISTRATION', 'DPR', 'BANK_DETAILS', 'NOC')),
	CONSTRAINT "seb_document_upload_intent_status_check" CHECK("status" IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')),
	CONSTRAINT "seb_document_upload_intent_expected_version_check" CHECK("expected_document_version" >= 0),
	CONSTRAINT "seb_document_upload_intent_size_check" CHECK("size_bytes" > 0 AND "size_bytes" <= 5242880),
	CONSTRAINT "seb_document_upload_intent_lifecycle_check" CHECK(("status" = 'FINALIZED'
          AND "finalized_document_version_id" IS NOT NULL
          AND "cleanup_target_status" IS NULL)
        OR ("status" = 'CLEANUP_PENDING'
          AND "finalized_document_version_id" IS NULL
          AND "cleanup_target_status" IN ('REJECTED', 'EXPIRED'))
        OR ("status" NOT IN ('FINALIZED', 'CLEANUP_PENDING')
          AND "finalized_document_version_id" IS NULL
          AND "cleanup_target_status" IS NULL))
);

INSERT INTO `seb_document_upload_intent__new` (`id`, `application_id`, `applicant_user_id`, `document_type`, `expected_document_version`, `object_key`, `original_filename`, `content_type`, `size_bytes`, `checksum_sha256`, `status`, `cleanup_target_status`, `expires_at`, `finalized_document_version_id`, `created_at`, `updated_at`)
SELECT `id`, `application_id`, `applicant_user_id`, `document_type`, `expected_document_version`, `object_key`, `original_filename`, `content_type`, `size_bytes`, `checksum_sha256`, `status`, `cleanup_target_status`, `expires_at`, `finalized_document_version_id`, `created_at`, `updated_at` FROM `seb_document_upload_intent`;

DROP TABLE `seb_document_upload_intent`;
ALTER TABLE `seb_document_upload_intent__new` RENAME TO `seb_document_upload_intent`;

CREATE UNIQUE INDEX IF NOT EXISTS `seb_document_upload_intent_object_key_unique` ON `seb_document_upload_intent` (`object_key`);
CREATE INDEX IF NOT EXISTS `seb_document_upload_intent_cleanup_idx` ON `seb_document_upload_intent` (`status`,`expires_at`);
CREATE INDEX IF NOT EXISTS `seb_document_upload_intent_owner_idx` ON `seb_document_upload_intent` (`applicant_user_id`,`application_id`,`created_at`);

PRAGMA foreign_keys = ON;
