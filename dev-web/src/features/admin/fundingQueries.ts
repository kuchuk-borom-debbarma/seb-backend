/**
 * The funding workspace for one application.
 *
 * Everything about the money — the award, the ledger, the utilization
 * obligations each release creates, the assessments and any recovery case —
 * arrives together, because the API computes the balances and a screen that
 * fetched the parts separately could show two moments at once.
 *
 * Never served stale. These are the figures a payment is authorized against.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import {
  FundingByApplicationDocument,
  RecoveryCaseDocument,
} from '#/graphql/generated/operations'
import type { FundingByApplicationQuery } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'

export type FundingWorkspace = NonNullable<
  FundingByApplicationQuery['admin']['funding']['byApplication']['response']
>

/**
 * Refuses when nothing has been sanctioned, which is the ordinary state before
 * a committee approves, so the caller reads the message rather than unwrapping.
 */
export const fundingWorkspaceQuery = (applicationId: string) =>
  queryOptions({
    queryKey: ['funding', applicationId],
    queryFn: async () => {
      const data = await gql(FundingByApplicationDocument, { applicationId })
      return data.admin.funding.byApplication
    },
    staleTime: 0,
  })

/**
 * Writes a mutation's own answer into the cache instead of refetching it.
 *
 * Every funding mutation returns the whole workspace, already consistent with
 * the ledger version it just advanced. Refetching would spend a request to
 * learn what the response already said, and could race a colleague's write into
 * the gap.
 */
export const putFunding = (
  queryClient: QueryClient,
  applicationId: string,
  workspace: FundingWorkspace,
): void => {
  queryClient.setQueryData(fundingWorkspaceQuery(applicationId).queryKey, {
    success: true,
    message: null,
    response: workspace,
  })
}

/**
 * One recovery case: its entries and the balance the API keeps.
 *
 * Separate from the funding workspace because a case is opened rarely and read
 * only while it is open — fetching it with every funding screen would spend a
 * request on nothing for most awards.
 */
export const recoveryQuery = (recoveryCaseId: string) =>
  queryOptions({
    queryKey: ['recovery', recoveryCaseId],
    queryFn: async () => {
      const data = await gql(RecoveryCaseDocument, { recoveryCaseId })
      return data.admin.funding.recoveryById
    },
    staleTime: 0,
  })
