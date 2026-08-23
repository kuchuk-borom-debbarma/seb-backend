/**
 * Attaching evidence to an application.
 *
 * An upload is three steps, and the bytes never touch the Worker:
 *
 *   1. `issueDocumentUpload` authorizes exactly one object. The browser sends
 *      the file's size, type and SHA-256 up front, and the Worker signs a URL
 *      that will only accept an object matching them.
 *   2. The browser PUTs the file straight into the bucket at that URL, with the
 *      headers the Worker named. This is the one request in the whole client
 *      that does not go through the backend-for-frontend, because a presigned
 *      upload is addressed to the storage provider by definition.
 *   3. `finalizeDocumentUpload` asks the Worker to look at what actually landed
 *      and, only if it matches, record a new document version.
 *
 * The checksum is what makes step 3 meaningful: the Worker verifies the stored
 * object rather than trusting the browser's account of it.
 */
import type { DocumentType } from '#/graphql/generated/schema'
import {
  FinalizeDocumentUploadDocument,
  IssueDocumentUploadDocument,
} from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

/**
 * The evidence an application can carry.
 *
 * Which of these are *required* depends on the cycle's document rules and on
 * the answers given, and only the server knows that — the validation report
 * names them. This list is what may be attached at all, in the order the
 * evidence screen presents it.
 */
export const DOCUMENT_TYPES: readonly DocumentType[] = [
  'IDENTITY_AGE_PROOF',
  'ST_CERTIFICATE',
  'ADDRESS_PROOF',
  'BUSINESS_REGISTRATION',
  'GST_REGISTRATION',
  'DPR',
  'BANK_DETAILS',
  'NOC',
]

/**
 * Whether a validation issue is about a file rather than a form answer.
 *
 * The evidence section carries both. A missing file is fixed on the evidence
 * screen; the question asking whether a no-objection certificate applies is a
 * form question, and telling somebody to fix it under Evidence sent them to a
 * screen with no such control on it.
 */
export const isDocumentIssue = (field: string): field is DocumentType =>
  field in DOCUMENT_TITLES

export const DOCUMENT_TITLES: Record<DocumentType, string> = {
  IDENTITY_AGE_PROOF: 'Identity and age proof',
  ST_CERTIFICATE: 'Scheduled Tribe certificate',
  ADDRESS_PROOF: 'Address proof',
  BUSINESS_REGISTRATION: 'Business registration',
  GST_REGISTRATION: 'GST registration',
  DPR: 'Detailed project report',
  BANK_DETAILS: 'Bank account details',
  NOC: 'No-objection certificate',
}

/*
 * Mirrored from `services/application/uploads.ts`. The server is the authority
 * and refuses anything outside these bounds; checking here only avoids sending
 * a file the answer to which is already known, and lets the file picker offer
 * the right types.
 */
export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

/** What the file picker accepts, so the wrong file is harder to choose. */
export const FILE_ACCEPT = ALLOWED_CONTENT_TYPES.join(',')

/**
 * Says why a file cannot be sent, or null when it can.
 *
 * Deliberately phrased as what to do rather than what is wrong, and only for
 * the two rules a browser can check without asking.
 */
export const rejectFile = (file: File): string | null => {
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'Choose a PDF, JPEG or PNG file.'
  }
  if (file.size < 1) return 'This file is empty. Choose another one.'
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `This file is ${formatBytes(file.size)}. The largest a document can be is 10 MB.`
  }
  return null
}

/** File sizes, in the unit a person would use for a file that size. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The file's SHA-256, base64-encoded, which is the form the API expects.
 *
 * `crypto.subtle` is only available in a secure context — HTTPS, or localhost
 * during development — which is where this runs.
 */
const checksumOf = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Attaches a file as the named document type.
 *
 * `expectedVersion` is optimistic concurrency for this one document: 0 when
 * nothing is attached yet, otherwise the version being replaced. The server
 * refuses the authorization outright if the document moved underneath, so two
 * people replacing the same evidence cannot silently overwrite one another.
 */
export const uploadDocument = async ({
  applicationId,
  documentType,
  expectedVersion,
  file,
}: {
  applicationId: string
  documentType: DocumentType
  expectedVersion: number
  file: File
}): Promise<void> => {
  const issued = await gql(IssueDocumentUploadDocument, {
    input: {
      applicationId,
      documentType,
      expectedDocumentVersion: expectedVersion,
      originalFilename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      checksumSha256: await checksumOf(file),
    },
  })
  const authorization = unwrap(issued.seb.application.issueDocumentUpload)

  const stored = await fetch(authorization.uploadUrl, {
    method: 'PUT',
    // Exactly the headers the signature covers. Adding or dropping one makes
    // the signature invalid, so they are sent as given rather than assembled.
    headers: Object.fromEntries(
      authorization.requiredHeaders.map((header) => [header.name, header.value]),
    ),
    body: file,
  })
  if (!stored.ok) {
    throw new Error(
      `The file could not be stored (${stored.status}). Check your connection and try again.`,
    )
  }

  const finalized = await gql(FinalizeDocumentUploadDocument, {
    uploadId: authorization.uploadId,
  })
  unwrap(finalized.seb.application.finalizeDocumentUpload)
}
