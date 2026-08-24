/**
 * How often one caller may do one thing.
 *
 * The interface names no vendor. A limit is a **bucket** — a named allowance
 * counted along one dimension — and a transport is anything that can spend from
 * one and say whether there was anything left. The platform's rate-limiting
 * binding, a Durable Object, Redis and an in-process map all satisfy it.
 *
 * ## A caller never sees a number
 *
 * `consume` answers "may this proceed", not "how many are left". A caller able
 * to read the remaining count would branch on it, and the branch would be wrong
 * the moment two requests arrived together. The only safe question is the one
 * that also decrements.
 */

/**
 * What an allowance is counted against.
 *
 * These are different questions, and a sensitive operation asks more than one:
 *
 * - `IP` protects the shared resource from one source. It has to be generous:
 *   an office behind one NAT is a single address, so a tight limit here
 *   punishes colleagues rather than attackers.
 * - `SESSION` protects an account from its own session being driven hard. It
 *   exists only once somebody is signed in, so it is no use for signup or
 *   sign-in.
 * - `SUBJECT` protects the thing being *acted on* — the address somebody is
 *   trying to sign into. This is what catches credential stuffing: an IP limit
 *   cannot see a botnet, and there is no session yet. Without it, limiting
 *   sign-in is largely theatre against a distributed attacker.
 */
export type RateLimitDimension = 'IP' | 'SESSION' | 'SUBJECT'

/** One allowance an operation must have room in before it proceeds. */
export type RateLimitBucket = {
  /**
   * The binding this allowance lives on once deployed.
   *
   * Named rather than described, because the deployed limiter declares its own
   * limit and period in the Worker's configuration — they are configuration
   * there, not arguments. `limit` and `periodSeconds` restate them so the
   * in-process transport can enforce the same thing and so a reader can see
   * what is permitted without opening another file. `npm run check:rate-limits`
   * fails when the two disagree.
   */
  readonly binding: string
  /** What this allowance is counted against. */
  readonly dimension: RateLimitDimension
  /** How many are permitted in one period. */
  readonly limit: number
  /** How long the allowance takes to refill, in seconds. */
  readonly periodSeconds: number
}

/** Whether an operation may proceed. */
export type RateLimitVerdict = {
  /** False when the allowance is spent. */
  readonly allowed: boolean
}

/**
 * Somewhere that can count.
 *
 * `consume` both asks and decrements in one indivisible step. A transport that
 * cannot do that atomically is the wrong transport: read-then-write loses
 * precisely the concurrent attempts a limiter exists to catch, and loses them
 * silently.
 *
 * **There is no way to look without spending, and so no "count only failures".**
 * That was tried: a bucket spent after a failed attempt is never consulted
 * before the next one, so it fills up and refuses nothing. Every allowance is
 * therefore spent by every attempt, and the limits are chosen to fit legitimate
 * repeated use — see the policy.
 *
 * **Throwing is not refusing.** `{ allowed: false }` means the transport
 * answered no. Throwing means it could not answer, which the caller treats as a
 * refusal for its own reasons — see this service's README.
 */
export type RateLimitTransport = {
  /** Which transport this is, for diagnostics. Never a binding or a secret. */
  readonly name: string
  /**
   * Spends one unit of `bucket`'s allowance for `identity`.
   *
   * `identity` is already the value being counted — an address, a digest, a
   * normalized email. The transport neither parses nor interprets it, and in
   * particular never assumes it is safe to log.
   */
  consume(bucket: RateLimitBucket, identity: string): Promise<RateLimitVerdict>
}
