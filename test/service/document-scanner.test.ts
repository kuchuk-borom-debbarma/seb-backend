/**
 * What examines an applicant's documents, and what it concludes.
 *
 * This is a fail-closed boundary: a document cannot be downloaded until an
 * `ACCEPTED` result exists, so every way the scanner can *fail* has to end in
 * something other than a verdict. The one outcome that must never happen is a
 * provider error, a truncated reply or a timeout being read as "clean".
 *
 * `fetch` is stubbed rather than called. What is under test is the decision
 * made about a reply — which reply arrives is the provider's business, and
 * asserting against a real one would be asserting against their uptime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUDMERSIVE_SCAN_REFERENCE,
  documentScanner,
  NO_SCANNER_REFERENCE,
} from '../../src/services/document-scanner'
import { cloudmersiveScanner } from '../../src/services/document-scanner/transports/cloudmersive'
import { queue, sendBestEffort, usesLocalQueue } from '../../src/services/queue'
import { testEnv } from '../support/harness'
import type { AppBindings } from '../../src/bindings'

afterEach(() => { vi.restoreAllMocks() })

const env = (overrides: Record<string, unknown>): AppBindings =>
  testEnv(overrides as never)

const reading = (body = '%PDF-1.7 bytes') =>
  async () => new Response(body, { headers: { 'content-type': 'application/pdf' } })

/** A provider reply, without going near the provider. */
const replying = (
  init: { status?: number; body?: unknown; text?: string },
) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
  new Response(
    init.text ?? JSON.stringify(init.body ?? {}),
    { status: init.status ?? 200, headers: { 'content-type': 'application/json' } },
  ))

describe('choosing what examines a document', () => {
  it('accepts without examining where nothing is configured, and says so', async () => {
    const scanner = documentScanner(env({}))
    expect(scanner.name).toBe('permissive')
    expect(await scanner.scan('any/key')).toMatchObject({
      verdict: 'ACCEPTED',
      reference: NO_SCANNER_REFERENCE,
    })
  })

  it('treats "none" as the same thing said out loud', () => {
    expect(documentScanner(env({ SCANNER_TRANSPORT: 'none' })).name).toBe('permissive')
  })

  /*
   * `develop` is deliberately not on the list that demands a scanner: it is a
   * demonstration environment holding no real applicant's evidence, and being
   * unable to open a document there costs more than it protects.
   */
  it('still accepts without examining in develop', () => {
    expect(documentScanner(env({ ENVIRONMENT: 'develop' })).name).toBe('permissive')
  })

  it('refuses to be built at all in production with no scanner', () => {
    expect(() => documentScanner(env({ ENVIRONMENT: 'production' })))
      .toThrow('No malware scanner is configured for the production environment.')
  })

  it('names the missing key rather than failing at the provider', () => {
    expect(() => documentScanner(env({
      SCANNER_TRANSPORT: 'cloudmersive', CLOUDMERSIVE_API_KEY: '   ',
    }))).toThrow('CLOUDMERSIVE_API_KEY is required when SCANNER_TRANSPORT is "cloudmersive".')
  })

  it('refuses a transport it does not have', () => {
    expect(() => documentScanner(env({ SCANNER_TRANSPORT: 'clamav' })))
      .toThrow('SCANNER_TRANSPORT must be either "none" or "cloudmersive".')
  })

  it('builds the real one when it is configured', () => {
    expect(documentScanner(env({
      SCANNER_TRANSPORT: 'cloudmersive', CLOUDMERSIVE_API_KEY: 'a-key',
    })).name).toBe('cloudmersive')
  })

  /**
   * The one it builds really reads the bytes, through this environment's store.
   *
   * Asserted end to end rather than by inspecting what was passed: the scanner
   * has to reach an object under *every* transport, including the one where
   * uploads bypass this Worker entirely, and that is the whole reason it takes
   * a reader rather than a bucket.
   */
  it('reads the object through this environment’s own store', async () => {
    const local = env({ SCANNER_TRANSPORT: 'cloudmersive', CLOUDMERSIVE_API_KEY: 'a-key' })
    await local.STORAGE!.put(
      'applications/a/documents/DPR/b',
      new TextEncoder().encode('%PDF-1.7'),
    )
    replying({ body: { CleanResult: true } })
    expect(await documentScanner(local).scan('applications/a/documents/DPR/b'))
      .toMatchObject({ verdict: 'ACCEPTED' })
  })

  it('concludes nothing when this environment’s store does not hold it', async () => {
    const local = env({ SCANNER_TRANSPORT: 'cloudmersive', CLOUDMERSIVE_API_KEY: 'a-key' })
    await expect(documentScanner(local).scan('nothing/here'))
      .rejects.toThrow('The document could not be read for scanning.')
  })
})

/**
 * Queueing a scan, which is deliberately best-effort.
 *
 * A document that could not be queued is still uploaded and still unopenable —
 * the safe direction. What must not happen is the upload itself failing because
 * the queue was unavailable, so the failure is logged and reported as `false`
 * rather than thrown.
 */
describe('where a scan request is queued', () => {
  /*
   * Same rule as every other seam: an unconfigured machine is a developer's,
   * and a deployed environment is always told what it is.
   */
  it('queues in process where nothing says otherwise', () => {
    expect(usesLocalQueue(env({}))).toBe(true)
    expect(usesLocalQueue(env({ ENVIRONMENT: '  LOCAL ' }))).toBe(true)
    expect(queue(env({})).name).toBe('memory')
  })

  it('hands a deployed environment to the runtime’s own queue', () => {
    expect(usesLocalQueue(env({ ENVIRONMENT: 'production' }))).toBe(false)
    expect(queue(env({ ENVIRONMENT: 'production' })).name).toBe('cloudflare')
  })

  it('names the missing key rather than failing on the first scan', () => {
    // The empty-after-trim case specifically: a secret set to whitespace is a
    // secret that is not set, and reads as configured until something uses it.
    expect(() => documentScanner(env({
      SCANNER_TRANSPORT: 'cloudmersive', CLOUDMERSIVE_API_KEY: undefined,
    }))).toThrow('CLOUDMERSIVE_API_KEY is required')
  })
})

describe('asking for a document to be scanned', () => {
  const message = { kind: 'DOCUMENT_SCAN_REQUESTED' as const, documentVersionId: 'dv-1' }

  it('reports that it was queued', async () => {
    const sent: unknown[] = []
    expect(await sendBestEffort(
      { send: async (each: unknown) => void sent.push(each) } as never,
      message,
      'The document scan',
    )).toBe(true)
    expect(sent).toEqual([message])
  })

  it('reports that it was not, and never throws', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await sendBestEffort(
      { send: async () => { throw new Error('the queue is unavailable') } } as never,
      message,
      'The document scan',
    )).toBe(false)
    // Named, never the error — and never the message, which carries an id.
    expect(errorLog).toHaveBeenCalledWith('The document scan could not be queued')
  })
})

describe('a document examined by the real scanner', () => {
  const scanner = () => cloudmersiveScanner('a-key', reading())

  it('accepts a file the provider calls clean', async () => {
    replying({ body: { CleanResult: true } })
    expect(await scanner().scan('a/key')).toEqual({
      verdict: 'ACCEPTED',
      reference: CLOUDMERSIVE_SCAN_REFERENCE,
      message: null,
    })
  })

  it('names what it found when the provider says the file is not clean', async () => {
    replying({ body: { CleanResult: false, FoundViruses: [{ VirusName: 'EICAR-Test' }] } })
    expect(await scanner().scan('a/key')).toEqual({
      verdict: 'REJECTED',
      reference: CLOUDMERSIVE_SCAN_REFERENCE,
      message: 'The scanner identified EICAR-Test.',
    })
  })

  it('still rejects when the provider names nothing', async () => {
    replying({ body: { CleanResult: false } })
    expect(await scanner().scan('a/key')).toMatchObject({
      verdict: 'REJECTED',
      message: 'The scanner found malware in this file.',
    })
  })

  it('ignores findings that are not names', async () => {
    replying({
      body: { CleanResult: false, FoundViruses: [{ VirusName: '  ' }, null, { VirusName: 3 }] },
    })
    expect(await scanner().scan('a/key')).toMatchObject({
      message: 'The scanner found malware in this file.',
    })
  })

  it('lists every name it was given', async () => {
    replying({
      body: { CleanResult: false, FoundViruses: [{ VirusName: 'A' }, { VirusName: 'B' }] },
    })
    expect(await scanner().scan('a/key')).toMatchObject({
      message: 'The scanner identified A, B.',
    })
  })

  /*
   * Everything below must **throw** rather than return a verdict. The consumer
   * leaves an unsettled message unacknowledged and the platform redelivers it,
   * so the document stays unopenable — which is the safe direction. A returned
   * `ACCEPTED` would be permanent.
   */
  it('concludes nothing when the object cannot be read', async () => {
    const noObject = cloudmersiveScanner('a-key', async () => null)
    await expect(noObject.scan('a/key'))
      .rejects.toThrow('The document could not be read for scanning.')
  })

  it('concludes nothing when the provider refuses the request', async () => {
    replying({ status: 402 })
    await expect(scanner().scan('a/key'))
      .rejects.toThrow('The malware scanner refused the request (402).')
  })

  it('concludes nothing when the reply is not JSON at all', async () => {
    replying({ text: 'not json' })
    await expect(scanner().scan('a/key'))
      .rejects.toThrow('The malware scanner returned no verdict.')
  })

  it('concludes nothing when the reply carries no verdict', async () => {
    replying({ body: { FoundViruses: [] } })
    await expect(scanner().scan('a/key'))
      .rejects.toThrow('The malware scanner returned no verdict.')
  })

  /*
   * A verdict that is not a boolean is not a verdict. `"true"` is the case
   * worth naming: it is truthy, so a check written as `if (reply.CleanResult)`
   * would have accepted the file on a reply that said nothing definite.
   */
  it('concludes nothing when the verdict is a string that looks true', async () => {
    replying({ body: { CleanResult: 'true' } })
    await expect(scanner().scan('a/key'))
      .rejects.toThrow('The malware scanner returned no verdict.')
  })

  it('concludes nothing when the provider never answers', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('The operation was aborted due to timeout')
    })
    await expect(scanner().scan('a/key')).rejects.toThrow()
  })

  /**
   * The request carries the bytes and nothing else about the applicant.
   *
   * The real filename is theirs and the object key is a storage identifier;
   * neither has any business travelling to a third party that only needs the
   * file.
   */
  it('sends the bytes under a constant name, never the applicant’s', async () => {
    const sent = replying({ body: { CleanResult: true } })
    await scanner().scan('applications/abc/documents/DPR/secret-object-key')

    const [endpoint, init] = sent.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe('https://api.cloudmersive.com/virus/scan/file')
    expect((init.headers as Record<string, string>).Apikey).toBe('a-key')
    const file = (init.body as FormData).get('inputFile') as File
    expect(file.name).toBe('document')
    expect(JSON.stringify([...(init.body as FormData).keys()])).not.toContain('secret-object-key')
  })
})
