/** Direct, private R2 upload/download signing and object verification. */
import type { ApplicationOperationContext, DocumentType } from './types'

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const UPLOAD_TTL_SECONDS = 10 * 60
export const DOWNLOAD_TTL_SECONDS = 5 * 60
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

export const attachmentHeader = (filename: string): string => {
  const ascii = filename.replace(/[^A-Za-z0-9._ -]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"`
}

const arrayBufferToBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

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

export const verifyUploadedObject = async (
  bucket: R2Bucket,
  input: {
    objectKey: string
    contentType: AllowedContentType
    sizeBytes: number
    checksumSha256: string
  },
): Promise<{ valid: true } | { valid: false; message: string }> => {
  const object = await bucket.head(input.objectKey)
  if (!object) return { valid: false, message: 'The uploaded object was not found.' }
  if (object.size !== input.sizeBytes || object.size < 1 || object.size > MAX_DOCUMENT_BYTES) {
    return { valid: false, message: 'The uploaded file size does not match the authorization.' }
  }
  if (object.httpMetadata?.contentType !== input.contentType) {
    return { valid: false, message: 'The uploaded file type does not match the authorization.' }
  }
  if (
    !object.checksums.sha256 ||
    arrayBufferToBase64(object.checksums.sha256) !== input.checksumSha256
  ) return { valid: false, message: 'The uploaded file checksum does not match.' }

  const prefix = await bucket.get(input.objectKey, { range: { offset: 0, length: 8 } })
  if (!prefix || !('body' in prefix)) {
    return { valid: false, message: 'The uploaded file could not be inspected.' }
  }
  const bytes = new Uint8Array(await prefix.arrayBuffer())
  if (!fileSignatureMatches(bytes, input.contentType)) {
    return { valid: false, message: 'The uploaded file content does not match its type.' }
  }
  return { valid: true }
}
