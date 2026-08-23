/**
 * What the programme accepts as a document, and how it is checked.
 *
 * These are the programme's rules — which types, how large, what a filename may
 * contain, what the first bytes must be. Where the file physically goes is the
 * storage service's business and is deliberately not decided here.
 */
import type { StorageBackend } from '../storage'
import type { DocumentType } from './types'

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const

export type AllowedContentType = (typeof ALLOWED_DOCUMENT_CONTENT_TYPES)[number]

export const sanitizeFilename = (value: string): string | null => {
  const filename = value
    .replace(/[/\\]/gu, '_')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
  if (filename.length < 1 || filename.length > 255) return null
  return filename
}

export const validSha256Base64 = (value: string): boolean =>
  /^[A-Za-z0-9+/]{43}=$/u.test(value)

export const createDocumentObjectKey = (
  applicationId: string,
  documentType: DocumentType,
): string => `applications/${applicationId}/documents/${documentType}/${crypto.randomUUID()}`

const fileSignatureMatches = (bytes: Uint8Array, contentType: AllowedContentType): boolean => {
  if (contentType === 'application/pdf') {
    return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
  }
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  return (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (expected, index) => bytes[index] === expected,
    )
  )
}

/**
 * Whether what arrived is what was promised.
 *
 * Takes the storage interface rather than a bucket, so the programme's rules
 * live here and the application service never holds a vendor's handle. The
 * backend reports what the object *is*; deciding whether that is acceptable is
 * this function's job, because acceptability is a programme rule.
 */
export const verifyUploadedObject = async (
  backend: StorageBackend,
  input: {
    objectKey: string
    contentType: AllowedContentType
    sizeBytes: number
    checksumSha256: string
  },
): Promise<{ valid: true } | { valid: false; message: string }> => {
  const facts = await backend.describe(input.objectKey)
  if (!facts) return { valid: false, message: 'The uploaded object was not found.' }
  if (
    facts.sizeBytes !== input.sizeBytes ||
    facts.sizeBytes < 1 ||
    facts.sizeBytes > MAX_DOCUMENT_BYTES
  ) {
    return { valid: false, message: 'The uploaded file size does not match the authorization.' }
  }
  if (facts.contentType !== input.contentType) {
    return { valid: false, message: 'The uploaded file type does not match the authorization.' }
  }
  if (facts.checksumSha256 !== input.checksumSha256) {
    return { valid: false, message: 'The uploaded file checksum does not match.' }
  }

  // The declared type is a claim; the first bytes are evidence. A file renamed
  // to .pdf is caught here rather than by whatever opens it later.
  const bytes = await backend.readPrefix(input.objectKey, 8)
  if (!bytes) {
    return { valid: false, message: 'The uploaded file could not be inspected.' }
  }
  if (!fileSignatureMatches(bytes, input.contentType)) {
    return { valid: false, message: 'The uploaded file content does not match its type.' }
  }
  return { valid: true }
}
