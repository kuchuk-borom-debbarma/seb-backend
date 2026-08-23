/**
 * An in-process queue, for local work and tests.
 *
 * There is no queue on a developer's machine, and the development runtime does
 * not provide one the way it provides a bucket. So messages are held here and
 * can be drained deliberately, which also makes a test able to assert that
 * something was queued without reaching for a real transport.
 *
 * **Held, not delivered.** Nothing consumes them in the background: a Worker
 * that finished responding is gone, and pretending otherwise would make local
 * behaviour differ from deployed in the one direction that hides bugs.
 */
import type { QueueMessage, QueueTransport } from '../types'

/**
 * Module-level, and deliberately so.
 *
 * The point of this transport is that a message survives the call that sent it
 * so a test or a local `drain()` can see it. A per-call array would be
 * discarded immediately and could hold nothing.
 */
const pending: QueueMessage[] = []

export const memoryQueueTransport = (): QueueTransport => ({
  name: 'memory',
  send: async (message: QueueMessage) => {
    pending.push(message)
  },
})

/** Everything queued since the last drain, emptying the buffer. */
export const drainMemoryQueue = (): QueueMessage[] => pending.splice(0, pending.length)
