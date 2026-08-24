-- Adds the per-cycle identifier rules the desk review consults.
--
-- Which identity numbers a programme cycle demands, and which it compares
-- against other applications, used to be a three-entry constant in the code.
-- It is now a policy decision recorded per cycle and frozen into the cycle
-- version, so editing a cycle cannot change what an already-submitted
-- application is judged by.
--
-- Purely additive: a new table and its indexes, nothing rebuilt. A cycle with
-- no rows here demands nothing and compares nothing, which is the correct
-- reading for every cycle that existed before this ran.

CREATE TABLE IF NOT EXISTS `seb_programme_cycle_identifier_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`programme_cycle_id` text NOT NULL,
	`programme_cycle_version` integer NOT NULL,
	`kind` text NOT NULL,
	`requirement` text NOT NULL,
	`duplicate_policy` text NOT NULL,
	`check_type` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`programme_cycle_id`,`programme_cycle_version`) REFERENCES `seb_programme_cycle_version`(`programme_cycle_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "seb_programme_cycle_identifier_rule_kind_check" CHECK("seb_programme_cycle_identifier_rule"."kind" IN ('ST_CERTIFICATE', 'IDENTITY_DOCUMENT', 'BANK_ACCOUNT', 'BUSINESS_REGISTRATION')),
	CONSTRAINT "seb_programme_cycle_identifier_rule_requirement_check" CHECK("seb_programme_cycle_identifier_rule"."requirement" IN ('REQUIRED_ON_PASS', 'OPTIONAL', 'OFF')),
	CONSTRAINT "seb_programme_cycle_identifier_rule_duplicate_check" CHECK("seb_programme_cycle_identifier_rule"."duplicate_policy" IN ('CHECKED', 'NOT_CHECKED')),
	CONSTRAINT "seb_programme_cycle_identifier_rule_check_type_check" CHECK(("seb_programme_cycle_identifier_rule"."requirement" <> 'REQUIRED_ON_PASS' AND "seb_programme_cycle_identifier_rule"."check_type" IS NULL)
        OR ("seb_programme_cycle_identifier_rule"."requirement" = 'REQUIRED_ON_PASS' AND "seb_programme_cycle_identifier_rule"."check_type" IN (
          'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
          'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
          'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE')))
);

CREATE UNIQUE INDEX IF NOT EXISTS `seb_programme_cycle_identifier_rule_kind_uq` ON `seb_programme_cycle_identifier_rule` (`programme_cycle_id`,`programme_cycle_version`,`kind`);
