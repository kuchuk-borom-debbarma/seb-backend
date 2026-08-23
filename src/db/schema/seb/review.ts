/**
 * Administrative intake ownership, internal notes, and completed desk reviews.
 *
 * The application head carries the current assignment for fast queues. These
 * append-only records retain the complete operational history and the exact
 * submission that a reviewer evaluated.
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
import { sebApplication, sebApplicationSubmission } from './application'
import { sebProgrammeCycleReason } from './programme'

export const assignmentEventTypes = ['CLAIMED', 'RELEASED', 'REASSIGNED'] as const
export const deskReviewChecks = [
  'IDENTITY_KYC',
  'ST_ELIGIBILITY',
  'MAJORITY_OWNERSHIP',
  'JURISDICTION',
  'FORM_COMPLETENESS',
  'DOCUMENT_COMPLETENESS',
  'ANSWER_DOCUMENT_CONSISTENCY',
  'DPR_FEASIBILITY',
  'EXPANSION_EVIDENCE',
] as const
export const deskReviewCheckResults = ['PASS', 'FAIL', 'NOT_APPLICABLE'] as const
export const deskReviewOutcomes = [
  'ADVANCE_TO_BANK',
  'REQUEST_REVISION',
  'REJECT',
] as const

/** What a reviewer transcribes off the document they are looking at. */
export const deskReviewIdentifierKinds = [
  'ST_CERTIFICATE',
  'IDENTITY_DOCUMENT',
  'BANK_ACCOUNT',
  'BUSINESS_REGISTRATION',
] as const

/** Every change to the current queue owner, including self-review disclosure. */
export const sebApplicationAssignmentEvent = sqliteTable(
  'seb_application_assignment_event',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    eventType: text('event_type', { enum: assignmentEventTypes }).notNull(),
    assignmentVersion: integer('assignment_version').notNull(),
    fromUserId: text('from_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    toUserId: text('to_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    reason: text('reason'),
    conflictAcknowledged: integer('conflict_acknowledged', { mode: 'boolean' })
      .notNull()
      .default(false),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_application_assignment_event_version_uq').on(
      table.applicationId,
      table.assignmentVersion,
    ),
    check(
      'seb_application_assignment_event_type_check',
      sql`${table.eventType} IN ('CLAIMED', 'RELEASED', 'REASSIGNED')`,
    ),
    check(
      'seb_application_assignment_event_version_check',
      sql`${table.assignmentVersion} >= 1`,
    ),
    check(
      'seb_application_assignment_event_conflict_check',
      sql`${table.conflictAcknowledged} IN (0, 1)`,
    ),
    check(
      'seb_application_assignment_event_state_check',
      sql`(${table.eventType} = 'CLAIMED' AND ${table.fromUserId} IS NULL AND ${table.toUserId} IS NOT NULL)
        OR (${table.eventType} = 'RELEASED' AND ${table.fromUserId} IS NOT NULL AND ${table.toUserId} IS NULL)
        OR (${table.eventType} = 'REASSIGNED' AND ${table.fromUserId} IS NOT NULL AND ${table.toUserId} IS NOT NULL AND ${table.fromUserId} <> ${table.toUserId})`,
    ),
    index('seb_application_assignment_event_application_idx').on(
      table.applicationId,
      table.createdAt,
    ),
  ],
)

/** Staff-only append-only note; a correction points to the note it replaces. */
export const sebApplicationInternalNote = sqliteTable(
  'seb_application_internal_note',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    correctionOfNoteId: text('correction_of_note_id'),
    note: text('note').notNull(),
    authoredByUserId: text('authored_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.correctionOfNoteId],
      foreignColumns: [table.applicationId, table.id],
      name: 'seb_application_internal_note_correction_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_application_internal_note_application_id_uq').on(
      table.applicationId,
      table.id,
    ),
    uniqueIndex('seb_application_internal_note_one_correction_uq').on(
      table.correctionOfNoteId,
    ),
    index('seb_application_internal_note_application_idx').on(
      table.applicationId,
      table.createdAt,
    ),
  ],
)

/** Immutable final checklist and outcome for one reviewed submission. */
export const sebDeskReview = sqliteTable(
  'seb_desk_review',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    submissionId: text('submission_id').notNull(),
    outcome: text('outcome', { enum: deskReviewOutcomes }).notNull(),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    applicantMessage: text('applicant_message'),
    reviewedByUserId: text('reviewed_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [sebApplicationSubmission.applicationId, sebApplicationSubmission.id],
      name: 'seb_desk_review_submission_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_desk_review_submission_uq').on(table.submissionId),
    uniqueIndex('seb_desk_review_application_id_uq').on(table.applicationId, table.id),
    check(
      'seb_desk_review_outcome_check',
      sql`${table.outcome} IN ('ADVANCE_TO_BANK', 'REQUEST_REVISION', 'REJECT')`,
    ),
    check(
      'seb_desk_review_reason_check',
      sql`(${table.outcome} = 'ADVANCE_TO_BANK'
          AND ${table.reasonCategoryId} IS NULL
          AND ${table.applicantMessage} IS NULL)
        OR (${table.outcome} IN ('REQUEST_REVISION', 'REJECT')
          AND ${table.reasonCategoryId} IS NOT NULL
          AND ${table.applicantMessage} IS NOT NULL)`,
    ),
    index('seb_desk_review_application_idx').on(table.applicationId, table.reviewedAt),
  ],
)

/** One result for every fixed checklist item in a completed review. */
export const sebDeskReviewCheck = sqliteTable(
  'seb_desk_review_check',
  {
    id: text('id').primaryKey(),
    deskReviewId: text('desk_review_id')
      .notNull()
      .references(() => sebDeskReview.id, { onDelete: 'restrict' }),
    checkType: text('check_type', { enum: deskReviewChecks }).notNull(),
    result: text('result', { enum: deskReviewCheckResults }).notNull(),
    internalNote: text('internal_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_desk_review_check_type_uq').on(table.deskReviewId, table.checkType),
    check(
      'seb_desk_review_check_type_check',
      sql`${table.checkType} IN ('IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION', 'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY', 'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE')`,
    ),
    check(
      'seb_desk_review_check_result_check',
      sql`${table.result} IN ('PASS', 'FAIL', 'NOT_APPLICABLE')`,
    ),
  ],
)

/**
 * The identifiers read off the documents a review passed.
 *
 * Append-only and immutable, like the review itself: this is a record of what
 * somebody read on a particular day, and correcting it means a new review
 * rather than an edit to an old one.
 *
 * `fundingCaseId` is copied here rather than joined for. The duplicate check
 * runs on every completed review and asks one question — has this value been
 * recorded against a different case — so it must be a single indexed lookup
 * rather than a walk through reviews and applications. The copy cannot drift:
 * an application's funding case is fixed when it is created and never moves.
 *
 * `matchedReason` is what the reviewer said when a match was found and the
 * check was passed anyway. A match is not proof of anything — a second-phase
 * expansion by the same promoter is expected here — so it is a question that
 * must be answered rather than a refusal.
 */
export const sebDeskReviewIdentifier = sqliteTable(
  'seb_desk_review_identifier',
  {
    id: text('id').primaryKey(),
    deskReviewId: text('desk_review_id')
      .notNull()
      .references(() => sebDeskReview.id, { onDelete: 'restrict' }),
    fundingCaseId: text('funding_case_id').notNull(),
    kind: text('kind', { enum: deskReviewIdentifierKinds }).notNull(),
    /** Normalized for comparison, or a keyed digest where the kind is sensitive. */
    comparableValue: text('comparable_value').notNull(),
    /** The digits a reviewer can check by eye. Never the whole number. */
    lastFour: text('last_four').notNull(),
    /** Set when this value already existed on another case and was passed anyway. */
    matchedReason: text('matched_reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // One value of each kind per review: a reviewer reads one certificate.
    uniqueIndex('seb_desk_review_identifier_kind_uq').on(table.deskReviewId, table.kind),
    check(
      'seb_desk_review_identifier_kind_check',
      sql`${table.kind} IN ('ST_CERTIFICATE', 'IDENTITY_DOCUMENT', 'BANK_ACCOUNT', 'BUSINESS_REGISTRATION')`,
    ),
    // The duplicate question, answered by one indexed seek.
    index('seb_desk_review_identifier_match_idx').on(
      table.kind,
      table.comparableValue,
      table.fundingCaseId,
    ),
  ],
)
