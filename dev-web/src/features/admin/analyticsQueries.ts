/**
 * The analytics summary behind the office dashboard's reporting panel.
 *
 * One unfiltered summary: the panel reports the whole intake, and anybody who
 * wants a narrower cut has the queue's own filters one click away. Held a
 * little longer than the queue counts because aggregate shapes move slowly and
 * the panel repaints on every dashboard visit.
 */
import { queryOptions } from '@tanstack/react-query'
import { IntakeAnalyticsDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const analyticsSummaryQuery = queryOptions({
  queryKey: ['intake-analytics'],
  queryFn: async () => {
    const data = await gql(IntakeAnalyticsDocument, { input: {} })
    return unwrap(data.admin.analytics.summary)
  },
  staleTime: 30_000,
})
