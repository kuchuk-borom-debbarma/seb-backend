/**
 * Committee meetings and their agendas.
 *
 * A meeting's workspace comes back whole from every mutation that touches it,
 * so the cache is written from the response rather than invalidated and
 * refetched — reordering an agenda of twenty items should not cost a round trip
 * per drag.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { TtmMeetingDocument, TtmMeetingsDocument } from '#/graphql/generated/operations'
import type { TtmMeetingQuery } from '#/graphql/generated/operations'
import type { TtmMeetingStatus } from '#/graphql/generated/schema'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export type MeetingWorkspace = NonNullable<
  TtmMeetingQuery['admin']['decision']['meetingById']['response']
>

export const MEETINGS_PAGE_SIZE = 20

/**
 * One page of committee meetings.
 *
 * Paged rather than exhaustive: a programme that runs for years accumulates
 * meetings, and a screen that fetched all of them would get slower every term.
 */
export const meetingsQuery = (
  input: { after?: string; status?: TtmMeetingStatus } = {},
) =>
  queryOptions({
    queryKey: ['meetings', input],
    queryFn: async () => {
      const data = await gql(TtmMeetingsDocument, {
        first: MEETINGS_PAGE_SIZE,
        after: input.after ?? null,
        status: input.status ?? null,
      })
      return unwrap(data.admin.decision.meetings)
    },
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  })

export const meetingQuery = (meetingId: string) =>
  queryOptions({
    queryKey: ['meeting', meetingId],
    queryFn: async () => {
      const data = await gql(TtmMeetingDocument, { meetingId })
      return unwrap(data.admin.decision.meetingById)
    },
    staleTime: 0,
  })

/** Writes a mutation's own answer into the cache instead of refetching it. */
export const putMeeting = (
  queryClient: QueryClient,
  meetingId: string,
  workspace: MeetingWorkspace,
): void => {
  queryClient.setQueryData(meetingQuery(meetingId).queryKey, workspace)
}
