/**
 * Queries shared by the applicant application screens.
 *
 * The status guide is here because more than one screen needs it and it barely
 * changes — holding it in one place with a long stale time means opening an
 * application does not refetch a catalogue the client already has.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  ProgrammeCyclesDocument,
  StatusGuideDocument,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

/**
 * The plain-language catalogue for every application status.
 *
 * Returns an empty list rather than throwing when the account may not read it.
 * The catalogue lives on the applicant surface, which the whole `seb` namespace
 * guards with one authentication rule, so an administrator is refused — and a
 * refusal here is an answer about this account, not a broken page. Callers show
 * what they know and leave out what they cannot see.
 */
export const statusGuideQuery = queryOptions({
  queryKey: ['status-guide'],
  queryFn: async () => {
    const data = await gql(StatusGuideDocument)
    return data.seb.application.statusGuide.response?.statuses ?? []
  },
  // A fixed catalogue that only changes when the workflow itself does.
  staleTime: 60 * 60 * 1000,
})

export const cyclesQuery = queryOptions({
  queryKey: ['cycles'],
  queryFn: async () => {
    const data = await gql(ProgrammeCyclesDocument)
    return {
      // The only list a "start application" action may be offered from.
      available: unwrap(data.seb.application.availableProgrammeCycles).cycles,
      // Everything this applicant has work in, so closed cycles stay readable.
      mine: unwrap(data.seb.application.myProgrammeCycles).cycles,
    }
  },
  staleTime: 5 * 60 * 1000,
})
