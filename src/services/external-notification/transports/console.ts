/**
 * The transport for local work: it prints the message and delivers nothing.
 *
 * This exists so a developer can read the one-time code without a provider
 * account. It must never run in a deployed environment — it writes OTPs to the
 * log, which is exactly what a deployed system must not do. The factory in
 * `../index.ts` is what keeps that true.
 *
 * ## The sentinel
 *
 * The line is prefixed `DEV_EMAIL` so the end-to-end suite can find it with an
 * anchored match. It used to scrape the Worker's whole log for the last run of
 * six digits, which silently returns the wrong code the moment anything else
 * logs six consecutive digits — a request id, a timestamp fragment, a provider
 * reference. The prefix makes the code findable by where it is rather than by
 * what it looks like.
 */
import type { Delivery, Notification, NotificationTransport } from '../types'

/** Marks the one line the development harness is allowed to read. */
export const DEV_EMAIL_PREFIX = 'DEV_EMAIL'

export const consoleTransport = (): NotificationTransport => ({
  name: 'console',
  send: async (notification: Notification): Promise<Delivery> => {
    /*
     * One line, and machine-readable. Logging the object directly made the
     * runtime pretty-print it across several lines, which put the marker and
     * the code on different lines and left the harness with nothing anchored
     * to read.
     */
    console.log(
      `${DEV_EMAIL_PREFIX} ${JSON.stringify({
        to: notification.to,
        subject: notification.subject,
        text: notification.body,
      })}`,
    )
    // Nothing was sent, so there is nothing to quote. Returning a made-up
    // reference here would let a caller believe a message is traceable.
    return { reference: null }
  },
})
