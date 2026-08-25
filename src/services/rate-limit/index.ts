/**
 * How often one caller may do one thing.
 *
 * The same shape as the storage, queue and notification seams: an interface
 * naming no vendor, one transport per environment, and a factory that picks.
 * Built per call rather than cached, for the reason `src/index.ts` gives about
 * its own configuration.
 *
 * ## What this service decides, and what it does not
 *
 * It decides **whether an allowance had room**. It does not decide what to do
 * about that, because the two enforcement points answer differently: the HTTP
 * layer refuses with a status, and the GraphQL layer refuses inside the
 * operation's own envelope, which is where every other expected failure in this
 * API lives.
 *
 * ## Failing closed
 *
 * A transport that throws could not answer. That is treated as a refusal, not
 * as permission — protection is never silently absent. The cost is real and
 * chosen deliberately: a limiter outage refuses signup rather than leaving it
 * unprotected, and the failure is recorded so a run of them is visible.
 */
import type { AppBindings } from '../../bindings'
import { requestIdentity } from './identity'
import { bucketsFor } from './policy'
import {
  cloudflareRateLimitTransport,
  type RateLimiterBinding,
} from './transports/cloudflare'
import { memoryRateLimitTransport } from './transports/memory'
import { unlimitedRateLimitTransport } from './transports/unlimited'
import type { RateLimitTransport } from './types'

export { allBuckets, bucketsFor, REQUEST_BUDGET } from './policy'
export { operationSubject, requestIdentity } from './identity'
export type * from './types'

/**
 * What a refused caller is told.
 *
 * Deliberately without a number. A precise "try again in 412 seconds" would
 * have to come from the policy while the deployed allowance actually refills on
 * the binding's own schedule, and the two would drift. Vague and true beats
 * precise and wrong.
 */
export const RATE_LIMITED_MESSAGE =
  'Too many attempts. Wait a few minutes and try again.'

/**
 * Where a limiter that counts nothing must never be built.
 *
 * Only production, matching the scanner: `develop` is a demonstration
 * environment, and the numbers are worth exercising there.
 */
const LIMITING_REQUIRED_ENVIRONMENTS = new Set(['production'])

/** Whether this environment counts in process rather than on a binding. */
export const usesLocalRateLimiter = (env: AppBindings): boolean => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  return environment === '' || environment === 'local'
}

/**
 * The limiter this environment should use.
 *
 * `RATE_LIMIT_DISABLED` is how the test suites turn counting off. It is refused
 * outright in production rather than merely discouraged, because a limiter that
 * can be switched off by configuration is not a limiter — and being refused at
 * construction means the Worker fails to start rather than failing at the first
 * attack.
 */
export const rateLimiter = (env: AppBindings): RateLimitTransport => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  const disabled = (env.RATE_LIMIT_DISABLED ?? '').trim().toLowerCase() === 'true'

  if (disabled) {
    if (LIMITING_REQUIRED_ENVIRONMENTS.has(environment)) {
      throw new Error(
        `Rate limiting cannot be disabled in the ${environment} environment.`,
      )
    }
    return unlimitedRateLimitTransport()
  }

  return usesLocalRateLimiter(env)
    ? memoryRateLimitTransport()
    : cloudflareRateLimitTransport(
      env as unknown as Record<string, RateLimiterBinding | undefined>,
    )
}

/** What one enforcement point needs to know to apply the policy. */
export type EnforcementRequest = {
  /** The field being limited, as the policy names it. */
  readonly operation: string
  readonly headers: Headers
  /** Keys the session digest. The same secret the session table is keyed with. */
  readonly secret: string
  /** The account being acted on, where the operation names one. */
  readonly subject: string | null
}

/**
 * Spends every allowance this operation needs, and says whether it may proceed.
 *
 * Buckets whose dimension the request cannot supply are skipped — an
 * unauthenticated caller has no session, and only some operations name a
 * subject. Skipping is right: refusing because a dimension is absent would stop
 * signup working at all.
 *
 * **Every applicable allowance is spent, not just until one refuses.** A caller
 * refused by one bucket has still made the attempt the others are counting, and
 * stopping early would let somebody exhaust a wide allowance for free by
 * ensuring a narrow one refused first.
 */
export const enforce = async (
  transport: RateLimitTransport,
  request: EnforcementRequest,
): Promise<{ allowed: boolean }> => {
  const buckets = bucketsFor(request.operation)
  if (buckets.length === 0) return { allowed: true }

  const identity = await requestIdentity(request.headers, request.secret, request.subject)
  let allowed = true
  for (const bucket of buckets) {
    const against = identity[bucket.dimension]
    if (!against) continue
    const verdict = await transport.consume(bucket, against)
    if (!verdict.allowed) allowed = false
  }
  return { allowed }
}
