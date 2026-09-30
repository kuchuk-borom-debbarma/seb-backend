/**
 * Which submitted applications a member of staff may read, as SQL.
 *
 * Two ways in, and nothing else:
 *
 * - **Office-wide** — `application:read`. The programme office reads every
 *   submitted file, as it always has. Acting on one still needs the stage.
 * - **By stage** — `stage:read`. A bank officer reads the files at the stages
 *   their roles own, and keeps reading, read-only, every file they have acted
 *   on after it moves on. A State Bank of India officer therefore never sees a
 *   file routed to the Tripura Gramin Bank, although both hold identical
 *   permissions: ownership is the only thing that tells them apart.
 *
 * The scope is decided once from the session and then **repeated inside every
 * read's SQL**, never applied to rows after they come back. A filter applied
 * in code is a filter one forgotten call site away from not applying, and a
 * count taken before it would leak how many files exist that the reader cannot
 * see.
 */
import { and, eq, or, sql, type SQL } from 'drizzle-orm'
import { sebApplication, sebApplicationStageAction } from '../../../db/schema'
import { holdsPermission, type Authority } from '../../auth/permissions'

export type ReadScope =
  | { readonly kind: 'OFFICE' }
  | {
      readonly kind: 'STAGES'
      readonly userId: string
      readonly owned: readonly { readonly pipelineId: string; readonly stageKey: string }[]
    }

/** The stage ids a session carries, `pipelineId/stageKey`, as pairs. */
export const ownedStagePairs = (owned: ReadonlySet<string>) =>
  [...owned].map((entry) => {
    // The stage key cannot contain a slash (it is a template key), so the last
    // one separates it whatever the pipeline id holds.
    const split = entry.lastIndexOf('/')
    return { pipelineId: entry.slice(0, split), stageKey: entry.slice(split + 1) }
  })

/**
 * What a session may read, or null when it may read no submitted file at all.
 *
 * A super administrator holds `application:read` through the wildcard, so they
 * read office-wide without a special case here.
 */
export const readScopeOf = (
  session: Pick<Authority, 'permissions' | 'ownedStages'> & { user: { id: string } },
): ReadScope | null => {
  if (holdsPermission(session, 'application', 'read')) return { kind: 'OFFICE' }
  if (holdsPermission(session, 'stage', 'read')) {
    return { kind: 'STAGES', userId: session.user.id, owned: ownedStagePairs(session.ownedStages) }
  }
  return null
}

/**
 * The scope as a predicate on `seb_application`, or nothing for office-wide.
 *
 * One `(pipeline_id, current_stage_key)` equality per owned stage, OR-ed, so
 * each arm is a seek on the stage-queue index rather than a string built from
 * two columns that no index can answer. "Files I acted on" probes the
 * stage-action actor index.
 */
export const readScopeFilter = (scope: ReadScope): SQL | undefined => {
  if (scope.kind === 'OFFICE') return undefined
  return or(
    ...scope.owned.map((stage) =>
      and(eq(sebApplication.pipelineId, stage.pipelineId), eq(sebApplication.currentStageKey, stage.stageKey)),
    ),
    sql`EXISTS (
      SELECT 1 FROM ${sebApplicationStageAction}
      WHERE ${sebApplicationStageAction.actorUserId} = ${scope.userId}
        AND ${sebApplicationStageAction.applicationId} = ${sebApplication.id}
    )`,
  )
}
