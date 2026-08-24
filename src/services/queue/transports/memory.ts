/**
 * An in-process queue, for local work and tests.
 *
 * There is no queue on a developer's machine, and the development runtime does
 * not provide one the way it provides a bucket. So messages are held here and
 * can be drained deliberately, which also makes a test able to assert that
 * something was queued without reaching for a real transport.
 *
 * **Held until something drains them.** Nothing consumes them in the
 * background, because a Worker that finished responding is gone. `src/index.ts`
 * drains this after each request through `executionCtx.waitUntil`, which is
 * the closest honest equivalent of a real queue: the work happens after the
 * response rather than inside it.
 *
 * Draining is deliberately somebody else's job. A transport that consumed its
 * own messages would be doing two things, and the one place that knows how to
 * handle a message is the Worker entry point that also serves the deployed
 * consumer — so both paths run the same code.
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
