/**
 * Queries behind the intake console.
 *
 * Staleness is chosen per query rather than globally. Queue counts move as
 * colleagues work, so they are refreshed often; a queue page is held long
 * enough that stepping into an application and back does not refetch, which is
 * the single most common movement in this part of the product.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  IntakeByReferenceDocument,
  IntakeQueueDocument,
  IntakeQueuesDocument,
} from '#/graphql/generated/operations'
import type { AdminIntakeQueueInput } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const QUEUE_PAGE_SIZE = 20

export const queueSummaryQuery = (cycleId?: string) =>
  queryOptions({
    queryKey: ['intake-queues', cycleId ?? null],
    queryFn: async () => {
      const data = await gql(IntakeQueuesDocument, { cycleId: cycleId ?? null })
      return unwrap(data.admin.intake.queues).queues
    },
    staleTime: 15_000,
  })

/**
 * One page of a queue.
 *
 * The key is the whole filter set, so moving back to a page already seen is
 * served from cache. `placeholderData` keeps the previous page on screen while
 * the next one loads, which stops the table collapsing to nothing and back on
 * every click of "Next".
 */
export const queueQuery = (input: AdminIntakeQueueInput) =>
  queryOptions({
    queryKey: ['intake-queue', input],
    queryFn: async () => {
      const data = await gql(IntakeQueueDocument, { input })
      return unwrap(data.admin.intake.queue)
    },
    placeholderData: (previous) => previous,
    staleTime: 10_000,
  })

/**
 * An application by the reference number an applicant quotes.
 *
 * Exact match, and a miss is an ordinary answer rather than an error — the
 * number may simply be wrong — so the caller reads the message.
 */
export const byReferenceQuery = (referenceNumber: string) =>
  queryOptions({
    queryKey: ['intake-by-reference', referenceNumber],
    queryFn: async () => {
      const data = await gql(IntakeByReferenceDocument, { referenceNumber })
      return data.admin.intake.byReference
    },
    enabled: referenceNumber.length > 0,
  })
