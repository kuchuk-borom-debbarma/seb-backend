/**
 * Offline partner-bank feedback and formal TTM meeting decisions.
 *
 * Bank identities are frozen as supplied text by product decision. Meetings
 * and agenda heads are versioned operational roots; outcomes and decisions are
 * append-only so a correction never erases what staff previously recorded.
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
export const ttmMeetingStatuses = ['DRAFT', 'IN_SESSION', 'FINALIZED', 'CANCELLED'] as const
export const ttmMeetingChangeTypes = [
  'CREATED',
  'UPDATED',
  'STARTED',
  'FINALIZED',
  'CANCELLED',
] as const
export const ttmAgendaStatuses = ['ACTIVE', 'REMOVED', 'DECIDED'] as const
export const ttmAgendaChangeTypes = ['ADDED', 'REORDERED', 'REMOVED', 'DECIDED'] as const
export const ttmDecisionOutcomes = [
  'APPROVED',
  'REJECTED',
  'DEFERRED',
  'REVISION_REQUIRED',
] as const

/** Current state of one offline referral for an exact submitted application. */
export const sebPartnerBankReferral = sqliteTable(
  'seb_partner_bank_referral',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    submissionId: text('submission_id').notNull(),
    deskReviewId: text('desk_review_id').notNull(),
    bankName: text('bank_name').notNull(),
    bankBranch: text('bank_branch'),
    referralReference: text('referral_reference').notNull().unique(),
    referralDate: text('referral_date').notNull(),
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
    uniqueIndex('seb_partner_bank_referral_application_id_uq').on(
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
export const sebPartnerBankReferralVersion = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
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
export const sebPartnerBankOutcome = sqliteTable(
  'seb_partner_bank_outcome',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    referralId: text('referral_id').notNull(),
    outcomeNumber: integer('outcome_number').notNull(),
    outcome: text('outcome', { enum: bankOutcomes }).notNull(),
    decisionReference: text('decision_reference').notNull(),
    decisionDate: text('decision_date').notNull(),
    availableLoanAmountPaise: integer('available_loan_amount_paise'),
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
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
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
    uniqueIndex('seb_partner_bank_outcome_referral_id_uq').on(table.referralId, table.id),
    // Agenda evidence repeats application_id so raw SQL cannot attach an
    // outcome from another application. SQLite requires this exact referenced
    // column order to be independently unique.
    uniqueIndex('seb_partner_bank_outcome_application_id_uq').on(
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
      sql`${table.availableLoanAmountPaise} IS NULL OR ${table.availableLoanAmountPaise} >= 0`,
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

/** Searchable current meeting state. */
export const sebTtmMeeting = sqliteTable(
  'seb_ttm_meeting',
  {
    id: text('id').primaryKey(),
    meetingReference: text('meeting_reference').notNull().unique(),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }).notNull(),
    venue: text('venue').notNull(),
    description: text('description'),
    status: text('status', { enum: ttmMeetingStatuses }).notNull().default('DRAFT'),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    check('seb_ttm_meeting_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_ttm_meeting_status_check',
      sql`${table.status} IN ('DRAFT', 'IN_SESSION', 'FINALIZED', 'CANCELLED')`,
    ),
    index('seb_ttm_meeting_schedule_idx').on(table.status, table.scheduledAt),
  ],
)

/** Immutable meeting revisions and lifecycle transitions. */
export const sebTtmMeetingVersion = sqliteTable(
  'seb_ttm_meeting_version',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => sebTtmMeeting.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    meetingReference: text('meeting_reference').notNull(),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }).notNull(),
    venue: text('venue').notNull(),
    description: text('description'),
    status: text('status', { enum: ttmMeetingStatuses }).notNull(),
    changeType: text('change_type', { enum: ttmMeetingChangeTypes }).notNull(),
    reason: text('reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_ttm_meeting_version_number_uq').on(table.meetingId, table.version),
    check('seb_ttm_meeting_version_number_check', sql`${table.version} >= 1`),
    check(
      'seb_ttm_meeting_version_status_check',
      sql`${table.status} IN ('DRAFT', 'IN_SESSION', 'FINALIZED', 'CANCELLED')`,
    ),
    check(
      'seb_ttm_meeting_version_change_type_check',
      sql`${table.changeType} IN ('CREATED', 'UPDATED', 'STARTED', 'FINALIZED', 'CANCELLED')`,
    ),
  ],
)

/** Current agenda position and pinned evidence for one application. */
export const sebTtmAgendaItem = sqliteTable(
  'seb_ttm_agenda_item',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => sebTtmMeeting.id, { onDelete: 'restrict' }),
    applicationId: text('application_id').notNull(),
    submissionId: text('submission_id').notNull(),
    bankOutcomeId: text('bank_outcome_id').notNull(),
    position: integer('position').notNull(),
    status: text('status', { enum: ttmAgendaStatuses }).notNull().default('ACTIVE'),
    currentVersion: integer('current_version').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [sebApplicationSubmission.applicationId, sebApplicationSubmission.id],
      name: 'seb_ttm_agenda_item_submission_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.applicationId, table.bankOutcomeId],
      foreignColumns: [sebPartnerBankOutcome.applicationId, sebPartnerBankOutcome.id],
      name: 'seb_ttm_agenda_item_bank_outcome_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_ttm_agenda_item_meeting_position_uq').on(table.meetingId, table.position),
    uniqueIndex('seb_ttm_agenda_item_application_id_uq').on(table.applicationId, table.id),
    uniqueIndex('seb_ttm_agenda_item_active_application_uq')
      .on(table.applicationId)
      .where(sql`${table.status} = 'ACTIVE'`),
    check('seb_ttm_agenda_item_position_check', sql`${table.position} >= 1`),
    check('seb_ttm_agenda_item_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_ttm_agenda_item_status_check',
      sql`${table.status} IN ('ACTIVE', 'REMOVED', 'DECIDED')`,
    ),
    index('seb_ttm_agenda_item_meeting_idx').on(table.meetingId, table.position),
  ],
)

/** Immutable agenda changes make reorder/removal races reviewable. */
export const sebTtmAgendaItemVersion = sqliteTable(
  'seb_ttm_agenda_item_version',
  {
    id: text('id').primaryKey(),
    agendaItemId: text('agenda_item_id')
      .notNull()
      .references(() => sebTtmAgendaItem.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    position: integer('position').notNull(),
    status: text('status', { enum: ttmAgendaStatuses }).notNull(),
    changeType: text('change_type', { enum: ttmAgendaChangeTypes }).notNull(),
    reason: text('reason'),
    changedByUserId: text('changed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_ttm_agenda_item_version_number_uq').on(
      table.agendaItemId,
      table.version,
    ),
    check('seb_ttm_agenda_item_version_number_check', sql`${table.version} >= 1`),
    check('seb_ttm_agenda_item_version_position_check', sql`${table.position} >= 1`),
    check(
      'seb_ttm_agenda_item_version_status_check',
      sql`${table.status} IN ('ACTIVE', 'REMOVED', 'DECIDED')`,
    ),
    check(
      'seb_ttm_agenda_item_version_change_type_check',
      sql`${table.changeType} IN ('ADDED', 'REORDERED', 'REMOVED', 'DECIDED')`,
    ),
  ],
)

/** Final or superseding programme decision for one agenda item. */
export const sebTtmDecision = sqliteTable(
  'seb_ttm_decision',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    agendaItemId: text('agenda_item_id').notNull(),
    decisionNumber: integer('decision_number').notNull(),
    outcome: text('outcome', { enum: ttmDecisionOutcomes }).notNull(),
    decisionReference: text('decision_reference').notNull().unique(),
    decisionDate: text('decision_date').notNull(),
    approvedAmountPaise: integer('approved_amount_paise'),
    applicantConditions: text('applicant_conditions'),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    applicantMessage: text('applicant_message').notNull(),
    nextAction: text('next_action'),
    supersedesDecisionId: text('supersedes_decision_id'),
    correctionReasonCategoryId: text('correction_reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    correctionReason: text('correction_reason'),
    recordedByUserId: text('recorded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.agendaItemId],
      foreignColumns: [sebTtmAgendaItem.applicationId, sebTtmAgendaItem.id],
      name: 'seb_ttm_decision_agenda_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.agendaItemId, table.supersedesDecisionId],
      foreignColumns: [table.agendaItemId, table.id],
      name: 'seb_ttm_decision_supersedes_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_ttm_decision_number_uq').on(table.agendaItemId, table.decisionNumber),
    uniqueIndex('seb_ttm_decision_agenda_id_uq').on(table.agendaItemId, table.id),
    uniqueIndex('seb_ttm_decision_one_correction_uq').on(table.supersedesDecisionId),
    check('seb_ttm_decision_number_check', sql`${table.decisionNumber} >= 1`),
    check(
      'seb_ttm_decision_outcome_check',
      sql`${table.outcome} IN ('APPROVED', 'REJECTED', 'DEFERRED', 'REVISION_REQUIRED')`,
    ),
    check(
      'seb_ttm_decision_amount_check',
      sql`(${table.outcome} = 'APPROVED' AND ${table.approvedAmountPaise} > 0)
        OR (${table.outcome} <> 'APPROVED' AND ${table.approvedAmountPaise} IS NULL)`,
    ),
    check(
      'seb_ttm_decision_deferral_check',
      sql`(${table.outcome} = 'DEFERRED' AND ${table.nextAction} IS NOT NULL)
        OR (${table.outcome} <> 'DEFERRED' AND ${table.nextAction} IS NULL)`,
    ),
    check(
      'seb_ttm_decision_reason_check',
      sql`(${table.outcome} = 'APPROVED' AND ${table.reasonCategoryId} IS NULL)
        OR (${table.outcome} <> 'APPROVED' AND ${table.reasonCategoryId} IS NOT NULL)`,
    ),
    check(
      'seb_ttm_decision_correction_check',
      sql`(${table.supersedesDecisionId} IS NULL
          AND ${table.correctionReasonCategoryId} IS NULL
          AND ${table.correctionReason} IS NULL)
        OR (${table.supersedesDecisionId} IS NOT NULL
          AND ${table.correctionReasonCategoryId} IS NOT NULL
          AND ${table.correctionReason} IS NOT NULL)`,
    ),
    index('seb_ttm_decision_application_idx').on(table.applicationId, table.createdAt),
  ],
)
