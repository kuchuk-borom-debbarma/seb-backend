/**
 * Plain-language explanation and next action for every application status.
 *
 * Held in code rather than configuration because these strings are part of the
 * product's promise to applicants: they must be reviewable in a pull request
 * and must change together with the workflow that produces the status.
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
  SUBMITTED: {
    label: 'Submitted',
    explanation: 'Your application has been received and is waiting to be picked up '
      + 'for review.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
  DESK_REVIEW: {
    label: 'Under desk review',
    explanation: 'A reviewer is checking your answers, eligibility, and documents.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
  REVISION_REQUIRED: {
    label: 'Changes requested',
    explanation: 'The programme office has asked you to correct specific sections. '
      + 'Only those sections can be edited.',
    nextActor: 'APPLICANT',
    nextAction: 'Make the requested corrections and submit your application again.',
  },
  PARTNER_BANK_EVALUATION: {
    label: 'With the partner bank',
    explanation: 'Your application has been referred to a partner bank for its '
      + 'assessment of the proposal.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
  TTM_REVIEW: {
    label: 'Awaiting committee decision',
    explanation: 'Your application is on the agenda for a Tripartite Meeting, which '
      + 'takes the funding decision.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
  APPROVED: {
    label: 'Approved',
    explanation: 'The committee has approved your application. The sanction order '
      + 'that releases funding is prepared next.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
  REJECTED: {
    label: 'Not approved',
    explanation: 'Your application was not approved. The reason is recorded in your '
      + 'application history.',
    nextActor: 'NOBODY',
    nextAction: null,
  },
  SANCTIONED: {
    label: 'Sanctioned',
    explanation: 'A funding award has been created for your application. Payments '
      + 'are released against it as their conditions are met.',
    nextActor: 'PROGRAMME_OFFICE',
    nextAction: null,
  },
  DISBURSED: {
    label: 'Funds released',
    explanation: 'At least one payment has been released against your award. '
      + 'Utilization evidence is required for every release.',
    nextActor: 'APPLICANT',
    nextAction: 'Provide utilization evidence for each payment when it is requested.',
  },
  CANCELLED: {
    label: 'Cancelled',
    explanation: 'This application is closed and no longer progressing.',
    nextActor: 'NOBODY',
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
