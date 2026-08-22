/**
 * One definition of "the caller owns this application".
 *
 * Ownership is resolved before any related record is read, so an opaque
 * identifier belonging to somebody else is indistinguishable from one that
 * never existed. Every applicant read that reaches beyond the application row
 * itself starts here, which is what keeps that guarantee from being restated
 * slightly differently in each of them.
 *
 * Lives outside `support.ts` because it needs the query layer, and `support.ts`
 * is what the query layer itself imports.
 */
import {
  findOwnedApplicationHead,
  loadOwnedApplication,
  type ApplicationHeadRecord,
} from './queries/application'
import { AUTH_REQUIRED_MESSAGE, currentApplicant, failure } from './support'
import type { Application, ApplicationOperationContext, SebResult } from './types'

export const APPLICATION_NOT_FOUND_MESSAGE = 'The application was not found.'
const STALE_APPLICATION_MESSAGE = 'The application changed. Refresh it and try again.'

export type OwnedApplication<T> =
  | { application: ApplicationHeadRecord }
  | { refusal: SebResult<T> }

export const ownedApplication = async <T>(
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<OwnedApplication<T>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return { refusal: failure(AUTH_REQUIRED_MESSAGE) }
  const application = await findOwnedApplicationHead(context.db, applicant.id, applicationId)
  if (!application) return { refusal: failure(APPLICATION_NOT_FOUND_MESSAGE) }
  return { application }
}

/**
 * Authenticates the caller and checks the optimistic-concurrency preconditions
 * every application write shares.
 *
 * Loading is left to the caller because the writes need different views: some
 * need the head row including soft-deleted ones, others the full aggregate.
 */
export const applicantForVersionedWrite = async <T>(
  input: { expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
): Promise<{ applicantId: string } | { refusal: SebResult<T> }> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return { refusal: failure(AUTH_REQUIRED_MESSAGE) }
  if (!validExpectedVersions(input.expectedVersion, input.expectedStatusVersion)) {
    return { refusal: failure('Expected versions must be positive integers.') }
  }
  return { applicantId: applicant.id }
}

/** Both versions are positive integers, the contract every guarded write uses. */
const validExpectedVersions = (version: number, statusVersion: number): boolean =>
  Number.isInteger(version) && version >= 1
  && Number.isInteger(statusVersion) && statusVersion >= 1

/**
 * Resolves the full application only when it is at exactly the version the
 * caller expects.
 *
 * This is the optimistic-concurrency precondition every draft write shares: the
 * caller acted on what they were last shown, and anything else has to be
 * refused so a stale form cannot overwrite a newer one. The guarded SQL repeats
 * the same versions, so this read is the friendly explanation rather than the
 * authority.
 */
export const ownedApplicationAtVersion = async (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
): Promise<
  | { applicantId: string; application: Application }
  | { refusal: SebResult<Application> }
> => {
  const authorized = await applicantForVersionedWrite<Application>(input, context)
  if ('refusal' in authorized) return authorized
  const application = await loadOwnedApplication(
    context.db, authorized.applicantId, input.applicationId,
  )
  if (!application) return { refusal: failure(APPLICATION_NOT_FOUND_MESSAGE) }
  if (
    application.currentVersion !== input.expectedVersion ||
    application.statusVersion !== input.expectedStatusVersion
  ) return { refusal: failure(STALE_APPLICATION_MESSAGE) }
  return { applicantId: authorized.applicantId, application }
}
