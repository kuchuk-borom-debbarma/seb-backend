/**
 * Operational grant-recovery records after support cancellation.
 *
 * The portal records externally authorized principal and penal-interest
 * amounts; it does not calculate statutory interest or manage court cases.
 * Ledger corrections are compensating reversals, never updates or deletion.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { dateOnly, instant, paise, versionedSoftDeleteColumns } from '../shared'
import { sebApplication } from './application'
import { sebFundingAward } from './funding'
import { sebProgrammeCycleReason } from './programme'

export const recoveryCaseStatuses = [
  'OPEN',
  'DEMANDED',
  'PARTIALLY_SETTLED',
  'SETTLED',
  'CANCELLED',
  'CLOSED',
] as const
export const recoveryCaseChangeTypes = [
  'OPENED',
  'STATUS_CHANGED',
  'CANCELLED',
  'CLOSED',
] as const
export const recoveryEntryTypes = ['DEMAND', 'RECEIPT', 'WAIVER', 'REVERSAL'] as const
export const recoveryComponents = ['PRINCIPAL', 'PENAL_INTEREST'] as const

/** Searchable current state of one recovery incident. */
export const sebRecoveryCase = pgTable(
  'seb_recovery_case',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    fundingAwardId: text('funding_award_id').notNull(),
    status: text('status', { enum: recoveryCaseStatuses }).notNull().default('OPEN'),
    ledgerVersion: integer('ledger_version').notNull().default(0),
    officialDecisionReference: text('official_decision_reference').notNull(),
    officialDecisionDate: dateOnly('official_decision_date').notNull(),
    reasonCategoryId: text('reason_category_id')
      .notNull()
      .references(() => sebProgrammeCycleReason.id, { onDelete: 'restrict' }),
    applicantMessage: text('applicant_message').notNull(),
    openedByUserId: text('opened_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.fundingAwardId],
      foreignColumns: [sebFundingAward.applicationId, sebFundingAward.id],
      name: 'seb_recovery_case_application_award_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_recovery_case_award_id_uq').on(table.fundingAwardId, table.id),
    uniqueIndex('seb_recovery_case_active_award_uq')
      .on(table.fundingAwardId)
      .where(sql`${table.status} IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED') AND ${table.deletedAt} IS NULL`),
    check('seb_recovery_case_version_check', sql`${table.currentVersion} >= 1`),
    check('seb_recovery_case_ledger_version_check', sql`${table.ledgerVersion} >= 0`),
    check(
      'seb_recovery_case_status_check',
      sql`${table.status} IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED', 'CLOSED')`,
    ),
    index('seb_recovery_case_status_idx').on(table.status, table.updatedAt),
    index('seb_recovery_case_award_idx').on(table.fundingAwardId, table.createdAt),
  ],
)

/** Immutable lifecycle version for a recovery case. */
export const sebRecoveryCaseVersion = pgTable(
  'seb_recovery_case_version',
  {
    id: text('id').primaryKey(),
    recoveryCaseId: text('recovery_case_id')
      .notNull()
      .references(() => sebRecoveryCase.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status', { enum: recoveryCaseStatuses }).notNull(),
    changeType: text('change_type', { enum: recoveryCaseChangeTypes }).notNull(),
    reason: text('reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_recovery_case_version_number_uq').on(
      table.recoveryCaseId,
      table.version,
    ),
    check('seb_recovery_case_version_number_check', sql`${table.version} >= 1`),
    check(
      'seb_recovery_case_version_status_check',
      sql`${table.status} IN ('OPEN', 'DEMANDED', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED', 'CLOSED')`,
    ),
    check(
      'seb_recovery_case_version_change_type_check',
      sql`${table.changeType} IN ('OPENED', 'STATUS_CHANGED', 'CANCELLED', 'CLOSED')`,
    ),
  ],
)

/** Append-only recovery accounting ledger. */
export const sebRecoveryEntry = pgTable(
  'seb_recovery_entry',
  {
    id: text('id').primaryKey(),
    recoveryCaseId: text('recovery_case_id')
      .notNull()
      .references(() => sebRecoveryCase.id, { onDelete: 'restrict' }),
    sequenceNumber: integer('sequence_number').notNull(),
    entryType: text('entry_type', { enum: recoveryEntryTypes }).notNull(),
    component: text('component', { enum: recoveryComponents }).notNull(),
    relatedEntryId: text('related_entry_id'),
    amountPaise: paise('amount_paise').notNull(),
    externalReference: text('external_reference').notNull().unique(),
    occurredAt: instant('occurred_at').notNull(),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    applicantMessage: text('applicant_message').notNull(),
    recordedByUserId: text('recorded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_recovery_entry_sequence_uq').on(
      table.recoveryCaseId,
      table.sequenceNumber,
    ),
    unique('seb_recovery_entry_case_id_uq').on(table.recoveryCaseId, table.id),
    foreignKey({
      columns: [table.recoveryCaseId, table.relatedEntryId],
      foreignColumns: [table.recoveryCaseId, table.id],
      name: 'seb_recovery_entry_related_case_fk',
    }).onDelete('restrict'),
    check('seb_recovery_entry_sequence_check', sql`${table.sequenceNumber} >= 1`),
    check(
      'seb_recovery_entry_amount_check',
      sql`${table.amountPaise} > 0 AND ${table.amountPaise} <= 9007199254740991`,
    ),
    check(
      'seb_recovery_entry_type_check',
      sql`${table.entryType} IN ('DEMAND', 'RECEIPT', 'WAIVER', 'REVERSAL')`,
    ),
    check(
      'seb_recovery_entry_component_check',
      sql`${table.component} IN ('PRINCIPAL', 'PENAL_INTEREST')`,
    ),
    check(
      'seb_recovery_entry_relation_check',
      sql`(${table.entryType} = 'REVERSAL' AND ${table.relatedEntryId} IS NOT NULL)
        OR (${table.entryType} <> 'REVERSAL' AND ${table.relatedEntryId} IS NULL)`,
    ),
    check(
      'seb_recovery_entry_reason_check',
      sql`(${table.entryType} IN ('WAIVER', 'REVERSAL') AND ${table.reasonCategoryId} IS NOT NULL)
        OR (${table.entryType} IN ('DEMAND', 'RECEIPT'))`,
    ),
    index('seb_recovery_entry_case_occurred_idx').on(
      table.recoveryCaseId,
      table.occurredAt,
    ),
  ],
)
