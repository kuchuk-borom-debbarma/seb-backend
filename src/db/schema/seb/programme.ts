/**
 * Versioned Mission SEP policy/application cycles.
 *
 * A cycle is more than a pair of dates: it is the policy contract pinned by
 * every application started in that window.
 *
 * **Rules are rows, not a JSON document, because rows can be referenced.** That
 * is the whole reason and it survives any engine: a document cannot be a
 * foreign-key target, and the template's entire job is to be pointed at — a
 * document slot names a file field, a revision request names a stage, an option
 * belongs to a field. Against a JSON column every one of those becomes an
 * assertion in application code. Rows also give cross-row uniqueness ("two
 * fields may not share a key in one version") as a one-line index, and let an
 * administrator diff two cycle versions in SQL rather than in a service that
 * would then be the only thing that knows what a template is.
 */
import { sql } from 'drizzle-orm'
import { deskReviewIdentifierKinds } from '../shared'
import {
  boolean,
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
import { instant, paise, versionedSoftDeleteColumns } from '../shared'

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
/*
 * ASSIGNMENT_RELEASE and ASSIGNMENT_REASSIGN are gone: assignment release and
 * reassignment left the product, so a cycle can neither cite nor be required
 * to catalogue reasons for them. Nothing is deployed, so no stored rows carry
 * the retired values.
 */
export const programmeReasonContexts = [
  'CYCLE_CLOSE',
  'REVISION',
  'REJECTION',
  'BANK_REFERRAL_CANCEL',
  'BANK_OUTCOME_CORRECTION',
  'DECISION_CORRECTION',
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
export const sebProgrammeCycle = pgTable(
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
    opensAt: instant('opens_at'),
    closesAt: instant('closes_at'),
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
    index('seb_programme_cycle_updated_idx')
      .on(table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    index('seb_programme_cycle_status_updated_idx')
      .on(table.status, table.updatedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    /* Prefix search on the code somebody would type. See the reference-number
       index in `application.ts` for why the opclass matters. */
    index('seb_programme_cycle_code_search_idx').on(
      sql`lower(${table.cycleCode}) text_pattern_ops`,
    ),
    index('seb_programme_cycle_status_idx')
      .on(table.status, table.opensAt, table.closesAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)

/**
 * Immutable complete policy snapshot. Applications reference this exact
 * version so a later cycle correction cannot silently change old eligibility.
 */
export const sebProgrammeCycleVersion = pgTable(
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
    opensAt: instant('opens_at'),
    closesAt: instant('closes_at'),

    // These scalar rules are deliberately configurable per cycle. The 2026
    // values come from the policy PDF, while later years can change safely.
    minimumApplicantAge: integer('minimum_applicant_age'),
    maximumApplicantAge: integer('maximum_applicant_age'),
    categoryAMaximumMonths: integer('category_a_maximum_months'),
    expansionWaitMonths: integer('expansion_wait_months'),
    majorityOwnershipRequired: boolean('majority_ownership_required'),
    jurisdiction: text('jurisdiction', { enum: programmeJurisdictions }),
    fundingCeilingState: text('funding_ceiling_state', {
      enum: fundingCeilingStates,
    }),
    fundingCeilingAmountPaise: paise('funding_ceiling_amount_paise'),
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
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('seb_programme_cycle_version_number_uq').on(
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
          AND ${table.fundingCeilingAmountPaise} <= 9007199254740991
          AND ${table.fundingCeilingScope} IN ('APPLICATION', 'PHASE', 'ENTERPRISE', 'FUNDING_CASE'))`,
    ),
  ],
)


/**
 * What a reviewer must transcribe, and what is compared against other files.
 *
 * These two are deliberately independent settings rather than one.
 *
 * A bank account can be worth recording without being worth refusing on: joint
 * accounts and family businesses are real, and a shared account is a question
 * rather than a finding. An ST certificate can be worth comparing across files
 * without being demanded on a check the reviewer marked not applicable.
 *
 * Frozen into the cycle version like every other rule here, so an application
 * is judged by the policy in force when it was submitted. Tightening the rules
 * next year cannot retroactively invalidate a review completed under the old
 * ones.
 *
 * **A cycle with no rows demands nothing and compares nothing.** That is the
 * honest default for a table that did not exist yesterday, and it is what
 * leaves already-open cycles working exactly as they did.
 */
export const identifierRequirements = ['REQUIRED_ON_PASS', 'OPTIONAL', 'OFF'] as const
export const identifierDuplicatePolicies = ['CHECKED', 'NOT_CHECKED'] as const

export const sebProgrammeCycleIdentifierRule = pgTable(
  'seb_programme_cycle_identifier_rule',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    kind: text('kind', { enum: deskReviewIdentifierKinds }).notNull(),
    /*
     * `REQUIRED_ON_PASS` rather than `REQUIRED`: an identifier is the evidence
     * behind a check, and a check that was failed or marked not applicable is
     * attesting to nothing, so there is nothing to have read.
     */
    requirement: text('requirement', { enum: identifierRequirements }).notNull(),
    duplicatePolicy: text('duplicate_policy', { enum: identifierDuplicatePolicies })
      .notNull(),
    /** The desk-review check this is evidence for. Null means it stands alone. */
    checkType: text('check_type'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.programmeCycleId, table.programmeCycleVersion],
      foreignColumns: [
        sebProgrammeCycleVersion.programmeCycleId,
        sebProgrammeCycleVersion.version,
      ],
      name: 'seb_programme_cycle_identifier_rule_version_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_cycle_identifier_rule_kind_uq').on(
      table.programmeCycleId,
      table.programmeCycleVersion,
      table.kind,
    ),
    check(
      'seb_programme_cycle_identifier_rule_kind_check',
      sql`${table.kind} IN ('ST_CERTIFICATE', 'IDENTITY_DOCUMENT', 'BANK_ACCOUNT', 'BUSINESS_REGISTRATION')`,
    ),
    check(
      'seb_programme_cycle_identifier_rule_requirement_check',
      sql`${table.requirement} IN ('REQUIRED_ON_PASS', 'OPTIONAL', 'OFF')`,
    ),
    check(
      'seb_programme_cycle_identifier_rule_duplicate_check',
      sql`${table.duplicatePolicy} IN ('CHECKED', 'NOT_CHECKED')`,
    ),
    /*
     * A rule that demands an identifier on a passing check must say which
     * check. Without one there is no moment at which it becomes required, so
     * the requirement would be unreachable rather than merely unused.
     */
    check(
      'seb_programme_cycle_identifier_rule_check_type_check',
      sql`(${table.requirement} <> 'REQUIRED_ON_PASS' AND ${table.checkType} IS NULL)
        OR (${table.requirement} = 'REQUIRED_ON_PASS' AND ${table.checkType} IN (
          'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
          'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
          'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE'))`,
    ),
  ],
)

/** Assessment outcome required before a later expansion may start. */
export const sebProgrammeCycleAssessmentRule = pgTable(
  'seb_programme_cycle_assessment_rule',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    assessmentType: text('assessment_type').notNull(),
    requiredOutcome: text('required_outcome').notNull().default('PASSED'),
    createdAt: instant('created_at').notNull(),
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
export const sebProgrammeCycleReason = pgTable(
  'seb_programme_cycle_reason',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id').notNull(),
    programmeCycleVersion: integer('programme_cycle_version').notNull(),
    context: text('context', { enum: programmeReasonContexts }).notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    applicantMessageTemplate: text('applicant_message_template'),
    createdAt: instant('created_at').notNull(),
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
      sql`${table.context} IN ('CYCLE_CLOSE', 'REVISION', 'REJECTION', 'BANK_REFERRAL_CANCEL', 'BANK_OUTCOME_CORRECTION', 'DECISION_CORRECTION', 'AWARD_AMENDMENT', 'AWARD_SUSPENSION', 'AWARD_CANCELLATION', 'AWARD_CLOSURE', 'RELEASE_REVERSAL', 'RECOVERY', 'RECOVERY_WAIVER')`,
    ),
  ],
)

/** Applicant-visible cycle notices, shared instead of copied per application. */
export const sebProgrammeCycleEvent = pgTable(
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
    createdAt: instant('created_at').notNull(),
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
