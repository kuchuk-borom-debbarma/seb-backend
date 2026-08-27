/** Dashboard reads assembled from operations the API already exposes. */
import { queryOptions } from '@tanstack/react-query'
import {
  ApplicantDashboardDocument,
  OfficeDashboardDocument,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

export const applicantDashboardQuery = queryOptions({
  queryKey: ['applicant-dashboard'],
  queryFn: async () => {
    const data = await gql(ApplicantDashboardDocument)
    const applications = unwrap(data.seb.application.allApplications)
    const enterprises = unwrap(data.seb.enterprise.mine)
    const revisions = unwrap(data.seb.application.revisions)
    const drafts = unwrap(data.seb.application.drafts)
    const cycles = unwrap(data.seb.application.availableProgrammeCycles).cycles
    const guide = unwrap(data.seb.application.statusGuide).statuses
    return { applications, enterprises, revisions, drafts, cycles, guide }
  },
})

export const officeDashboardQuery = queryOptions({
  queryKey: ['office-dashboard'],
  queryFn: async () => {
    const data = await gql(OfficeDashboardDocument)
    return {
      queues: unwrap(data.admin.intake.queues).queues,
      decisionQueue: unwrap(data.admin.intake.decisionQueue),
    }
  },
})
