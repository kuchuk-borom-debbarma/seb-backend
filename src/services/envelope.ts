/**
 * The one response envelope every service returns.
 *
 * Four services each had their own `success`/`failure` and their own result
 * type, all four byte-identical apart from the name of the type they returned.
 * That is not four decisions — it is one decision copied, and the copies drift:
 * a change to how a refusal is shaped would have had to be made in four places
 * with nothing to say it had been missed in the fourth.
 *
 * ## Why the envelope exists at all
 *
 * Expected failures live **inside** the response, not in GraphQL `errors`. A
 * stale version, a refused permission, an application that is not there — all
 * arrive as `success: false` with a message fit to show somebody. `errors`
 * means the request was malformed or the server broke, which needs different
 * handling entirely.
 *
 * Each service still names its own alias — `AdminResult`, `SebResult` — because
 * the name at a call site says which service is answering, and that is worth
 * keeping. What is shared is the shape and the two constructors.
 */

/** A response that carries its own failure rather than throwing one. */
export type Envelope<T> = {
  /** Whether the operation did what was asked. */
  success: boolean
  /** What to show the person when it did not. Null on success. */
  message: string | null
  /** The result. Null whenever `success` is false. */
  response: T | null
}

/**
 * A successful response.
 *
 * The message is optional and usually absent: a screen showing something that
 * worked rarely needs words, and one that does can say them itself.
 */
export const success = <T>(response: T, message: string | null = null): Envelope<T> => ({
  success: true,
  message,
  response,
})

/**
 * A refusal.
 *
 * `response` is always null, so a caller cannot read a stale value out of a
 * failed operation by forgetting to check `success` first.
 */
export const failure = <T>(message: string): Envelope<T> => ({
  success: false,
  message,
  response: null,
})
