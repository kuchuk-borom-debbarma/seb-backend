/**
 * A limiter that counts nothing.
 *
 * The test suites use this, and the reason is worth stating: the browser suite
 * signs in dozens of times in three minutes, which is not a usage pattern any
 * real limit should have to accommodate. **Numbers chosen so a test suite fits
 * are numbers too loose to be worth having**, so the suites turn the limiter
 * off rather than the limits being widened to suit them.
 *
 * It is a named transport rather than a flag inside another one so that it is
 * visible in the seam, has somewhere to explain itself, and is something a test
 * can assert about. Two independent things stop it reaching a real environment:
 * the factory refuses to build it when `ENVIRONMENT` is production, and
 * `npm run check:rate-limits` refuses it in the deployed configuration.
 *
 * What this costs is real and is written down in this service's README: nothing
 * in the browser suite exercises a refusal.
 */
import type { RateLimitTransport, RateLimitVerdict } from '../types'

const ALLOWED: RateLimitVerdict = { allowed: true }

export const unlimitedRateLimitTransport = (): RateLimitTransport => ({
  name: 'unlimited',
  consume: async () => ALLOWED,
})
