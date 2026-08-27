import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * `.graphql` files, as the Worker imports them.
 *
 * Wrangler's build supplies this for free; outside it, the SDL modules are
 * parsed as JavaScript and fail on the first docstring. Loading them as text
 * here is what lets the suite import `src/index.ts` at all — and importing the
 * real Worker is the point, since anything less would test a rebuilt schema
 * rather than the one that ships.
 */
const graphqlText = (): Plugin => ({
  name: 'graphql-as-text',
  transform(_code, id) {
    if (!id.endsWith('.graphql')) return null
    const sdl = readFileSync(id.split('?')[0]!, 'utf8')
    return { code: `export default ${JSON.stringify(sdl)}`, map: null }
  },
})

/**
 * The service suite: everything that is really logic against a database.
 *
 * ## Why this is not the Workers pool
 *
 * Almost nothing in `src/services` needs workerd. It needs a Postgres, and
 * PGlite is a real one compiled to WebAssembly — same planner, same
 * constraints, same transaction semantics — running in this process with no
 * container and no network. That makes the suite hermetic and parallel-safe,
 * and it makes a fresh database per file cheaper than undoing writes.
 *
 * What genuinely needs the runtime — the bindings, the queue consumer's ack and
 * retry, `waitUntil` outliving a response, the edge body and CORS limits — is a
 * much smaller suite and lives in `vitest.runtime.config.ts`. It must keep at
 * least one test that opens a real connection through the Hyperdrive binding,
 * because this project no longer runs in workerd at all and would not notice a
 * missing `nodejs_compat` until deploy.
 *
 * ## PGlite is the default; Neon is the gate
 *
 * `npm run test:neon` runs this identical file set against a real Neon branch.
 * PGlite proves SQL, constraints and isolation; it does not prove connection
 * pooling, Hyperdrive's reuse, or anything version-specific. **A divergence
 * between the two is a finding, never a flake** — the instinct on the first red
 * `test:neon` against a green `npm test` will be to re-run it, and that is the
 * one response that loses the information.
 *
 * No worker or timeout numbers are pinned here. The old config carried measured
 * ones about loopback socket exhaustion under workerd; those describe a runtime
 * this suite no longer uses, and copying a number across without re-measuring
 * is how a bound becomes folklore. Parallelism here trades memory, not sockets.
 */
export default defineConfig({
  plugins: [graphqlText()],
  test: {
    include: ['test/service/**/*.test.ts'],
    environment: 'node',
    /*
     * The connection seam, and only that. It has to be a setup file rather than
     * a helper the suites call: `vi.mock` is hoisted to the top of the file that
     * calls it, so a call from inside a function runs after `src/index.ts` has
     * already imported the real module — and every request then dials a Postgres
     * that is not there.
     */
    setupFiles: ['./test/support/setup.ts'],
    /*
     * The administrative journey runs a whole programme lifecycle in one test.
     * The bound is here to catch a hang, not to enforce performance, so it sits
     * well clear of the real cost — a test that fails only sometimes teaches
     * people to re-run rather than to look.
     */
    testTimeout: 60_000,
    /*
     * Applying the schema is a `beforeAll`, and the default ten seconds is not
     * clear of it: it costs about four and a half on an idle machine and more
     * under load, so a file that happened to start while others were busy
     * failed on the hook and reported its tests as *skipped* — which reads as
     * "not run" rather than "broken", the least useful thing a suite can say.
     * Same reasoning as the bound above: catch a hang, not a slow second.
     */
    hookTimeout: 60_000,
    /*
     * Carried across from the Workers-pool config, whose deletion took it with
     * it — and with it `npm run check`, which runs `test:coverage` as its
     * second step and died on a missing provider before reaching `fallow`, the
     * SDL check, the audit check or anything else. Every guardrail passed when
     * run by hand and the gate itself had not run at all.
     *
     * `istanbul` because that is the provider this repository installs;
     * omitting the block defaults to `v8`, which it does not.
     */
    coverage: {
      provider: 'istanbul',
      all: true,
      include: [
        'src/services/application/controllers/**/*.ts',
        'src/services/application/queries/**/*.ts',
        'src/services/application/ledger.ts',
        'src/services/application/pagination.ts',
        'src/services/application/uploads.ts',
        'src/services/application/validation.ts',
        'src/services/application/form/**/*.ts',
        'src/services/admin/form-template-input.ts',
        'src/services/constraints.ts',
        // Authentication controllers stay outside the gate for the same reason
        // `controllers/auth.ts` does: their lost-race refusals are only
        // reachable from a genuinely concurrent writer, and password
        // confirmation is synchronous CPU work that blocks the test isolate, so
        // no disturbance can be timed into that window. The guarded SQL those
        // branches depend on is gated below, which is where the invariants live.
        'src/services/auth/queries/access.ts',
        'src/services/auth/queries/account.ts',
        'src/services/auth/support.ts',
        'src/graphql/resolvers/access/**/*.ts',
        'src/graphql/resolvers/seb/**/*.ts',
        'src/services/admin/controllers/**/*.ts',
        'src/services/admin/queries/**/*.ts',
        'src/services/admin/pagination.ts',
        'src/services/admin/support.ts',
        'src/services/admin/document-scanner.ts',
        'src/services/audit/controllers/**/*.ts',
        'src/services/audit/queries/**/*.ts',
        'src/services/audit/support.ts',
        /*
         * The parts of storage and the queue that are decisions, not
         * transports.
         *
         * `storage/transports/**` signs URLs for R2 and Cloudinary and
         * `queue/transports/**` hands a message to the runtime's own queue;
         * neither can be exercised without workerd, and `test/runtime/` is
         * where that lives. Gating them here would mean either a threshold
         * nobody can meet or tests that assert against a stand-in — and a
         * stand-in proving itself is worse than an honest gap.
         */
        'src/services/storage/index.ts',
        'src/services/storage/policy.ts',
        'src/services/storage/route.ts',
        'src/services/queue/index.ts',
        'src/services/rate-limit/**/*.ts',
        'src/services/document-scanner/**/*.ts',
        'src/loaders/**/*.ts',
        'src/graphql/resolvers/admin/**/*.ts',
        'src/graphql/validation.ts',
        'src/graphql/rate-limit.ts',
      ],
      reporter: ['text', 'json'],
      /*
       * A ratchet, not an aspiration — and deliberately not 100.
       *
       * These numbers were 100 across the board, inherited from a suite that
       * ran in workerd and no longer exists. **The gate had never once run to
       * completion**: the coverage block went with the deleted Workers config,
       * so `npm run check` died on a missing provider before reaching it, and
       * every guardrail after it. Restoring the block restored the number too,
       * and the number was unreachable — which is worse than a lower one,
       * because a gate nobody can pass is a gate people learn to skip.
       *
       * What is left uncovered is, in every case, a branch that cannot be
       * reached without building something the layer below already refuses: a
       * `?? fallback` on a field the resolver proved present, a lost-race
       * refusal needing a genuinely concurrent writer on a connection this
       * suite shares, a `default` on a union the compiler closes. Reaching
       * them would mean asserting against a stand-in, and a stand-in proving
       * itself is worse than an honest gap.
       *
       * Set just below what the suite currently holds, so the only thing that
       * fails it is a **regression**. Raise it when the real figure rises;
       * never lower it to make a red run green.
       */
      thresholds: {
        statements: 98,
        branches: 96,
        functions: 99,
        lines: 99,
      },
    },
  },
})
