/**
 * Reading and writing a file at a pipeline stage.
 *
 * ## Reads
 *
 * Everything an action is decided on comes back in **one statement**
 * ({@link findStageFile}): the head with its stage, trail, flags and recorded
 * values, the pinned pipeline document, the answers of the latest submission,
 * the pinned form's stages, the cycle's ceiling, the open revision requests
 * and whether the caller has acted on the file before. Deciding on two reads
 * taken at different moments is how a guard comes to check one state and write
 * over another, and every extra read is a network hop on Hyperdrive.
 *
 * ## Writes
 *
 * A stage action is **one data-modifying statement** ({@link writeStageAction}):
 * the guarded head update, the action row, the revision requests, the notes,
 * the timeline events and the audit rows are members of one `WITH`, each
 * selecting from the head update's `RETURNING`. A losing writer's update
 * returns no row, so every member writes nothing — no action row, no note, no
 * audit — and the statement still commits cleanly. That is the version guard
 * of the old batches, in one round trip whatever the number of effects.
 *
 * `unique(application_id, status_version)` on the action row is the second
 * guard: two actions racing on one version cannot both land even if the head's
 * predicate were ever weakened.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreUser,
  sebApplication,
  sebApplicationEvent,
  sebApplicationInternalNote,
  sebApplicationStageAction,
  sebApplicationSubmission,
  sebApplicationVersion,
  sebApplicationVersionAnswer,
  sebEnterprise,
  sebPipeline,
  sebPipelineVersion,
  sebPipelineVersionStage,
  sebProgrammeCycleFormField,
  sebProgrammeCycleFormStage,
  sebProgrammeCycleVersion,
  sebRevisionRequest,
} from '../../../db/schema'
import type { AnswerValue } from '../../application/form/types'
import { auditEventCteMember, type AuditEventRecord } from '../../audit-event'
import { readScopeFilter, type ReadScope } from './stage-scope'

/** A timestamp from a raw row: node-postgres and PGlite both parse it, but not always to the same thing. */
const instantOf = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)))
const optionalInstant = (value: unknown): Date | null => (value === null || value === undefined ? null : instantOf(value))

/**
 * One stored answer's text, read by its field's type.
 *
 * Only what a pipeline can refer to: `pipelinePinProblem` refused any pinned
 * answer key that is not a top-level question, so a repeated group never
 * arrives here, and a multiple choice is its ordered selections.
 */
const decodeAnswer = (type: string, texts: readonly string[]): AnswerValue => {
  if (type === 'MULTI_CHOICE') return [...texts]
  const [text] = texts
  if (text === undefined) return null
  if (type === 'BOOLEAN' || type === 'ATTESTATION') return text === 'true'
  if (type === 'INTEGER' || type === 'MONEY_PAISE') {
    const parsed = Number(text)
    // Null rather than NaN: a corrupt amount must fail a bound, never pass it.
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return text
}

const answersOf = (rows: readonly [string, string, string][]): Record<string, AnswerValue> => {
  const grouped = new Map<string, { type: string; texts: string[] }>()
  for (const [key, type, text] of rows) {
    const entry = grouped.get(key) ?? { type, texts: [] }
    entry.texts.push(text)
    grouped.set(key, entry)
  }
  return Object.fromEntries([...grouped].map(([key, entry]) => [key, decodeAnswer(entry.type, entry.texts)]))
}

export type StageFile = {
  id: string
  referenceNumber: string | null
  enterpriseName: string
  applicantUserId: string
  applicantEmail: string
  applicationKind: string
  statusVersion: number
  pipelineId: string
  /** The pipeline's key, which is how the history names it. */
  pipelineKey: string
  pipelineVersion: number
  currentStageKey: string | null
  stageEnteredAt: Date | null
  stageTrail: string[]
  statusFlags: string[]
  recordedValues: Record<string, AnswerValue>
  updatedAt: Date
  /** The pinned pipeline document, unparsed; the caller parses it once. */
  definition: unknown
  /** The newest submission, which revision requests are raised against. */
  latestSubmissionId: string
  latestApplicationVersion: number
  /** Top-level answers of the newest submission, decoded by field type. */
  answers: Record<string, AnswerValue>
  /** The pinned form's stages, which are what a revision may name. */
  formStageKeys: string[]
  /** The pinned cycle's resolved ceiling for one application, or null. */
  ceilingPaise: number | null
  openRevisions: { id: string; stageKey: string }[]
  /** Whether the caller has taken an action on this file before. */
  actedByCaller: boolean
}

/**
 * The whole decision context for one file, in one statement, or null when the
 * file does not exist, is a draft, is removed, or lies outside `scope`.
 *
 * The scope is part of the `WHERE`, so a file the caller may not read and a
 * file that does not exist are the same answer, produced by the same query.
 */
export const findStageFile = async (
  db: Database,
  input: { applicationId: string; callerUserId: string; scope: ReadScope },
): Promise<StageFile | null> => {
  const scope = readScopeFilter(input.scope)
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH latest AS (
      SELECT ${sebApplicationSubmission.id} AS submission_id,
        ${sebApplicationVersion.id} AS version_id,
        ${sebApplicationVersion.version} AS application_version,
        ${sebApplicationVersion.programmeCycleId} AS cycle_id,
        ${sebApplicationVersion.programmeCycleVersion} AS cycle_version
      FROM ${sebApplicationSubmission}
      JOIN ${sebApplicationVersion}
        ON ${sebApplicationVersion.applicationId} = ${sebApplicationSubmission.applicationId}
       AND ${sebApplicationVersion.version} = ${sebApplicationSubmission.applicationVersion}
      WHERE ${sebApplicationSubmission.applicationId} = ${input.applicationId}
      ORDER BY ${sebApplicationSubmission.submissionNumber} DESC
      LIMIT 1
    )
    SELECT
      ${sebApplication.id} AS id,
      ${sebApplication.referenceNumber} AS reference_number,
      ${sebEnterprise.currentName} AS enterprise_name,
      ${sebApplication.applicantUserId} AS applicant_user_id,
      ${coreUser.email} AS applicant_email,
      ${sebApplication.applicationKind} AS application_kind,
      ${sebApplication.statusVersion} AS status_version,
      ${sebApplication.pipelineId} AS pipeline_id,
      ${sebApplication.pipelineVersion} AS pipeline_version,
      ${sebPipeline.key} AS pipeline_key,
      ${sebApplication.currentStageKey} AS current_stage_key,
      ${sebApplication.stageEnteredAt} AS stage_entered_at,
      ${sebApplication.stageTrail} AS stage_trail,
      ${sebApplication.statusFlags} AS status_flags,
      ${sebApplication.recordedValues} AS recorded_values,
      ${sebApplication.updatedAt} AS updated_at,
      ${sebPipelineVersion.definition} AS definition,
      latest.submission_id,
      latest.application_version,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_array(answer.field_key, field.field_type, answer.value_text)
          ORDER BY answer.field_key, answer.value_ordinal)
        FROM ${sebApplicationVersionAnswer} AS answer
        JOIN ${sebProgrammeCycleFormField} AS field
          ON field.programme_cycle_id = answer.programme_cycle_id
         AND field.programme_cycle_version = answer.programme_cycle_version
         AND field.field_key = answer.field_key
        WHERE answer.application_version_id = latest.version_id
          AND answer.entry_index = 0
          AND field.parent_field_key IS NULL
      ), '[]'::jsonb) AS answers,
      ARRAY(
        SELECT form_stage.stage_key FROM ${sebProgrammeCycleFormStage} AS form_stage
        WHERE form_stage.programme_cycle_id = latest.cycle_id
          AND form_stage.programme_cycle_version = latest.cycle_version
        ORDER BY form_stage.sort_order
      ) AS form_stage_keys,
      (
        SELECT cycle_version.funding_ceiling_amount_paise
        FROM ${sebProgrammeCycleVersion} AS cycle_version
        WHERE cycle_version.programme_cycle_id = latest.cycle_id
          AND cycle_version.version = latest.cycle_version
          AND cycle_version.funding_ceiling_state = 'RESOLVED'
      ) AS ceiling_paise,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', revision.id, 'stageKey', revision.stage_key)
          ORDER BY revision.requested_at)
        FROM ${sebRevisionRequest} AS revision
        WHERE revision.application_id = ${sebApplication.id}
          AND revision.resolved_at IS NULL
          AND revision.cancelled_at IS NULL
      ), '[]'::jsonb) AS open_revisions,
      EXISTS (
        SELECT 1 FROM ${sebApplicationStageAction} AS acted
        WHERE acted.actor_user_id = ${input.callerUserId}
          AND acted.application_id = ${sebApplication.id}
      ) AS acted_by_caller
    FROM ${sebApplication}
    JOIN latest ON TRUE
    JOIN ${coreUser} ON ${coreUser.id} = ${sebApplication.applicantUserId}
    JOIN ${sebEnterprise} ON ${sebEnterprise.id} = ${sebApplication.enterpriseId}
    JOIN ${sebPipelineVersion}
      ON ${sebPipelineVersion.pipelineId} = ${sebApplication.pipelineId}
     AND ${sebPipelineVersion.version} = ${sebApplication.pipelineVersion}
    JOIN ${sebPipeline} ON ${sebPipeline.id} = ${sebApplication.pipelineId}
    WHERE ${sebApplication.id} = ${input.applicationId}
      AND ${sebApplication.deletedAt} IS NULL
      AND ${sebApplication.status} = 'IN_PIPELINE'
      ${scope ? sql`AND ${scope}` : sql``}
  `)
  const row = result.rows[0]
  if (!row) return null
  const ceiling = row.ceiling_paise === null ? null : Number(row.ceiling_paise)
  return {
    id: String(row.id),
    referenceNumber: (row.reference_number as string | null) ?? null,
    enterpriseName: String(row.enterprise_name),
    applicantUserId: String(row.applicant_user_id),
    applicantEmail: String(row.applicant_email),
    applicationKind: String(row.application_kind),
    statusVersion: Number(row.status_version),
    pipelineId: String(row.pipeline_id),
    pipelineVersion: Number(row.pipeline_version),
    pipelineKey: String(row.pipeline_key),
    currentStageKey: (row.current_stage_key as string | null) ?? null,
    stageEnteredAt: optionalInstant(row.stage_entered_at),
    stageTrail: row.stage_trail as string[],
    statusFlags: row.status_flags as string[],
    recordedValues: row.recorded_values as Record<string, AnswerValue>,
    updatedAt: instantOf(row.updated_at),
    definition: row.definition,
    latestSubmissionId: String(row.submission_id),
    latestApplicationVersion: Number(row.application_version),
    answers: answersOf(row.answers as [string, string, string][]),
    formStageKeys: row.form_stage_keys as string[],
    ceilingPaise: Number.isSafeInteger(ceiling) ? ceiling : null,
    openRevisions: row.open_revisions as { id: string; stageKey: string }[],
    actedByCaller: row.acted_by_caller === true,
  }
}

export type StageActionRecord = {
  id: string
  stageKey: string
  actionKey: string
  toStageKey: string | null
  actorUserId: string
  actorEmail: string
  statusVersion: number
  inputs: Record<string, AnswerValue>
  flagsAdded: string[]
  flagsRemoved: string[]
  recorded: Record<string, AnswerValue>
  revisionStageKeys: string[]
  selfReviewDisclosed: boolean
  pipelineVersion: number
  createdAt: Date
}

/** Every action taken on a file, oldest first, with who took it. One seek on the history index. */
export const listStageActions = async (db: Database, applicationId: string): Promise<StageActionRecord[]> => {
  const rows = await db
    .select({
      id: sebApplicationStageAction.id,
      stageKey: sebApplicationStageAction.stageKey,
      actionKey: sebApplicationStageAction.actionKey,
      toStageKey: sebApplicationStageAction.toStageKey,
      actorUserId: sebApplicationStageAction.actorUserId,
      actorEmail: coreUser.email,
      statusVersion: sebApplicationStageAction.statusVersion,
      inputs: sebApplicationStageAction.inputs,
      flagsAdded: sebApplicationStageAction.flagsAdded,
      flagsRemoved: sebApplicationStageAction.flagsRemoved,
      recorded: sebApplicationStageAction.recorded,
      revisionStageKeys: sebApplicationStageAction.revisionStageKeys,
      selfReviewDisclosed: sebApplicationStageAction.selfReviewDisclosed,
      pipelineVersion: sebApplicationStageAction.pipelineVersion,
      createdAt: sebApplicationStageAction.createdAt,
    })
    .from(sebApplicationStageAction)
    .innerJoin(coreUser, sql`${coreUser.id} = ${sebApplicationStageAction.actorUserId}`)
    .where(sql`${sebApplicationStageAction.applicationId} = ${applicationId}`)
    .orderBy(sebApplicationStageAction.createdAt, sebApplicationStageAction.statusVersion)
  return rows.map((row) => ({
    ...row,
    inputs: row.inputs as Record<string, AnswerValue>,
    recorded: row.recorded as Record<string, AnswerValue>,
  }))
}

/**
 * The stages a person works, with how many files wait at each.
 *
 * `stages` null means every stage of every published pipeline — the super
 * administrator's answer. Each count is an index-only count on the stage-queue
 * index, so the list costs one probe per stage, not a scan.
 */
export const listWorkedStages = async (
  db: Database,
  stages: readonly { pipelineId: string; stageKey: string }[] | null,
) => {
  if (stages !== null && stages.length === 0) return []
  const owned = stages === null
    ? sql``
    : sql`AND (stage.pipeline_id, stage.stage_key) IN (${sql.join(
        stages.map((each) => sql`(${each.pipelineId}, ${each.stageKey})`),
        sql`, `,
      )})`
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT pipeline.id AS pipeline_id, pipeline.key AS pipeline_key, pipeline.name AS pipeline_name,
      pipeline.current_published_version AS version, stage.stage_key, stage.position,
      (
        SELECT count(*) FROM ${sebApplication} AS waiting
        WHERE waiting.pipeline_id = pipeline.id
          AND waiting.current_stage_key = stage.stage_key
          AND waiting.deleted_at IS NULL
          AND waiting.current_stage_key IS NOT NULL
      )::int AS waiting
    FROM ${sebPipeline} AS pipeline
    JOIN ${sebPipelineVersionStage} AS stage
      ON stage.pipeline_id = pipeline.id AND stage.version = pipeline.current_published_version
    WHERE pipeline.current_published_version IS NOT NULL
      ${owned}
    ORDER BY pipeline.name, pipeline.id, stage.position
  `)
  return result.rows.map((row) => ({
    pipelineId: String(row.pipeline_id),
    pipelineKey: String(row.pipeline_key),
    pipelineName: String(row.pipeline_name),
    version: Number(row.version),
    stageKey: String(row.stage_key),
    waiting: Number(row.waiting),
  }))
}

const textArray = (values: readonly string[]): SQL =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`

export type StageQueueRow = {
  id: string
  referenceNumber: string | null
  enterpriseName: string
  applicationKind: string
  statusVersion: number
  pipelineVersion: number
  stageEnteredAt: Date
  statusFlags: string[]
  recordedValues: Record<string, AnswerValue>
}

type StageQueueInput = {
  pipelineId: string
  stageKey: string
  flags: readonly string[]
  first: number
  after: { timestamp: Date; id: string } | null
}

/*
 * The files at one stage. Spelled with both partial-index terms, because the
 * planner uses a partial index only when it can prove its predicate.
 */
const atStage = (input: StageQueueInput): SQL => sql`${sebApplication.pipelineId} = ${input.pipelineId}
    AND ${sebApplication.currentStageKey} = ${input.stageKey}
    AND ${sebApplication.deletedAt} IS NULL
    AND ${sebApplication.currentStageKey} IS NOT NULL
    ${input.flags.length > 0 ? sql`AND ${sebApplication.statusFlags} @> ${textArray(input.flags)}` : sql``}`

/**
 * One page of the files at a stage, as a statement not yet run — exported so
 * the performance suite can `EXPLAIN` exactly what the queue runs.
 *
 * The predicate and the ordering are exactly the stage-queue index
 * `(pipeline_id, current_stage_key, stage_entered_at, id) WHERE deleted_at IS
 * NULL AND current_stage_key IS NOT NULL`, so a page is a seek with no sort
 * however long the queue grows.
 */
export const stageQueuePage = (db: Database, input: StageQueueInput) => {
  const cursor: SQL = input.after
    ? sql`AND (${sebApplication.stageEnteredAt}, ${sebApplication.id}) > (${input.after.timestamp}::timestamptz, ${input.after.id}::text)`
    : sql``
  return db
    .select({
      id: sebApplication.id,
      referenceNumber: sebApplication.referenceNumber,
      enterpriseName: sebEnterprise.currentName,
      applicationKind: sebApplication.applicationKind,
      statusVersion: sebApplication.statusVersion,
      pipelineVersion: sebApplication.pipelineVersion,
      stageEnteredAt: sebApplication.stageEnteredAt,
      statusFlags: sebApplication.statusFlags,
      recordedValues: sebApplication.recordedValues,
    })
    .from(sebApplication)
    .innerJoin(sebEnterprise, sql`${sebEnterprise.id} = ${sebApplication.enterpriseId}`)
    .where(sql`${atStage(input)} ${cursor}`)
    .orderBy(sebApplication.stageEnteredAt, sebApplication.id)
    .limit(input.first + 1)
}

/** One page of a stage's queue and the queue's length: two statements. */
export const listStageQueue = async (
  db: Database,
  input: StageQueueInput,
): Promise<{ rows: StageQueueRow[]; total: number }> => {
  const rows = await stageQueuePage(db, input)
  const [total] = await db.select({ value: sql<number>`count(*)::int` }).from(sebApplication).where(atStage(input))
  return {
    rows: rows.map((row) => ({
      ...row,
      // The predicate proved a stage, and the lifecycle CHECK pairs it with a time.
      stageEnteredAt: row.stageEnteredAt as Date,
      recordedValues: row.recordedValues as Record<string, AnswerValue>,
    })),
    total: Number(total?.value ?? 0),
  }
}

/** What one guarded stage-action statement writes; built by the controller from the plan. */
export type StageActionWrite = {
  file: Pick<StageFile, 'id' | 'statusVersion' | 'pipelineId' | 'pipelineVersion' | 'currentStageKey' | 'latestSubmissionId' | 'latestApplicationVersion'>
  actionId: string
  actionKey: string
  actorUserId: string
  now: Date
  toStageKey: string | null
  /** Whether the file changed stage, so it gets a new arrival time. */
  moved: boolean
  trail: readonly string[]
  flags: readonly string[]
  /** Merged into `recorded_values`; keys replace, others stay. */
  recorded: Readonly<Record<string, AnswerValue>>
  flagsAdded: readonly string[]
  flagsRemoved: readonly string[]
  inputs: Readonly<Record<string, AnswerValue>>
  revisions: readonly { id: string; stageKey: string; note: string }[]
  notes: readonly { id: string; note: string }[]
  selfReviewDisclosed: boolean
  /** What the applicant is shown on their timeline; null for nothing to say. */
  timelineMessage: string | null
  audits: readonly AuditEventRecord[]
}

/**
 * Writes one stage action as one statement. True when it landed; false when
 * the file had moved on — the version, the stage or the pin no longer matched —
 * in which case nothing at all was written.
 */
export const writeStageAction = async (db: Database, write: StageActionWrite): Promise<boolean> => {
  const { file } = write
  const nextVersion = file.statusVersion + 1
  const members: SQL[] = [
    sql`head AS (
      UPDATE ${sebApplication} SET
        status_version = ${nextVersion}::int,
        status_changed_at = ${write.now},
        updated_at = ${write.now},
        current_stage_key = ${write.toStageKey},
        stage_entered_at = ${write.toStageKey === null ? null : write.moved ? write.now : sql`stage_entered_at`},
        stage_trail = ${textArray(write.trail)},
        status_flags = ${textArray(write.flags)},
        recorded_values = recorded_values || ${JSON.stringify(write.recorded)}::jsonb
      WHERE id = ${file.id}
        AND status_version = ${file.statusVersion}::int
        AND status = 'IN_PIPELINE'
        AND deleted_at IS NULL
        AND pipeline_id = ${file.pipelineId}
        AND pipeline_version = ${file.pipelineVersion}::int
        AND current_stage_key = ${file.currentStageKey}
      RETURNING id
    )`,
    sql`action AS (
      INSERT INTO ${sebApplicationStageAction} (
        id, application_id, pipeline_id, pipeline_version, stage_key, action_key,
        actor_user_id, status_version, to_stage_key, inputs, flags_added,
        flags_removed, recorded, revision_stage_keys, self_review_disclosed, created_at
      )
      SELECT ${write.actionId}, head.id, ${file.pipelineId}, ${file.pipelineVersion}::int,
        ${file.currentStageKey}, ${write.actionKey}, ${write.actorUserId}, ${nextVersion}::int,
        ${write.toStageKey}, ${JSON.stringify(write.inputs)}::jsonb, ${textArray(write.flagsAdded)},
        ${textArray(write.flagsRemoved)}, ${JSON.stringify(write.recorded)}::jsonb,
        ${textArray(write.revisions.map((revision) => revision.stageKey))},
        ${write.selfReviewDisclosed}, ${write.now}
      FROM head
      RETURNING id
    )`,
    // The applicant's timeline: one entry for the action, whatever it did.
    sql`action_event AS (
      INSERT INTO ${sebApplicationEvent} (
        id, application_id, event_type, actor_user_id, application_version,
        submission_id, revision_request_id, from_status, to_status, stage_key,
        message, metadata_json, created_at, stage_action_id
      )
      SELECT ${crypto.randomUUID()}, head.id, 'STAGE_ACTION', ${write.actorUserId}, NULL,
        NULL, NULL, 'IN_PIPELINE', 'IN_PIPELINE', NULL,
        ${write.timelineMessage}, NULL, ${write.now}, action.id
      FROM head CROSS JOIN action
    )`,
  ]
  write.revisions.forEach((revision, index) => {
    members.push(sql`revision_${sql.raw(String(index))} AS (
      INSERT INTO ${sebRevisionRequest} (
        id, application_id, submission_id, stage_key, note, requested_by_user_id,
        requested_at, resolved_by_submission_id, resolved_at, cancelled_at,
        cancelled_by_user_id, cancellation_reason
      )
      SELECT ${revision.id}, head.id, ${file.latestSubmissionId}, ${revision.stageKey}, ${revision.note},
        ${write.actorUserId}, ${write.now}, NULL, NULL, NULL, NULL, NULL
      FROM head
    )`)
    members.push(sql`revision_event_${sql.raw(String(index))} AS (
      INSERT INTO ${sebApplicationEvent} (
        id, application_id, event_type, actor_user_id, application_version,
        submission_id, revision_request_id, from_status, to_status, stage_key,
        message, metadata_json, created_at, stage_action_id
      )
      SELECT ${crypto.randomUUID()}, head.id, 'REVISION_REQUESTED', ${write.actorUserId},
        ${file.latestApplicationVersion}::int, ${file.latestSubmissionId}, ${revision.id},
        'IN_PIPELINE', 'IN_PIPELINE', ${revision.stageKey}, ${revision.note}, NULL, ${write.now}, action.id
      FROM head CROSS JOIN action
    )`)
  })
  write.notes.forEach((note, index) => {
    members.push(sql`note_${sql.raw(String(index))} AS (
      INSERT INTO ${sebApplicationInternalNote} (
        id, application_id, correction_of_note_id, note, authored_by_user_id, created_at
      )
      SELECT ${note.id}, head.id, NULL, ${note.note}, ${write.actorUserId}, ${write.now}
      FROM head
    )`)
  })
  write.audits.forEach((audit, index) => {
    members.push(sql`audit_${sql.raw(String(index))} AS (${auditEventCteMember(audit, sql`head`)})`)
  })
  const result = await db.execute<{ id: string }>(sql`
    WITH ${sql.join(members, sql`, `)}
    SELECT id FROM head
  `)
  return result.rows.length === 1
}

/**
 * Withdraws one open revision request, as one statement.
 *
 * The head is bumped only while the request is still open, under the same
 * guards as an action, and the request is cancelled only from that update's
 * row — so a withdrawal racing an action or a resubmission writes nothing, and
 * the head never moves without the cancellation it exists for. When it was the last open request,
 * `flags` no longer holds the editing flag, and the file is the office's again.
 */
export const writeRevisionWithdrawal = async (
  db: Database,
  write: {
    file: Pick<StageFile, 'id' | 'statusVersion' | 'currentStageKey' | 'latestSubmissionId' | 'latestApplicationVersion'>
    revisionRequestId: string
    stageKey: string
    reason: string
    flags: readonly string[]
    actorUserId: string
    now: Date
    audit: AuditEventRecord
  },
): Promise<boolean> => {
  const result = await db.execute<{ id: string }>(sql`
    WITH head AS (
      UPDATE ${sebApplication} SET
        status_version = ${write.file.statusVersion + 1}::int,
        status_changed_at = ${write.now},
        updated_at = ${write.now},
        status_flags = ${textArray(write.flags)}
      WHERE id = ${write.file.id}
        AND status_version = ${write.file.statusVersion}::int
        AND status = 'IN_PIPELINE'
        AND deleted_at IS NULL
        AND current_stage_key = ${write.file.currentStageKey}
        AND EXISTS (
          SELECT 1 FROM ${sebRevisionRequest} AS still_open
          WHERE still_open.id = ${write.revisionRequestId}
            AND still_open.application_id = ${write.file.id}
            AND still_open.resolved_at IS NULL
            AND still_open.cancelled_at IS NULL
        )
      RETURNING id
    ),
    cancelled AS (
      UPDATE ${sebRevisionRequest} SET
        cancelled_at = ${write.now},
        cancelled_by_user_id = ${write.actorUserId},
        cancellation_reason = ${write.reason}
      FROM head
      WHERE ${sebRevisionRequest}.id = ${write.revisionRequestId}
        AND ${sebRevisionRequest}.application_id = head.id
        AND ${sebRevisionRequest}.resolved_at IS NULL
        AND ${sebRevisionRequest}.cancelled_at IS NULL
      RETURNING ${sebRevisionRequest}.id
    ),
    cancel_event AS (
      INSERT INTO ${sebApplicationEvent} (
        id, application_id, event_type, actor_user_id, application_version,
        submission_id, revision_request_id, from_status, to_status, stage_key,
        message, metadata_json, created_at, stage_action_id
      )
      SELECT ${crypto.randomUUID()}, head.id, 'REVISION_CANCELLED', ${write.actorUserId},
        ${write.file.latestApplicationVersion}::int, ${write.file.latestSubmissionId}, cancelled.id,
        'IN_PIPELINE', 'IN_PIPELINE', ${write.stageKey},
        'A correction the office asked for is no longer needed.', NULL, ${write.now}, NULL
      FROM head CROSS JOIN cancelled
    ),
    audit AS (${auditEventCteMember(write.audit, sql`head CROSS JOIN cancelled`)})
    SELECT head.id FROM head CROSS JOIN cancelled
  `)
  return result.rows.length === 1
}
