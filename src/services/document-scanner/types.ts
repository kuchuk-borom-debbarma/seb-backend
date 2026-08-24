/**
 * Deciding whether a stored document is safe for staff to open.
 *
 * The programme needs one thing from a scanner: given an object that has
 * already been stored, say whether it may be opened, and give something a
 * person could quote when asking why. That is the whole interface, and it names
 * no product.
 *
 * It also says nothing about *how* the answer is reached. A real scanner will
 * be a network call to somebody's service; a queue consumer may wait on it for
 * seconds. Neither is this interface's business.
 */

/** What a scan concluded. `PENDING` is not here: a scanner returns an answer. */
export type ScanVerdict = 'ACCEPTED' | 'REJECTED'

export type ScanOutcome = {
  verdict: ScanVerdict
  /**
   * Identifies the scan to whoever performed it — a vendor's job id, or the
   * reason there is no job. Recorded and shown to staff, so it must never
   * carry a credential or an object key.
   */
  reference: string
  /** Safe to show a person. Null when there is nothing useful to say. */
  message: string | null
}

export type DocumentScanner = {
  /** Which scanner this is, for diagnostics. Never a credential. */
  readonly name: string
  /**
   * Examines one stored object.
   *
   * Throwing means no conclusion was reached — the document stays unopenable
   * and the work can be retried. It must never resolve `ACCEPTED` for a file
   * it could not actually examine.
   */
  scan(objectKey: string): Promise<ScanOutcome>
}
