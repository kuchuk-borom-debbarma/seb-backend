/**
 * Pipelines: the configurable route an application takes after it is
 * submitted.
 *
 * A pipeline's shape — its stages, their actions, the inputs and effects of
 * each action, its status flags and recorded values — is one **frozen JSONB
 * document** per version, validated against `services/catalogue/workflow.json`
 * whenever it is saved, published or loaded. Only what other rows must
 * *reference* is materialised as rows: a pipeline's stages, because an
 * application's current stage, the history of its actions and the roles that
 * own a stage all point at one. Everything else in the document is referenced by
 * nothing, and restating it as rows would add a join to every read without
 * adding an integrity guarantee.
 *
 * A published version never changes; every write predicate names
 * `status = 'DRAFT'`. A cycle pins the published version it opened with, and an
 * application pins its cycle's, so editing a pipeline never re-routes a file
 * already being worked.
 *
 * Who owns a stage is **not** versioned: it is authority, not shape, and a
 * programme office adding a second bank officer's role must not have to publish
 * a new pipeline to do it. Ownership is kept as retained history, like grants.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreRole } from '../core/access'
import { coreUser } from '../core/auth'
import { instant, TEMPLATE_KEY_PATTERN } from '../shared'

export const pipelineVersionStatuses = ['DRAFT', 'PUBLISHED'] as const

const keyPattern = sql.raw(`'${TEMPLATE_KEY_PATTERN}'`)

/** A pipeline's identity. Its shape lives in its versions. */
export const sebPipeline = pgTable(
  'seb_pipeline',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** The version a cycle may pin today; null until the first publish. */
    currentPublishedVersion: integer('current_published_version'),
    createdAt: instant('created_at').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    updatedAt: instant('updated_at').notNull(),
    retiredAt: instant('retired_at'),
    retiredByUserId: text('retired_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    retireReason: text('retire_reason'),
  },
  (table) => [
    unique('seb_pipeline_key_uq').on(table.key),
    check('seb_pipeline_key_check', sql`${table.key} ~ ${keyPattern}`),
    check(
      'seb_pipeline_name_check',
      sql`char_length(${table.name}) BETWEEN 1 AND 120`,
    ),
    check(
      'seb_pipeline_description_check',
      sql`char_length(${table.description}) <= 1000`,
    ),
    check(
      'seb_pipeline_published_version_check',
      sql`${table.currentPublishedVersion} IS NULL OR ${table.currentPublishedVersion} >= 1`,
    ),
    // Retired together or not at all: a retirement nobody can attribute, or one
    // with no time, would be a record that cannot answer the question it exists
    // for.
    check(
      'seb_pipeline_retire_group_check',
      sql`(${table.retiredAt} IS NULL AND ${table.retiredByUserId} IS NULL AND ${table.retireReason} IS NULL)
        OR (${table.retiredAt} IS NOT NULL AND ${table.retiredByUserId} IS NOT NULL AND ${table.retireReason} IS NOT NULL)`,
    ),
  ],
)

/**
 * One version of a pipeline's shape.
 *
 * At most one draft per pipeline, edited as a whole and guarded by `revision`,
 * so two authors cannot interleave half-edits into a state neither chose — the
 * same argument `updateRole` makes about a role's permissions.
 */
export const sebPipelineVersion = pgTable(
  'seb_pipeline_version',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => sebPipeline.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status', { enum: pipelineVersionStatuses }).notNull(),
    definition: jsonb('definition').notNull(),
    /** Which shape of document `definition` is; a future schema is a new number. */
    definitionSchema: smallint('definition_schema').notNull().default(1),
    revision: integer('revision').notNull().default(1),
    createdAt: instant('created_at').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    updatedAt: instant('updated_at').notNull(),
    publishedAt: instant('published_at'),
    publishedByUserId: text('published_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    changeNote: text('change_note'),
  },
  (table) => [
    // A constraint rather than an index: composite foreign keys target it.
    unique('seb_pipeline_version_uq').on(table.pipelineId, table.version),
    uniqueIndex('seb_pipeline_version_one_draft_uq')
      .on(table.pipelineId)
      .where(sql`${table.status} = 'DRAFT'`),
    check('seb_pipeline_version_version_check', sql`${table.version} >= 1`),
    check('seb_pipeline_version_revision_check', sql`${table.revision} >= 1`),
    check('seb_pipeline_version_status_check', sql`${table.status} IN ('DRAFT', 'PUBLISHED')`),
    check('seb_pipeline_version_schema_check', sql`${table.definitionSchema} = 1`),
    check(
      'seb_pipeline_version_definition_check',
      sql`jsonb_typeof(${table.definition}) = 'object' AND octet_length(${table.definition}::text) <= 262144`,
    ),
    check(
      'seb_pipeline_version_note_check',
      sql`${table.changeNote} IS NULL OR char_length(${table.changeNote}) <= 500`,
    ),
    // A draft has not been published by anybody; a published version always
    // says who published it and when.
    check(
      'seb_pipeline_version_publish_group_check',
      sql`(${table.status} = 'DRAFT' AND ${table.publishedAt} IS NULL AND ${table.publishedByUserId} IS NULL)
        OR (${table.status} = 'PUBLISHED' AND ${table.publishedAt} IS NOT NULL AND ${table.publishedByUserId} IS NOT NULL)`,
    ),
  ],
)

/**
 * A stage's identity across every version of its pipeline — what owners
 * attach to.
 *
 * Created the first time a saved draft names the key, so owners can be set
 * before publishing and a stage has somebody working it from the moment a cycle
 * opens on it. `owners_version` guards the owner list the way `revision` guards
 * a draft.
 */
export const sebPipelineStage = pgTable(
  'seb_pipeline_stage',
  {
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => sebPipeline.id, { onDelete: 'restrict' }),
    stageKey: text('stage_key').notNull(),
    ownersVersion: integer('owners_version').notNull().default(0),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    primaryKey({ name: 'seb_pipeline_stage_pk', columns: [table.pipelineId, table.stageKey] }),
    check('seb_pipeline_stage_key_check', sql`${table.stageKey} ~ ${keyPattern}`),
    check('seb_pipeline_stage_owners_version_check', sql`${table.ownersVersion} >= 0`),
  ],
)

/**
 * Which roles work a stage, with the history of who changed it.
 *
 * Closed rather than deleted, like a grant, so "who could act on this stage
 * last March" stays answerable.
 */
export const sebPipelineStageOwner = pgTable(
  'seb_pipeline_stage_owner',
  {
    id: text('id').primaryKey(),
    pipelineId: text('pipeline_id').notNull(),
    stageKey: text('stage_key').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => coreRole.id, { onDelete: 'restrict' }),
    addedAt: instant('added_at').notNull(),
    addedByUserId: text('added_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    removedAt: instant('removed_at'),
    removedByUserId: text('removed_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    removalReason: text('removal_reason'),
  },
  (table) => [
    foreignKey({
      columns: [table.pipelineId, table.stageKey],
      foreignColumns: [sebPipelineStage.pipelineId, sebPipelineStage.stageKey],
      name: 'seb_pipeline_stage_owner_stage_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_pipeline_stage_owner_live_uq')
      .on(table.pipelineId, table.stageKey, table.roleId)
      .where(sql`${table.removedAt} IS NULL`),
    // The session query probes this for every request's owned stages.
    index('seb_pipeline_stage_owner_role_idx')
      .on(table.roleId)
      .where(sql`${table.removedAt} IS NULL`),
    check(
      'seb_pipeline_stage_owner_removal_check',
      sql`(${table.removedAt} IS NULL AND ${table.removedByUserId} IS NULL AND ${table.removalReason} IS NULL)
        OR (${table.removedAt} IS NOT NULL AND ${table.removedByUserId} IS NOT NULL AND ${table.removalReason} IS NOT NULL
            AND ${table.removedAt} >= ${table.addedAt})`,
    ),
  ],
)

/**
 * The stages of one published version, materialised from its document when it
 * is published, so an application's stage and its action history can be foreign
 * keys rather than strings nothing checks.
 */
export const sebPipelineVersionStage = pgTable(
  'seb_pipeline_version_stage',
  {
    pipelineId: text('pipeline_id').notNull(),
    version: integer('version').notNull(),
    stageKey: text('stage_key').notNull(),
    position: integer('position').notNull(),
    isInitial: boolean('is_initial').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'seb_pipeline_version_stage_pk',
      columns: [table.pipelineId, table.version, table.stageKey],
    }),
    foreignKey({
      columns: [table.pipelineId, table.version],
      foreignColumns: [sebPipelineVersion.pipelineId, sebPipelineVersion.version],
      name: 'seb_pipeline_version_stage_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.pipelineId, table.stageKey],
      foreignColumns: [sebPipelineStage.pipelineId, sebPipelineStage.stageKey],
      name: 'seb_pipeline_version_stage_stage_fk',
    }).onDelete('restrict'),
    // Exactly one place a submitted application enters.
    uniqueIndex('seb_pipeline_version_stage_initial_uq')
      .on(table.pipelineId, table.version)
      .where(sql`${table.isInitial}`),
    check('seb_pipeline_version_stage_position_check', sql`${table.position} >= 0`),
  ],
)
