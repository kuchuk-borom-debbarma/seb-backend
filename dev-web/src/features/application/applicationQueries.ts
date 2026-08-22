/**
 * Queries for one application, shared by its overview, form and review screens.
 *
 * They live together so the three screens agree about staleness. An open draft
 * is never served stale — what is editable can change the moment a reviewer
 * issues or cancels a revision request — while the timeline only grows.
 */
import { queryOptions } from '@tanstack/react-query'
import {
  ApplicationByIdDocument,
  ApplicationTimelineDocument,
  DraftChangesDocument,
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

export const timelineQuery = (id: string) =>
  queryOptions({
    queryKey: ['application-timeline', id],
    queryFn: async () => {
      const data = await gql(ApplicationTimelineDocument, { applicationId: id, first: 50 })
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
