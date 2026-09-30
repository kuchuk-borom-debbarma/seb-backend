/**
 * Plain-language explanation and next action for every application status.
 *
 * Held in code rather than configuration because these strings are part of the
 * product's promise to applicants: they must be reviewable in a pull request
 * and must change together with the workflow that produces the status.
 *
 * Two statuses only. Everything after submission — which stage holds the
 * application, whether it was approved, whether a correction is asked for —
 * is the pipeline's, configured as stages and status flags, and explained by
 * the pipeline's own labels rather than by strings fixed here.
 *
 * Deliberately carries no timing. Programme staff do not commit to a completion
 * date, so nothing here may imply one; a status says who holds the work, not
 * when they will finish it.
 */
import { applicationStatuses } from '../../db/schema'
import type { ApplicationStatus, ApplicationStatusGuideEntry } from './types'

const guide: Record<ApplicationStatus, Omit<ApplicationStatusGuideEntry, 'status'>> = {
  DRAFT: {
    label: 'Draft',
    explanation: 'Your application has been started but not submitted. '
      + 'Nobody at the programme office can see it yet.',
    nextActor: 'APPLICANT',
    nextAction: 'Complete every section and the required documents, then submit.',
  },
  IN_PIPELINE: {
    label: 'Submitted',
    explanation: 'Your application has been received and the programme office is working '
      + 'on it. Where it is, and anything asked of you, is shown alongside it.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
}

/**
 * The complete catalogue, in workflow order.
 *
 * Built from the schema's own status list rather than the object above, so a
 * status added to the workflow cannot be silently missing from the guide.
 */
export const applicationStatusGuide: ApplicationStatusGuideEntry[] =
  applicationStatuses.map((status) => ({ status, ...guide[status] }))
