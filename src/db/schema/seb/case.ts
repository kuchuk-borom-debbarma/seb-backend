/** Long-lived Mission SEP funding case shared by every phase for an enterprise. */
import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { instant, versionedSoftDeleteColumns } from '../shared'
import { sebEnterprise } from './enterprise'

export const fundingCaseStatuses = ['OPEN', 'CLOSED', 'CANCELLED'] as const
export const fundingCaseChangeTypes = ['CREATED', 'STATUS_CHANGED', 'CORRECTED'] as const

/** One funding chain per enterprise across all Mission SEP programme cycles. */
export const sebFundingCase = pgTable(
  'seb_funding_case',
  {
    id: text('id').primaryKey(),
    enterpriseId: text('enterprise_id')
      .notNull()
      .unique()
      .references(() => sebEnterprise.id, { onDelete: 'restrict' }),
    status: text('status', { enum: fundingCaseStatuses }).notNull().default('OPEN'),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    unique('seb_funding_case_enterprise_id_uq').on(table.enterpriseId, table.id),
    check('seb_funding_case_current_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_funding_case_status_check',
      sql`${table.status} IN ('OPEN', 'CLOSED', 'CANCELLED')`,
    ),
    index('seb_funding_case_status_idx')
      .on(table.status, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

/** Immutable lifecycle snapshot for a funding case. */
export const sebFundingCaseVersion = pgTable(
  'seb_funding_case_version',
  {
    id: text('id').primaryKey(),
    fundingCaseId: text('funding_case_id')
      .notNull()
      .references(() => sebFundingCase.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status', { enum: fundingCaseStatuses }).notNull(),
    changeType: text('change_type', { enum: fundingCaseChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_funding_case_version_number_uq').on(table.fundingCaseId, table.version),
    check('seb_funding_case_version_number_check', sql`${table.version} >= 1`),
    check(
      'seb_funding_case_version_status_check',
      sql`${table.status} IN ('OPEN', 'CLOSED', 'CANCELLED')`,
    ),
    check(
      'seb_funding_case_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'STATUS_CHANGED', 'CORRECTED')`,
    ),
  ],
)
