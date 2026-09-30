/**
 * Persistence for authoring pipelines: their identity, their versions and who
 * works each stage.
 *
 * ## Every write is one statement
 *
 * Each write below is a single data-modifying `WITH`: a guarded head member
 * first, then every dependent row — the stage identities, the published stage
 * list, the audit row — selected **from that member's returned rows**. A losing
 * writer's guard returns nothing, so its dependents insert nothing, and the
 * whole write is one round trip that either landed or did not. That is the
 * batch-with-predicates rule the rest of the repository uses, expressed as a
 * join instead of a `WHERE EXISTS` — and it spares the four extra round trips a
 * `batch` would spend on `BEGIN`, `COMMIT` and a statement per dependent.
 *
 * ## A published version never changes
 *
 * Every write to `seb_pipeline_version` names `status = 'DRAFT'` in its
 * predicate. Publishing is the last write a version ever receives, so a cycle
 * pinned to it, and every application pinned to that cycle, reads the same
 * document for ever.
 *
 * ## Parameters that are lists travel as JSON
 *
 * drizzle renders a JavaScript array as a parenthesised list of parameters,
 * which is `()` — a syntax error — when the list is empty, and an empty list is
 * an ordinary case here (a stage losing its last owner). So lists are passed
 * as one `jsonb` parameter and unpacked in SQL.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreRole,
  sebPipeline,
  sebPipelineStage,
  sebPipelineStageOwner,
  sebPipelineVersion,
  sebPipelineVersionStage,
} from '../../../db/schema'
import { auditEventCteMember, type AuditEventRecord } from '../../audit-event'

export type PipelineHead = typeof sebPipeline.$inferSelect

/** One version as a list shows it: everything but the document. */
export type PipelineVersionSummary = {
  id: string
  version: number
  status: 'DRAFT' | 'PUBLISHED'
  revision: number
  createdAt: Date
  createdByUserId: string
  updatedAt: Date
  publishedAt: Date | null
  publishedByUserId: string | null
  changeNote: string | null
}

/** A version with its document, which only the draft and a publish read need. */
export type PipelineVersionRecord = PipelineVersionSummary & { definition: unknown }

/** A stage's identity and the roles that work it now. */
export type PipelineStageRecord = {
  stageKey: string
  ownersVersion: number
  owners: { roleId: string; roleKey: string; roleName: string; addedAt: Date }[]
}

const summaryColumns = {
  id: sebPipelineVersion.id,
  version: sebPipelineVersion.version,
  status: sebPipelineVersion.status,
  revision: sebPipelineVersion.revision,
  createdAt: sebPipelineVersion.createdAt,
  createdByUserId: sebPipelineVersion.createdByUserId,
  updatedAt: sebPipelineVersion.updatedAt,
  publishedAt: sebPipelineVersion.publishedAt,
  publishedByUserId: sebPipelineVersion.publishedByUserId,
  changeNote: sebPipelineVersion.changeNote,
}

/* ------------------------------------------------------------------ reads */

/**
 * Every pipeline, by name, with the number of its draft if it has one.
 *
 * The draft is a correlated probe of `seb_pipeline_version_one_draft_uq`, one
 * seek per pipeline; a programme runs a handful of pipelines, so there is no
 * page here.
 */
export const listPipelines = (db: Database) =>
  db
    .select({
      head: sebPipeline,
      /*
       * The outer column is written out in full. drizzle renders a column of
       * the query's only table unqualified, so `${sebPipeline.id}` here read as
       * the version's own `id` and matched nothing: every list showed no draft.
       */
      draftVersion: sql<number | null>`(
        SELECT v.version FROM ${sebPipelineVersion} v
         WHERE v.pipeline_id = "seb_pipeline"."id" AND v.status = 'DRAFT')`,
    })
    .from(sebPipeline)
    .orderBy(asc(sebPipeline.name), asc(sebPipeline.id))

export const findPipelineByKey = async (db: Database, key: string): Promise<PipelineHead | null> => {
  const [row] = await db.select().from(sebPipeline).where(eq(sebPipeline.key, key)).limit(1)
  return row ?? null
}

export const findPipelineById = async (db: Database, id: string): Promise<PipelineHead | null> => {
  const [row] = await db.select().from(sebPipeline).where(eq(sebPipeline.id, id)).limit(1)
  return row ?? null
}

/** A pipeline's versions, newest first, without their documents. */
export const listPipelineVersions = async (db: Database, pipelineId: string): Promise<PipelineVersionSummary[]> =>
  db
    .select(summaryColumns)
    .from(sebPipelineVersion)
    .where(eq(sebPipelineVersion.pipelineId, pipelineId))
    .orderBy(desc(sebPipelineVersion.version))

/** One version with its document, or null. */
export const findPipelineVersion = async (
  db: Database,
  pipelineId: string,
  version: number,
): Promise<PipelineVersionRecord | null> => {
  const [row] = await db
    .select({ ...summaryColumns, definition: sebPipelineVersion.definition })
    .from(sebPipelineVersion)
    .where(and(eq(sebPipelineVersion.pipelineId, pipelineId), eq(sebPipelineVersion.version, version)))
    .limit(1)
  return row ?? null
}

/** The draft, with its document, or null when there is none. */
export const findPipelineDraft = async (db: Database, pipelineId: string): Promise<PipelineVersionRecord | null> => {
  const [row] = await db
    .select({ ...summaryColumns, definition: sebPipelineVersion.definition })
    .from(sebPipelineVersion)
    .where(and(eq(sebPipelineVersion.pipelineId, pipelineId), eq(sebPipelineVersion.status, 'DRAFT')))
    .limit(1)
  return row ?? null
}

/**
 * Every stage identity of a pipeline with its live owners, in one statement.
 *
 * A left join rather than two reads, so a stage's `owners_version` and the
 * owner list it guards come from one snapshot: an editor that saw them apart
 * could quote a version against a list it never saw.
 */
export const listPipelineStages = async (db: Database, pipelineId: string): Promise<PipelineStageRecord[]> => {
  const rows = await db
    .select({
      stageKey: sebPipelineStage.stageKey,
      ownersVersion: sebPipelineStage.ownersVersion,
      roleId: sebPipelineStageOwner.roleId,
      roleKey: coreRole.key,
      roleName: coreRole.name,
      addedAt: sebPipelineStageOwner.addedAt,
    })
    .from(sebPipelineStage)
    .leftJoin(
      sebPipelineStageOwner,
      and(
        eq(sebPipelineStageOwner.pipelineId, sebPipelineStage.pipelineId),
        eq(sebPipelineStageOwner.stageKey, sebPipelineStage.stageKey),
        isNull(sebPipelineStageOwner.removedAt),
      ),
    )
    .leftJoin(coreRole, eq(coreRole.id, sebPipelineStageOwner.roleId))
    .where(eq(sebPipelineStage.pipelineId, pipelineId))
    .orderBy(asc(sebPipelineStage.stageKey), asc(coreRole.name))
  const stages = new Map<string, PipelineStageRecord>()
  for (const row of rows) {
    const stage = stages.get(row.stageKey) ?? { stageKey: row.stageKey, ownersVersion: row.ownersVersion, owners: [] }
    stages.set(row.stageKey, stage)
    if (row.roleId !== null && row.roleKey !== null && row.roleName !== null && row.addedAt !== null) {
      stage.owners.push({ roleId: row.roleId, roleKey: row.roleKey, roleName: row.roleName, addedAt: row.addedAt })
    }
  }
  return [...stages.values()]
}

/** One stage with its live owners, or null when the pipeline never named it. */
export const findPipelineStage = async (
  db: Database,
  pipelineId: string,
  stageKey: string,
): Promise<PipelineStageRecord | null> =>
  (await listPipelineStages(db, pipelineId)).find((stage) => stage.stageKey === stageKey) ?? null

/**
 * The pipelines a cycle may choose: published at least once and not retired.
 * What the cycle editor's picker lists, so it cannot offer a refusal.
 */
export const listPublishedChoices = (db: Database) =>
  db
    .select()
    .from(sebPipeline)
    .where(and(isNotNull(sebPipeline.currentPublishedVersion), isNull(sebPipeline.retiredAt)))
    .orderBy(asc(sebPipeline.name), asc(sebPipeline.id))

/* ----------------------------------------------------------------- writes */

/** Whether the statement's guarded member returned exactly one row. */
const landed = (result: { rows: unknown[] }): boolean => result.rows.length === 1

/**
 * Stage identities for every key a document names, from a guarded member.
 *
 * Created as soon as a draft names a stage, so owners can be set before the
 * first publish and a cycle opening on the pipeline finds somebody working its
 * first stage. `ON CONFLICT DO NOTHING` because most saves name stages that
 * already exist; a stage dropped from a later draft keeps its identity and its
 * owner history.
 */
const ensureStages = (source: string, stageKeysJson: string, now: Date) => sql`
  INSERT INTO ${sebPipelineStage} (pipeline_id, stage_key, owners_version, created_at)
  SELECT ${sql.raw(source)}.pipeline_id, named.stage_key, 0, ${now}
  FROM ${sql.raw(source)}, jsonb_array_elements_text(${stageKeysJson}::jsonb) AS named(stage_key)
  ON CONFLICT DO NOTHING
`

/**
 * Creates a pipeline with its first draft.
 *
 * `ON CONFLICT DO NOTHING` on the key: the unique constraint is the authority
 * on a duplicate, and a taken key returns no row rather than an error.
 */
export const createPipelineWrite = async (
  db: Database,
  input: {
    id: string
    key: string
    name: string
    description: string
    draftId: string
    definitionJson: string
    stageKeysJson: string
    actorUserId: string
    now: Date
    audit: AuditEventRecord
  },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH created AS (
      INSERT INTO ${sebPipeline} (id, key, name, description, current_published_version,
        created_at, created_by_user_id, updated_at, retired_at, retired_by_user_id, retire_reason)
      VALUES (${input.id}, ${input.key}, ${input.name}, ${input.description}, NULL,
        ${input.now}, ${input.actorUserId}, ${input.now}, NULL, NULL, NULL)
      ON CONFLICT DO NOTHING
      RETURNING id AS pipeline_id
    ),
    drafted AS (
      INSERT INTO ${sebPipelineVersion} (id, pipeline_id, version, status, definition, definition_schema,
        revision, created_at, created_by_user_id, updated_at, published_at, published_by_user_id, change_note)
      SELECT ${input.draftId}, created.pipeline_id, 1, 'DRAFT', ${input.definitionJson}::jsonb, 1,
        1, ${input.now}, ${input.actorUserId}, ${input.now}, NULL, NULL, NULL
      FROM created
    ),
    stages AS (${ensureStages('created', input.stageKeysJson, input.now)}),
    recorded AS (${auditEventCteMember(input.audit, sql`created`)})
    SELECT pipeline_id FROM created
  `))

/**
 * Starts the next draft of a pipeline that has none.
 *
 * `version` is computed by the caller from the versions it read, and the
 * statement proves it is still the next one: the unique `(pipeline_id,
 * version)` and the one-draft index both refuse a racing start, and `ON
 * CONFLICT DO NOTHING` turns either refusal into "no row" — the stale answer.
 */
export const startPipelineDraftWrite = async (
  db: Database,
  input: {
    pipelineId: string
    draftId: string
    version: number
    definitionJson: string
    stageKeysJson: string
    actorUserId: string
    now: Date
    audit: AuditEventRecord
  },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH started AS (
      INSERT INTO ${sebPipelineVersion} (id, pipeline_id, version, status, definition, definition_schema,
        revision, created_at, created_by_user_id, updated_at, published_at, published_by_user_id, change_note)
      SELECT ${input.draftId}, p.id, ${input.version}, 'DRAFT', ${input.definitionJson}::jsonb, 1,
        1, ${input.now}, ${input.actorUserId}, ${input.now}, NULL, NULL, NULL
      FROM ${sebPipeline} p
      WHERE p.id = ${input.pipelineId}
        AND p.retired_at IS NULL
        AND ${input.version} = 1 + COALESCE((
          SELECT max(v.version) FROM ${sebPipelineVersion} v WHERE v.pipeline_id = p.id), 0)
      ON CONFLICT DO NOTHING
      RETURNING pipeline_id
    ),
    touched AS (
      UPDATE ${sebPipeline} SET updated_at = ${input.now}
      FROM started WHERE ${sebPipeline}.id = started.pipeline_id
    ),
    stages AS (${ensureStages('started', input.stageKeysJson, input.now)}),
    recorded AS (${auditEventCteMember(input.audit, sql`started`)})
    SELECT pipeline_id FROM started
  `))

/**
 * Replaces a draft's document, guarded by the revision the author saw.
 *
 * The whole document at once, like a role's permission set: two authors
 * cannot interleave half-edits into a state neither chose, because the second
 * save quotes a revision that no longer exists.
 */
export const saveDraftWrite = async (
  db: Database,
  input: {
    pipelineId: string
    version: number
    expectedRevision: number
    definitionJson: string
    stageKeysJson: string
    now: Date
    audit: AuditEventRecord
  },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH saved AS (
      UPDATE ${sebPipelineVersion}
         SET definition = ${input.definitionJson}::jsonb,
             revision = revision + 1,
             updated_at = ${input.now}
       WHERE pipeline_id = ${input.pipelineId}
         AND version = ${input.version}
         AND status = 'DRAFT'
         AND revision = ${input.expectedRevision}
         -- A retired pipeline takes no further edits; it can only be read.
         AND EXISTS (SELECT 1 FROM ${sebPipeline} p WHERE p.id = ${input.pipelineId} AND p.retired_at IS NULL)
      RETURNING pipeline_id
    ),
    touched AS (
      UPDATE ${sebPipeline} SET updated_at = ${input.now}
      FROM saved WHERE ${sebPipeline}.id = saved.pipeline_id
    ),
    stages AS (${ensureStages('saved', input.stageKeysJson, input.now)}),
    recorded AS (${auditEventCteMember(input.audit, sql`saved`)})
    SELECT pipeline_id FROM saved
  `))

/**
 * Publishes the draft the author validated.
 *
 * The revision guard is what makes "validated" mean something: the caller ran
 * every check against the document at `expectedRevision`, and a save landing in
 * between moves the revision, so this publishes nothing rather than a document
 * nobody checked.
 *
 * The stage list is materialised from the stored document itself, in the
 * author's order, so the foreign-key targets an application's stage points at
 * are exactly the stages of the version it is pinned to.
 */
export const publishDraftWrite = async (
  db: Database,
  input: {
    pipelineId: string
    version: number
    expectedRevision: number
    actorUserId: string
    changeNote: string | null
    stageKeysJson: string
    now: Date
    audit: AuditEventRecord
  },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH published AS (
      UPDATE ${sebPipelineVersion}
         SET status = 'PUBLISHED',
             published_at = ${input.now},
             published_by_user_id = ${input.actorUserId},
             change_note = ${input.changeNote},
             updated_at = ${input.now}
       WHERE pipeline_id = ${input.pipelineId}
         AND version = ${input.version}
         AND status = 'DRAFT'
         AND revision = ${input.expectedRevision}
         AND EXISTS (SELECT 1 FROM ${sebPipeline} p WHERE p.id = ${input.pipelineId} AND p.retired_at IS NULL)
      RETURNING pipeline_id, version, definition
    ),
    -- Every save already created these; restated so a publish never depends
    -- on how its draft was written.
    stages AS (${ensureStages('published', input.stageKeysJson, input.now)}),
    materialised AS (
      INSERT INTO ${sebPipelineVersionStage} (pipeline_id, version, stage_key, position, is_initial)
      SELECT published.pipeline_id, published.version, listed.stage ->> 'key', (listed.position - 1)::int, (listed.stage ->> 'key') = (published.definition ->> 'initialStageKey')
      FROM published, jsonb_array_elements(published.definition -> 'stages') WITH ORDINALITY AS listed(stage, position)
    ),
    head AS (
      UPDATE ${sebPipeline}
         SET current_published_version = published.version, updated_at = ${input.now}
        FROM published WHERE ${sebPipeline}.id = published.pipeline_id
    ),
    recorded AS (${auditEventCteMember(input.audit, sql`published`)})
    SELECT pipeline_id FROM published
  `))

/** Throws away the draft, guarded by the revision the author saw. */
export const discardDraftWrite = async (
  db: Database,
  input: { pipelineId: string; version: number; expectedRevision: number; now: Date; audit: AuditEventRecord },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH discarded AS (
      DELETE FROM ${sebPipelineVersion}
       WHERE pipeline_id = ${input.pipelineId}
         AND version = ${input.version}
         AND status = 'DRAFT'
         AND revision = ${input.expectedRevision}
      RETURNING pipeline_id
    ),
    touched AS (
      UPDATE ${sebPipeline} SET updated_at = ${input.now}
      FROM discarded WHERE ${sebPipeline}.id = discarded.pipeline_id
    ),
    recorded AS (${auditEventCteMember(input.audit, sql`discarded`)})
    SELECT pipeline_id FROM discarded
  `))

/**
 * Retires a pipeline: no new cycle may choose it and no draft may change.
 * Cycles already pinned to it keep working their files — that is the point of
 * the pin.
 */
export const retirePipelineWrite = async (
  db: Database,
  input: { pipelineId: string; actorUserId: string; reason: string; now: Date; audit: AuditEventRecord },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH retired AS (
      UPDATE ${sebPipeline}
         SET retired_at = ${input.now},
             retired_by_user_id = ${input.actorUserId},
             retire_reason = ${input.reason},
             updated_at = ${input.now}
       WHERE id = ${input.pipelineId} AND retired_at IS NULL
      RETURNING id AS pipeline_id
    ),
    recorded AS (${auditEventCteMember(input.audit, sql`retired`)})
    SELECT pipeline_id FROM retired
  `))

/**
 * Replaces who works a stage, guarded by the owner list's version.
 *
 * The caller diffed the list it read against the list it was given; the guard
 * proves that read is still current. Owners are closed rather than deleted,
 * like grants, so "who could act on this stage last March" stays answerable.
 */
export const setStageOwnersWrite = async (
  db: Database,
  input: {
    pipelineId: string
    stageKey: string
    expectedOwnersVersion: number
    /** `[{ id, roleId }]` — the owner rows to open, ids minted by the caller. */
    addedJson: string
    /** `[roleId]` — the live owners to close. */
    removedJson: string
    actorUserId: string
    reason: string
    now: Date
    audit: AuditEventRecord
  },
): Promise<boolean> =>
  landed(await db.execute(sql`
    WITH bumped AS (
      UPDATE ${sebPipelineStage}
         SET owners_version = owners_version + 1
       WHERE pipeline_id = ${input.pipelineId}
         AND stage_key = ${input.stageKey}
         AND owners_version = ${input.expectedOwnersVersion}
      RETURNING pipeline_id, stage_key
    ),
    closed AS (
      UPDATE ${sebPipelineStageOwner} AS owner
         SET removed_at = ${input.now},
             removed_by_user_id = ${input.actorUserId},
             removal_reason = ${input.reason}
        FROM bumped
       WHERE owner.pipeline_id = bumped.pipeline_id
         AND owner.stage_key = bumped.stage_key
         AND owner.removed_at IS NULL
         AND owner.role_id IN (SELECT jsonb_array_elements_text(${input.removedJson}::jsonb))
    ),
    opened AS (
      INSERT INTO ${sebPipelineStageOwner} (id, pipeline_id, stage_key, role_id, added_at, added_by_user_id, removed_at, removed_by_user_id, removal_reason)
      SELECT added.id, bumped.pipeline_id, bumped.stage_key, added.role_id, ${input.now}, ${input.actorUserId}, NULL, NULL, NULL
      FROM bumped, jsonb_to_recordset(${input.addedJson}::jsonb) AS added(id text, role_id text)
    ),
    recorded AS (${auditEventCteMember(input.audit, sql`bumped`)})
    SELECT pipeline_id FROM bumped
  `))
