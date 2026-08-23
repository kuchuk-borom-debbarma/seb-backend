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
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export type MeetingWorkspace = NonNullable<
  TtmMeetingQuery['admin']['decision']['meetingById']['response']
>

export const meetingsQuery = queryOptions({
  queryKey: ['meetings'],
  queryFn: async () => {
    const data = await gql(TtmMeetingsDocument, undefined)
    return unwrap(data.admin.decision.meetings).meetings
  },
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
