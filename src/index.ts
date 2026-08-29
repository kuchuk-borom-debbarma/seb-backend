import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppBindings } from './bindings'
import { withDatabase, type Database } from './db'
import { createLoaders } from './loaders'
import { handleGraphQLRequest } from './graphql'
import {
  bootstrapFirstSuperAdmin,
  cleanupExpiredAuthentication,
  isValidBootstrapSecret,
} from './services/auth'
import { cleanupExpiredDocumentUploads } from './services/application'
import { handleLocalStorageRequest } from './services/storage/route'
import { confirmationPdfResponse } from './services/application/confirmation-link'
import { drainMemoryQueue, usesLocalQueue, type QueueMessage } from './services/queue'
import {
  scanDocumentVersion,
  scanPolicyDocumentVersion,
} from './services/document-scanner/consume'
import {
  rateLimiter,
  RATE_LIMITED_MESSAGE,
  CONFIRMATION_PDF,
  REQUEST_BUDGET,
} from './services/rate-limit'
import { callerAddress } from './services/rate-limit/identity'
import { relaysThroughWorker } from './services/storage'
import {
  cleanupExpiredCyclePolicyUploads,
  closeExpiredProgrammeCycles,
} from './services/admin'

const app = new Hono<{ Bindings: AppBindings }>()

/**
 * Everything a service operation needs, built fresh for one request.
 *
 * The point of a single builder is the loaders. They are a cache, and one
 * shared between requests would answer one person's query with another's data
 * — so "new every time" has to be structural rather than remembered at four
 * call sites. See `src/loaders.ts`.
 */
const operationContext = (
  env: AppBindings,
  db: Database,
  requestHeaders: Headers,
  requestUrl: string,
  responseHeaders = new Headers(),
) => ({ env, db, loaders: createLoaders(db), requestHeaders, requestUrl, responseHeaders })

/**
 * The connection every request opens and every request closes.
 *
 * Per request rather than per isolate, for the same reason the loaders are: an
 * isolate serves many people, and a connection held across them is a slot that
 * leaks rather than a cache that helps. Hyperdrive holds the real pool, so
 * opening one costs a hop rather than a handshake.
 *
 * A deployed environment may name its database directly: `DATABASE_URL`,
 * provisioned with `wrangler secret put`, wins over the Hyperdrive binding
 * there. Deliberately only where `ENVIRONMENT` is set — Wrangler loads
 * `.env.local` into a local Worker's vars, and the same variable an operator
 * keeps for the deployed database must not quietly point `npm run local` or
 * the end-to-end suite at it. A developer's machine keeps its local database.
 */
const connectionString = (env: AppBindings): string =>
  (env.ENVIRONMENT?.trim() && env.DATABASE_URL?.trim())
    ? env.DATABASE_URL.trim()
    : env.HYPERDRIVE.connectionString


// FRONTEND_ORIGINS is parsed on demand so tests and local Wrangler overrides can
// supply different bindings without global mutable configuration.
const frontendOrigins = (value: string | undefined): Set<string> =>
  new Set(
    (value ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )

const allowedOrigins = (env: AppBindings, requestUrl: string): Set<string> => {
  const origins = frontendOrigins(env.FRONTEND_ORIGINS)
  origins.add(new URL(requestUrl).origin)
  return origins
}

const applyCorsHeaders = (
  headers: Headers,
  origin: string | null,
  env: AppBindings,
  requestUrl: string,
): boolean => {
  if (!origin) return false
  /*
   * `FRONTEND_ORIGINS = "*"` echoes whichever origin asks.
   *
   * Not the same as sending `*`, which a browser refuses on a credentialed
   * request — so an allow-all still has to name the caller. **It also means any
   * site can call this API as a signed-in user.** The session cookie is
   * `SameSite=Lax`, which stops the simplest cross-site form posts, and that is
   * the whole of what stands behind it. Deliberate, and only for a demo whose
   * frontend host is not yet known: name the origin before public launch.
   */
  const trusted = allowedOrigins(env, requestUrl)
  if (!trusted.has('*') && !trusted.has(origin)) return false

  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-credentials', 'true')
  headers.append('vary', 'Origin')
  return true
}

app.get('/', (c) => {
  return c.json({
    name: 'seb-backend',
    status: 'ok',
    graphql: '/graphql',
    bindings: ['HYPERDRIVE', 'STORAGE', 'QUEUE'],
  })
})

/**
 * The budget every request spends, whatever it asks for.
 *
 * Applied before anything is parsed, so a flood costs one atomic increment
 * rather than a GraphQL parse — and it covers the routes below that have no
 * GraphQL at all. This is a guard on volume; the limits that make the sensitive
 * operations hard are per-operation and live in the policy, applied by the
 * plugin that can see which operation a document runs.
 *
 * Refuses with 429 and an envelope-shaped body, the way the body limit beside
 * it refuses with 413: a client reading `/graphql` gets the shape it expects
 * whatever went wrong.
 */
const requestBudget = async (
  c: { env: AppBindings; req: { raw: Request } },
  next: () => Promise<void>,
): Promise<Response | void> => {
  const address = callerAddress(c.req.raw.headers)
  // Nothing to count against. Locally there is no such header at all, and a
  // request that reaches a deployed Worker without one is the platform's
  // business rather than something to refuse over.
  if (!address) return next()

  let allowed: boolean
  try {
    allowed = (await rateLimiter(c.env).consume(REQUEST_BUDGET, address)).allowed
  } catch {
    // Could not answer. This service refuses rather than permitting when it
    // cannot answer — protection is never silently absent.
    allowed = false
  }
  if (allowed) return next()

  /*
   * Carries the CORS headers, for the same reason the storage route's success
   * answer does: a document upload is the one thing the browser sends here
   * itself, and without them the browser withholds the response from the page.
   * The applicant would see a network error rather than being told to wait.
   *
   * The GraphQL path does not need this — the client executes those on its own
   * server — but this middleware covers both, and a refusal that is legible on
   * one surface and opaque on the other is worse than either.
   */
  const headers = new Headers({ 'content-type': 'application/json' })
  applyCorsHeaders(headers, c.req.raw.headers.get('Origin'), c.env, c.req.raw.url)
  return new Response(
    JSON.stringify({ success: false, message: RATE_LIMITED_MESSAGE, response: null }),
    { status: 429, headers },
  )
}

const BOOTSTRAP_FAILURE_MESSAGE =
  'First administrator bootstrap is unavailable or the supplied credentials are invalid.'
const BOOTSTRAP_BODY_LIMIT_BYTES = 1_024

/**
 * The largest GraphQL request the service will buffer.
 *
 * Measured, not guessed: the client's largest document is 2.4 KB and its
 * largest variables — a programme cycle's whole frozen policy, with its
 * document rules, assessment rules and reason catalogue — are a few kilobytes
 * more. 64 KB is several times the largest legitimate request and small enough
 * that nobody can make the Worker buffer a platform-sized body before a single
 * validation rule has run.
 */
const GRAPHQL_BODY_LIMIT_BYTES = 64 * 1_024

/**
 * One deliberately non-GraphQL bootstrap route for trusted command-line use.
 *
 * Browsers are denied by the Origin check and receive no CORS opt-in. The route
 * still relies on credentials—not User-Agent—for security because clients can
 * spoof a curl header. Once any SUPER_ADMIN grant has ever existed, the service
 * permanently refuses this transition even if the environment secret remains.
 */
app.post(
  '/internal/bootstrap/first-super-admin',
  bodyLimit({
    // The only request field is a password capped at 128 characters. A small
    // streaming limit prevents unauthenticated callers from making the Worker
    // buffer a platform-sized request before credential validation.
    maxSize: BOOTSTRAP_BODY_LIMIT_BYTES,
    onError: (c) => c.json(
      { success: false, message: BOOTSTRAP_FAILURE_MESSAGE, response: null },
      413,
    ),
  }),
  async (c) => {
    if (c.req.header('Origin')) {
      return c.json(
        { success: false, message: BOOTSTRAP_FAILURE_MESSAGE, response: null },
        403,
      )
    }

    // Reject an absent or structurally invalid bearer token before touching the
    // body. The service performs the constant-time credential comparison later.
    const authorization = c.req.header('Authorization') ?? ''
    const bootstrapSecret = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : ''
    if (!isValidBootstrapSecret(bootstrapSecret)) {
      return c.json(
        { success: false, message: BOOTSTRAP_FAILURE_MESSAGE, response: null },
        403,
      )
    }

    const contentType = c.req.header('Content-Type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('application/json')) {
      return c.json(
        { success: false, message: BOOTSTRAP_FAILURE_MESSAGE, response: null },
        400,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { success: false, message: BOOTSTRAP_FAILURE_MESSAGE, response: null },
        400,
      )
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { currentPassword?: unknown }).currentPassword !== 'string'
    ) {
      return c.json(
        { success: false, message: BOOTSTRAP_FAILURE_MESSAGE, response: null },
        400,
      )
    }

    const result = await withDatabase(connectionString(c.env), (db) =>
      bootstrapFirstSuperAdmin(
        {
          currentPassword: (body as { currentPassword: string }).currentPassword,
          bootstrapSecret,
        },
        operationContext(c.env, db, c.req.raw.headers, c.req.url),
      ),
    )
    return result.success ? c.json(result) : c.json(result, 403)
  },
)

app.use('/graphql', requestBudget)
app.use('/internal/*', requestBudget)

app.use(
  '/graphql',
  bodyLimit({
    maxSize: GRAPHQL_BODY_LIMIT_BYTES,
    onError: (c) => c.json(
      { success: false, message: 'The request is too large.', response: null },
      413,
    ),
  }),
  async (c, next) => {
    // Reject an untrusted browser origin before Yoga parses or executes GraphQL.
    // `*` trusts every origin — see `applyCorsHeaders` for what that costs.
    const origin = c.req.header('Origin')
    const trusted = allowedOrigins(c.env, c.req.url)
    if (origin && !trusted.has('*') && !trusted.has(origin)) {
      return c.json({ success: false, message: 'Origin is not allowed.' }, 403)
    }
    await next()
  },
)

app.options('/graphql', (c) => {
  // Credentialed CORS must echo a concrete trusted origin; `*` is invalid when
  // browsers attach the applicant session cookie.
  const headers = new Headers()
  const allowed = applyCorsHeaders(
    headers,
    c.req.header('Origin') ?? null,
    c.env,
    c.req.url,
  )
  if (!allowed) return c.body(null, 403)

  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  headers.set('access-control-allow-headers', 'Content-Type')
  headers.set('access-control-max-age', '86400')
  return new Response(null, { status: 204, headers })
})

/*
 * The preflight for an upload this Worker receives itself.
 *
 * Open wherever storage **relays** rather than sending the browser to a
 * provider — locally, and deployed on Cloudinary. Deliberately so: the PUT it
 * precedes is open in exactly those cases, and a preflight that refused where
 * the handler accepts would kill the upload in the browser before the Worker
 * ever saw it. It is not a second way in; it is the same way, answered.
 *
 * On R2 neither is open, because there the browser is sent to the bucket and
 * this Worker never handles a byte.
 */
app.options('/internal/storage/*', (c) => {
  /*
   * The browser uploads to a different origin than the page it is on, because
   * that is what it does deployed: the page is the client's origin and the
   * bytes go to the bucket's. Locally this Worker stands in for the bucket, so
   * it has to answer the preflight the bucket's CORS policy would.
   *
   * Without this the upload never leaves the page — the preflight 404s and the
   * browser never sends the PUT, which looks like a broken upload rather than a
   * missing header.
   */
  // The same predicate the handler this preflights uses. They have to agree:
  // a relaying backend that answered the PUT but not the preflight would fail
  // before the browser ever sent it.
  if (!relaysThroughWorker(c.env)) return c.notFound()

  const headers = new Headers()
  if (!applyCorsHeaders(headers, c.req.header('Origin') ?? null, c.env, c.req.url)) {
    return c.body(null, 403)
  }
  headers.set('access-control-allow-methods', 'GET, PUT, OPTIONS')
  // Exactly the two the authorization asks the caller to send. Content-Length
  // is generated by the browser from the body and is never preflighted.
  headers.set('access-control-allow-headers', 'Content-Type, Content-Disposition')
  headers.set('access-control-max-age', '86400')
  return new Response(null, { status: 204, headers })
})

app.on(['GET', 'PUT'], '/internal/storage/*', async (c) => {
  const response = await withDatabase(connectionString(c.env), (db) =>
    handleLocalStorageRequest(c.req.raw, { env: c.env, db }),
  )
  if (!response) return c.notFound()

  // The preflight only authorizes the browser to send the request; the answer
  // needs the headers too, or the browser withholds it from the page.
  const headers = new Headers(response.headers)
  applyCorsHeaders(headers, c.req.header('Origin') ?? null, c.env, c.req.url)
  return new Response(response.body, { status: response.status, headers })
})

/**
 * The emailed copy of a submitted application.
 *
 * The notification provider attaches by URL, so the confirmation email links
 * here. The link authorizes itself — a signature over the application id and
 * an expiry — and the module serves the same refusal for every way a link
 * can be wrong. No session, deliberately: it is opened from an inbox.
 */
app.use('/confirmation-pdf', requestBudget)
app.get('/confirmation-pdf', async (c) => {
  /*
   * Its own allowance on top of the shared budget: the valid path rebuilds
   * a PDF, and the link is a bearer credential that outlives the email. The
   * limiter fails closed, like every enforcement point in this service.
   */
  const address = callerAddress(c.req.raw.headers)
  if (address) {
    let allowed: boolean
    try {
      allowed = (await rateLimiter(c.env).consume(CONFIRMATION_PDF, address)).allowed
    } catch {
      allowed = false
    }
    if (!allowed) return c.text('Too many requests. Try again in a minute.', 429)
  }
  return withDatabase(connectionString(c.env), (db) =>
    confirmationPdfResponse(db, c.env, {
      application: c.req.query('application'),
      expires: c.req.query('expires'),
      signature: c.req.query('signature'),
    }),
  )
})

/**
 * Delivers whatever the in-process queue collected during this request.
 *
 * A developer's machine has no queue, so the local transport only holds what
 * was sent to it. Something has to carry those messages to the consumer, or
 * documents are never scanned locally and no administrator can open one —
 * which is the whole reason the scanner seam exists.
 *
 * Run after the response rather than inside it, which is what a real queue
 * does: the applicant is not kept waiting for work that is not theirs.
 */
const deliverLocalQueue = async (env: AppBindings): Promise<void> => {
  const pending = drainMemoryQueue()
  if (pending.length === 0) return
  await withDatabase(connectionString(env), async (db) => {
    for (const message of pending) {
      // A failure leaves the document unopenable, which is the safe direction.
      // Never the error or the body: both can name a stored object.
      await (message.kind === 'POLICY_DOCUMENT_SCAN_REQUESTED'
        ? scanPolicyDocumentVersion(db, env, message.policyDocumentVersionId)
        : scanDocumentVersion(db, env, message.documentVersionId))
        .catch(() => console.error('Scanning a queued document failed'))
    }
  })
}

app.on(['GET', 'POST'], '/graphql', async (c) => {
  // Controllers append session cookies here. The Worker merges them into
  // Yoga's immutable response after GraphQL execution completes.
  const responseHeaders = new Headers()
  /*
   * The connection lives exactly as long as GraphQL execution.
   *
   * It has to close before the response is returned rather than in a
   * `waitUntil`: a pooled slot held past the request is one the next request
   * cannot have, and an isolate serving many people would exhaust them.
   */
  const response = await withDatabase(connectionString(c.env), (db) =>
    handleGraphQLRequest(
      c.req.raw,
      operationContext(c.env, db, c.req.raw.headers, c.req.url, responseHeaders),
    ),
  )
  if (usesLocalQueue(c.env)) c.executionCtx.waitUntil(deliverLocalQueue(c.env))

  const headers = new Headers(response.headers)
  applyCorsHeaders(headers, c.req.header('Origin') ?? null, c.env, c.req.url)
  responseHeaders.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return headers.append('set-cookie', value)
    headers.set(key, value)
  })

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
})

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: AppBindings, ctx: ExecutionContext) {
    // Cleanup is deliberately off the request path. waitUntil lets Cloudflare
    // keep the scheduled task alive after the handler returns, and the
    // connection is closed when the last job finishes rather than leaking.
    ctx.waitUntil(
      withDatabase(connectionString(env), async (db) => {
        /*
         * One at a time, on purpose.
         *
         * This was a `Promise.all`, which bought no parallelism — the three
         * share one connection, so their statements queue on it regardless —
         * while reading as though it did. What it did buy was interleaving: a
         * job's plain statement issued while another job's guarded write holds
         * a `BEGIN` lands *inside* that transaction, and if the transaction has
         * already failed, the innocent statement is refused with `25P02`. One
         * job's lost race would take another down with it, and a scheduled run
         * has nobody to report that to.
         *
         * Sequential also means a job that throws does not leave two others
         * mid-flight on a connection about to be closed. The jobs are
         * independent, so each is awaited on its own and a failure in one still
         * lets the rest run.
         */
        const jobs: [string, () => Promise<unknown>][] = [
          ['expired authentication', () => cleanupExpiredAuthentication(db)],
          ['expired document uploads', () => cleanupExpiredDocumentUploads({ db, env })],
          ['expired policy uploads', () => cleanupExpiredCyclePolicyUploads({ db, env })],
          // Its own loaders, for the same reason a request gets its own: a
          // scheduled run is a separate instant from anybody's request.
          ['programme cycles past their close', () => closeExpiredProgrammeCycles(
            operationContext(env, db, new Headers(), 'https://scheduled.internal/'),
          )],
        ]
        for (const [name, run] of jobs) {
          try {
            await run()
          } catch {
            // Named, never the error: a driver message can quote the statement.
            console.error(`Scheduled cleanup of ${name} did not finish.`)
          }
        }
      }),
    )
  },
  /**
   * Consumer for queued work.
   *
   * Every message kind is a request to scan a stored file — an applicant's
   * document or a cycle's policy PDF. Which scanner examines it is
   * `SCANNER_TRANSPORT`'s decision, and `services/document-scanner` holds it;
   * this holds none of it.
   *
   * A message that could not be settled is left unacknowledged so the platform
   * redelivers it. The document stays unopenable until it succeeds, which is
   * the safe direction to fail in.
   *
   * **A permanent condition is acknowledged rather than retried.** A document
   * version that no longer exists cannot be scanned by trying again, and the
   * retry budget it would consume is shared with failures that a retry really
   * can fix — a provider timeout, a rate-limited request.
   */
  async queue(messages: MessageBatch<QueueMessage>, env: CloudflareBindings) {
    await withDatabase(connectionString(env as AppBindings), async (db) => {
      for (const message of messages.messages) {
        try {
          const disposition = message.body.kind === 'POLICY_DOCUMENT_SCAN_REQUESTED'
            ? await scanPolicyDocumentVersion(
                db,
                env as AppBindings,
                message.body.policyDocumentVersionId,
              )
            : await scanDocumentVersion(
                db,
                env as AppBindings,
                message.body.documentVersionId,
              )
          if (disposition === 'NOT_RECORDED') message.retry()
          else message.ack()
        } catch {
          // Never the error and never the body: a scan failure can carry the
          // request it was making, and that request names a stored object.
          console.error('Scanning a queued document failed', message.id)
          message.retry()
        }
      }
    })
  },
}

