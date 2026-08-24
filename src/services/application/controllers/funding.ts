/**
 * Applicant reads of their own funding outcome.
 *
 * The administrative service owns every write behind these records. This
 * controller adds one thing: proof that the caller owns the application before
 * any funding fact leaves the server.
 */
import { ownedApplication } from '../ownership'
import { findApplicantFunding } from '../queries/funding'
import { failure, success } from '../../envelope'
import type { ApplicantFunding, ApplicationOperationContext, SebResult } from '../types'

export const applicationFunding = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<ApplicantFunding>> => {
  const owned = await ownedApplication<ApplicantFunding>(applicationId, context)
  if ('refusal' in owned) return owned.refusal
  const funding = await findApplicantFunding(context.db, owned.application.id)
  return funding
    ? success(funding)
    : failure('No funding award has been created for this application yet.')
}
