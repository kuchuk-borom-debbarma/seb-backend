/**
 * Queries for one application, shared by its overview, form and review screens.
 *
 * They live together so the three screens agree about staleness. An open draft
 * is never served stale — what is editable can change the moment a reviewer
 * issues or cancels a revision request — while the timeline only grows.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query'
import {
  ApplicationByIdDocument,
  ApplicationKindEligibilityDocument,
  MyEnterprisesDocument,
  ApplicationFormTemplateDocument,
  ApplicationTimelineDocument,
  DraftChangesDocument,
  SubmittedCopyDocument,
  ValidateApplicationDocument,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const applicationQuery = (id: string) =>
  queryOptions({
    queryKey: ['application', id],
    queryFn: async () => {
      const data = await gql(ApplicationByIdDocument, { id })
      return unwrap(data.seb.application.byId)
    },
    staleTime: 0,
  })

/**
 * The signed link to the PDF copy of the submitted application — the same
 * document the confirmation email attaches. Null until first submission. The
 * signature is minted per request, so a refetch simply mints a fresh link.
 */
export const submittedCopyQuery = (id: string) =>
  queryOptions({
    queryKey: ['submitted-copy', id],
    queryFn: async () => {
      const data = await gql(SubmittedCopyDocument, { applicationId: id })
      return data.seb.application.submittedCopy.response?.url ?? null
    },
  })

/**
 * The form this application is filled against.
 *
 * Cached hard, unlike the application beside it: the template is frozen with
 * the cycle version an application pins, so it cannot change while the
 * applicant is looking at it — and refetching it on every save would fetch
 * the same bytes back each time.
 */
export const formTemplateQuery = (id: string) =>
  queryOptions({
    queryKey: ['form-template', id],
    queryFn: async () => {
      const data = await gql(ApplicationFormTemplateDocument, { applicationId: id })
      return unwrap(data.seb.application.formTemplate)
    },
    staleTime: Infinity,
  })

export const timelineQuery = (id: string) =>
  queryOptions({
    queryKey: ['application-timeline', id],
    queryFn: async () => {
      const data = await gql(ApplicationTimelineDocument, {
        applicationId: id,
        first: 50,
      })
      return unwrap(data.seb.application.timeline).nodes
    },
  })

export const validationQuery = (id: string) =>
  queryOptions({
    queryKey: ['validation', id],
    queryFn: async () => {
      const data = await gql(ValidateApplicationDocument, { applicationId: id })
      return unwrap(data.seb.application.validate)
    },
    staleTime: 0,
  })

/**
 * What this draft changes relative to the last submission.
 *
 * Refuses when nothing has been submitted yet, which is a legitimate answer
 * rather than an error, so the caller reads the message instead of unwrapping.
 */
export const draftChangesQuery = (id: string) =>
  queryOptions({
    queryKey: ['draft-changes', id],
    queryFn: async () => {
      const data = await gql(DraftChangesDocument, { applicationId: id })
      return data.seb.application.draftChanges
    },
    staleTime: 0,
  })

/**
 * Loads an application and its validation report, both guaranteed fresh.
 *
 * `ensureQueryData` returns whatever is in the cache without revalidating, and
 * on these two screens that is wrong in a way that surfaces as a refusal: every
 * write carries the version this data reports, so arriving from the form with
 * a copy taken before the last save means the first save — or the
 * submission — is refused as stale, and the applicant is told to refresh a page
 * they just opened.
 *
 * Fetching costs one round of two parallel requests per navigation, which is
 * the right trade for the screen where an application is sent.
 */
export const loadApplication = (queryClient: QueryClient, id: string) =>
  Promise.all([
    queryClient.fetchQuery(applicationQuery(id)),
    queryClient.fetchQuery(validationQuery(id)),
    queryClient.fetchQuery(formTemplateQuery(id)),
  ])

/** The applicant's live enterprises: what can carry a new application. */
export const liveEnterprisesQuery = queryOptions({
  queryKey: ['enterprises', 'live'],
  queryFn: async () => {
    const data = await gql(MyEnterprisesDocument, {
      first: 100,
      after: null,
      includeDeleted: false,
    })
    return unwrap(data.seb.enterprise.mine).nodes
  },
  staleTime: 60_000,
})

/**
 * The kinds of application a cycle accepts, judged for one enterprise.
 *
 * Only asked once both are known, because the API needs both to answer: the
 * kinds are the cycle's, and whether each is open is the enterprise's history
 * read against that kind's rules. The application page reads it too, for the
 * kind's name.
 */
export const applicationKindsQuery = (enterpriseId: string, programmeCycleId: string) =>
  queryOptions({
    queryKey: ['application-kinds', enterpriseId, programmeCycleId],
    queryFn: async () => {
      const data = await gql(ApplicationKindEligibilityDocument, {
        enterpriseId,
        programmeCycleId,
      })
      return unwrap(data.seb.application.applicationKinds).kinds
    },
  })
