/**
 * The platform's rate-limiting binding. The only file that knows it exists.
 *
 * Each binding carries one limit and one period, declared in `wrangler.jsonc`
 * rather than passed here — so a bucket names its binding and the policy
 * restates the numbers for the reader and for the in-process transport.
 * `npm run check:rate-limits` is what keeps the two honest.
 *
 * The count is atomic and lives outside this isolate, which is the whole reason
 * this transport exists: two simultaneous attempts cannot both see the same
 * remaining allowance.
 */
import type { RateLimitBucket, RateLimitTransport, RateLimitVerdict } from '../types'

/**
 * What one rate-limiting binding offers.
 *
 * Declared here rather than imported because the generated Worker types
 * describe the bindings this Worker happens to have today, and this transport
 * is handed whichever ones the policy names.
 */
export type RateLimiterBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export const cloudflareRateLimitTransport = (
  /**
   * The bindings, by the name the policy uses.
   *
   * A map rather than the whole environment, so this file never reads a secret
   * and a test can hand it two fakes.
   */
  bindings: Readonly<Record<string, RateLimiterBinding | undefined>>,
): RateLimitTransport => ({
  name: 'cloudflare',
  consume: async (
    bucket: RateLimitBucket,
    identity: string,
  ): Promise<RateLimitVerdict> => {
    const binding = bindings[bucket.binding]
    /*
     * A missing binding is a deployment that does not match its own policy.
     * Throwing rather than allowing turns it into the refusal this service has
     * chosen for every failure it cannot answer — a limiter that silently
     * permitted everything would be worse than one that is plainly broken.
     */
    if (!binding) {
      throw new Error(`The rate-limit binding ${bucket.binding} is not configured.`)
    }
    const { success } = await binding.limit({ key: identity })
    return { allowed: success }
  },
})
