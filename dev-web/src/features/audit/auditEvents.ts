/**
 * One page of the activity history, as a query.
 *
 * Its own module because the application workspace embeds a slice of the
 * history, and a screen that shows ten entries should not load the full view's
 * filters, dialogs and person lookup to do it — the workspace's bundle budget
 * is two kilobytes for this.
 */
import { queryOptions } from '@tanstack/react-query'
import { AuditEventsDocument } from '#/graphql/generated/operations'
import type { AuditFilterInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const auditEventsQuery = (input: {
  first: number
  after: string | null
  oldest: boolean
  filter: AuditFilterInput
}) =>
  queryOptions({
    queryKey: ['audit-events', input],
    queryFn: async () => {
      const data = await gql(AuditEventsDocument, {
        input: {
          first: input.first,
          after: input.after,
          order: input.oldest ? 'OLDEST_FIRST' : 'NEWEST_FIRST',
          filter: input.filter,
        },
      })
      return unwrap(data.audit.events)
    },
    // The previous page stays on screen while the next loads, marked busy,
    // rather than the table collapsing to "nothing matches" in between.
    placeholderData: (previous) => previous,
  })
