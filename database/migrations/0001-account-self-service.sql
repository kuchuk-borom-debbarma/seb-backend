-- Account self-service: password reset, email change, and a display name.
--
-- The first migration in this repository. Everything before it was carried by
-- `../schema.sql` alone, which was correct while no database had to survive a
-- change. One does now: the deployed D1 holds real accounts.
--
-- Two changes, one file, because the live database should have one route
-- forward rather than two half-applied ones.
--
-- ## On running this twice
--
-- The `CREATE`s are guarded and would be skipped. `ALTER TABLE ADD COLUMN`
-- cannot be — SQLite has no `IF NOT EXISTS` for it, and a second run fails with
-- `duplicate column name`. That is not the mechanism that makes this run once.
-- The ledger is: `scripts/migrate.mjs` reads what `core_schema_migration`
-- already records, applies only what is missing, and writes this file and its
-- ledger row in ONE batch — one D1 transaction — so a crash between the two is
-- impossible. `npm run db:migrate` a second time prints "Nothing to do".
--
-- Apply it with `npm run db:migrate` (or `db:migrate:remote`), never by hand.

CREATE TABLE IF NOT EXISTS `core_account_challenge` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`challenge_digest` text NOT NULL,
	`otp_digest` text NOT NULL,
	`attempts_remaining` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`consumed_at` integer,
	`invalidated_at` integer,
	`invalidation_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `core_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "core_account_challenge_attempts_check" CHECK("core_account_challenge"."attempts_remaining" BETWEEN 0 AND 20),
	CONSTRAINT "core_account_challenge_purpose_check" CHECK("core_account_challenge"."purpose" IN ('PASSWORD_RESET', 'EMAIL_CHANGE')),
	CONSTRAINT "core_account_challenge_status_check" CHECK("core_account_challenge"."status" IN ('PENDING', 'CONSUMED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'DELIVERY_FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS `core_account_challenge_challenge_digest_unique` ON `core_account_challenge` (`challenge_digest`);
CREATE INDEX IF NOT EXISTS `core_account_challenge_user_purpose_idx` ON `core_account_challenge` (`user_id`,`purpose`,`status`,`expires_at`);
CREATE INDEX IF NOT EXISTS `core_account_challenge_status_expiry_idx` ON `core_account_challenge` (`status`,`expires_at`);

-- Appended, not inserted. `ADD COLUMN` can only append, so `display_name` is
-- declared last in `src/db/schema/core/auth.ts` too — otherwise a database
-- built from the baseline and one built by this migration would disagree about
-- column order, and `check-migrations.mjs` compares exactly that.
--
-- No rebuild is needed and none is wanted: the column is nullable with no
-- default and no constraint, which is the one shape `ADD COLUMN` handles
-- outright. Every existing row reads NULL, which is the truth — nobody has said
-- what they are called yet.
ALTER TABLE `core_user` ADD COLUMN `display_name` text;
