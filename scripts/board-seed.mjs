/**
 * The announcement board's one seeded row.
 *
 * The board is the banner's contention point (see
 * `src/db/schema/seb/announcement.ts`), and its row is seeded rather than
 * lazily created so reads stay read-only. The deployed database receives it
 * from migration `0002_announcement-banner`; every path that builds a database
 * from `database/schema.sql` instead — the local setup, the e2e reset, and the
 * test harness after each truncate — runs this same statement, kept here once
 * so the copies cannot drift.
 */
export const ANNOUNCEMENT_BOARD_SEED =
  `INSERT INTO "seb_announcement_board" ("id", "current_version", "updated_at") ` +
  `VALUES ('BOARD', 1, now()) ON CONFLICT DO NOTHING`
