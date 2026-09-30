import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { instant } from '../shared'
import {
  applicationStatuses,
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
} from './application'
import { sebPipelineVersionStage } from './pipeline'


/**
 * Every action taken on an application at a stage — the stage history, and the
 * one home of what an officer entered.
 *
 * Kept here with the rest of an application's workflow history rather than
 * beside the pipeline tables: it points at the application and at a pinned
 * pipeline stage, and the application points at the pipeline, so defining it
 * with the pipeline would make the two schema modules import each other.
 *
 * Append-only. `status_version` is the version the action produced, and it is
 * unique per application: two actions racing on one version cannot both land
 * even if the head's guard were ever weakened.
 */
export const sebApplicationStageAction = pgTable(
  'seb_application_stage_action',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    pipelineId: text('pipeline_id').notNull(),
    pipelineVersion: integer('pipeline_version').notNull(),
    stageKey: text('stage_key').notNull(),
    actionKey: text('action_key').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    statusVersion: integer('status_version').notNull(),
    /** Where the action sent the file; null when it stayed, or when it ended. */
    toStageKey: text('to_stage_key'),
    /** What the officer entered, normalized by the form engine. */
    inputs: jsonb('inputs').notNull(),
    flagsAdded: text('flags_added').array().notNull(),
    flagsRemoved: text('flags_removed').array().notNull(),
    recorded: jsonb('recorded').notNull(),
    revisionStageKeys: text('revision_stage_keys').array().notNull(),
    selfReviewDisclosed: boolean('self_review_disclosed').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('seb_application_stage_action_version_uq').on(table.applicationId, table.statusVersion),
    unique('seb_application_stage_action_application_uq').on(table.applicationId, table.id),
    foreignKey({
      columns: [table.pipelineId, table.pipelineVersion, table.stageKey],
      foreignColumns: [
        sebPipelineVersionStage.pipelineId,
        sebPipelineVersionStage.version,
        sebPipelineVersionStage.stageKey,
      ],
      name: 'seb_application_stage_action_stage_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.pipelineId, table.pipelineVersion, table.toStageKey],
      foreignColumns: [
        sebPipelineVersionStage.pipelineId,
        sebPipelineVersionStage.version,
        sebPipelineVersionStage.stageKey,
      ],
      name: 'seb_application_stage_action_to_stage_fk',
    }).onDelete('restrict'),
    index('seb_application_stage_action_history_idx').on(table.applicationId, table.createdAt),
    // "Files I have acted on" — the read scope a stage owner keeps after the
    // file moves on.
    index('seb_application_stage_action_actor_idx').on(table.actorUserId, table.applicationId),
    check('seb_application_stage_action_version_check', sql`${table.statusVersion} >= 2`),
    check(
      'seb_application_stage_action_json_check',
      sql`jsonb_typeof(${table.inputs}) = 'object' AND jsonb_typeof(${table.recorded}) = 'object'
        AND octet_length(${table.inputs}::text) <= 65536`,
    ),
  ],
)


/**
 * A request for the applicant to correct one stage of the form; notes are never
 * edited after creation.
 *
 * Created only by a pipeline's revision effect. While one is open the applicant
 * may edit exactly the stages named, and the file stays at the stage that asked
 * — which is where resubmission returns it.
 */
export const sebRevisionRequest = pgTable(
  'seb_revision_request',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    submissionId: text('submission_id').notNull(),
    stageKey: text('stage_key').notNull(),
    note: text('note').notNull(),
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    requestedAt: instant('requested_at').notNull(),
    resolvedBySubmissionId: text('resolved_by_submission_id'),
    resolvedAt: instant('resolved_at'),
    cancelledAt: instant('cancelled_at'),
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
      'seb_revision_request_stage_key_check',
      sql`${table.stageKey} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
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
    unique('seb_revision_request_application_id_uq').on(table.applicationId, table.id),
    // A partial unique index lets a cancelled or resolved request stay in
    // history while preventing two simultaneous instructions for one form
    // stage. Uniqueness that applied to every row would make the history
    // itself the thing that blocks a new request.
    uniqueIndex('seb_revision_request_open_stage_uq')
      .on(table.applicationId, table.stageKey)
      .where(sql`${table.resolvedAt} IS NULL AND ${table.cancelledAt} IS NULL`),
  ],
)

/** Client-facing, append-only workflow timeline for an application. */
export const sebApplicationEvent = pgTable(
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
    stageKey: text('stage_key'),
    message: text('message'),
    metadataJson: text('metadata_json'),
    createdAt: instant('created_at').notNull(),
    /** The stage action this event reports, when an action caused it. */
    stageActionId: text('stage_action_id'),
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
    foreignKey({
      columns: [table.applicationId, table.stageActionId],
      foreignColumns: [sebApplicationStageAction.applicationId, sebApplicationStageAction.id],
      name: 'seb_application_event_stage_action_fk',
    }).onDelete('restrict'),
    check(
      'seb_application_event_stage_key_check',
      sql`${table.stageKey} IS NULL OR ${table.stageKey} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    // Drizzle enums are compile-time only, so these checks remain the
    // authoritative protection for dynamic inputs and administrative SQL.
    check(
      'seb_application_event_from_status_check',
      sql`${table.fromStatus} IS NULL OR ${table.fromStatus} IN ('DRAFT', 'IN_PIPELINE')`,
    ),
    check(
      'seb_application_event_to_status_check',
      sql`${table.toStatus} IS NULL OR ${table.toStatus} IN ('DRAFT', 'IN_PIPELINE')`,
    ),
    index('seb_application_event_application_idx').on(table.applicationId, table.createdAt),
  ],
)
