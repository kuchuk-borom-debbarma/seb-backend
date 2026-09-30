/**
 * Queries behind one application's workspace.
 *
 * The workspace is a single call: the API assembles submissions, documents,
 * revisions, notes and the case history together, so the screen shows one
 * moment rather than a dozen queries' worth of slightly different ones.
 */
import { queryOptions } from '@tanstack/react-query'
import { IntakeWorkspaceDocument } from '#/graphql/generated/operations'
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
