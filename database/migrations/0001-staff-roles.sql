-- Adds REVIEWER and APPROVER to the roles a grant may name.
--
-- Before this, staff were one undifferentiated ADMIN. A reviewer who may only
-- read casework, and an approver who may read and decide but not administer,
-- both need a grant row — and the CHECK on `role` refused both.
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

CREATE TABLE `core_user_role_grant__new` (
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
	CONSTRAINT "core_user_role_grant_role_check" CHECK("role" IN ('APPLICANT', 'REVIEWER', 'APPROVER', 'ADMIN', 'SUPER_ADMIN')),
	CONSTRAINT "core_user_role_grant_revocation_check" CHECK(("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL AND "revocation_reason" IS NULL)
        OR ("revoked_at" IS NOT NULL
          AND "revocation_reason" IS NOT NULL
          AND "revoked_at" >= "granted_at"))
);

INSERT INTO `core_user_role_grant__new` (`id`, `user_id`, `role`, `granted_by_user_id`, `grant_reason`, `granted_at`, `revoked_by_user_id`, `revoked_at`, `revocation_reason`)
SELECT `id`, `user_id`, `role`, `granted_by_user_id`, `grant_reason`, `granted_at`, `revoked_by_user_id`, `revoked_at`, `revocation_reason` FROM `core_user_role_grant`;

DROP TABLE `core_user_role_grant`;
ALTER TABLE `core_user_role_grant__new` RENAME TO `core_user_role_grant`;

CREATE UNIQUE INDEX IF NOT EXISTS `core_user_role_grant_active_uq` ON `core_user_role_grant` (`user_id`,`role`) WHERE "core_user_role_grant"."revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS `core_user_role_grant_user_idx` ON `core_user_role_grant` (`user_id`,`revoked_at`,`role`);
CREATE INDEX IF NOT EXISTS `core_user_role_grant_role_idx` ON `core_user_role_grant` (`role`,`revoked_at`,`user_id`);

PRAGMA foreign_keys = ON;
