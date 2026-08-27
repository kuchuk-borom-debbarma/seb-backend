/**
 * What the programme will accept as a document, decided before anything opens
 * it.
 *
 * Four claims arrive with an upload — a size, a type, a name and a checksum —
 * and every one of them is the applicant's word. This is where each is turned
 * into something checked: the size and checksum against what the store
 * actually holds, the type against the file's own first bytes, and the name
 * against what a browser will be told to save it as.
 *
 * The signature check is the one that matters most. **A declared type is a
 * claim; the first bytes are evidence** — an executable renamed `report.pdf`
 * passes every other check here.
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  createDocumentObjectKey,
  extensionMatchesContentType,
  MAX_DOCUMENT_BYTES,
  sanitizeFilename,
  validSha256Base64,
  verifyUploadedObject,
  type AllowedContentType,
} from '../../src/services/application/uploads'
import type { StorageBackend } from '../../src/services/storage'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CHECKSUM = `${'A'.repeat(43)}=`

/** A store holding exactly one object, described however the test needs. */
const holding = (
  described: { sizeBytes: number; contentType: string | null } | null,
  prefix: Uint8Array | null,
  checksumSha256: string = CHECKSUM,
): StorageBackend => ({
  name: 'local',
  authorizeUpload: async () => { throw new Error('not used') },
  authorizeDownload: async () => { throw new Error('not used') },
  describe: async () => (described ? { ...described, checksumSha256 } : null),
  readPrefix: async () => prefix,
}) as unknown as StorageBackend

const authorized = {
  objectKey: 'applications/a/documents/DPR/b',
  contentType: 'application/pdf' as AllowedContentType,
  sizeBytes: PDF.byteLength,
  checksumSha256: CHECKSUM,
}

describe('whether what arrived is what was promised', () => {
  it('accepts an object matching every claim made about it', async () => {
    const backend = holding({ sizeBytes: PDF.byteLength, contentType: 'application/pdf' }, PDF)
    expect(await verifyUploadedObject(backend, authorized)).toEqual({ valid: true })
  })

  it('refuses an object the store does not have', async () => {
    expect(await verifyUploadedObject(holding(null, null), authorized))
      .toEqual({ valid: false, message: 'The uploaded object was not found.' })
  })

  it.each([
    ['larger than authorized', PDF.byteLength + 1],
    ['smaller than authorized', PDF.byteLength - 1],
    ['empty', 0],
  ])('refuses an object %s', async (_name, sizeBytes) => {
    const backend = holding({ sizeBytes, contentType: 'application/pdf' }, PDF)
    expect(await verifyUploadedObject(backend, authorized)).toEqual({
      valid: false,
      message: 'The uploaded file size does not match the authorization.',
    })
  })

  it('refuses an object past the programme’s own limit however it was authorized', async () => {
    const huge = { ...authorized, sizeBytes: MAX_DOCUMENT_BYTES + 1 }
    const backend = holding(
      { sizeBytes: MAX_DOCUMENT_BYTES + 1, contentType: 'application/pdf' }, PDF,
    )
    expect((await verifyUploadedObject(backend, huge)).valid).toBe(false)
  })

  it('refuses an object the store says is a different type', async () => {
    const backend = holding({ sizeBytes: PDF.byteLength, contentType: 'image/png' }, PDF)
    expect(await verifyUploadedObject(backend, authorized)).toEqual({
      valid: false,
      message: 'The uploaded file type does not match the authorization.',
    })
  })

  /*
   * A store that keeps no type says so with `null`, and treating that as a
   * mismatch would refuse every document it holds. Nothing is waived: the
   * signature check below reads the actual bytes.
   */
  it('accepts an object from a store that records no type at all', async () => {
    const backend = holding({ sizeBytes: PDF.byteLength, contentType: null }, PDF)
    expect(await verifyUploadedObject(backend, authorized)).toEqual({ valid: true })
  })

  /*
   * The store computes this on write, so a mismatch means the bytes that
   * landed are not the bytes the applicant said they were sending.
   */
  it('refuses an object whose stored checksum is not the one declared', async () => {
    const backend = holding(
      { sizeBytes: PDF.byteLength, contentType: 'application/pdf' }, PDF, `${'B'.repeat(43)}=`,
    )
    expect(await verifyUploadedObject(backend, authorized)).toEqual({
      valid: false,
      message: 'The uploaded file checksum does not match.',
    })
  })

  it('refuses an object whose first bytes cannot be read', async () => {
    const backend = holding({ sizeBytes: PDF.byteLength, contentType: 'application/pdf' }, null)
    expect(await verifyUploadedObject(backend, authorized)).toEqual({
      valid: false,
      message: 'The uploaded file could not be inspected.',
    })
  })

  /**
   * The claim against the evidence.
   *
   * Every case here passes the size, type and name checks and is refused only
   * because the bytes are not what they say they are.
   */
  it.each([
    ['application/pdf', JPEG],
    ['image/jpeg', PNG],
    ['image/png', PDF],
    ['application/pdf', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
  ] as const)('refuses bytes that are not a %s', async (contentType, bytes) => {
    const backend = holding({ sizeBytes: bytes.byteLength, contentType }, bytes)
    expect(await verifyUploadedObject(backend, {
      ...authorized, contentType, sizeBytes: bytes.byteLength,
    })).toEqual({
      valid: false,
      message: 'The uploaded file content does not match its type.',
    })
  })

  it.each([
    ['application/pdf', PDF],
    ['image/jpeg', JPEG],
    ['image/png', PNG],
  ] as const)('accepts bytes that really are a %s', async (contentType, bytes) => {
    const backend = holding({ sizeBytes: bytes.byteLength, contentType }, bytes)
    expect(await verifyUploadedObject(backend, {
      ...authorized, contentType, sizeBytes: bytes.byteLength,
    })).toEqual({ valid: true })
  })

  // Too few bytes to tell. Refused rather than guessed: a truncated file is
  // not a file this programme can say anything about.
  it.each([
    ['application/pdf', new Uint8Array([0x25, 0x50])],
    ['image/jpeg', new Uint8Array([0xff])],
    ['image/png', new Uint8Array([0x89, 0x50, 0x4e])],
  ] as const)('refuses a %s too short to identify', async (contentType, bytes) => {
    const backend = holding({ sizeBytes: bytes.byteLength, contentType }, bytes)
    expect((await verifyUploadedObject(backend, {
      ...authorized, contentType, sizeBytes: bytes.byteLength,
    })).valid).toBe(false)
  })

  it('covers every type the programme accepts', () => {
    expect([...ALLOWED_DOCUMENT_CONTENT_TYPES].sort())
      .toEqual(['application/pdf', 'image/jpeg', 'image/png'])
  })
})

describe('the name a document is stored and served under', () => {
  it.each([
    ['report.pdf', 'application/pdf'],
    ['annual.report.2026.pdf', 'application/pdf'],
    ['SCAN.PDF', 'application/pdf'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.png', 'image/png'],
  ] as const)('accepts %s as a %s', (filename, contentType) => {
    expect(extensionMatchesContentType(filename, contentType)).toBe(true)
  })

  /*
   * `report.pdf.exe` is the case this exists for: it passes the declared type
   * and the signature check is about the bytes, not the name a browser will
   * offer to save it as.
   */
  it.each([
    ['report.pdf.exe', 'application/pdf'],
    ['report', 'application/pdf'],
    ['report.', 'application/pdf'],
    ['.pdf', 'application/pdf'],
    ['photo.png', 'application/pdf'],
    ['photo.jpg', 'image/png'],
  ] as const)('refuses %s as a %s', (filename, contentType) => {
    expect(extensionMatchesContentType(filename, contentType)).toBe(false)
  })

  it('strips what would make a name mean something to a filesystem', () => {
    expect(sanitizeFilename('../../etc/passwd.pdf')).toBe('.._.._etc_passwd.pdf')
    expect(sanitizeFilename('C:\\Users\\me\\plan.pdf')).toBe('C:_Users_me_plan.pdf')
  })

  it('removes control characters rather than replacing them', () => {
    // Removed, not turned into `_`: a name is not improved by preserving the
    // place where somebody tried to inject a line break.
    expect(sanitizeFilename('plan\r\n\u0000.pdf')).toBe('plan.pdf')
  })

  it.each([['   '], [''], ['\u0000\u0001']])('refuses a name of nothing (%s)', (given) => {
    expect(sanitizeFilename(given)).toBeNull()
  })

  it('refuses a name past 255 characters', () => {
    expect(sanitizeFilename(`${'a'.repeat(252)}.pdf`)).toBeNull()
    expect(sanitizeFilename(`${'a'.repeat(251)}.pdf`)).toBe(`${'a'.repeat(251)}.pdf`)
  })
})

describe('the checksum an applicant declares', () => {
  it('accepts a base64 SHA-256', () => {
    expect(validSha256Base64(`${'A'.repeat(43)}=`)).toBe(true)
    expect(validSha256Base64('n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=')).toBe(true)
  })

  it.each([
    ['one character short', `${'A'.repeat(42)}=`],
    ['one too long', `${'A'.repeat(44)}=`],
    ['unpadded', 'A'.repeat(43)],
    ['url-safe base64, which is a different encoding', `${'-'.repeat(43)}=`],
    ['not base64 at all', `${'!'.repeat(43)}=`],
    ['empty', ''],
  ])('refuses one %s', (_name, given) => {
    expect(validSha256Base64(given)).toBe(false)
  })
})

describe('where a document is kept', () => {
  it('puts the application and the slot in the key, and nothing guessable after', () => {
    const key = createDocumentObjectKey('app-1', 'DPR' as never)
    expect(key).toMatch(
      /^applications\/app-1\/documents\/DPR\/[0-9a-f-]{36}$/u,
    )
  })

  it('never returns the same key twice for one slot', () => {
    const first = createDocumentObjectKey('app-1', 'DPR' as never)
    const second = createDocumentObjectKey('app-1', 'DPR' as never)
    // Replacing a document must not overwrite the version it replaced: the
    // old bytes stay reachable for as long as the old version does.
    expect(first).not.toBe(second)
  })
})
