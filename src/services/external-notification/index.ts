/**
 * Choosing who delivers a notification.
 *
 * The rest of the programme asks for a transport and sends through it. It does
 * not know which one it got, and nothing outside `transports/` names a
 * provider.
 *
 * ## Why this is built per call rather than cached
 *
 * A cached transport would be a singleton built from whichever environment
 * arrived first, and this codebase deliberately has none of those. `index.ts`
 * says why for its own configuration: parsed on demand "so tests and local
 * Wrangler overrides can supply different bindings without global mutable
 * configuration". The same reasoning holds here, and one thing more — the test
 * suite runs `singleWorker: true`, so a cached transport would be shared by
 * every test in the run, and a suite that changes configuration mid-run would
 * silently keep the first answer.
 *
 * Construction is two object literals. There is nothing to save.
 */
import type { AppBindings } from '../../bindings'
import { consoleTransport } from './transports/console'
import { pingramTransport } from './transports/pingram'
import type { Notification, NotificationTransport } from './types'

export type { Delivery, Notification, NotificationTransport } from './types'

/**
 * Which environment this is running as.
 *
 * `develop` and anything else. Unset means local, because an unconfigured
 * machine is a developer's machine — a deployed environment is always told
 * what it is.
 */
const DELIVERING_ENVIRONMENTS = new Set(['develop', 'production'])

/**
 * The transport for this environment.
 *
 * A deployed environment must really deliver. If it is configured to and
 * cannot — no key — this refuses rather than quietly printing the code to a
 * log, which is what the console transport would do and what a deployed system
 * must never do. The refusal reaches the applicant as "the code could not be
 * sent", which is true.
 */
/**
 * How a code sent through this seam reaches the person: really emailed on a
 * delivering environment, printed to the worker log everywhere else. The
 * screens that say "check your inbox" or "read the console" ask this instead
 * of guessing from their build.
 */
export const notificationDelivery = (env: AppBindings): 'EMAIL' | 'CONSOLE' => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  return DELIVERING_ENVIRONMENTS.has(environment) ? 'EMAIL' : 'CONSOLE'
}

export const notificationTransport = (env: AppBindings): NotificationTransport => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  if (!DELIVERING_ENVIRONMENTS.has(environment)) return consoleTransport()

  const apiKey = env.PINGRAM_API_KEY?.trim()
  const notificationType = env.PINGRAM_NOTIFICATION_TYPE?.trim()
  if (!apiKey || !notificationType) {
    throw new Error(
      `Notification delivery is not configured for the ${environment} environment.`,
    )
  }
  return pingramTransport({
    apiKey,
    notificationType,
    baseUrl: env.PINGRAM_BASE_URL?.trim() || undefined,
    fromName: env.PINGRAM_FROM_NAME?.trim() || undefined,
    fromAddress: env.PINGRAM_FROM_ADDRESS?.trim() || undefined,
  })
}

/**
 * Sends one notification through whichever transport this environment uses.
 *
 * The one entry point the rest of the programme calls. It resolves when the
 * transport accepted the message and throws when it could not, which is the
 * contract every caller already handles.
 */
export const sendNotification = async (
  notification: Notification,
  env: AppBindings,
): Promise<void> => {
  await notificationTransport(env).send(notification)
}
