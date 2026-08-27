/**
 * Delivery through Pingram.
 *
 * **This is the only file in the repository that knows Pingram exists.** Its
 * job is to translate between what the programme says and what one provider's
 * API wants, and to keep every one of that provider's ideas inside this file.
 *
 * Three of those ideas are worth naming, because each would otherwise have
 * leaked into the interface:
 *
 * - **`type`** is Pingram's identifier for a configured notification kind. It
 *   is a provider concept with no meaning in this programme, so it comes from
 *   configuration rather than from the caller.
 * - **`html`** is the only body format Pingram accepts — there is no plain-text
 *   field. The programme composes plain text, so this adapter escapes it and
 *   wraps it. No caller writes markup.
 * - **`trackingId`** becomes the interface's `reference`, which is opaque and
 *   only ever repeated.
 */
import type { Delivery, Notification, NotificationTransport } from '../types'

/** Where the account lives. Regional, so it is configuration rather than a constant. */
const DEFAULT_BASE_URL = 'https://api.pingram.io'

export type PingramConfiguration = {
  apiKey: string
  /** Pingram's own notification-type identifier. */
  notificationType: string
  /** Regional API host. Unset means the default region. */
  baseUrl?: string
  /** Who the message appears to come from. Unset leaves it to the account. */
  fromName?: string
  fromAddress?: string
}

/** Escapes text so a message containing `<` or `&` renders as written. */
const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * The programme's plain text as the minimal HTML Pingram requires.
 *
 * Deliberately plain. A styled template is a thing to maintain and a thing to
 * get wrong, and the messages this sends are one sentence long.
 */
const asHtml = (body: string): string =>
  `<p>${escapeHtml(body).replaceAll('\n', '<br>')}</p>`

/**
 * Binary to base64 without `Buffer`, which the Workers runtime does not have.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads the whole document
 * onto the argument stack, and a PDF is comfortably large enough to overflow
 * it. The chunk size is far below every engine's argument limit.
 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const CHUNK = 8_192
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

/**
 * Fails without saying anything a log should not repeat.
 *
 * The caller logs whatever is thrown here (`auth/controllers/auth.ts`), and
 * those logs are readable in CI on a public repository. So the message carries
 * the transport and the status and nothing else — never the key, never the
 * request, never the provider's response body, which can echo what was sent.
 */
const refuse = (status: number | 'unreachable'): Error =>
  new Error(`The notification provider did not accept the message (${status}).`)

export const pingramTransport = (
  configuration: PingramConfiguration,
): NotificationTransport => ({
  name: 'pingram',
  send: async (notification: Notification): Promise<Delivery> => {
    let response: Response
    try {
      response = await fetch(`${configuration.baseUrl ?? DEFAULT_BASE_URL}/email`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${configuration.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: configuration.notificationType,
          to: notification.to,
          subject: notification.subject,
          html: asHtml(notification.body),
          ...(configuration.fromName ? { fromName: configuration.fromName } : {}),
          ...(configuration.fromAddress
            ? { fromAddress: configuration.fromAddress }
            : {}),
          /*
           * `attachments: [{filename, contentType, content}]` with base64
           * content is the provider's documented shape as best understood.
           * If Pingram rejects one, the failure surfaces as the sanitised
           * `refuse(status)` below — the response body is never repeated,
           * because it can echo the filename and the document itself.
           */
          ...(notification.attachments?.length
            ? {
                attachments: notification.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  contentType: attachment.contentType,
                  content: toBase64(attachment.bytes),
                })),
              }
            : {}),
        }),
      })
    } catch {
      // The original error can carry the request, and with it the recipient
      // and the message. It is deliberately not propagated.
      throw refuse('unreachable')
    }

    if (!response.ok) throw refuse(response.status)

    /*
     * A malformed success body is not a delivery failure — the provider
     * accepted the message. The reference is simply unavailable, which the
     * interface already allows for.
     */
    const body = (await response.json().catch(() => null)) as
      | { trackingId?: unknown }
      | null
    const reference = typeof body?.trackingId === 'string' ? body.trackingId : null
    return { reference }
  },
})
