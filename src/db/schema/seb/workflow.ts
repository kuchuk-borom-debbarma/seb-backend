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
import {
  applicationStatuses,
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
} from './application'
import { sebProgrammeCycleReason } from './programme'

export const applicationSections = [
  'ENTERPRISE',
  'APPLICANT_PROFILE',
  'FINANCIAL',
  'PRIOR_FUNDING',
  'EXPANSION',
  'DOCUMENTS',
  'DECLARATION',
] as const

/** Section-specific correction request; notes are never edited after creation. */
export const sebRevisionRequest = sqliteTable(
  'seb_revision_request',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    submissionId: text('submission_id').notNull(),
    section: text('section', { enum: applicationSections }).notNull(),
    reasonCategoryId: text('reason_category_id').references(
      () => sebProgrammeCycleReason.id,
      { onDelete: 'restrict' },
    ),
    note: text('note').notNull(),
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedBySubmissionId: text('resolved_by_submission_id'),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
    cancelledByUserId: text('cancelled_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    cancellationReason: text('cancellation_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [
        sebApplicationSubmission.applicationId,
        sebApplicationSubmission.id,
      ],
      name: 'seb_revision_request_submission_application_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.applicationId, table.resolvedBySubmissionId],
      foreignColumns: [
        sebApplicationSubmission.applicationId,
        sebApplicationSubmission.id,
      ],
      name: 'seb_revision_request_resolution_application_fk',
    }).onDelete('restrict'),
    check(
      'seb_revision_request_section_check',
      sql`${table.section} IN ('ENTERPRISE', 'APPLICANT_PROFILE', 'FINANCIAL', 'PRIOR_FUNDING', 'EXPANSION', 'DOCUMENTS', 'DECLARATION')`,
    ),
    // Resolution and cancellation are terminal, mutually exclusive states.
    // Their metadata is stored as a complete group so timeline consumers never
    // have to interpret a partially populated lifecycle transition.
    check(
      'seb_revision_request_resolution_fields_check',
      sql`(${table.resolvedBySubmissionId} IS NULL AND ${table.resolvedAt} IS NULL)
        OR (${table.resolvedBySubmissionId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)`,
    ),
    check(
      'seb_revision_request_cancellation_fields_check',
      sql`(${table.cancelledAt} IS NULL AND ${table.cancelledByUserId} IS NULL AND ${table.cancellationReason} IS NULL)
        OR (${table.cancelledAt} IS NOT NULL AND ${table.cancelledByUserId} IS NOT NULL AND ${table.cancellationReason} IS NOT NULL)`,
    ),
    check(
      'seb_revision_request_terminal_state_check',
      sql`NOT (${table.resolvedAt} IS NOT NULL AND ${table.cancelledAt} IS NOT NULL)`,
    ),
    index('seb_revision_request_application_idx').on(
      table.applicationId,
      table.resolvedAt,
      table.cancelledAt,
      table.requestedAt,
    ),
    // Events use this key to ensure a referenced revision belongs to the event's
    // application rather than merely checking that the revision ID exists.
    uniqueIndex('seb_revision_request_application_id_uq').on(table.applicationId, table.id),
    // SQLite partial uniqueness allows a cancelled or resolved request to stay
    // in history while preventing two simultaneous instructions for one form
    // section.
    uniqueIndex('seb_revision_request_open_section_uq')
      .on(table.applicationId, table.section)
      .where(sql`${table.resolvedAt} IS NULL AND ${table.cancelledAt} IS NULL`),
  ],
)

/** Client-facing, append-only workflow timeline for an application. */
export const sebApplicationEvent = sqliteTable(
  'seb_application_event',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    actorUserId: text('actor_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    applicationVersion: integer('application_version'),
    submissionId: text('submission_id'),
    revisionRequestId: text('revision_request_id'),
    fromStatus: text('from_status', { enum: applicationStatuses }),
    toStatus: text('to_status', { enum: applicationStatuses }),
    section: text('section', { enum: applicationSections }),
    message: text('message'),
    metadataJson: text('metadata_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.applicationVersion],
      foreignColumns: [sebApplicationVersion.applicationId, sebApplicationVersion.version],
      name: 'seb_application_event_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [
        sebApplicationSubmission.applicationId,
        sebApplicationSubmission.id,
      ],
      name: 'seb_application_event_submission_application_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.applicationId, table.revisionRequestId],
      foreignColumns: [sebRevisionRequest.applicationId, sebRevisionRequest.id],
      name: 'seb_application_event_revision_application_fk',
    }).onDelete('restrict'),
    check(
      'seb_application_event_section_check',
      sql`${table.section} IS NULL OR ${table.section} IN ('ENTERPRISE', 'APPLICANT_PROFILE', 'FINANCIAL', 'PRIOR_FUNDING', 'EXPANSION', 'DOCUMENTS', 'DECLARATION')`,
    ),
    // Drizzle enums are compile-time only, so D1 checks remain the authoritative
    // protection for dynamic inputs and administrative SQL.
    check(
      'seb_application_event_from_status_check',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED', 'CANCELLED')`,
    ),
    check(
      'seb_application_event_to_status_check',
      sql`${table.toStatus} IS NULL OR ${table.toStatus} IN ('DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED', 'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED', 'SANCTIONED', 'DISBURSED', 'CANCELLED')`,
    ),
    index('seb_application_event_application_idx').on(table.applicationId, table.createdAt),
  ],
)
