/**
 * The notification seam.
 *
 * These tests are written against the interface, never against a provider.
 * That is the point: if the seam is real, a test can name `NotificationTransport`
 * and a stub, and never mention Pingram outside the one file that adapts to it.
 *
 * What is worth asserting here is not that an HTTP call was made. It is that a
 * deployed environment cannot silently fall back to printing one-time codes,
 * and that a provider failure cannot carry its own words into a log.
 */
import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/bindings'
import { createDatabase } from '../src/db'
import { handleLocalStorageRequest } from '../src/services/application/local-storage-route'
import { storage } from '../src/services/application/storage'
import type { ApplicationOperationContext } from '../src/services/application/types'
import {
  notificationTransport,
  type Delivery,
  type NotificationTransport,
} from '../src/services/external-notification'
import { DEV_EMAIL_PREFIX } from '../src/services/external-notification/transports/console'
import { pingramTransport } from '../src/services/external-notification/transports/pingram'

const bindings = (extra: Partial<AppBindings> = {}) => extra as AppBindings

const message = {
  to: 'rina@example.test',
  subject: 'Your applicant signup code',
  body: 'Your applicant signup code is 123456. It expires in 10 minutes.',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('choosing a transport', () => {
  it('prints locally, and treats an unconfigured machine as local', () => {
    for (const environment of [undefined, '', 'local', 'LOCAL', '  ']) {
      expect(notificationTransport(bindings({ ENVIRONMENT: environment })).name)
        .toBe('console')
    }
  })

  it('delivers for real once the environment says it is deployed', () => {
    const env = bindings({
      ENVIRONMENT: 'develop',
      PINGRAM_API_KEY: 'pingram_sk_test',
      PINGRAM_NOTIFICATION_TYPE: 'applicant-signup-otp',
    })
    expect(notificationTransport(env).name).toBe('pingram')

    // Case and stray whitespace in configuration are a deployment mistake, not
    // a reason to quietly print one-time codes to a log.
    expect(notificationTransport({ ...env, ENVIRONMENT: ' Develop ' }).name)
      .toBe('pingram')
  })

  it('refuses rather than falling back to printing codes', () => {
    /*
     * The failure that matters. A deployed environment missing its credentials
     * must not degrade to the console transport — that writes one-time codes
     * into logs, which is the one thing this service must never do. Refusing
     * reaches the applicant as "the code could not be sent", which is true.
     */
    for (const partial of [
      {},
      { PINGRAM_API_KEY: 'pingram_sk_test' },
      { PINGRAM_NOTIFICATION_TYPE: 'applicant-signup-otp' },
      { PINGRAM_API_KEY: '   ', PINGRAM_NOTIFICATION_TYPE: 'applicant-signup-otp' },
    ]) {
      expect(() => notificationTransport(bindings({ ENVIRONMENT: 'develop', ...partial })))
        .toThrowError(/not configured for the develop environment/u)
    }
  })
})

describe('any transport, through the interface alone', () => {
  /** A stub. Nothing here knows which real transport it stands in for. */
  const stub = (result: Promise<Delivery>): NotificationTransport => ({
    name: 'stub',
    send: () => result,
  })

  it('resolves with a reference somebody can quote, or with none', async () => {
    await expect(stub(Promise.resolve({ reference: 'abc123' })).send(message))
      .resolves.toEqual({ reference: 'abc123' })
    await expect(stub(Promise.resolve({ reference: null })).send(message))
      .resolves.toEqual({ reference: null })
  })

  it('throwing is how a transport says it could not accept the message', async () => {
    await expect(stub(Promise.reject(new Error('nope'))).send(message)).rejects.toThrow()
  })
})

describe('the console transport', () => {
  it('marks its line so the harness can find it by position, not by shape', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const delivery = await notificationTransport(bindings()).send(message)

    // One marked, single-line payload: the harness reads it by position.
    const line = log.mock.calls[0]![0] as string
    expect(line.startsWith(`${DEV_EMAIL_PREFIX} `)).toBe(true)
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line.slice(DEV_EMAIL_PREFIX.length + 1))).toEqual({
      to: message.to,
      subject: message.subject,
      text: message.body,
    })
    // Nothing was sent, so there is nothing to quote.
    expect(delivery.reference).toBeNull()
  })
})

describe('the provider adapter', () => {
  const transport = pingramTransport({
    apiKey: 'pingram_sk_secret_value',
    notificationType: 'applicant-signup-otp',
  })

  it('sends what the provider asks for, and nothing the caller wrote', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ trackingId: 'trk_1' }), { status: 200 }),
    )

    const delivery = await transport.send(message)
    expect(delivery).toEqual({ reference: 'trk_1' })

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://api.pingram.io/email')
    expect((init?.headers as Record<string, string>).authorization)
      .toBe('Bearer pingram_sk_secret_value')

    const body = JSON.parse(init?.body as string) as Record<string, string>
    expect(body.type).toBe('applicant-signup-otp')
    expect(body.to).toBe(message.to)
    // The programme composes plain text; the adapter is what produces markup.
    expect(body.html).toContain('123456')
    expect(body.html).toMatch(/^<p>/u)
  })

  it('escapes the message rather than letting it become markup', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ trackingId: 't' }), { status: 200 }),
    )
    await transport.send({ ...message, body: 'Bring <b>ID</b> & the form' })

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]![1]?.body as string),
    ) as Record<string, string>
    expect(body.html).toContain('&lt;b&gt;ID&lt;/b&gt; &amp; the form')
    expect(body.html).not.toContain('<b>')
  })

  it('accepts the message even when the reference cannot be read', async () => {
    // The provider took it; only the reference is unavailable. That is not a
    // delivery failure, and treating it as one would invalidate a live code.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(transport.send(message)).resolves.toEqual({ reference: null })
  })

  it('fails without repeating the key, the message, or the provider', async () => {
    /*
     * The caller logs what is thrown, and in CI those logs are public. So a
     * refusal may name the status and nothing else — not the key, not the
     * recipient, not the one-time code, and not the provider's response body,
     * which can echo the request straight back.
     */
    const leaky = JSON.stringify({
      error: { code: 'bad', message: 'to=rina@example.test code=123456' },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(leaky, { status: 401 }))

    await expect(transport.send(message)).rejects.toThrow(/did not accept the message \(401\)/u)
    const thrown = await transport.send(message).catch((error: Error) => error.message)
    for (const secret of ['pingram_sk_secret_value', 'rina@example.test', '123456']) {
      expect(thrown).not.toContain(secret)
    }
  })

  it('says nothing about the request when the provider cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`connect failed to ${message.to} with pingram_sk_secret_value`),
    )
    const thrown = await transport.send(message).catch((error: Error) => error.message)
    expect(thrown).toContain('(unreachable)')
    expect(thrown).not.toContain('pingram_sk_secret_value')
    expect(thrown).not.toContain(message.to)
  })
})

describe('storage on a machine with no bucket', () => {
  /*
   * Uploads have to work locally. Signing addresses the real bucket, so it
   * needs credentials — but the STORAGE binding works locally on its own, so
   * the bytes come to the Worker instead and it writes them. These prove the
   * round trip, and that the path is closed everywhere else.
   */
  const context = (extra: Partial<AppBindings> = {}) =>
    ({
      db: createDatabase(env.DB),
      env: { ...env, ...extra },
      requestHeaders: new Headers(),
      requestUrl: 'http://localhost:9999/graphql',
      responseHeaders: new Headers(),
    }) as unknown as ApplicationOperationContext

  it('sends the browser to the Worker rather than to a bucket', async () => {
    const backend = storage(context())
    expect(backend.name).toBe('local')

    const grant = await backend.authorizeUpload({
      uploadId: 'upload-abc',
      objectKey: 'applications/a/DPR/1',
      originalFilename: 'plan.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4,
      checksumSha256: `${'A'.repeat(43)}=`,
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    })
    expect(grant.uploadUrl).toBe(
      'http://localhost:9999/internal/storage/uploads/upload-abc',
    )
    // The same constraints a bucket would be given, re-checked on arrival.
    expect(grant.requiredHeaders.map((header) => header.name)).toEqual([
      'Content-Type',
      'Content-Disposition',
      'Content-Length',
    ])
  })

  it('signs for the bucket once the environment says it is deployed', async () => {
    const backend = storage(context({ ENVIRONMENT: 'develop' }))
    expect(backend.name).toBe('r2')
  })

  it('refuses rather than accepting documents it cannot durably keep', () => {
    // Deployed and unconfigured. Falling back to the Worker's own bucket would
    // take an applicant's evidence into storage that may not exist.
    expect(() =>
      storage(context({ ENVIRONMENT: 'develop', R2_ACCESS_KEY_ID: undefined })),
    ).toThrowError(/R2 signing configuration is required/u)
  })

  it('refuses an upload id that was never issued', async () => {
    // A missing authorization and a spent one are refused identically, so the
    // path cannot be used to discover which upload ids exist.
    const response = await handleLocalStorageRequest(
      new Request(
        `http://localhost:9999/internal/storage/uploads/${crypto.randomUUID()}`,
        { method: 'PUT', body: new Uint8Array([1]) },
      ),
      context(),
    )
    expect(response?.status).toBe(403)
  })

  it('serves nothing for an object key that does not exist', async () => {
    const response = await handleLocalStorageRequest(
      new Request('http://localhost:9999/internal/storage/objects?key=missing'),
      context(),
    )
    expect(response?.status).toBe(404)
  })

  it('accepts only the two methods it implements', async () => {
    const response = await handleLocalStorageRequest(
      new Request('http://localhost:9999/internal/storage/objects', { method: 'POST' }),
      context(),
    )
    expect(response?.status).toBe(405)
  })

  it('is closed in a deployed environment', async () => {
    // The whole security boundary of that route: it exists in the deployed
    // Worker's code and must never accept bytes there.
    const deployed = context({ ENVIRONMENT: 'develop' })
    const response = await handleLocalStorageRequest(
      new Request('http://localhost:9999/internal/storage/uploads/anything', {
        method: 'PUT',
        body: new Uint8Array([1]),
      }),
      deployed,
    )
    expect(response?.status).toBe(404)
  })

  it('leaves requests that are not its own alone', async () => {
    expect(await handleLocalStorageRequest(
      new Request('http://localhost:9999/graphql'), context(),
    )).toBeNull()
  })
})
