/**
 * Queries behind one application's workspace.
 *
 * The workspace itself is a single call: the API assembles submissions,
 * documents, revisions, assignments, notes and reviews together, so the screen
 * shows one moment rather than a dozen queries' worth of slightly different
 * ones.
 *
 * Reason categories are the exception, and they cost two extra requests. Every
 * write that needs a reason — releasing a claim, reassigning, requesting a
 * correction — names a category defined by the *programme cycle*, but the
 * workspace reports its cycle by code rather than by id. So the cycle list is
 * searched for that code and the cycle then read for its reasons. Both are
 * cached for a long time because a cycle's reason catalogue does not change
 * during a working day.
 *
 * Recorded as a gap: `AdminWorkspace` exposing `programmeCycleId` would remove
 * both requests.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  AdminCycleByIdDocument,
  AdminCyclesDocument,
  IntakeWorkspaceDocument,
} from '#/graphql/generated/operations'
import type { ProgrammeReasonContext } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const workspaceQuery = (applicationId: string) =>
  queryOptions({
    queryKey: ['workspace', applicationId],
    queryFn: async () => {
      const data = await gql(IntakeWorkspaceDocument, { applicationId })
      return unwrap(data.admin.intake.workspace)
    },
    // Never served stale: another reviewer may have claimed it a moment ago,
    // and every write here is checked against a version read from this data.
    staleTime: 0,
  })

/**
 * The reason catalogue of the cycle with this code.
 *
 * Returns an empty list rather than throwing when the cycle cannot be found:
 * the forms that use it already refuse to submit without a reason, and a
 * workspace should not fail to render because a catalogue is missing.
 */
export const cycleReasonsQuery = (cycleCode: string | null | undefined) =>
  queryOptions({
    queryKey: ['cycle-reasons', cycleCode ?? null],
    queryFn: async () => {
      const cycles = await gql(AdminCyclesDocument, {
        first: 100,
        after: null,
        includeDeleted: true,
      })
      const cycle = unwrap(cycles.admin.programmeCycle.list).nodes.find(
        (node) => node.cycleCode === cycleCode,
      )
      if (!cycle) return []
      const data = await gql(AdminCycleByIdDocument, { id: cycle.id })
      return unwrap(data.admin.programmeCycle.byId).reasons
    },
    enabled: Boolean(cycleCode),
    staleTime: 5 * 60_000,
  })

export type ReasonCategory = {
  id: string
  context: ProgrammeReasonContext
  code: string
  label: string
  applicantMessageTemplate?: string | null
}

/** The reasons defined for one situation, which is all a form ever offers. */
export const reasonsFor = (
  reasons: ReasonCategory[] | undefined,
  context: ProgrammeReasonContext,
): ReasonCategory[] => (reasons ?? []).filter((reason) => reason.context === context)
