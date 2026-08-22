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
import { sebProgrammeCycleReason } from './programme'

export const fundingAwardStatuses = [
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
  'CLOSED',
] as const
export const fundingAwardClosureDispositions = [
  'RELEASES_COMPLETE',
  'REMAINDER_NOT_RELEASED',
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
    applicantConditions: text('applicant_conditions'),
    status: text('status', { enum: fundingAwardStatuses }).notNull().default('ACTIVE'),
    // Closing must state whether the sanction was fully released or whether a
    // deliberate remainder will never be paid; other states leave this null.
    closureDisposition: text('closure_disposition', {
      enum: fundingAwardClosureDispositions,
    }),
    // Ledger concurrency is operational rather than a change to the sanction;
    // it increments for every release or reversal without manufacturing an
    // award-policy version for an accounting entry.
    ledgerVersion: integer('ledger_version').notNull().default(0),
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
    uniqueIndex('seb_funding_award_application_id_uq').on(table.applicationId, table.id),
    check('seb_funding_award_current_version_check', sql`${table.currentVersion} >= 1`),
    check('seb_funding_award_ledger_version_check', sql`${table.ledgerVersion} >= 0`),
    check(
      'seb_funding_award_amount_check',
      sql`${table.sanctionedAmountPaise} > 0`,
    ),
    check(
      'seb_funding_award_status_check',
      sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'CANCELLED', 'CLOSED')`,
    ),
    check(
      'seb_funding_award_closure_disposition_check',
      // SQLite accepts a CHECK whose result is NULL. The explicit non-null
      // predicate prevents a closed row with no disposition from slipping
      // through that three-valued-logic rule.
      sql`(${table.status} = 'CLOSED' AND ${table.closureDisposition} IS NOT NULL
          AND ${table.closureDisposition} IN ('RELEASES_COMPLETE', 'REMAINDER_NOT_RELEASED'))
        OR (${table.status} <> 'CLOSED' AND ${table.closureDisposition} IS NULL)`,
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
    applicantConditions: text('applicant_conditions'),
    status: text('status', { enum: fundingAwardStatuses }).notNull(),
    closureDisposition: text('closure_disposition', {
      enum: fundingAwardClosureDispositions,
    }),
    changeType: text('change_type', { enum: fundingAwardChangeTypes }).notNull(),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
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
      'seb_funding_award_version_closure_disposition_check',
      sql`(${table.status} = 'CLOSED' AND ${table.closureDisposition} IS NOT NULL
          AND ${table.closureDisposition} IN ('RELEASES_COMPLETE', 'REMAINDER_NOT_RELEASED'))
        OR (${table.status} <> 'CLOSED' AND ${table.closureDisposition} IS NULL)`,
    ),
    check(
      'seb_funding_award_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'AMENDED', 'STATUS_CHANGED', 'CORRECTED')`,
    ),
    check(
      'seb_funding_award_version_reason_check',
      sql`(${table.changeType} = 'CREATED' AND ${table.reasonCategoryId} IS NULL)
        OR (${table.changeType} <> 'CREATED' AND ${table.reasonCategoryId} IS NOT NULL)`,
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
    // SQLite permits multiple NULL values in a unique index. Cancelling a
    // rejected/deleted attempt clears this pointer, so history remains reusable
    // while two current attempts can never claim the same award concurrently.
    currentFundingAwardId: text('current_funding_award_id'),
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
    uniqueIndex('seb_application_qualifying_award_current_award_uq').on(
      table.currentFundingAwardId,
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
    // A RELEASE combines the TTM authorization evidence and actual payment by
    // product decision. REVERSAL rows keep these fields null and point to the
    // release they correct.
    ttmApprovalReference: text('ttm_approval_reference'),
    ttmApprovalDate: text('ttm_approval_date'),
    bankAccountVerifiedAt: integer('bank_account_verified_at', { mode: 'timestamp_ms' }),
    performanceAgreementReference: text('performance_agreement_reference'),
    performanceAgreementExecutedAt: integer('performance_agreement_executed_at', {
      mode: 'timestamp_ms',
    }),
    physicalVerificationRequired: integer('physical_verification_required', {
      mode: 'boolean',
    }),
    physicalVerificationReference: text('physical_verification_reference'),
    physicalVerificationCompletedAt: integer('physical_verification_completed_at', {
      mode: 'timestamp_ms',
    }),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    applicantMessage: text('applicant_message'),
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
    check(
      'seb_disbursement_release_evidence_check',
      sql`(${table.entryType} = 'RELEASE'
          AND ${table.ttmApprovalReference} IS NOT NULL
          AND ${table.ttmApprovalDate} IS NOT NULL
          AND ${table.bankAccountVerifiedAt} IS NOT NULL
          AND ${table.performanceAgreementReference} IS NOT NULL
          AND ${table.performanceAgreementExecutedAt} IS NOT NULL
          AND ${table.physicalVerificationRequired} IN (0, 1)
          AND ((${table.physicalVerificationRequired} = 0
              AND ${table.physicalVerificationReference} IS NULL
              AND ${table.physicalVerificationCompletedAt} IS NULL)
            OR (${table.physicalVerificationRequired} = 1
              AND ${table.physicalVerificationReference} IS NOT NULL
              AND ${table.physicalVerificationCompletedAt} IS NOT NULL)))
        OR (${table.entryType} = 'REVERSAL'
          AND ${table.ttmApprovalReference} IS NULL
          AND ${table.ttmApprovalDate} IS NULL
          AND ${table.bankAccountVerifiedAt} IS NULL
          AND ${table.performanceAgreementReference} IS NULL
          AND ${table.performanceAgreementExecutedAt} IS NULL
          AND ${table.physicalVerificationRequired} IS NULL
          AND ${table.physicalVerificationReference} IS NULL
          AND ${table.physicalVerificationCompletedAt} IS NULL
          AND ${table.reasonCategoryId} IS NOT NULL
          AND ${table.applicantMessage} IS NOT NULL)`,
    ),
    index('seb_disbursement_award_occurred_idx').on(
      table.fundingAwardId,
      table.occurredAt,
    ),
  ],
)

/**
 * One immutable 180-day utilization obligation created with each release.
 * Completion is derived from assessment history rather than updated here.
 */
export const sebUtilizationObligation = sqliteTable(
  'seb_utilization_obligation',
  {
    id: text('id').primaryKey(),
    fundingAwardId: text('funding_award_id').notNull(),
    releaseDisbursementId: text('release_disbursement_id').notNull().unique(),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.fundingAwardId, table.releaseDisbursementId],
      foreignColumns: [sebDisbursement.fundingAwardId, sebDisbursement.id],
      name: 'seb_utilization_obligation_release_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_utilization_obligation_award_id_uq').on(
      table.fundingAwardId,
      table.id,
    ),
    index('seb_utilization_obligation_due_idx').on(table.fundingAwardId, table.dueAt),
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
    utilizationObligationId: text('utilization_obligation_id'),
    evidenceReference: text('evidence_reference').notNull(),
    applicantSummary: text('applicant_summary').notNull(),
    internalNote: text('internal_note'),
    assessedByUserId: text('assessed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    assessedAt: integer('assessed_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.fundingAwardId, table.utilizationObligationId],
      foreignColumns: [
        sebUtilizationObligation.fundingAwardId,
        sebUtilizationObligation.id,
      ],
      name: 'seb_award_assessment_utilization_obligation_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_award_assessment_award_number_uq')
      .on(table.fundingAwardId, table.assessmentType, table.assessmentNumber)
      .where(sql`${table.utilizationObligationId} IS NULL`),
    uniqueIndex('seb_award_assessment_utilization_number_uq')
      .on(
        table.fundingAwardId,
        table.utilizationObligationId,
        table.assessmentNumber,
      )
      .where(sql`${table.utilizationObligationId} IS NOT NULL`),
    check('seb_award_assessment_number_check', sql`${table.assessmentNumber} >= 1`),
    check(
      'seb_award_assessment_type_check',
      sql`${table.assessmentType} IN ('UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT')`,
    ),
    check(
      'seb_award_assessment_outcome_check',
      sql`${table.outcome} IN ('PASSED', 'FAILED')`,
    ),
    check(
      'seb_award_assessment_scope_check',
      sql`(${table.assessmentType} = 'UTILIZATION' AND ${table.utilizationObligationId} IS NOT NULL)
        OR (${table.assessmentType} IN ('PERFORMANCE', 'FINANCIAL_AUDIT') AND ${table.utilizationObligationId} IS NULL)`,
    ),
    index('seb_award_assessment_latest_idx').on(
      table.fundingAwardId,
      table.assessmentType,
      table.utilizationObligationId,
      table.assessmentNumber,
    ),
  ],
)
