/**
 * Accepts every document without examining it.
 *
 * This exists because the alternative is worse. Staff download fails closed
 * until an `ACCEPTED` result is recorded, and until something records one, no
 * administrator can open any document at all — which makes the whole review
 * workflow untestable on a developer's machine and undemonstrable on a
 * development deployment.
 *
 * **It is honest about what it did.** The reference it records says plainly
 * that nothing scanned the file, so anybody reading a document's scan history
 * — or the audit trail behind it — can tell an unexamined file from a checked
 * one. A permissive scanner that recorded a clean-looking result would be far
 * more dangerous than no scanner, because it would look like evidence.
 *
 * The factory in `../index.ts` is what keeps this away from production.
 */
import type { DocumentScanner, ScanOutcome } from '../types'

/** Recorded as the scan reference. Deliberately reads as an absence. */
export const NO_SCANNER_REFERENCE = 'NO_SCANNER_CONFIGURED'

export const permissiveScanner = (): DocumentScanner => ({
  name: 'permissive',
  scan: async (): Promise<ScanOutcome> => ({
    verdict: 'ACCEPTED',
    reference: NO_SCANNER_REFERENCE,
    message: 'This environment has no malware scanner. The file was not examined.',
  }),
})
