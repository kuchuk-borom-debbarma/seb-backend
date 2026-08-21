/**
 * Authoritative funding records created after an application is sanctioned.
 *
 * Awards are mutable business roots with immutable versions. Disbursements and
 * assessments are append-only facts: corrections add a new fact instead of
 * rewriting history. These records let the future service derive expansion
 * eligibility without trusting applicant-entered prior-funding claims.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { coreUser } from '../core/auth'
import { versionedSoftDeleteColumns } from '../shared'
import { sebApplication } from './application'
import { sebFundingCase } from './case'

export const fundingAwardStatuses = [
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
  'CLOSED',
] as const
export const fundingAwardChangeTypes = [
  'CREATED',
  'AMENDED',
  'STATUS_CHANGED',
  'CORRECTED',
] as const
export const disbursementEntryTypes = ['RELEASE', 'REVERSAL'] as const
export const awardAssessmentTypes = [
  'UTILIZATION',
  'PERFORMANCE',
  'FINANCIAL_AUDIT',
] as const
export const awardAssessmentOutcomes = ['PASSED', 'FAILED'] as const
export const qualifyingAwardLinkStatuses = ['ACTIVE', 'CANCELLED'] as const
export const qualifyingAwardLinkChangeTypes = [
  'LINKED',
  'CORRECTED',
  'CANCELLED',
] as const

/**
 * Current searchable state of a sanctioned award.
 *
 * `fundingCaseId` is intentionally repeated beside `applicationId`. The
 * composite foreign key proves that the sanctioned application belongs to the
 * same funding chain, which prevents cross-enterprise links even in raw SQL.
 */
export const sebFundingAward = sqliteTable(
  'seb_funding_award',
  {
    id: text('id').primaryKey(),
    fundingCaseId: text('funding_case_id')
      .notNull()
      .references(() => sebFundingCase.id, { onDelete: 'restrict' }),
    applicationId: text('application_id').notNull().unique(),
    sanctionOrderNumber: text('sanction_order_number').notNull().unique(),
    sanctionDate: text('sanction_date').notNull(),
    sanctionedAmountPaise: integer('sanctioned_amount_paise').notNull(),
    status: text('status', { enum: fundingAwardStatuses }).notNull().default('ACTIVE'),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    foreignKey({
      columns: [table.fundingCaseId, table.applicationId],
      foreignColumns: [sebApplication.fundingCaseId, sebApplication.id],
      name: 'seb_funding_award_case_application_fk',
    }).onDelete('restrict'),
    // Qualifying-award links use this composite key to retain case scope.
    uniqueIndex('seb_funding_award_case_id_uq').on(table.fundingCaseId, table.id),
    check('seb_funding_award_current_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_funding_award_amount_check',
      sql`${table.sanctionedAmountPaise} > 0`,
    ),
    check(
      'seb_funding_award_status_check',
      sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED')`,
    ),
    index('seb_funding_award_case_idx').on(
      table.fundingCaseId,
      table.deletedAt,
      table.sanctionDate,
    ),
    index('seb_funding_award_status_idx').on(table.status, table.deletedAt, table.updatedAt),
  ],
)

/** Complete immutable snapshot of one award revision. */
export const sebFundingAwardVersion = sqliteTable(
  'seb_funding_award_version',
  {
    id: text('id').primaryKey(),
    fundingAwardId: text('funding_award_id')
      .notNull()
      .references(() => sebFundingAward.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    sanctionOrderNumber: text('sanction_order_number').notNull(),
    sanctionDate: text('sanction_date').notNull(),
    sanctionedAmountPaise: integer('sanctioned_amount_paise').notNull(),
    status: text('status', { enum: fundingAwardStatuses }).notNull(),
    changeType: text('change_type', { enum: fundingAwardChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_funding_award_version_number_uq').on(
      table.fundingAwardId,
      table.version,
    ),
    check('seb_funding_award_version_number_check', sql`${table.version} >= 1`),
    check(
      'seb_funding_award_version_amount_check',
      sql`${table.sanctionedAmountPaise} > 0`,
    ),
    check(
      'seb_funding_award_version_status_check',
      sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED')`,
    ),
    check(
      'seb_funding_award_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'AMENDED', 'STATUS_CHANGED', 'CORRECTED')`,
    ),
  ],
)

/**
 * Current authoritative earlier-award link for an expansion application.
 *
 * The mutable head permits an incorrect association to be corrected or
 * cancelled without deleting history. Only the current award is unique; once a
 * link is cancelled or corrected, its prior award remains in the version table
 * and can legitimately qualify another application.
 */
export const sebApplicationQualifyingAward = sqliteTable(
  'seb_application_qualifying_award',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull().unique(),
    fundingCaseId: text('funding_case_id').notNull(),
    currentFundingAwardId: text('current_funding_award_id').unique(),
    status: text('status', { enum: qualifyingAwardLinkStatuses })
      .notNull()
      .default('ACTIVE'),
    currentVersion: integer('current_version').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
    cancelledByUserId: text('cancelled_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    cancellationReason: text('cancellation_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.fundingCaseId, table.applicationId],
      foreignColumns: [sebApplication.fundingCaseId, sebApplication.id],
      name: 'seb_application_qualifying_award_case_application_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.fundingCaseId, table.currentFundingAwardId],
      foreignColumns: [sebFundingAward.fundingCaseId, sebFundingAward.id],
      name: 'seb_application_qualifying_award_case_award_fk',
    }).onDelete('restrict'),
    // Versions repeat the case so a historic award can be proven to belong to
    // the same funding chain as this stable link root.
    uniqueIndex('seb_application_qualifying_award_id_case_uq').on(
      table.id,
      table.fundingCaseId,
    ),
    check(
      'seb_application_qualifying_award_version_check',
      sql`${table.currentVersion} >= 1`,
    ),
    check(
      'seb_application_qualifying_award_status_check',
      sql`${table.status} IN ('ACTIVE', 'CANCELLED')`,
    ),
    check(
      'seb_application_qualifying_award_lifecycle_check',
      sql`(${table.status} = 'ACTIVE'
          AND ${table.currentFundingAwardId} IS NOT NULL
          AND ${table.cancelledAt} IS NULL
          AND ${table.cancelledByUserId} IS NULL
          AND ${table.cancellationReason} IS NULL)
        OR (${table.status} = 'CANCELLED'
          AND ${table.currentFundingAwardId} IS NULL
          AND ${table.cancelledAt} IS NOT NULL
          AND ${table.cancelledByUserId} IS NOT NULL
          AND ${table.cancellationReason} IS NOT NULL)`,
    ),
    index('seb_application_qualifying_award_case_idx').on(
      table.fundingCaseId,
      table.status,
      table.updatedAt,
    ),
  ],
)

/** Immutable history of every link, correction, and cancellation decision. */
export const sebApplicationQualifyingAwardVersion = sqliteTable(
  'seb_application_qualifying_award_version',
  {
    id: text('id').primaryKey(),
    qualifyingAwardLinkId: text('qualifying_award_link_id').notNull(),
    fundingCaseId: text('funding_case_id').notNull(),
    version: integer('version').notNull(),
    fundingAwardId: text('funding_award_id').notNull(),
    status: text('status', { enum: qualifyingAwardLinkStatuses }).notNull(),
    changeType: text('change_type', { enum: qualifyingAwardLinkChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.qualifyingAwardLinkId, table.fundingCaseId],
      foreignColumns: [
        sebApplicationQualifyingAward.id,
        sebApplicationQualifyingAward.fundingCaseId,
      ],
      name: 'seb_application_qualifying_award_version_link_case_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.fundingCaseId, table.fundingAwardId],
      foreignColumns: [sebFundingAward.fundingCaseId, sebFundingAward.id],
      name: 'seb_application_qualifying_award_version_case_award_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_application_qualifying_award_version_number_uq').on(
      table.qualifyingAwardLinkId,
      table.version,
    ),
    check(
      'seb_application_qualifying_award_version_number_check',
      sql`${table.version} >= 1`,
    ),
    check(
      'seb_application_qualifying_award_version_status_check',
      sql`${table.status} IN ('ACTIVE', 'CANCELLED')`,
    ),
    check(
      'seb_application_qualifying_award_version_change_type_check',
      sql`${table.changeType} IN ('LINKED', 'CORRECTED', 'CANCELLED')`,
    ),
    check(
      'seb_application_qualifying_award_version_state_check',
      sql`(${table.changeType} IN ('LINKED', 'CORRECTED') AND ${table.status} = 'ACTIVE')
        OR (${table.changeType} = 'CANCELLED' AND ${table.status} = 'CANCELLED')`,
    ),
  ],
)

/**
 * Append-only money ledger for an award.
 *
 * Amounts are always positive. Direction comes from `entryType`: RELEASE adds
 * money and REVERSAL compensates a release. A composite self-reference ensures
 * a reversal cannot point at an entry belonging to another award; the service
 * verifies that the referenced entry is a RELEASE and prevents over-reversal.
 */
export const sebDisbursement = sqliteTable(
  'seb_disbursement',
  {
    id: text('id').primaryKey(),
    fundingAwardId: text('funding_award_id')
      .notNull()
      .references(() => sebFundingAward.id, { onDelete: 'restrict' }),
    sequenceNumber: integer('sequence_number').notNull(),
    entryType: text('entry_type', { enum: disbursementEntryTypes }).notNull(),
    relatedDisbursementId: text('related_disbursement_id'),
    amountPaise: integer('amount_paise').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    externalReference: text('external_reference').unique(),
    recordedByUserId: text('recorded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_disbursement_award_sequence_uq').on(
      table.fundingAwardId,
      table.sequenceNumber,
    ),
    uniqueIndex('seb_disbursement_award_id_uq').on(table.fundingAwardId, table.id),
    foreignKey({
      columns: [table.fundingAwardId, table.relatedDisbursementId],
      foreignColumns: [table.fundingAwardId, table.id],
      name: 'seb_disbursement_related_award_fk',
    }).onDelete('restrict'),
    check('seb_disbursement_sequence_check', sql`${table.sequenceNumber} >= 1`),
    check('seb_disbursement_amount_check', sql`${table.amountPaise} > 0`),
    check(
      'seb_disbursement_entry_type_check',
      sql`${table.entryType} IN ('RELEASE', 'REVERSAL')`,
    ),
    check(
      'seb_disbursement_relation_check',
      sql`(${table.entryType} = 'RELEASE' AND ${table.relatedDisbursementId} IS NULL)
        OR (${table.entryType} = 'REVERSAL' AND ${table.relatedDisbursementId} IS NOT NULL)`,
    ),
    index('seb_disbursement_award_occurred_idx').on(
      table.fundingAwardId,
      table.occurredAt,
    ),
  ],
)

/**
 * Append-only assessment history. The largest assessment number for an award
 * and type is authoritative, while every earlier result remains reviewable.
 */
export const sebAwardAssessment = sqliteTable(
  'seb_award_assessment',
  {
    id: text('id').primaryKey(),
    fundingAwardId: text('funding_award_id')
      .notNull()
      .references(() => sebFundingAward.id, { onDelete: 'restrict' }),
    assessmentType: text('assessment_type', { enum: awardAssessmentTypes }).notNull(),
    assessmentNumber: integer('assessment_number').notNull(),
    outcome: text('outcome', { enum: awardAssessmentOutcomes }).notNull(),
    note: text('note'),
    assessedByUserId: text('assessed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    assessedAt: integer('assessed_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_award_assessment_number_uq').on(
      table.fundingAwardId,
      table.assessmentType,
      table.assessmentNumber,
    ),
    check('seb_award_assessment_number_check', sql`${table.assessmentNumber} >= 1`),
    check(
      'seb_award_assessment_type_check',
      sql`${table.assessmentType} IN ('UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT')`,
    ),
    check(
      'seb_award_assessment_outcome_check',
      sql`${table.outcome} IN ('PASSED', 'FAILED')`,
    ),
  ],
)
