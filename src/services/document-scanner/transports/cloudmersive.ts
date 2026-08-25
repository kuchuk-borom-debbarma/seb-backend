/**
 * Examining a stored document with Cloudmersive's virus scan API.
 *
 * One POST per document: the bytes go up as multipart form data, and the
 * answer is a boolean plus the names of anything found. There is no job to
 * poll and no identifier to keep, which is why the recorded reference names
 * the scanner rather than a scan — see `SCAN_REFERENCE`.
 *
 * ## Why this shape
 *
 * The bytes are *read* rather than passed in, because the queue consumer holds
 * a document version id and nothing else. The reader is injected rather than
 * imported so this file stays about the vendor: `../index.ts` supplies one that
 * works under whichever storage transport the environment has.
 *
 * ## What it refuses to do
 *
 * Never resolve `ACCEPTED` for a file it did not actually examine. Every
 * unexpected condition throws, which leaves the document unopenable and the
 * queue message retryable — the safe direction. That includes an answer whose
 * shape is not the documented one: a body that does not carry a boolean
 * `CleanResult` is not a clean result, it is an unknown one, and treating the
 * two alike is how a scanner becomes decoration.
 *
 * ## What must never leave here
 *
 * The API key, and the object key. The key is a credential; the object key
 * names an applicant's evidence in a store, and `ScanOutcome.reference` is
 * shown to staff and written to the audit trail. So the multipart filename is a
 * constant, not the object key, and no error message quotes either one — the
 * provider's own error body is not repeated for the same reason the Cloudinary
 * transport does not repeat its own: it can contain the request that was made.
 */
import type { DocumentScanner, ScanOutcome } from '../types'

const SCAN_ENDPOINT = 'https://api.cloudmersive.com/virus/scan/file'

/**
 * Recorded as the scan reference for every result.
 *
 * The provider returns no job id, so there is nothing scan-specific to keep.
 * This names what examined the file, which is what a person reading a scan
 * history actually needs, and it is deliberately distinguishable from
 * `NO_SCANNER_REFERENCE`.
 */
export const SCAN_REFERENCE = 'CLOUDMERSIVE'

/**
 * Sent as the multipart filename.
 *
 * Constant on purpose. The real filename is an applicant's, and the object key
 * is a storage identifier; neither has any business travelling to a third party
 * that only needs the bytes.
 */
const UPLOAD_FILENAME = 'document'

/** The documented response. Anything else is treated as no answer at all. */
type ScanReply = {
  CleanResult?: unknown
  FoundViruses?: unknown
}

/** The threat names, as a sentence a person can be shown, or null if none. */
const describeFindings = (found: unknown): string | null => {
  if (!Array.isArray(found)) return null
  const names = found
    .map((entry) => (entry as { VirusName?: unknown } | null)?.VirusName)
    .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
  if (names.length === 0) return null
  return `The scanner identified ${names.join(', ')}.`
}

export const cloudmersiveScanner = (
  apiKey: string,
  readObject: (objectKey: string) => Promise<Response | null>,
): DocumentScanner => ({
  name: 'cloudmersive',
  scan: async (objectKey: string): Promise<ScanOutcome> => {
    const stored = await readObject(objectKey)
    // The object is gone, or the store would not give it up. Either way nothing
    // was examined, so this must not conclude anything.
    if (!stored) throw new Error('The document could not be read for scanning.')

    const body = new FormData()
    body.append('inputFile', await stored.blob(), UPLOAD_FILENAME)

    const response = await fetch(SCAN_ENDPOINT, {
      method: 'POST',
      headers: { Apikey: apiKey },
      body,
    })
    if (!response.ok) {
      throw new Error(`The malware scanner refused the request (${response.status}).`)
    }

    const reply = (await response.json().catch(() => null)) as ScanReply | null
    if (typeof reply?.CleanResult !== 'boolean') {
      throw new Error('The malware scanner returned no verdict.')
    }

    if (reply.CleanResult) {
      return { verdict: 'ACCEPTED', reference: SCAN_REFERENCE, message: null }
    }
    return {
      verdict: 'REJECTED',
      reference: SCAN_REFERENCE,
      message:
        describeFindings(reply.FoundViruses) ??
        'The scanner found malware in this file.',
    }
  },
})
