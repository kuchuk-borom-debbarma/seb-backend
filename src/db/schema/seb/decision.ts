/**
 * Offline partner-bank feedback, and the programme decision it feeds.
 *
 * Bank identities are frozen as supplied text by product decision. Referral
 * heads are versioned operational roots; outcomes and decisions are append-only
 * so a correction never erases what staff previously recorded.
 *
 * **Nothing convenes to decide an application.** One that clears the bank stage
 * waits in `AWAITING_DECISION` and is decided directly, and the decision itself
 * pins which submission and which appraisal were in front of the decider. The
 * programme's own source describes a Tripartite Meeting instead; the divergence
 * is recorded in `docs/policy-alignment.md` rather than absorbed here.
 */
import { sql } from 'drizzle-orm'
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
import { dateOnly, instant, paise, versionedSoftDeleteColumns } from '../shared'
import { sebApplication, sebApplicationSubmission } from './application'
import { sebDeskReview } from './review'
import { sebProgrammeCycleReason } from './programme'

export const bankReferralStatuses = ['OPEN', 'RESPONDED', 'CANCELLED'] as const
export const bankReferralChangeTypes = ['REFERRED', 'RESPONDED', 'CANCELLED'] as const
export const bankOutcomes = [
  'RECOMMENDED',
  'NOT_RECOMMENDED',
  'MORE_INFORMATION_REQUIRED',
] as const
/**
 * What a programme decision can be.
 *
 * There is deliberately no *deferral*. Deferring meant holding an application
 * over to a later sitting, and with nothing that sits it would name no event at
 * all — a decision that moves the application nowhere and points at no future
 * date is not a decision. One nobody is ready to decide simply stays where it
 * is, in `AWAITING_DECISION`.
 */
export const decisionOutcomes = ['APPROVED', 'REJECTED', 'REVISION_REQUIRED'] as const

/** Current state of one offline referral for an exact submitted application. */
export const sebPartnerBankReferral = pgTable(
  'seb_partner_bank_referral',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    submissionId: text('submission_id').notNull(),
    deskReviewId: text('desk_review_id').notNull(),
    bankName: text('bank_name').notNull(),
    bankBranch: text('bank_branch'),
    referralReference: text('referral_reference').notNull().unique(),
    referralDate: dateOnly('referral_date').notNull(),
    status: text('status', { enum: bankReferralStatuses }).notNull().default('OPEN'),
    internalNote: text('internal_note'),
    referredByUserId: text('referred_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [sebApplicationSubmission.applicationId, sebApplicationSubmission.id],
      name: 'seb_partner_bank_referral_submission_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.applicationId, table.deskReviewId],
      foreignColumns: [sebDeskReview.applicationId, sebDeskReview.id],
      name: 'seb_partner_bank_referral_review_fk',
    }).onDelete('restrict'),
    unique('seb_partner_bank_referral_application_id_uq').on(
      table.applicationId,
      table.id,
    ),
    uniqueIndex('seb_partner_bank_referral_active_application_uq')
      .on(table.applicationId)
      .where(sql`${table.status} = 'OPEN' AND ${table.deletedAt} IS NULL`),
    check('seb_partner_bank_referral_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_partner_bank_referral_status_check',
      sql`${table.status} IN ('OPEN', 'RESPONDED', 'CANCELLED')`,
    ),
    index('seb_partner_bank_referral_application_idx').on(
      table.applicationId,
      table.createdAt,
    ),
  ],
)

/** Immutable referral lifecycle snapshot. */
export const sebPartnerBankReferralVersion = pgTable(
  'seb_partner_bank_referral_version',
  {
    id: text('id').primaryKey(),
    referralId: text('referral_id')
      .notNull()
      .references(() => sebPartnerBankReferral.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status', { enum: bankReferralStatuses }).notNull(),
    changeType: text('change_type', { enum: bankReferralChangeTypes }).notNull(),
    reason: text('reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_partner_bank_referral_version_number_uq').on(
      table.referralId,
      table.version,
    ),
    check('seb_partner_bank_referral_version_check', sql`${table.version} >= 1`),
    check(
      'seb_partner_bank_referral_version_status_check',
      sql`${table.status} IN ('OPEN', 'RESPONDED', 'CANCELLED')`,
    ),
    check(
      'seb_partner_bank_referral_version_change_type_check',
      sql`${table.changeType} IN ('REFERRED', 'RESPONDED', 'CANCELLED')`,
    ),
  ],
)

/** Append-only bank feedback; a correction supersedes an earlier outcome. */
export const sebPartnerBankOutcome = pgTable(
  'seb_partner_bank_outcome',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    referralId: text('referral_id').notNull(),
    outcomeNumber: integer('outcome_number').notNull(),
    outcome: text('outcome', { enum: bankOutcomes }).notNull(),
    decisionReference: text('decision_reference').notNull(),
    decisionDate: dateOnly('decision_date').notNull(),
    availableLoanAmountPaise: paise('available_loan_amount_paise'),
    applicantSummary: text('applicant_summary').notNull(),
    internalNote: text('internal_note'),
    supersedesOutcomeId: text('supersedes_outcome_id'),
    correctionReasonCategoryId: text('correction_reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    correctionReason: text('correction_reason'),
    recordedByUserId: text('recorded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.referralId],
      foreignColumns: [sebPartnerBankReferral.applicationId, sebPartnerBankReferral.id],
      name: 'seb_partner_bank_outcome_referral_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.referralId, table.supersedesOutcomeId],
      foreignColumns: [table.referralId, table.id],
      name: 'seb_partner_bank_outcome_supersedes_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_partner_bank_outcome_number_uq').on(
      table.referralId,
      table.outcomeNumber,
    ),
    unique('seb_partner_bank_outcome_referral_id_uq').on(table.referralId, table.id),
    // The decision repeats application_id so raw SQL cannot attach an outcome
    // from another application. A composite foreign key needs its referenced
    // columns unique in exactly this order, hence a second index over the pair.
    unique('seb_partner_bank_outcome_application_id_uq').on(
      table.applicationId,
      table.id,
    ),
    uniqueIndex('seb_partner_bank_outcome_one_correction_uq').on(
      table.supersedesOutcomeId,
    ),
    check('seb_partner_bank_outcome_number_check', sql`${table.outcomeNumber} >= 1`),
    check(
      'seb_partner_bank_outcome_type_check',
      sql`${table.outcome} IN ('RECOMMENDED', 'NOT_RECOMMENDED', 'MORE_INFORMATION_REQUIRED')`,
    ),
    check(
      'seb_partner_bank_outcome_amount_check',
      sql`${table.availableLoanAmountPaise} IS NULL
        OR (${table.availableLoanAmountPaise} >= 0
            AND ${table.availableLoanAmountPaise} <= 9007199254740991)`,
    ),
    check(
      'seb_partner_bank_outcome_correction_check',
      sql`(${table.supersedesOutcomeId} IS NULL
          AND ${table.correctionReasonCategoryId} IS NULL
          AND ${table.correctionReason} IS NULL)
        OR (${table.supersedesOutcomeId} IS NOT NULL
          AND ${table.correctionReasonCategoryId} IS NOT NULL
          AND ${table.correctionReason} IS NOT NULL)`,
    ),
    index('seb_partner_bank_outcome_application_idx').on(
      table.applicationId,
      table.createdAt,
    ),
  ],
)

/**
 * The programme decision on one application, append-only.
 *
 * An application that clears the partner bank waits in `AWAITING_DECISION`, and
 * whoever holds `DECIDE` records the outcome here.
 *
 * **The evidence is pinned on the decision itself.** `submissionId` says which
 * form version was decided and `bankOutcomeId` which appraisal was read, both by
 * composite key so neither can name another application's. Without the first, a
 * revision request has no submission to attach to; without the second, a later
 * corrected appraisal would leave the decision pointing at nothing in
 * particular.
 *
 * A correction supersedes rather than edits, and the whole series is scoped to
 * the application, which is why `decisionNumber` is unique per application and
 * never restarts.
 */
export const sebProgrammeDecision = pgTable(
  'seb_programme_decision',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    /* Which submission was in front of the decider. */
    submissionId: text('submission_id').notNull(),
    /* Which bank appraisal was read. Null where a cycle refers to no bank. */
    bankOutcomeId: text('bank_outcome_id'),
    decisionNumber: integer('decision_number').notNull(),
    outcome: text('outcome', { enum: decisionOutcomes }).notNull(),
    decisionReference: text('decision_reference').notNull().unique(),
    /* When the decision was taken, which may precede when it was typed. */
    decisionDate: dateOnly('decision_date').notNull(),
    approvedAmountPaise: paise('approved_amount_paise'),
    applicantConditions: text('applicant_conditions'),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    applicantMessage: text('applicant_message').notNull(),
    supersedesDecisionId: text('supersedes_decision_id'),
    correctionReasonCategoryId: text('correction_reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    correctionReason: text('correction_reason'),
    recordedByUserId: text('recorded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
    /*
     * Whether the officer disclosed that this is their own application. Kept
     * on the decision, and again on a correction, because each is its own act
     * and a disclosure made for the first does not cover the second.
     */
    conflictAcknowledged: boolean('conflict_acknowledged')
      .notNull()
      .default(false),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [sebApplicationSubmission.applicationId, sebApplicationSubmission.id],
      name: 'seb_programme_decision_submission_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.applicationId, table.bankOutcomeId],
      foreignColumns: [sebPartnerBankOutcome.applicationId, sebPartnerBankOutcome.id],
      name: 'seb_programme_decision_bank_outcome_fk',
    }).onDelete('restrict'),
    /* A correction supersedes a decision on the same application, never another. */
    foreignKey({
      columns: [table.applicationId, table.supersedesDecisionId],
      foreignColumns: [table.applicationId, table.id],
      name: 'seb_programme_decision_supersedes_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_programme_decision_number_uq').on(
      table.applicationId,
      table.decisionNumber,
    ),
    /* Backs the supersedes key above. */
    unique('seb_programme_decision_application_id_uq').on(table.applicationId, table.id),
    /* One correction per decision, so a series cannot fork. */
    uniqueIndex('seb_programme_decision_one_correction_uq').on(table.supersedesDecisionId),
    check('seb_programme_decision_number_check', sql`${table.decisionNumber} >= 1`),
    check(
      'seb_programme_decision_outcome_check',
      sql`${table.outcome} IN ('APPROVED', 'REJECTED', 'REVISION_REQUIRED')`,
    ),
    check(
      'seb_programme_decision_amount_check',
      sql`(${table.outcome} = 'APPROVED' AND ${table.approvedAmountPaise} > 0
          AND ${table.approvedAmountPaise} <= 9007199254740991)
        OR (${table.outcome} <> 'APPROVED' AND ${table.approvedAmountPaise} IS NULL)`,
    ),
    check(
      'seb_programme_decision_reason_check',
      sql`(${table.outcome} = 'APPROVED' AND ${table.reasonCategoryId} IS NULL)
        OR (${table.outcome} <> 'APPROVED' AND ${table.reasonCategoryId} IS NOT NULL)`,
    ),
    check(
      'seb_programme_decision_correction_check',
      sql`(${table.supersedesDecisionId} IS NULL
          AND ${table.correctionReasonCategoryId} IS NULL
          AND ${table.correctionReason} IS NULL)
        OR (${table.supersedesDecisionId} IS NOT NULL
          AND ${table.correctionReasonCategoryId} IS NOT NULL
          AND ${table.correctionReason} IS NOT NULL)`,
    ),
    index('seb_programme_decision_application_idx').on(table.applicationId, table.createdAt),
  ],
)
