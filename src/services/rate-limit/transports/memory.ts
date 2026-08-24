/**
 * A limiter that counts in this isolate and nowhere else.
 *
 * **This is a development convenience, not protection.** A Worker runs in many
 * isolates and each would keep its own counts, so a limit of five means five
 * per isolate — which is to say, no limit anybody could rely on. It exists so
 * that local work behaves like the deployed thing without a binding, exactly as
 * the in-process queue does.
 *
 * A fixed window rather than a sliding one, because that is what the deployed
 * limiter does and the two should not disagree about when an allowance refills.
 */
import type { RateLimitBucket, RateLimitTransport, RateLimitVerdict } from '../types'

/** One window's tally. */
type Window = {
  /** When this window ends, in milliseconds. */
  expiresAt: number
  spent: number
}

/**
 * Module-level, and deliberately so.
 *
 * A counter that did not outlive the request would count to one for ever. This
 * is the opposite of the rule about loaders in `src/loaders/index.ts`: a loader
 * is a cache of somebody's data and must never be shared between requests,
 * while a limiter is a tally of *how often* and is worth nothing unless it is.
 *
 * Nothing here is anybody's data — the keys are an address or a digest, and the
 * values are integers.
 */
const windows = new Map<string, Window>()

export const memoryRateLimitTransport = (
  /** Injected so a test can make a window expire without waiting for one. */
  now: () => number = Date.now,
): RateLimitTransport => {
  return {
    name: 'memory',
    consume: async (
      bucket: RateLimitBucket,
      identity: string,
    ): Promise<RateLimitVerdict> => {
      /*
       * The binding name is part of the key, not just the identity: two buckets
       * counted along the same dimension for the same person are separate
       * allowances, and sharing a key would make the tighter one govern both.
       */
      const key = `${bucket.binding}:${identity}`
      const at = now()
      const current = windows.get(key)

      if (!current || current.expiresAt <= at) {
        windows.set(key, { expiresAt: at + bucket.periodSeconds * 1_000, spent: 1 })
        return { allowed: bucket.limit >= 1 }
      }

      if (current.spent >= bucket.limit) return { allowed: false }
      current.spent += 1
      return { allowed: true }
    },
  }
}
