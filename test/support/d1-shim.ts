/**
 * The D1 fixture API, backed by a real Postgres.
 *
 * Around four hundred fixture statements were written against `env.DB` — D1's
 * `prepare(...).bind(...)` with `?` placeholders, integer booleans and epoch
 * milliseconds. Rewriting them by hand would have been four hundred chances to
 * transpose two binds, and a transposed bind in a fixture is a **green test
 * asserting the wrong thing** — the same class of defect as the `db.batch`
 * column shift this repository already has a scar for.
 *
 * So the rewrite is mechanical instead, and its two halves are both derived
 * rather than guessed:
 *
 * 1. **`?` becomes `$1, $2, …` in order.** Order is preserved by construction,
 *    so the transposition this exists to avoid cannot happen.
 * 2. **Values are marshalled from the parameter types Postgres itself reports.**
 *    `PREPARE` the statement, read `pg_prepared_statements.parameter_types`, and
 *    convert only where the declared type says to. Guessing from the JS value
 *    would be worse than useless: a `size_bytes` of 1_700_000_000 looks exactly
 *    like an epoch-second timestamp, and nothing downstream would notice.
 *
 * This is a **fixture** seam. Production code never sees it; it exists so the
 * suite's arrangement can stay as it was written while the assertions move to
 * the engine the product actually runs on.
 */
import type { TestClient } from './client'

type Row = Record<string, unknown>

/** What D1 returns from a mutating statement, in the shape callers destructure. */
type RunResult = { success: true; meta: { changes: number; last_row_id: number } }

const TIMESTAMP_TYPES = new Set([
  'timestamp with time zone',
  'timestamp without time zone',
])

/**
 * Replaces `?` with `$n`, leaving anything inside a literal alone.
 *
 * A `?` inside a quoted string is data, not a placeholder — the schema's own
 * CHECK patterns contain them. Walking the string is the only way to tell, and
 * getting it wrong would silently renumber every parameter after it.
 */
export const positional = (sql: string): string => {
  let out = ''
  let index = 0
  let quote: string | null = null
  for (let i = 0; i < sql.length; i += 1) {
    const character = sql[i]!
    if (quote) {
      out += character
      if (character === quote) {
        // A doubled quote is an escaped one and does not close the literal.
        if (sql[i + 1] === quote) {
          out += sql[i + 1]
          i += 1
        } else quote = null
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      out += character
      continue
    }
    if (character === '?') {
      index += 1
      out += `$${index}`
      continue
    }
    out += character
  }
  return out
}

/** Marshals one fixture value into what its declared parameter type accepts. */
const marshal = (value: unknown, type: string | undefined): unknown => {
  if (value === null || value === undefined) return null
  if (type === undefined) return value
  if (TIMESTAMP_TYPES.has(type) && typeof value === 'number') {
    return new Date(value).toISOString()
  }
  if (type === 'date' && typeof value === 'number') {
    return new Date(value).toISOString().slice(0, 10)
  }
  if (type === 'boolean' && typeof value === 'number') return value !== 0
  if (type === 'boolean' && typeof value === 'string') return value === '1' || value === 'true'
  // `bigint` columns come back as strings from node-postgres; a fixture binding
  // a JS number is what it means, and Postgres parses the decimal text.
  if (type === 'bigint' && typeof value === 'number') return String(value)
  return value
}

/**
 * Turns a read back into what a D1 fixture expects.
 *
 * Symmetrical with the write path, and for the same reason: these assertions
 * were written against a store that held an instant as an integer, so they
 * compare with `Date.now()` and with each other arithmetically. Returning a
 * `Date` would fail them one at a time with a type error, and each would be
 * "fixed" by hand — a thousand chances to change what a test proves.
 *
 * The conversion is exact, so nothing is lost: an assertion that wants the
 * instant gets the instant.
 */
const readBack = (row: Row): Row => {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.getTime() : value
  }
  return out
}

/**
 * A name no concurrent lookup can collide with.
 *
 * Incremented synchronously, before any `await`. Deriving it from the cache's
 * size instead let two fixtures issued by one `Promise.all` both see zero and
 * both `PREPARE shim_0` — the second refused, and the failure named a prepared
 * statement rather than the fixture that caused it.
 */
let describeSequence = 0

class ShimStatement {
  private values: readonly unknown[] = []

  constructor(
    private readonly db: TestClient,
    private readonly types: Map<string, Promise<readonly string[]>>,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): ShimStatement {
    const next = new ShimStatement(this.db, this.types, this.sql)
    next.values = values
    return next
  }

  /**
   * The parameter types this statement's placeholders take, from Postgres.
   *
   * The *promise* is cached, not the result: two concurrent callers with the
   * same SQL then share one description rather than racing to produce it.
   */
  private parameterTypes(text: string): Promise<readonly string[]> {
    const known = this.types.get(text)
    if (known) return known
    describeSequence += 1
    const name = `shim_${describeSequence}`
    const described = (async () => {
      await this.db.exec(`PREPARE ${name} AS ${text}`)
      const result = await this.db.query<{ t: string[] }>(
        `SELECT parameter_types::text[] AS t FROM pg_prepared_statements WHERE name = $1`,
        [name],
      )
      await this.db.exec(`DEALLOCATE ${name}`)
      return result.rows[0]?.t ?? []
    })()
    this.types.set(text, described)
    return described
  }

  async rows<T = Row>(): Promise<{ rows: T[]; changes: number }> {
    const text = positional(this.sql)
    const types = this.values.length > 0 ? await this.parameterTypes(text) : []
    const bound = this.values.map((value, index) => marshal(value, types[index]))
    const result = await this.db.query<Row>(text, bound as unknown[])
    return {
      rows: result.rows.map(readBack) as T[],
      changes: result.affectedRows ?? result.rowCount ?? 0,
    }
  }

  async run(): Promise<RunResult> {
    const { changes } = await this.rows()
    return { success: true, meta: { changes, last_row_id: 0 } }
  }

  async all<T = Row>(): Promise<{ success: true; results: T[] }> {
    const { rows } = await this.rows<T>()
    return { success: true, results: rows }
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const { rows } = await this.rows<Row>()
    const row = rows[0]
    if (!row) return null
    return (column === undefined ? row : row[column]) as T
  }

  /** D1's positional form. Used by the structural tests to read tuples. */
  async raw<T = unknown[]>(): Promise<T[]> {
    const { rows } = await this.rows<Row>()
    return rows.map((row) => Object.values(row)) as T[]
  }
}

export type ShimDatabase = {
  prepare: (sql: string) => ShimStatement
  batch: <T>(statements: ShimStatement[]) => Promise<{ success: true; results: T[] }[]>
}

/**
 * A fixture handle over one test database, whichever it is.
 *
 * `batch` runs inside a transaction, which is what D1's was: the fixtures rely
 * on all-or-nothing so a half-built aggregate never reaches an assertion.
 */
export const shimDatabase = (db: TestClient): ShimDatabase => {
  const types = new Map<string, Promise<readonly string[]>>()
  return {
    prepare: (sql: string) => new ShimStatement(db, types, sql),
    batch: async <T>(statements: ShimStatement[]) => {
      await db.exec('BEGIN')
      try {
        const results: { success: true; results: T[] }[] = []
        for (const statement of statements) results.push(await statement.all<T>())
        await db.exec('COMMIT')
        return results
      } catch (error) {
        await db.exec('ROLLBACK')
        throw error
      }
    },
  }
}
