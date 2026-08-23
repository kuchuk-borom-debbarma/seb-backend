/**
 * Versioned Mission SEP policy/application cycles.
 *
 * A cycle is more than a pair of dates: it is the policy contract pinned by
 * every application started in that window. Rules are stored in normalized
 * rows instead of opaque JSON so D1 can validate and query them directly.
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

export const programmeCycleStatuses = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED'] as const
export const programmeCycleChangeTypes = [
  'CREATED',
  'UPDATED',
  'OPENED',
  'GUIDANCE_CHANGED',
  'CLOSING_CHANGED',
  'CLOSED',
  'ARCHIVED',
] as const
export const programmeJurisdictions = ['TRIPURA', 'TTAADC'] as const
export const fundingCeilingStates = ['UNRESOLVED', 'RESOLVED'] as const
export const fundingCeilingScopes = [
  'APPLICATION',
  'PHASE',
  'ENTERPRISE',
  'FUNDING_CASE',
] as const
export const programmeDocumentConditions = [
  'ALWAYS',
  'WHEN_REGISTERED',
  'WHEN_GSTIN_PRESENT',
  'WHEN_NOC_REQUIRED',
  'OPTIONAL',
] as const
export const programmeReasonContexts = [
  'CYCLE_CLOSE',
  'ASSIGNMENT_RELEASE',
  'ASSIGNMENT_REASSIGN',
  'REVISION',
  'REJECTION',
  'BANK_REFERRAL_CANCEL',
  'BANK_OUTCOME_CORRECTION',
  'TTM_DEFERRAL',
  'TTM_DECISION_CORRECTION',
  'AWARD_AMENDMENT',
  'AWARD_SUSPENSION',
  'AWARD_CANCELLATION',
  'AWARD_CLOSURE',
  'RELEASE_REVERSAL',
  'RECOVERY',
  'RECOVERY_WAIVER',
] as const
export const programmeCycleEventTypes = [
  'OPENED',
  'GUIDANCE_CHANGED',
  'CLOSING_CHANGED',
  'CLOSED',
  'ARCHIVED',
] as const

/** Current searchable and applicant-visible state of one programme window. */
export const sebProgrammeCycle = sqliteTable(
  'seb_programme_cycle',
  {
    id: text('id').primaryKey(),
    cycleCode: text('cycle_code').notNull().unique(),
    displayName: text('display_name').notNull(),
    cycleYear: integer('cycle_year').notNull(),
    policyReference: text('policy_reference'),
    applicantGuidance: text('applicant_guidance'),
    partnerBankGuidance: text('partner_bank_guidance'),
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
    /* The cycle list's own ordering, and its status filter. `status_idx` is led
       by status, so it could not serve a list ordered by updated_at. */
    index('seb_programme_cycle_updated_idx').on(table.deletedAt, table.updatedAt),
    index('seb_programme_cycle_status_updated_idx').on(
      table.status,
      table.deletedAt,
      table.updatedAt,
    ),
    /* Prefix search on the code somebody would type. */
    index('seb_programme_cycle_code_search_idx').on(sql`lower(${table.cycleCode})`),
    index('seb_programme_cycle_status_idx').on(
      table.status,
      table.deletedAt,
      table.opensAt,
      table.closesAt,
    ),
  ],
)

/**
 * Immutable complete policy snapshot. Applications reference this exact
 * version so a later cycle correction cannot silently change old eligibility.
 */
export const sebProgrammeCycleVersion = sqliteTable(
  'seb_programme_cycle_version',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    cycleCode: text('cycle_code').notNull(),
    displayName: text('display_name').notNull(),
    cycleYear: integer('cycle_year').notNull(),
    policyReference: text('policy_reference'),
    applicantGuidance: text('applicant_guidance'),
    partnerBankGuidance: text('partner_bank_guidance'),
    status: text('status', { enum: programmeCycleStatuses }).notNull(),
    opensAt: integer('opens_at', { mode: 'timestamp_ms' }),
    closesAt: integer('closes_at', { mode: 'timestamp_ms' }),

    // These scalar rules are deliberately configurable per cycle. The 2026
    // values come from the policy PDF, while later years can change safely.
    minimumApplicantAge: integer('minimum_applicant_age'),
    maximumApplicantAge: integer('maximum_applicant_age'),
    categoryAMaximumMonths: integer('category_a_maximum_months'),
    expansionWaitMonths: integer('expansion_wait_months'),
    majorityOwnershipRequired: integer('majority_ownership_required', {
      mode: 'boolean',
    }),
    jurisdiction: text('jurisdiction', { enum: programmeJurisdictions }),
    fundingCeilingState: text('funding_ceiling_state', {
      enum: fundingCeilingStates,
    }),
    fundingCeilingAmountPaise: integer('funding_ceiling_amount_paise'),
    fundingCeilingScope: text('funding_ceiling_scope', {
      enum: fundingCeilingScopes,
    }),

    changeType: text('change_type', { enum: programmeCycleChangeTypes }).notNull(),
    changeReason: text('change_reason'),
    // Scheduled lifecycle changes have no human actor. Null is therefore a
    // truthful system transition, not a fabricated attribution to the last
    // administrator who edited the cycle.
    changedByUserId: text('changed_by_user_id')
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
      sql`${table.changeType} IN ('CREATED', 'UPDATED', 'OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED')`,
    ),
    check(
      'seb_programme_cycle_version_window_check',
      sql`${table.opensAt} IS NULL OR ${table.closesAt} IS NULL OR ${table.closesAt} > ${table.opensAt}`,
    ),
    check(
      'seb_programme_cycle_version_age_check',
      sql`(${table.minimumApplicantAge} IS NULL AND ${table.maximumApplicantAge} IS NULL)
        OR (${table.minimumApplicantAge} >= 0
          AND ${table.maximumApplicantAge} >= ${table.minimumApplicantAge})`,
    ),
    check(
      'seb_programme_cycle_version_months_check',
      sql`(${table.categoryAMaximumMonths} IS NULL OR ${table.categoryAMaximumMonths} >= 0)
        AND (${table.expansionWaitMonths} IS NULL OR ${table.expansionWaitMonths} >= 1)`,
    ),
    check(
      'seb_programme_cycle_version_majority_check',
      sql`${table.majorityOwnershipRequired} IS NULL OR ${table.majorityOwnershipRequired} IN (0, 1)`,
    ),
    check(
      'seb_programme_cycle_version_jurisdiction_check',
      sql`${table.jurisdiction} IS NULL OR ${table.jurisdiction} IN ('TRIPURA', 'TTAADC')`,
    ),
    check(
      'seb_programme_cycle_version_ceiling_check',
      sql`(${table.fundingCeilingState} IS NULL
          AND ${table.fundingCeilingAmountPaise} IS NULL
          AND ${table.fundingCeilingScope} IS NULL)
        OR (${table.fundingCeilingState} = 'UNRESOLVED'
          AND ${table.fundingCeilingAmountPaise} IS NULL
          AND ${table.fundingCeilingScope} IS NULL)
        OR (${table.fundingCeilingState} = 'RESOLVED'
          AND ${table.fundingCeilingAmountPaise} > 0
          AND ${table.fundingCeilingScope} IN ('APPLICATION', 'PHASE', 'ENTERPRISE', 'FUNDING_CASE'))`,
    ),
  ],
)

/** One normalized document requirement belonging to an exact policy version. */
export const sebProgrammeCycleDocumentRule = sqliteTable(
  'seb_programme_cycle_document_rule',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    documentType: text('document_type').notNull(),
    condition: text('condition', { enum: programmeDocumentConditions }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_document_rule_version_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_document_rule_type_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.documentType,
    ),
    check(
      'seb_programme_cycle_document_rule_type_check',
      sql`${table.documentType} IN ('IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF', 'BUSINESS_REGISTRATION', 'GST_REGISTRATION', 'DPR', 'BANK_DETAILS', 'NOC')`,
    ),
    check(
      'seb_programme_cycle_document_rule_condition_check',
      sql`${table.condition} IN ('ALWAYS', 'WHEN_REGISTERED', 'WHEN_GSTIN_PRESENT', 'WHEN_NOC_REQUIRED', 'OPTIONAL')`,
    ),
  ],
)

/** Assessment outcome required before a later expansion may start. */
export const sebProgrammeCycleAssessmentRule = sqliteTable(
  'seb_programme_cycle_assessment_rule',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    assessmentType: text('assessment_type').notNull(),
    requiredOutcome: text('required_outcome').notNull().default('PASSED'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_assessment_rule_version_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_assessment_rule_type_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.assessmentType,
    ),
    check(
      'seb_programme_cycle_assessment_rule_type_check',
      sql`${table.assessmentType} IN ('UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT')`,
    ),
    check(
      'seb_programme_cycle_assessment_rule_outcome_check',
      sql`${table.requiredOutcome} = 'PASSED'`,
    ),
  ],
)

/** Approved reason code and safe message template for one policy version. */
export const sebProgrammeCycleReason = sqliteTable(
  'seb_programme_cycle_reason',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    context: text('context', { enum: programmeReasonContexts }).notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    applicantMessageTemplate: text('applicant_message_template'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_reason_version_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_reason_code_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.context,
      table.code,
    ),
    uniqueIndex('seb_programme_cycle_reason_cycle_id_uq').on(
      table.programmeCycleId,
      table.id,
    ),
    check(
      'seb_programme_cycle_reason_context_check',
      sql`${table.context} IN ('CYCLE_CLOSE', 'ASSIGNMENT_RELEASE', 'ASSIGNMENT_REASSIGN', 'REVISION', 'REJECTION', 'BANK_REFERRAL_CANCEL', 'BANK_OUTCOME_CORRECTION', 'TTM_DEFERRAL', 'TTM_DECISION_CORRECTION', 'AWARD_AMENDMENT', 'AWARD_SUSPENSION', 'AWARD_CANCELLATION', 'AWARD_CLOSURE', 'RELEASE_REVERSAL', 'RECOVERY', 'RECOVERY_WAIVER')`,
    ),
  ],
)

/** Applicant-visible cycle notices, shared instead of copied per application. */
export const sebProgrammeCycleEvent = sqliteTable(
  'seb_programme_cycle_event',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    eventType: text('event_type', { enum: programmeCycleEventTypes }).notNull(),
    actorUserId: text('actor_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    message: text('message').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    check(
      'seb_programme_cycle_event_type_check',
      sql`${table.eventType} IN ('OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED', 'CLOSED', 'ARCHIVED')`,
    ),
    index('seb_programme_cycle_event_cycle_idx').on(
      table.programmeCycleId,
      table.createdAt,
    ),
  ],
)
