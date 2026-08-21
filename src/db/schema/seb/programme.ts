/**
 * Versioned Mission SEP policy/application cycles.
 *
 * Cycles keep applications tied to the exact policy window under which they
 * were submitted. No monetary ceiling is stored until TTAADC resolves the
 * contradictory amount in the supplied policy document.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { coreUser } from '../core/auth'
import { versionedSoftDeleteColumns } from '../shared'

export const programmeCycleStatuses = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] as const
export const programmeCycleChangeTypes = ['CREATED', 'UPDATED', 'CORRECTED'] as const

/** Current searchable state of one Mission SEP programme cycle. */
export const sebProgrammeCycle = sqliteTable(
  'seb_programme_cycle',
  {
    id: text('id').primaryKey(),
    cycleCode: text('cycle_code').notNull().unique(),
    cycleYear: integer('cycle_year').notNull(),
    policyReference: text('policy_reference'),
    status: text('status', { enum: programmeCycleStatuses }).notNull().default('DRAFT'),
    opensAt: integer('opens_at', { mode: 'timestamp_ms' }),
    closesAt: integer('closes_at', { mode: 'timestamp_ms' }),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    check('seb_programme_cycle_year_check', sql`${table.cycleYear} >= 1`),
    check('seb_programme_cycle_current_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_programme_cycle_status_check',
      sql`${table.status} IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')`,
    ),
    check(
      'seb_programme_cycle_window_check',
      sql`${table.opensAt} IS NULL OR ${table.closesAt} IS NULL OR ${table.closesAt} > ${table.opensAt}`,
    ),
    index('seb_programme_cycle_status_idx').on(table.status, table.deletedAt, table.opensAt),
  ],
)

/** Immutable policy-window snapshot for a programme cycle. */
export const sebProgrammeCycleVersion = sqliteTable(
  'seb_programme_cycle_version',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    cycleCode: text('cycle_code').notNull(),
    cycleYear: integer('cycle_year').notNull(),
    policyReference: text('policy_reference'),
    status: text('status', { enum: programmeCycleStatuses }).notNull(),
    opensAt: integer('opens_at', { mode: 'timestamp_ms' }),
    closesAt: integer('closes_at', { mode: 'timestamp_ms' }),
    changeType: text('change_type', { enum: programmeCycleChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_programme_cycle_version_number_uq').on(
      table.programmeCycleId,
      table.version,
    ),
    check('seb_programme_cycle_version_number_check', sql`${table.version} >= 1`),
    check('seb_programme_cycle_version_year_check', sql`${table.cycleYear} >= 1`),
    check(
      'seb_programme_cycle_version_status_check',
      sql`${table.status} IN ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED')`,
    ),
    check(
      'seb_programme_cycle_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'UPDATED', 'CORRECTED')`,
    ),
    check(
      'seb_programme_cycle_version_window_check',
      sql`${table.opensAt} IS NULL OR ${table.closesAt} IS NULL OR ${table.closesAt} > ${table.opensAt}`,
    ),
  ],
)
