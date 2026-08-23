/**
 * Unwrapping the API's result envelope.
 *
 * Every operation returns `{ success, message, response }`. Expected refusals —
 * a wrong password, a stale version, a rule that was not met — arrive with
 * `success: false` and a message written for the person reading it. They are
 * not GraphQL errors, so they must be surfaced in the interface rather than
 * thrown away.
 */

/** Carries a refusal the API wrote. Its message is safe to show verbatim. */
export class OperationFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationFailed'
  }
}

type Envelope<TResponse> = {
  success: boolean
  message: string | null
  response: TResponse | null
}

/**
 * Returns the payload of a successful operation, or throws its refusal.
 *
 * Use this for mutations, where a refusal belongs in the caller's error state.
 * Queries that legitimately succeed with no payload — `auth.currentSession` for
 * a signed-out visitor — should read `response` directly instead.
 */
export const unwrap = <TResponse>(envelope: Envelope<TResponse>): TResponse => {
  if (!envelope.success || envelope.response === null) {
    throw new OperationFailed(envelope.message ?? 'The operation could not be completed.')
  }
  return envelope.response
}

/**
 * Throws if an operation refused, for the operations whose payload says nothing
 * useful — revoking a session reports only that it happened.
 */
export const assertSucceeded = (envelope: {
  success: boolean
  message: string | null
}): void => {
  if (!envelope.success) {
    throw new OperationFailed(envelope.message ?? 'The operation could not be completed.')
  }
}

/** The message to show for a failure, whatever kind it turned out to be. */
export const messageFor = (error: unknown): string => {
  if (error instanceof OperationFailed) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong. Try again.'
}
