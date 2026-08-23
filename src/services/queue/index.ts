/**
 * Choosing who carries queued work.
 *
 * The same shape as the notification and storage seams: an agnostic interface,
 * one transport per environment, and a factory that picks. Built per call
 * rather than cached, for the reason `src/index.ts` gives for its own
 * configuration.
 *
 * ## What is and is not built
 *
 * The seam is real and so is its one producer: finalizing a document queues a
 * scan request. What does not exist is a scanner — none has been chosen, and
 * that is an open public-launch blocker on the roadmap. So the consumer records
 * that a scan was requested and stops; administrative download keeps failing
 * closed until an `ACCEPTED` result is appended, exactly as it does now.
 *
 * That gap is named rather than papered over. A consumer that marked documents
 * clean because nothing had scanned them would be worse than no scanner at all.
 */
import type { AppBindings } from '../../bindings'
import { cloudflareQueueTransport } from './transports/cloudflare'
import { memoryQueueTransport } from './transports/memory'
import type { QueueMessage, QueueTransport } from './types'

export { drainMemoryQueue } from './transports/memory'
export type * from './types'

/**
 * Whether this environment queues in process.
 *
 * Unset means local, matching every other seam: an unconfigured machine is a
 * developer's, and a deployed environment is always told what it is.
 */
export const usesLocalQueue = (env: AppBindings): boolean => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  return environment === '' || environment === 'local'
}

export const queue = (env: AppBindings): QueueTransport =>
  usesLocalQueue(env) ? memoryQueueTransport() : cloudflareQueueTransport(env.QUEUE)

/**
 * Hands over a message, and carries on if it could not be handed over.
 *
 * Queued work is by definition not part of what the caller promised. A business
 * operation that already succeeded must not be reported as failed because the
 * follow-up work could not be scheduled — the applicant's upload really did
 * land, and telling them otherwise would invite them to do it again.
 *
 * The error is deliberately not logged with the message. A transport failure
 * can carry the request it was making, and these payloads name stored objects.
 *
 * Only for work whose loss is safe. It is safe for document scanning because
 * administrative download fails closed until a scan result is appended, so a
 * lost message yields a document nobody can read rather than a document nobody
 * checked. Anything without that property should handle its own failure.
 */
export const sendBestEffort = async (
  transport: QueueTransport,
  message: QueueMessage,
  description: string,
): Promise<boolean> => {
  try {
    await transport.send(message)
    return true
  } catch {
    console.error(`${description} could not be queued`)
    return false
  }
}
