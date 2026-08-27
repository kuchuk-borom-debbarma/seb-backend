/**
 * The two upload checks that need a real bucket.
 *
 * Everything else about uploads is pure and lives in the service suite. These
 * two do not: one signs against R2's own configuration, the other reads back a
 * stored object to verify its size, type, checksum and magic bytes. A mock
 * bucket would make both assert the mock.
 */
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { AppBindings } from '../../src/bindings'
import { storage } from '../../src/services/storage'
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  verifyUploadedObject,
} from '../../src/services/application/uploads'

// Says it is deployed, because signing is what a deployed environment does.
// Locally the bytes come to the Worker and nothing is signed.
const signingBackend = (extra: Record<string, unknown> = {}) =>
  storage(
    { ...env, ENVIRONMENT: 'develop', ...extra } as unknown as AppBindings,
    'https://api.example.test/graphql',
  )

/** Both forms a checksum is needed in: the bucket wants bytes, the API base64. */
const digest = async (bytes: Uint8Array) => {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const value = await crypto.subtle.digest('SHA-256', input)
  return {
    buffer: value,
    base64: btoa(String.fromCharCode(...new Uint8Array(value))),
  }
}

describe('uploads, against a real bucket', () => {
  it('signs private upload and attachment-only download authorizations', async () => {
    const backend = signingBackend()
    const checksum = 'A'.repeat(43) + '='
    const upload = await backend.authorizeUpload({
      uploadId: 'upload-1',
      objectKey: 'applications/a/documents/DPR/object',
      originalFilename: 'DPR “final”.pdf',
      contentType: ALLOWED_DOCUMENT_CONTENT_TYPES[0],
      sizeBytes: 1234,
      checksumSha256: checksum,
      expiresAt: new Date('2026-08-22T10:10:00Z'),
    })

    expect(upload.uploadUrl).toContain('X-Amz-Signature=')
    expect(upload.requiredHeaders).toEqual(expect.arrayContaining([
      { name: 'If-None-Match', value: '*' },
      { name: 'Content-Length', value: '1234' },
      { name: 'x-amz-checksum-sha256', value: checksum },
    ]))
    expect(new URL(upload.uploadUrl).searchParams.get('X-Amz-SignedHeaders'))
      .toContain('content-length')
    expect(upload.requiredHeaders.find((item) => item.name === 'Content-Disposition')?.value)
      .not.toContain('“')
    const download = await backend.authorizeDownload(
      'applications/a/documents/DPR/object',
      'project-report.pdf',
      new Date('2026-08-22T10:00:00Z'),
    )
    expect(download.downloadUrl).toContain('X-Amz-Signature=')
    expect(new URL(download.downloadUrl).searchParams.get('response-content-disposition'))
      .toBe('attachment; filename="project-report.pdf"')
    expect(download.expiresAt.toISOString()).toBe('2026-08-22T10:05:00.000Z')
    // A deployed environment missing its credentials refuses rather than
    // quietly accepting documents it cannot durably keep.
    expect(() => signingBackend({ R2_ACCESS_KEY_ID: undefined }))
      .toThrow('R2 signing configuration is required.')
  })

  it('verifies size, MIME, checksum, and magic bytes against private R2', async () => {
    const key = `unit/${crypto.randomUUID()}`
    const bytes = new TextEncoder().encode('%PDF-valid')
    const checksum = await digest(bytes)
    await env.STORAGE.put(key, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      sha256: checksum.buffer,
    })
    expect(await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
      objectKey: key,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: checksum.base64,
    })).toEqual({ valid: true })
    expect((await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
      objectKey: 'missing',
      contentType: 'application/pdf',
      sizeBytes: 1,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
    expect((await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
      objectKey: key,
      contentType: 'application/pdf',
      sizeBytes: MAX_DOCUMENT_BYTES,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
    expect((await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
      objectKey: key,
      contentType: 'image/png',
      sizeBytes: bytes.length,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
    expect((await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
      objectKey: key,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: 'B'.repeat(43) + '=',
    })).valid).toBe(false)

    const fakePdfKey = `unit/${crypto.randomUUID()}`
    const fakeBytes = new TextEncoder().encode('not-a-pdf')
    const fakeChecksum = await digest(fakeBytes)
    await env.STORAGE.put(fakePdfKey, fakeBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      sha256: fakeChecksum.buffer,
    })
    expect((await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
      objectKey: fakePdfKey,
      contentType: 'application/pdf',
      sizeBytes: fakeBytes.length,
      checksumSha256: fakeChecksum.base64,
    })).valid).toBe(false)

    for (const [contentType, fileBytes] of [
      ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0x01])],
      ['image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ] as const) {
      const imageKey = `unit/${crypto.randomUUID()}`
      const imageChecksum = await digest(fileBytes)
      await env.STORAGE.put(imageKey, fileBytes, {
        httpMetadata: { contentType },
        sha256: imageChecksum.buffer,
      })
      expect(await verifyUploadedObject(storage(env as unknown as AppBindings, 'https://api.example.test/graphql'), {
        objectKey: imageKey,
        contentType,
        sizeBytes: fileBytes.length,
        checksumSha256: imageChecksum.base64,
      })).toEqual({ valid: true })
    }

    // A backend that can describe an object but not read it back. Rare, and
    // the answer must still be a refusal rather than an unchecked pass.
    const uninspectable = {
      ...storage(env as unknown as AppBindings, 'https://api.example.test/graphql'),
      describe: async () => ({
        sizeBytes: 1,
        contentType: 'application/pdf',
        checksumSha256: checksum.base64,
      }),
      readPrefix: async () => null,
    }
    expect((await verifyUploadedObject(uninspectable, {
      objectKey: 'object',
      contentType: 'application/pdf',
      sizeBytes: 1,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
  })
})
