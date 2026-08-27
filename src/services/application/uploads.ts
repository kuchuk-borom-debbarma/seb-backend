/**
 * What the programme accepts as a document, and how it is checked.
 *
 * These are the programme's rules — which types, how large, what a filename may
 * contain, what the first bytes must be. Where the file physically goes is the
 * storage service's business and is deliberately not decided here.
 */
import type { StorageBackend } from '../storage'
import type { DocumentType } from './types'

/**
 * The largest a document may be.
 *
 * Two megabytes is enough for a scanned certificate or a project report and
 * small enough that a poor connection can still finish one. It is also the
 * number the browser refuses at, so almost nothing oversized reaches the API at
 * all — `dev-web/src/features/application/documents.ts` states the same number,
 * and `npm run check:document-limit` fails if the two stop agreeing.
 *
 * **The malware scanner is what sets it.** Cloudmersive's free tier refuses a
 * file over 2.5 MB, and a document the scanner cannot examine never becomes
 * openable — download fails closed until an `ACCEPTED` result exists. So an
 * upload the scanner would reject must be refused up front, where the applicant
 * gets a useful message, rather than accepted and left permanently unreadable.
 * Two megabytes rather than 2.5 because the provider documents "2.5 MB" without
 * saying whether it means 2,500,000 or 2,621,440, and the gap is not worth a
 * silently unopenable document. Raising this means checking the scanner first.
 *
 * The database `CHECK` on `size_bytes` is a wider backstop at 5 MiB. It is
 * deliberately not narrowed to match: SQLite cannot alter a `CHECK` without
 * rebuilding the table, and a bound that is merely wider than the rule costs
 * nothing.
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

/** For messages, so the limit is stated once and read everywhere. */
export const MAX_DOCUMENT_MEGABYTES = MAX_DOCUMENT_BYTES / (1024 * 1024)
export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const

export type AllowedContentType = (typeof ALLOWED_DOCUMENT_CONTENT_TYPES)[number]

/**
 * The extensions each accepted type may carry.
 *
 * The MIME type is what the browser claims and the magic bytes are what the
 * file actually is, so this looks like a third copy of the same check. It is
 * not, because the filename is the one of the three that gets **stored and
 * later served back**.
 *
 * `report.pdf.exe` passes both other checks today: the browser reports
 * `application/pdf`, the bytes begin `%PDF-`, and the name is kept as given.
 * Requiring the final extension to agree with the declared type is what stops
 * a file arriving with a name that describes something else entirely.
 */
const EXTENSIONS_BY_CONTENT_TYPE: Record<AllowedContentType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
}

/**
 * Whether the filename's final extension matches the type it claims to be.
 *
 * Only the last extension is considered: everything before it is an ordinary
 * part of the name, and `annual.report.2026.pdf` is a perfectly good filename.
 */
export const extensionMatchesContentType = (
  filename: string,
  contentType: AllowedContentType,
): boolean => {
  const lastDot = filename.lastIndexOf('.')
  // No extension at all is refused rather than waved through: a stored
  // document with no extension is one a person cannot open by clicking it.
  if (lastDot <= 0 || lastDot === filename.length - 1) return false
  const extension = filename.slice(lastDot + 1).toLowerCase()
  return EXTENSIONS_BY_CONTENT_TYPE[contentType].includes(extension)
}

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
  /*
   * Compared only where the backend recorded a type. A store that keeps one —
   * R2 does — must agree with the declaration. A store that keeps none says so
   * with `null`, and treating that as a mismatch would refuse every document it
   * holds. Nothing is waived: the signature check below reads the actual bytes,
   * which is the evidence this comparison is only a cheap proxy for.
   */
  if (facts.contentType !== null && facts.contentType !== input.contentType) {
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
