/**
 * What the programme wants to say, and who can say it.
 *
 * Nothing here names a provider. The programme has a recipient, a subject and
 * a message; a transport has whatever wire format it happens to need and
 * derives it. When an adapter's own vocabulary — a template identifier, an
 * HTML body, a tracking id — reaches this file, the seam has stopped working.
 *
 * The test for a change here is simple: would it still make sense if the only
 * transport were a printer, or a queue, or the postal service?
 */

/** One message, in the form the programme has it. */
export type Notification = {
  to: string
  subject: string
  /**
   * The message as plain text.
   *
   * Plain text because that is what the domain composes and the least a
   * transport can be asked to carry. One that needs another format derives it
   * — the caller never learns which, and never writes markup.
   */
  body: string
  /**
   * Documents that travel with the message, or none.
   *
   * A named place, not bytes. Bytes passed the printer test in theory; in
   * practice the provider attaches by URL — it fetches what the link names
   * and encloses it, and silently dropped an inline body. So the programme
   * signs a link it serves itself (`/confirmation-pdf`) and every carrier
   * does something honest with it: the provider encloses the file, the
   * console prints the address.
   */
  attachments?: readonly {
    filename: string
    contentType: string
    url: string
  }[]
}

/** What came back, in terms a support conversation can use. */
export type Delivery = {
  /**
   * An opaque reference somebody can quote when asking a provider what
   * happened, or `null` from a transport that has none. Deliberately not
   * parsed or interpreted anywhere: its only job is to be repeated.
   */
  reference: string | null
}

/**
 * Something that can accept a notification.
 *
 * Resolving means the transport has accepted the message, not that it has
 * arrived. Throwing means it could not be accepted at all, and the caller
 * applies its own failure policy — for signup that means invalidating the
 * challenge and asking the applicant to try again.
 */
export type NotificationTransport = {
  /**
   * Which transport this is, for diagnostics and for tests to assert on.
   * A short stable name — never a secret, an endpoint, or a version.
   */
  readonly name: string
  send(notification: Notification): Promise<Delivery>
}
