/**
 * Which schema migrations a database has already had applied.
 *
 * `database/schema.sql` is a baseline: it creates the current shape of every
 * table, and it is guarded with `IF NOT EXISTS` so re-running it is harmless.
 * That guard is worth having and is not a migration — it only ever helps an
 * object that does not exist yet, and it silently does nothing for a table that
 * already exists with an older `CHECK` constraint or a missing column.
 *
 * So changes to existing tables live in `database/migrations/` as ordered
 * files, and this table records which of them a given database has run.
 *
 * ## Written in the same batch as the migration it records
 *
 * The ledger row and the migration's own statements go in one D1 batch, which
 * is one transaction. Recording afterwards would let a crash in between leave a
 * database that has been migrated but does not know it — and the next run would
 * apply the same file twice. For a table rebuild, applying twice destroys data
 * rather than erroring.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const coreSchemaMigration = sqliteTable('core_schema_migration', {
  /**
   * The migration's filename without its extension, e.g. `0001-staff-roles`.
   *
   * The file *is* the identity. A checksum column was considered and rejected:
   * it would turn an editorial fix to a comment into a failed deploy, and the
   * real protection against an edited migration is that applied files are never
   * edited — a correction is a new migration.
   */
  id: text('id').primaryKey(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
})
