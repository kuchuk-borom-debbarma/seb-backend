/**
 * The queue seam.
 *
 * There is one thing worth protecting here and it is not throughput. A queued
 * message outlives the request that made it, may be retried, and is readable by
 * whoever can read the queue — so what it carries matters more than how fast it
 * gets there.
 */
import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/bindings'
import {
  drainMemoryQueue,
  queue,
  sendBestEffort,
  usesLocalQueue,
  type QueueMessage,
} from '../src/services/queue'
import { cloudflareQueueTransport } from '../src/services/queue/transports/cloudflare'
import { documentScanner, NO_SCANNER_REFERENCE } from '../src/services/document-scanner'

const bindings = (extra: Partial<AppBindings> = {}) => ({ ...env, ...extra }) as AppBindings

const message: QueueMessage = {
  kind: 'DOCUMENT_SCAN_REQUESTED',
  documentVersionId: 'c0ffee00-0000-4000-8000-000000000000',
}

describe('choosing a queue', () => {
  it('queues in process locally, and treats an unconfigured machine as local', () => {
    for (const environment of [undefined, '', 'local', 'LOCAL', '  ']) {
      expect(usesLocalQueue(bindings({ ENVIRONMENT: environment }))).toBe(true)
      expect(queue(bindings({ ENVIRONMENT: environment })).name).toBe('memory')
    }
  })

  it('uses the real queue once the environment says it is deployed', () => {
    for (const environment of ['develop', ' Develop ', 'production']) {
      expect(usesLocalQueue(bindings({ ENVIRONMENT: environment }))).toBe(false)
      expect(queue(bindings({ ENVIRONMENT: environment })).name).toBe('cloudflare')
    }
  })
})

describe('the in-process transport', () => {
  it('holds what was sent so it can be drained deliberately', async () => {
    drainMemoryQueue()
    await queue(bindings()).send(message)
    // Held rather than delivered: a Worker that finished responding is gone,
    // and pretending otherwise would hide the difference from deployed.
    expect(drainMemoryQueue()).toEqual([message])
    // Draining empties it, so a second read sees nothing twice.
    expect(drainMemoryQueue()).toEqual([])
  })
})

describe('the Cloudflare transport', () => {
  it('hands the message to the binding unchanged', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const transport = cloudflareQueueTransport({ send } as unknown as Queue)
    await transport.send(message)
    expect(send).toHaveBeenCalledWith(message)
  })

  it('lets a refusal reach the caller rather than swallowing it', async () => {
    // The caller decides what a failure means. For document scanning it means
    // carry on, because the upload genuinely succeeded — but that is the
    // caller's policy to apply, not the transport's to assume.
    const transport = cloudflareQueueTransport({
      send: async () => { throw new Error('queue unavailable') },
    } as unknown as Queue)
    await expect(transport.send(message)).rejects.toThrow()
  })
})

describe('work whose loss is safe', () => {
  it('carries on when the message could not be handed over', async () => {
    /*
     * The operation that queued this already succeeded. Reporting it as failed
     * because the follow-up could not be scheduled would be untrue, and would
     * invite the applicant to upload the same document again.
     */
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const refusing = {
      name: 'refusing',
      send: async () => { throw new Error('to=someone key=secret') },
    }
    await expect(sendBestEffort(refusing, message, 'The document scan')).resolves.toBe(false)

    // Says what failed and nothing else. A transport error can carry the
    // request it was making, and these payloads name stored objects.
    const logged = String(error.mock.calls[0]?.[0])
    expect(logged).toBe('The document scan could not be queued')
    expect(logged).not.toContain('secret')
    expect(logged).not.toContain(message.documentVersionId)
    error.mockRestore()
  })

  it('reports success when it was accepted', async () => {
    drainMemoryQueue()
    await expect(sendBestEffort(queue(bindings()), message, 'The document scan'))
      .resolves.toBe(true)
    expect(drainMemoryQueue()).toEqual([message])
  })
})

describe('scanning a document that was queued', () => {
  it('accepts without examining, and says so where anybody can read it', async () => {
    /*
     * The honesty is the point. Staff download fails closed until an ACCEPTED
     * result exists, so something has to record one or no administrator can
     * open any document — but a permissive scanner that recorded a
     * clean-looking result would be worse than no scanner, because it would
     * read as evidence that something checked.
     */
    const scanner = documentScanner(bindings())
    expect(scanner.name).toBe('permissive')

    const outcome = await scanner.scan('applications/a/documents/DPR/object')
    expect(outcome.verdict).toBe('ACCEPTED')
    expect(outcome.reference).toBe(NO_SCANNER_REFERENCE)
    expect(outcome.message).toContain('not examined')
  })

  it('is permissive on develop, because a demonstration has no real evidence', () => {
    expect(documentScanner(bindings({ ENVIRONMENT: 'develop' })).name).toBe('permissive')
  })

  it('refuses to exist in production until a real one is configured', () => {
    /*
     * At construction, not at scan time. A scanner that failed only when asked
     * would let a deployment look healthy until the first document was
     * uploaded; refusing to be built is loud and immediate.
     */
    expect(() => documentScanner(bindings({ ENVIRONMENT: 'production' })))
      .toThrowError(/No malware scanner is configured for the production environment/u)
  })
})
