/**
 * Submitted applications whose analytic dimensions the test chooses.
 *
 * The queue's analytic filters read the sector, district and registration type
 * live from the enterprise, the category from the frozen snapshot, and the
 * requested amount from the answer — so a test about them needs applications
 * that *differ* in those dimensions. `submittedApplication` deliberately knows
 * nothing about any of them, and teaching it would push five optional knobs
 * onto forty call sites that want the default. This helper goes through the
 * same real mutations; nothing here writes a row the product would refuse.
 */
import { env } from '../../support/worker'
import {
  attachEvidence,
  createEnterprise,
  saveAnswers,
  signIn,
  startApplication,
  submitApplication,
} from '../../support/api'
import { completeAnswers, requiredDocuments } from '../../support/form'

export type SubmittedProfile = {
  applicationId: string
  enterpriseId: string
  submissionId: string
  applicantUserId: string
  referenceNumber: string
}

/**
 * One submitted application with the analytic dimensions the caller names.
 *
 * Signs in its own applicant by default: the enterprise cap is five per owner,
 * so a summary test seeding a spread of applications under one account would
 * fail on the sixth for a reason that has nothing to do with analytics.
 */
export const submittedProfile = async (input: {
  cycleId: string
  /** Passed through to the enterprise create mutation. */
  enterprise?: Record<string, unknown>
  /** The seed-fund answer, in paise. Defaults to the fixture's 10,000,000. */
  requestedPaise?: number
  /** Reuse an account instead of signing a fresh applicant in. */
  applicant?: { cookie: string; userId: string }
}): Promise<SubmittedProfile> => {
  const applicant = input.applicant ?? await signIn({ roles: ['APPLICANT'] })
  const enterpriseId = await createEnterprise(applicant.cookie, input.enterprise ?? {})
  const applicationId = await startApplication(applicant.cookie, enterpriseId, input.cycleId)
  const saved = await saveAnswers(
    applicant.cookie,
    applicationId,
    completeAnswers(
      input.requestedPaise === undefined
        ? {}
        : { SEED_FUND_REQUESTED_PAISE: input.requestedPaise },
    ),
  )
  await attachEvidence(applicationId, applicant.userId, requiredDocuments, 'ACCEPTED')
  await submitApplication(applicant.cookie, applicationId, {
    version: saved.currentVersion,
    statusVersion: saved.statusVersion,
  })
  const head = await env.DB.prepare(
    `SELECT reference_number AS "referenceNumber" FROM seb_application WHERE id = ?`,
  ).bind(applicationId).first<{ referenceNumber: string }>()
  const submission = await env.DB.prepare(
    `SELECT id FROM seb_application_submission
      WHERE application_id = ? ORDER BY submission_number DESC LIMIT 1`,
  ).bind(applicationId).first<{ id: string }>()
  if (!head || !submission) throw new Error('submission missing after a successful submit')
  return {
    applicationId,
    enterpriseId,
    submissionId: submission.id,
    applicantUserId: applicant.userId,
    referenceNumber: head.referenceNumber,
  }
}
