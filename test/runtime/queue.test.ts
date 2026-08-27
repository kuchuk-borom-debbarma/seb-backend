/**
 * The queue seam.
 *
 * There is one thing worth protecting here and it is not throughput. A queued
 * message outlives the request that made it, may be retried, and is readable by
 * whoever can read the queue — so what it carries matters more than how fast it
 * gets there.
 */
import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../../src/bindings'
import {
  drainMemoryQueue,
  queue,
  sendBestEffort,
  usesLocalQueue,
  type QueueMessage,
} from '../../src/services/queue'
import { cloudflareQueueTransport } from '../../src/services/queue/transports/cloudflare'
import {
  CLOUDMERSIVE_SCAN_REFERENCE,
  documentScanner,
  NO_SCANNER_REFERENCE,
} from '../../src/services/document-scanner'
import { cloudmersiveScanner } from '../../src/services/document-scanner/transports/cloudmersive'

/*
 * Deliberately looser than `Partial<AppBindings>`. These tests are about what
 * the factory does with a value it should refuse — an unset environment, a
 * padded one, a credential that is not there — and a type narrowed to the
 * configured literal cannot express the question.
 */
const bindings = (extra: Record<string, unknown> = {}) =>
  ({ ...env, ...extra }) as unknown as AppBindings

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
  /*
   * Pinned, not inherited. `bindings()` spreads the worker env, which vitest
   * fills from `.env.local` — and `.env.local` is exactly where a developer is
   * told to put a real key when turning the transport on. Left to the
   * environment, these three would start failing the day that happens, and
   * would read as a regression in the factory rather than as configuration
   * leaking into the suite.
   */
  const unscanned = { SCANNER_TRANSPORT: 'none' } as Partial<AppBindings>

  it('accepts without examining, and says so where anybody can read it', async () => {
    /*
     * The honesty is the point. Staff download fails closed until an ACCEPTED
     * result exists, so something has to record one or no administrator can
     * open any document — but a permissive scanner that recorded a
     * clean-looking result would be worse than no scanner, because it would
     * read as evidence that something checked.
     */
    const scanner = documentScanner(bindings(unscanned))
    expect(scanner.name).toBe('permissive')

    const outcome = await scanner.scan('applications/a/documents/DPR/object')
    expect(outcome.verdict).toBe('ACCEPTED')
    expect(outcome.reference).toBe(NO_SCANNER_REFERENCE)
    expect(outcome.message).toContain('not examined')
  })

  it('is permissive on develop, because a demonstration has no real evidence', () => {
    expect(documentScanner(bindings({ ...unscanned, ENVIRONMENT: 'develop' })).name).toBe('permissive')
  })

  it('refuses to exist in production until a real one is configured', () => {
    /*
     * When the scanner is built, so the error names the configuration rather
     * than arriving later as something else. Worth being exact about what that
     * buys: the queue consumer is the only thing that builds one, so this does
     * not stop a bad deployment starting — `npm run check:scanner` is what
     * refuses the configuration beforehand.
     */
    expect(() => documentScanner(bindings({ ...unscanned, ENVIRONMENT: 'production' })))
      .toThrowError(/No malware scanner is configured for the production environment/u)
  })

  it('is satisfied in production by a real scanner', () => {
    const scanner = documentScanner(bindings({
      ENVIRONMENT: 'production',
      SCANNER_TRANSPORT: 'cloudmersive',
      CLOUDMERSIVE_API_KEY: 'test-key',
      STORAGE_TRANSPORT: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
    }))
    expect(scanner.name).toBe('cloudmersive')
  })

  it('refuses a transport it does not have, rather than falling back', () => {
    // Falling back would be the dangerous kind of forgiving: a typo in
    // configuration would silently stop documents being examined.
    expect(() => documentScanner(bindings({ SCANNER_TRANSPORT: 'clamav' })))
      .toThrowError('SCANNER_TRANSPORT must be either "none" or "cloudmersive".')
  })

  it('refuses cloudmersive without its key, when it is built', () => {
    expect(() => documentScanner(bindings({ SCANNER_TRANSPORT: 'cloudmersive' })))
      .toThrowError(/CLOUDMERSIVE_API_KEY is required/u)
    // Whitespace is not a key either.
    expect(() => documentScanner(bindings({
      SCANNER_TRANSPORT: 'cloudmersive',
      CLOUDMERSIVE_API_KEY: '   ',
    }))).toThrowError(/CLOUDMERSIVE_API_KEY is required/u)
  })

  it('names "none" explicitly as well as by absence', () => {
    expect(documentScanner(bindings({ SCANNER_TRANSPORT: 'none' })).name).toBe('permissive')
    expect(() => documentScanner(bindings({
      SCANNER_TRANSPORT: 'NONE',
      ENVIRONMENT: 'production',
    }))).toThrowError(/No malware scanner is configured/u)
  })
})

describe('scanning with Cloudmersive', () => {
  afterEach(() => vi.unstubAllGlobals())

  const OBJECT_KEY = 'applications/a/documents/DPR/object'

  /** Records every call, and answers with whatever the test supplies. */
  const stubFetch = (reply: () => Response) => {
    const calls: Array<{ url: string; request: RequestInit | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, request?: RequestInit) => {
      calls.push({ url: String(url), request })
      return reply()
    })
    return calls
  }

  type Reader = (objectKey: string) => Promise<Response | null>
  const reader: Reader = async () => new Response('file bytes')
  const scanner = (read: Reader = reader) => cloudmersiveScanner('test-key', read)

  it('sends the bytes, and never the key or the object key, in the body', async () => {
    const calls = stubFetch(() => Response.json({ CleanResult: true, FoundViruses: [] }))
    const outcome = await scanner().scan(OBJECT_KEY)

    expect(outcome).toEqual({
      verdict: 'ACCEPTED',
      reference: CLOUDMERSIVE_SCAN_REFERENCE,
      message: null,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.cloudmersive.com/virus/scan/file')
    // The key authenticates the request and belongs in a header, not the body.
    expect((calls[0]!.request!.headers as Record<string, string>).Apikey).toBe('test-key')

    const form = calls[0]!.request!.body as FormData
    const sent = form.get('inputFile') as File
    expect(await sent.text()).toBe('file bytes')
    /*
     * The filename is a constant. The object key names an applicant's evidence
     * in a store, and there is no reason for a third party that only needs the
     * bytes to learn it.
     */
    expect(sent.name).toBe('document')
    expect(sent.name).not.toContain('applications')
  })

  it('rejects a file the scanner found something in, and names what', async () => {
    stubFetch(() => Response.json({
      CleanResult: false,
      FoundViruses: [{ FileName: 'document', VirusName: 'Eicar-Test-Signature' }],
    }))
    const outcome = await scanner().scan(OBJECT_KEY)

    expect(outcome.verdict).toBe('REJECTED')
    expect(outcome.reference).toBe(CLOUDMERSIVE_SCAN_REFERENCE)
    // Shown to staff, so it has to say something a person can act on.
    expect(outcome.message).toContain('Eicar-Test-Signature')
  })

  it('still rejects when the provider names nothing it found', async () => {
    // Both shapes of "nothing named": the field absent, and an empty list. A
    // rejection has to survive either, because the verdict is the boolean.
    for (const body of [{ CleanResult: false }, { CleanResult: false, FoundViruses: [] }]) {
      stubFetch(() => Response.json(body))
      const outcome = await scanner().scan(OBJECT_KEY)
      expect(outcome.verdict).toBe('REJECTED')
      expect(outcome.message).toBe('The scanner found malware in this file.')
    }
  })

  it('reads the bytes from storage when built by the factory', async () => {
    /*
     * The factory wires the scanner to `objectReader`, and that wiring is the
     * part no transport test can reach: given only a key, the queue consumer
     * has to be able to fetch what the key names. Stored through the binding
     * here, which is what a local environment reads.
     */
    const key = `scan/${crypto.randomUUID()}`
    await env.STORAGE.put(key, new TextEncoder().encode('stored bytes'))

    const calls = stubFetch(() => Response.json({ CleanResult: true }))
    const outcome = await documentScanner(bindings({
      SCANNER_TRANSPORT: 'cloudmersive',
      CLOUDMERSIVE_API_KEY: 'test-key',
    })).scan(key)

    expect(outcome.verdict).toBe('ACCEPTED')
    const sent = (calls[0]!.request!.body as FormData).get('inputFile') as File
    expect(await sent.text()).toBe('stored bytes')
  })

  it('ignores entries that name no virus, rather than showing blanks', async () => {
    stubFetch(() => Response.json({
      CleanResult: false,
      FoundViruses: [{ FileName: 'd' }, { VirusName: '  ' }, null, { VirusName: 'Real.Threat' }],
    }))
    expect((await scanner().scan(OBJECT_KEY)).message).toBe(
      'The scanner identified Real.Threat.',
    )
  })

  /*
   * Everything below must throw rather than conclude. A document that was not
   * examined stays unopenable and the queue message can be retried, which is
   * the safe direction — resolving ACCEPTED for a file nothing looked at is
   * the one outcome a scanner must never produce.
   */
  it('refuses to conclude when the object cannot be read', async () => {
    stubFetch(() => Response.json({ CleanResult: true }))
    await expect(scanner(async () => null).scan(OBJECT_KEY))
      .rejects.toThrowError('The document could not be read for scanning.')
  })

  it('refuses to conclude when the provider rejects the request', async () => {
    stubFetch(() => new Response('Apikey test-key is over quota', { status: 429 }))
    // The status, and not the body: a provider's error can quote the request,
    // and the request carries the key.
    await expect(scanner().scan(OBJECT_KEY))
      .rejects.toThrowError('The malware scanner refused the request (429).')
    await expect(scanner().scan(OBJECT_KEY)).rejects.not.toThrowError(/test-key/u)
  })

  it('refuses to conclude when the answer is not a verdict', async () => {
    for (const body of ['not json at all', '{"CleanResult":"true"}', '{}']) {
      stubFetch(() => new Response(body, { status: 200 }))
      await expect(scanner().scan(OBJECT_KEY))
        .rejects.toThrowError('The malware scanner returned no verdict.')
    }
  })
})
