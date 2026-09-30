/**
 * How the office list shows an application's standing.
 *
 * The named work queues of the hard-coded workflow are gone: which stage holds
 * a file, and what it may do next, is its pipeline's to say. What is left here
 * is what every list needs regardless of the pipeline.
 */
import type { ApplicationStatus } from '#/graphql/generated/schema'

/**
 * How a status is toned wherever it appears.
 *
 * Two statuses remain, and neither needs a colour: a draft is the applicant's
 * and a submitted file is the office's. Tone by outcome belongs to the
 * pipeline's status flags, which say whether a file was approved or closed.
 */
export const statusTone = (
  status: ApplicationStatus,
): 'action' | 'error' | 'ok' | undefined => (status === 'DRAFT' ? 'action' : undefined)

/** How long something has been waiting, in the terms a person would use. */
export const waitingFor = (since: string): string => {
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000)
  if (days < 1) return 'Today'
  if (days === 1) return '1 day'
  return `${days} days`
}
