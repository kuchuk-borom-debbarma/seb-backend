/**
 * The `cloudflare:test` surface, outside workerd.
 *
 * Five things came from that module — `env`, `SELF`, `createExecutionContext`,
 * `waitOnExecutionContext` and `createScheduledController` — and every suite
 * reaches the Worker through them. Providing the same five here is what lets a
 * three-thousand-line file move to the node pool by changing its import line
 * and nothing else: the bodies keep their arrangement, their assertions and
 * their scars.
 *
 * That mattered more than elegance. Rewriting four hundred fixture statements
 * and a thousand assertions by hand would have been a thousand chances to
 * change what a test proves without noticing, and a test that still passes
 * while proving something else is the worst outcome available here.
 */
import worker from '../../src/index'
import type { AppBindings } from '../../src/bindings'
import { activeShim, testEnv } from './harness'
import type { ShimDatabase } from './d1-shim'

/**
 * The bindings, with `DB` resolving to whichever database is current.
 *
 * A proxy rather than a plain object because `env` is captured at module scope
 * by every suite, while `freshDatabase()` replaces the database per file — and
 * a stale handle would read an empty database while the Worker read the real
 * one, which is a failure mode that looks like a missing fixture.
 */
export const env: AppBindings & { DB: ShimDatabase } = new Proxy(
  testEnv() as AppBindings & { DB: ShimDatabase },
  {
    get: (target, property) =>
      property === 'DB' ? activeShim() : target[property as keyof typeof target],
  },
)

export type TestExecutionContext = ExecutionContext & { settled: () => Promise<unknown> }

export const createExecutionContext = (): TestExecutionContext => {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
    settled: () => Promise.all(pending),
  } as unknown as TestExecutionContext
}

/**
 * Waits for what a handler deferred.
 *
 * In workerd this made `waitUntil` work observable; here it is the same
 * promise. Suites await it to assert on a side effect that outlives the
 * response — a queue delivery, a cleanup sweep — and dropping it would make
 * those assertions race.
 */
export const waitOnExecutionContext = (context: TestExecutionContext): Promise<unknown> =>
  context.settled()

export const createScheduledController = (
  overrides: Partial<ScheduledController> = {},
): ScheduledController =>
  ({
    scheduledTime: Date.now(),
    cron: '0 * * * *',
    noRetry: () => undefined,
    ...overrides,
  }) as ScheduledController

/**
 * The Worker, reached the way `SELF` reached it.
 *
 * `SELF.fetch` went through the runtime's own loopback, so a suite's request
 * crossed a real socket. This does not, and the difference is worth naming: the
 * edge body limit and the connection-level CORS preflight are the runtime's, not
 * Hono's, so anything asserting *those* belongs in `test/runtime/` rather than
 * here. Everything else — routing, cookies, the GraphQL pipeline — is the same
 * code either way.
 */
export const SELF = {
  fetch: async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    const context = createExecutionContext()
    const response = await worker.fetch(request, env, context as unknown as ExecutionContext)
    await waitOnExecutionContext(context)
    return response
  },
}
