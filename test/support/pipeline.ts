/**
 * The pipeline every fixture cycle is worked in.
 *
 * A cycle cannot be saved without naming a pipeline, nor opened unless that
 * pipeline has a published version to pin. Authoring one goes through
 * operations that belong to the next phase of the pipeline work, so until they
 * exist this seeds the finished state as rows: the parent's example definition
 * (`services/pipeline/example.ts`), published as version 1, with the stage
 * rows the application and stage-action foreign keys stand on.
 *
 * Idempotent, and seeded by `signIn` with the signed-in user as its author, so
 * no suite gains a user it did not create and every suite that can create a
 * cycle finds the pipeline already there.
 */
import { env } from './worker'
import { examplePipeline } from '../../src/services/pipeline/example'

export const TEST_PIPELINE_ID = 'fixture-pipeline'
const TEST_PIPELINE_KEY = 'FIXTURE_STANDARD'

/** The stage every fixture application enters on submission. */
export const TEST_INITIAL_STAGE = examplePipeline.initialStageKey

export const ensureTestPipeline = async (authorUserId: string): Promise<void> => {
  const now = Date.now()
  const stages = examplePipeline.stages.map((stage) => stage.key)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seb_pipeline (id, key, name, description, current_published_version,
         created_at, created_by_user_id, updated_at)
       VALUES (?, ?, 'Fixture pipeline', 'Seeded by the test suite.', NULL, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(TEST_PIPELINE_ID, TEST_PIPELINE_KEY, now, authorUserId, now),
    env.DB.prepare(
      `INSERT INTO seb_pipeline_version (id, pipeline_id, version, status, definition,
         created_at, created_by_user_id, updated_at, published_at, published_by_user_id)
       VALUES (?, ?, 1, 'PUBLISHED', ?::jsonb, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      `${TEST_PIPELINE_ID}-v1`, TEST_PIPELINE_ID, JSON.stringify(examplePipeline),
      now, authorUserId, now, now, authorUserId,
    ),
    ...stages.flatMap((stageKey, position) => [
      env.DB.prepare(
        `INSERT INTO seb_pipeline_stage (pipeline_id, stage_key, created_at)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(TEST_PIPELINE_ID, stageKey, now),
      env.DB.prepare(
        `INSERT INTO seb_pipeline_version_stage (pipeline_id, version, stage_key, position, is_initial)
         VALUES (?, 1, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(TEST_PIPELINE_ID, stageKey, position, stageKey === examplePipeline.initialStageKey),
    ]),
    env.DB.prepare(
      `UPDATE seb_pipeline SET current_published_version = 1
        WHERE id = ? AND current_published_version IS NULL`,
    ).bind(TEST_PIPELINE_ID),
  ])
}
