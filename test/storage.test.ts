/**
 * The storage seam.
 *
 * Written against the interface, never against a vendor. Documents have to be
 * uploadable on a machine with no bucket and no credentials, and they have to
 * behave identically once there is one — so most of what is asserted here is
 * that the two backends are indistinguishable to a caller, and that the local
 * path is firmly closed everywhere else.
 */
import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/bindings'
import { createDatabase } from '../src/db'
import {
  objectReader,
  objectStore,
  relaysThroughWorker,
  storage,
  usesLocalStorage,
} from '../src/services/storage'
import { handleLocalStorageRequest } from '../src/services/storage/route'
import { base64FromBytes } from '../src/services/storage/policy'

describe('storage on a machine with no bucket', () => {
  /*
   * Uploads have to work locally. Signing addresses the real bucket, so it
   * needs credentials — but the STORAGE binding works locally on its own, so
   * the bytes come to the Worker instead and it writes them. These prove the
   * round trip, and that the path is closed everywhere else.
   */
  const ORIGIN = 'http://localhost:9999'
  const bindings = (extra: Partial<AppBindings> = {}) =>
    ({ ...env, ...extra }) as AppBindings
  const context = (extra: Partial<AppBindings> = {}) =>
    ({ db: createDatabase(env.DB), env: bindings(extra) })

  it('sends the browser to the Worker rather than to a bucket', async () => {
    const backend = storage(bindings(), `${ORIGIN}/graphql`)
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
    const backend = storage(bindings({ ENVIRONMENT: 'develop' }), `${ORIGIN}/graphql`)
    expect(backend.name).toBe('r2')
  })

  it('refuses rather than accepting documents it cannot durably keep', () => {
    // Deployed and unconfigured. Falling back to the Worker's own bucket would
    // take an applicant's evidence into storage that may not exist.
    expect(() =>
      storage(bindings({ ENVIRONMENT: 'develop', R2_ACCESS_KEY_ID: undefined }), `${ORIGIN}/graphql`),
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

  /*
   * The browser uploads to a different origin than the page it is on — the
   * page is the client's, the bytes go to the bucket's. Locally this Worker
   * stands in for the bucket, so it has to answer the preflight a bucket's CORS
   * policy would. Without it the upload never leaves the page, and nothing
   * below the browser can tell: the API is fine, the PUT is simply never sent.
   */
  describe('the preflight the browser sends first', () => {
    const preflight = (origin: string) =>
      SELF.fetch('https://api.example.test/internal/storage/uploads/anything', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type,content-disposition',
        },
      })

    it('authorizes the upload the authorization asked the caller to make', async () => {
      const response = await preflight('https://app.example.test')
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin'))
        .toBe('https://app.example.test')
      expect(response.headers.get('access-control-allow-methods')).toContain('PUT')
      // Exactly the two headers issueDocumentUpload asks for. Content-Length is
      // generated by the browser from the body and is never preflighted.
      const allowed = response.headers.get('access-control-allow-headers') ?? ''
      expect(allowed).toContain('Content-Type')
      expect(allowed).toContain('Content-Disposition')
    })

    it('refuses an origin nobody trusts', async () => {
      expect((await preflight('https://attacker.example')).status).toBe(403)
    })

    it('is guarded by the same predicate as the handler it precedes', () => {
      /*
       * Not reachable through SELF: the worker behind it reads its own
       * configuration, so a cloudinary environment cannot be simulated over
       * HTTP. What can be asserted is the thing the bug actually was — the
       * preflight was guarded on "is this local" while the PUT it precedes was
       * guarded on "does this relay". Cloudinary relays without being local, so
       * the PUT handler was open and the preflight 404'd, and the upload died
       * in the browser before the API ever saw it.
       */
      const cloudinary = bindings({
        ENVIRONMENT: 'production',
        STORAGE_TRANSPORT: 'cloudinary',
        CLOUDINARY_CLOUD_NAME: 'c',
        CLOUDINARY_API_KEY: 'k',
        CLOUDINARY_API_SECRET: 's',
      })
      expect(relaysThroughWorker(cloudinary)).toBe(true)
      expect(usesLocalStorage(cloudinary)).toBe(false)
    })

    it('answers the request itself with the headers too', async () => {
      // A preflight only authorizes sending. Without them on the answer the
      // browser withholds it from the page, and the upload looks like a failure
      // that never happened.
      const response = await SELF.fetch(
        'https://api.example.test/internal/storage/uploads/never-issued',
        {
          method: 'PUT',
          headers: { Origin: 'https://app.example.test', 'content-type': 'application/pdf' },
          body: new Uint8Array([1]),
        },
      )
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin'))
        .toBe('https://app.example.test')
    })
  })


  it('serves a stored object as an attachment, and never inline', async () => {
    // The download half of the local backend. Attachment-only matters as much
    // here as it does on a signed URL: a PDF or an image rendered inline is a
    // script-execution surface on the portal's own origin.
    const key = `served/${crypto.randomUUID()}`
    await env.STORAGE.put(key, new TextEncoder().encode('%PDF-1.7 served'))

    const response = await SELF.fetch(
      `https://api.example.test/internal/storage/objects?key=${encodeURIComponent(key)}`,
    )
    expect(response.status).toBe(200)
    // No filename was asked for and none was stored, so it falls back rather
    // than serving an object with no name at all.
    expect(response.headers.get('content-disposition'))
      .toBe('attachment; filename="document"')
    // And no stored content type, so the most inert one.
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.text()).toContain('%PDF')
  })

  it('measures the body even when nothing declared its length', async () => {
    /*
     * A streamed request carries no Content-Length, so the cheap check before
     * buffering cannot apply. The measurement after buffering is what actually
     * binds the size, and this is the path that proves it still does.
     */
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('far more than was authorized'))
        controller.close()
      },
    })
    const response = await handleLocalStorageRequest(
      new Request('https://api.example.test/internal/storage/uploads/anything', {
        method: 'PUT',
        body: streamed,
        // @ts-expect-error duplex is required for a streaming body and is not
        // in the DOM types the Worker build uses.
        duplex: 'half',
      }),
      context(),
    )
    // Refused, because no such authorization exists — reached without the
    // length check having anything to work with.
    expect(response?.status).toBe(403)
  })


  it('refuses an upload address with no id in it', async () => {
    // `/uploads/` with nothing after it. Slicing the path would otherwise give
    // an empty id and send it to the database as a real lookup.
    const response = await handleLocalStorageRequest(
      new Request('https://api.example.test/internal/storage/uploads/', {
        method: 'PUT',
        body: new Uint8Array([1]),
      }),
      context(),
    )
    expect(response?.status).toBe(404)
  })

  it('refuses a download that names no object', async () => {
    const response = await handleLocalStorageRequest(
      new Request('https://api.example.test/internal/storage/objects'),
      context(),
    )
    expect(response?.status).toBe(404)
  })

  it('leaves requests that are not its own alone', async () => {
    expect(await handleLocalStorageRequest(
      new Request('http://localhost:9999/graphql'), context(),
    )).toBeNull()
  })
})

describe('what a backend reports about an object', () => {
  /*
   * `describe` and `readPrefix` are what let the application check a document
   * without ever holding a bucket. Both backends answer identically, which is
   * the property that matters: verification must not have a different meaning
   * locally than it does deployed.
   */
  const ORIGIN = 'http://localhost:9999'
  const bindings = (extra: Partial<AppBindings> = {}) => ({ ...env, ...extra }) as AppBindings
  const deployed = () =>
    storage(bindings({ ENVIRONMENT: 'develop' }), `${ORIGIN}/graphql`)
  const local = () => storage(bindings(), `${ORIGIN}/graphql`)

  it('reports size, type and checksum for a stored object', async () => {
    const key = `facts/${crypto.randomUUID()}`
    const bytes = new TextEncoder().encode('%PDF-1.7 tiny')
    const sha256 = await crypto.subtle.digest('SHA-256', bytes)
    await env.STORAGE.put(key, bytes, {
      sha256,
      httpMetadata: { contentType: 'application/pdf' },
    })

    // Both backends read through the binding, so both must agree.
    for (const backend of [local(), deployed()]) {
      const facts = await backend.describe(key)
      expect(facts?.sizeBytes, backend.name).toBe(bytes.byteLength)
      expect(facts?.contentType, backend.name).toBe('application/pdf')
      expect(facts?.checksumSha256, backend.name).toBeTruthy()
    }
  })

  it('reports nothing at all for an object that is not there', async () => {
    for (const backend of [local(), deployed()]) {
      expect(await backend.describe(`missing/${crypto.randomUUID()}`), backend.name)
        .toBeNull()
      expect(await backend.readPrefix(`missing/${crypto.randomUUID()}`, 8), backend.name)
        .toBeNull()
    }
  })

  it('reads only the first bytes, which is all a signature check needs', async () => {
    const key = `prefix/${crypto.randomUUID()}`
    await env.STORAGE.put(key, new TextEncoder().encode('%PDF-1.7 and a great deal more'))
    for (const backend of [local(), deployed()]) {
      const bytes = await backend.readPrefix(key, 5)
      expect(new TextDecoder().decode(bytes!), backend.name).toBe('%PDF-')
    }
  })

  it('reports no checksum when the object was stored without one', async () => {
    // R2 records a digest for uploads that declare one. An object stored
    // without is a real state, and must read as "unknown" rather than as a
    // mismatch that looks like tampering.
    const key = `nodigest/${crypto.randomUUID()}`
    await env.STORAGE.put(key, new TextEncoder().encode('x'))
    for (const backend of [local(), deployed()]) {
      expect((await backend.describe(key))?.checksumSha256, backend.name).toBeNull()
    }
  })

  it('answers which environment keeps documents where', () => {
    for (const environment of [undefined, '', 'local', 'LOCAL', '  ']) {
      expect(usesLocalStorage(bindings({ ENVIRONMENT: environment }))).toBe(true)
    }
    for (const environment of ['develop', ' Develop ', 'production']) {
      expect(usesLocalStorage(bindings({ ENVIRONMENT: environment }))).toBe(false)
    }
  })
})

describe('storage in Cloudinary', () => {
  /*
   * Cloudinary takes a signed multipart POST rather than a signed URL, so the
   * Worker relays the bytes. What is asserted here is that relaying does not
   * loosen anything: the grant a caller sees is the same shape as every other
   * backend's, no provider URL escapes, and an upload the provider refuses is a
   * failure rather than a silent success.
   */
  const ORIGIN = 'http://localhost:9999'
  const configured = {
    ENVIRONMENT: 'develop',
    STORAGE_TRANSPORT: 'cloudinary',
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
  }
  const bindings = (extra: Partial<AppBindings> = {}) =>
    ({ ...env, ...configured, ...extra }) as AppBindings
  const backend = (extra: Partial<AppBindings> = {}) =>
    storage(bindings(extra), `${ORIGIN}/graphql`)

  it('is chosen only when named, and r2 remains the default', () => {
    expect(backend().name).toBe('cloudinary')
    for (const named of [undefined, '', '  ', 'r2', ' R2 ']) {
      expect(
        storage(bindings({ STORAGE_TRANSPORT: named }), `${ORIGIN}/graphql`).name,
        String(named),
      ).toBe('r2')
    }
  })

  it('refuses an unrecognised provider rather than picking one', () => {
    expect(() => backend({ STORAGE_TRANSPORT: 'gcs' })).toThrow(
      'STORAGE_TRANSPORT must be either "r2" or "cloudinary".',
    )
  })

  it('refuses rather than accepting documents it cannot durably keep', () => {
    for (const missing of [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ]) {
      expect(() => backend({ [missing]: undefined }), missing).toThrow(
        'Cloudinary configuration is required.',
      )
    }
  })

  it('hands out this Worker rather than the provider, in both directions', async () => {
    const grant = await backend().authorizeUpload({
      uploadId: 'upload-xyz',
      objectKey: 'applications/a/DPR/1',
      originalFilename: 'plan.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4,
      checksumSha256: `${'A'.repeat(43)}=`,
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    })
    expect(grant.uploadUrl).toBe(
      'http://localhost:9999/internal/storage/uploads/upload-xyz',
    )
    expect(grant.requiredHeaders.map((header) => header.name)).toEqual([
      'Content-Type',
      'Content-Disposition',
      'Content-Length',
    ])

    const download = await backend().authorizeDownload(
      'applications/a/DPR/1',
      'plan.pdf',
      new Date('2026-01-01T00:00:00Z'),
    )
    // The whole point: a browser never learns where the file actually is.
    expect(download.downloadUrl).toContain(ORIGIN)
    expect(download.downloadUrl).not.toContain('cloudinary')
  })
})

describe('relaying bytes to Cloudinary', () => {
  /*
   * The provider is stubbed. What matters is not that `fetch` was called but
   * what it was called with: an upload the provider could actually verify, and
   * a refusal that never quotes the request back, because the request carries a
   * signature.
   */
  const configured = {
    ENVIRONMENT: 'develop',
    STORAGE_TRANSPORT: 'cloudinary',
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
  }
  const bindings = () => ({ ...env, ...configured }) as AppBindings
  const backend = () => storage(bindings(), 'http://localhost:9999/graphql')

  afterEach(() => vi.unstubAllGlobals())

  /** Records every call, and answers with whatever the test supplies. */
  const stubFetch = (reply: () => Response) => {
    const calls: Array<{ url: string; request: RequestInit | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, request?: RequestInit) => {
      calls.push({ url: String(url), request })
      return reply()
    })
    return calls
  }

  it('signs the upload with everything the provider will verify', async () => {
    const calls = stubFetch(() => new Response('{}', { status: 200 }))
    await objectStore(bindings()).put(
      'applications/a/DPR/1',
      new TextEncoder().encode('hello').buffer as ArrayBuffer,
      { contentType: 'application/pdf' },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.cloudinary.com/v1_1/test-cloud/raw/upload')
    const form = calls[0]!.request!.body as FormData
    expect(form.get('public_id')).toBe('applications/a/DPR/1')
    // Unreachable without a signature. A default upload is readable by anyone
    // holding the link, and this evidence includes identity documents.
    expect(form.get('type')).toBe('authenticated')
    expect(form.get('api_key')).toBe('test-key')
    expect(String(form.get('signature'))).toMatch(/^[0-9a-f]{40}$/u)
    // The secret signs the request and must never travel in it.
    expect([...form.keys()]).not.toContain('api_secret')
  })

  it('treats a refused upload as a failure, and does not quote the request', async () => {
    stubFetch(() => new Response('signature mismatch for api_key=test-key', { status: 401 }))
    await expect(
      objectStore(bindings()).put(
        'applications/a/DPR/1',
        new TextEncoder().encode('hello').buffer as ArrayBuffer,
        { contentType: 'application/pdf' },
      ),
    ).rejects.toThrow(/^Cloudinary refused the upload \(401\)\.$/u)
  })

  it('describes an object by what actually came back', async () => {
    const calls = stubFetch(
      () =>
        new Response(new TextEncoder().encode('hello'), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
    )
    const facts = await backend().describe('applications/a/DPR/1')

    // Signed, and pointed at the authenticated delivery path.
    expect(calls[0]!.url).toMatch(
      /^https:\/\/res\.cloudinary\.com\/test-cloud\/raw\/authenticated\/s--[\w-]{8}--\/applications\/a\/DPR\/1$/u,
    )
    /*
     * Null rather than what delivery echoed. A `raw` asset comes back as
     * `application/octet-stream` whatever went up, so reporting the header
     * would tell finalization every document is the wrong type — which refused
     * every upload until it was caught against the real provider.
     */
    expect(facts).toMatchObject({ sizeBytes: 5, contentType: null })
    /*
     * Cloudinary records no SHA-256, so it is computed from the bytes returned.
     * A null here would make finalization's comparison against the applicant's
     * declaration pass silently, which is the one thing it exists to stop.
     */
    expect(facts?.checksumSha256).toBe(
      base64FromBytes(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello')),
      ),
    )
  })

  it('reads only the prefix a caller asked for', async () => {
    stubFetch(() => new Response(new TextEncoder().encode('%PDF-1.7 rest')))
    expect(await backend().readPrefix('applications/a/DPR/1', 5)).toEqual(
      new TextEncoder().encode('%PDF-'),
    )
  })

  it('reports a missing object as missing rather than as an error', async () => {
    stubFetch(() => new Response('not found', { status: 404 }))
    expect(await backend().describe('applications/a/gone/1')).toBeNull()
    expect(await backend().readPrefix('applications/a/gone/1', 5)).toBeNull()
    expect(await objectStore(bindings()).get('applications/a/gone/1')).toBeNull()
  })
})

describe('reading an object under any transport', () => {
  /*
   * `objectStore` exists for the relaying route and is documented as never
   * being asked about R2 — that store is only reached when the browser talks to
   * this Worker rather than to the provider. `objectReader` has no such luxury:
   * the malware scanner must fetch bytes under every transport, including the
   * one where uploads bypass this Worker entirely. So each transport is
   * exercised here, and R2 is the one that would have thrown.
   */
  const bindings = (extra: Partial<AppBindings> = {}) => ({ ...env, ...extra }) as AppBindings

  afterEach(() => vi.unstubAllGlobals())

  const stored = async (body: string) => {
    const key = `reader/${crypto.randomUUID()}`
    await env.STORAGE.put(key, new TextEncoder().encode(body), {
      httpMetadata: { contentType: 'application/pdf' },
    })
    return key
  }

  it('reads through the binding locally', async () => {
    const key = await stored('local bytes')
    const object = await objectReader(bindings()).get(key)
    expect(await object!.text()).toBe('local bytes')
    expect(object!.headers.get('content-type')).toBe('application/pdf')
  })

  it('reads through the binding under r2, where objectStore would refuse', async () => {
    const key = await stored('r2 bytes')
    const r2 = bindings({ ENVIRONMENT: 'develop', STORAGE_TRANSPORT: 'r2' })
    expect(await (await objectReader(r2).get(key))!.text()).toBe('r2 bytes')
    // The distinction this function exists for.
    expect(() => objectStore(r2)).toThrowError()
  })

  it('reads from the provider under cloudinary', async () => {
    vi.stubGlobal('fetch', async () => new Response('cloudinary bytes'))
    const object = await objectReader(bindings({
      ENVIRONMENT: 'develop',
      STORAGE_TRANSPORT: 'cloudinary',
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
    })).get('applications/a/DPR/1')
    expect(await object!.text()).toBe('cloudinary bytes')
  })

  it('reports an object that is not there as absent', async () => {
    expect(await objectReader(bindings()).get(`missing/${crypto.randomUUID()}`)).toBeNull()
  })

  it('defaults a type-less object to the most inert type', async () => {
    const key = `reader/${crypto.randomUUID()}`
    await env.STORAGE.put(key, new TextEncoder().encode('no type'))
    const object = await objectReader(bindings()).get(key)
    expect(object!.headers.get('content-type')).toBe('application/octet-stream')
    /*
     * Read even though the header is what is being asserted. The response wraps
     * the R2 object's stream, and leaving it unconsumed holds the bucket open —
     * isolated storage then cannot unwind after the test and the whole file
     * fails with "unable to pop R2 storage", nowhere near the cause.
     */
    expect(await object!.text()).toBe('no type')
  })
})
