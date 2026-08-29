/**
 * Work handed off to be done after the response.
 *
 * The interface is one method, because that is genuinely all the programme
 * needs from a queue: hand over a message and be told it was accepted. It names
 * no vendor — Cloudflare Queues, SQS, a database table and an in-process array
 * all satisfy it.
 *
 * ## What a message may carry
 *
 * Identifiers and nothing else. A queued payload outlives the request that
 * created it, may be retried, and is readable by whoever can read the queue —
 * so it carries the id of something already stored, and the consumer reads the
 * rest for itself. Never a one-time code, a document's contents, a session
 * token, or an applicant's answers.
 */

/**
 * The message kinds this programme sends.
 *
 * A closed union rather than an open payload, so a consumer can be exhaustive
 * and adding a kind is a compile error everywhere it must be handled.
 */
export type QueueMessage =
  | {
      kind: 'DOCUMENT_SCAN_REQUESTED'
      /** The immutable document version to scan. */
      documentVersionId: string
    }
  | {
      kind: 'POLICY_DOCUMENT_SCAN_REQUESTED'
      /** The immutable cycle policy document version to scan. */
      policyDocumentVersionId: string
    }

export type QueueTransport = {
  /** Which transport this is, for diagnostics. Never a binding or a secret. */
  readonly name: string
  /**
   * Hands over one message.
   *
   * Resolves when the transport accepted it. Throwing means it did not, and
   * the caller applies its own policy — which for this programme is never to
   * fail the business operation that queued the work.
   */
  send(message: QueueMessage): Promise<void>
}
