/**
 * Counts how many times a D1 binding is actually reached.
 *
 * Not a `.test.ts` file, so Vitest does not collect it — it is shared fixture
 * code for the tests that assert what a read costs.
 */
/**
 * Wraps the binding to count how many times it is actually reached.
 *
 * Drizzle calls `prepare(...)` then `.bind(...)` then `.all()`, and `bind`
 * returns a fresh statement — so the wrapper has to follow it, or the call
 * that matters escapes uncounted.
 */
export const counting = (database: D1Database) => {
  let calls = 0
  const RUNNERS = new Set(['all', 'run', 'first', 'raw'])

  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        if (property === 'bind') {
          return (...args: unknown[]) =>
            wrapStatement(value.apply(target, args) as D1PreparedStatement)
        }
        if (RUNNERS.has(property as string)) {
          return (...args: unknown[]) => {
            calls += 1
            return value.apply(target, args)
          }
        }
        return value.bind(target)
      },
    })

  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'prepare') {
        return (...args: unknown[]) =>
          wrapStatement(value.apply(target, args) as D1PreparedStatement)
      }
      if (property === 'batch') {
        // One call however many statements it carries. That is the point.
        return (...args: unknown[]) => {
          calls += 1
          return value.apply(target, args)
        }
      }
      return value.bind(target)
    },
  })
  return { database: proxy, calls: () => calls }
}
