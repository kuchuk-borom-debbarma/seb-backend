/**
 * Counting what a read actually costs, in round trips.
 *
 * ## Why this replaces the D1 call counter
 *
 * The old one counted calls to the D1 binding, and the numbers it recorded —
 * 232s to 145s, 5.0s to 34.7s — measured a binding co-located with the isolate.
 * None of that survives the move to Postgres over Hyperdrive, where the cost
 * model is one network hop per statement and a "batch" is not one call at all.
 * Carrying those numbers across without re-measuring is how a bound becomes
 * folklore, so they are gone and this counts the thing that now costs.
 *
 * The *rule* they encoded survives intact and is why this exists at all:
 * **measure, do not reason.** A fan-out that looks like one read and issues
 * twelve is invisible in the code and obvious here.
 *
 * Statements are counted at the driver, so nothing in the service layer has to
 * know it is being watched, and a query added inside a helper three calls down
 * is counted like any other.
 */
/**
 * What a countable client has to offer.
 *
 * The driver handle rather than the test-client wrapper: Drizzle holds a
 * direct reference to the driver, so patching anything above it counts
 * nothing and the test reports zero round trips while passing.
 */
type CountableClient = {
  query: (...args: never[]) => unknown
  /*
   * PGlite has a separate `exec` for scripts; node-postgres routes everything
   * through `query`. Optional, so the counter works against either — patching
   * a method that is not there is how this reported zero round trips while
   * passing.
   */
  exec?: (...args: never[]) => unknown
}

export type RoundTripCounter = {
  /** How many statements have reached the database since the last `reset`. */
  count: () => number
  reset: () => void
  /** Every statement counted, for a failure message that says which. */
  statements: () => readonly string[]
}

/*
 * The transaction control a transition issues around its own statements. Real
 * round trips, but not the *reads* a caller is asking about — counting them
 * would make "how many queries does this take" depend on whether the answer
 * happened to be wrapped, which is not the question anybody is asking.
 */
const CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK'])

export const countRoundTrips = (db: CountableClient): RoundTripCounter => {
  const seen: string[] = []
  const original = db.query.bind(db)
  const originalExec = db.exec?.bind(db)

  /*
   * The statement, however the driver was handed it. PGlite takes the SQL as a
   * string; node-postgres takes `{ text, values }`. Assuming a string made
   * every call throw inside the counter, which surfaced as the query itself
   * having failed — a long way from the cause.
   */
  const record = (query: unknown) => {
    const text = typeof query === 'string'
      ? query
      : String((query as { text?: unknown })?.text ?? '')
    const trimmed = text.trim()
    if (trimmed && !CONTROL.has(trimmed.toUpperCase())) seen.push(trimmed)
  }

  // Patched rather than proxied: Drizzle holds a direct reference to the
  // client, so a proxy handed to it later would not be the object it calls.
  ;(db as { query: typeof db.query }).query = ((query: unknown, ...rest: unknown[]) => {
    record(query)
    return (original as (...args: unknown[]) => unknown)(query, ...rest)
  }) as typeof db.query
  if (originalExec) {
    ;(db as { exec?: typeof db.exec }).exec = ((query: unknown, ...rest: unknown[]) => {
      record(query)
      return (originalExec as (...args: unknown[]) => unknown)(query, ...rest)
    }) as typeof db.exec
  }

  return {
    count: () => seen.length,
    reset: () => void (seen.length = 0),
    statements: () => [...seen],
  }
}
