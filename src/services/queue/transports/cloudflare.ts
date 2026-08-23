/**
 * Cloudflare Queues. The only file that knows the binding exists.
 */
import type { QueueMessage, QueueTransport } from '../types'

export const cloudflareQueueTransport = (queue: Queue): QueueTransport => ({
  name: 'cloudflare',
  send: async (message: QueueMessage) => {
    await queue.send(message)
  },
})
