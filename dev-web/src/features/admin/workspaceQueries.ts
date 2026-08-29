/**
 * Queries behind one application's workspace.
 *
 * The workspace is a single call: the API assembles submissions, documents,
 * revisions, assignments, notes, reviews — and the reason catalogue — together,
 * so the screen shows one moment rather than a dozen queries' worth of
 * slightly different ones.
 *
 * The reasons ride the workspace on purpose. Every write that needs one —
 * requesting a correction, cancelling a referral, recording a rejection —
 * is validated against the cycle *version this application is pinned to*, and
 * only the workspace read knows that version. A catalogue fetched from the
 * cycle's current version offered ids that stopped validating the moment the
 * cycle was revised.
 */
import { queryOptions } from '@tanstack/react-query'
import { IntakeWorkspaceDocument } from '#/graphql/generated/operations'
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
    // Never served stale: another officer may have acted on it a moment ago,
    // and every write here is checked against a version read from this data.
    staleTime: 0,
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
