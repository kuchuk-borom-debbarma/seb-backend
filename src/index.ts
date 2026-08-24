import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppBindings } from './bindings'
import { createDatabase } from './db'
import { createLoaders } from './loaders'
import { handleGraphQLRequest } from './graphql'
import {
  bootstrapFirstSuperAdmin,
  cleanupExpiredAuthentication,
  isValidBootstrapSecret,
} from './services/auth'
import { cleanupExpiredDocumentUploads } from './services/application'
import { handleLocalStorageRequest } from './services/storage/route'
import { drainMemoryQueue, usesLocalQueue, type QueueMessage } from './services/queue'
import { scanDocumentVersion } from './services/document-scanner/consume'
import {
  rateLimiter,
  RATE_LIMITED_MESSAGE,
  REQUEST_BUDGET,
} from './services/rate-limit'
import { callerAddress } from './services/rate-limit/identity'
import { usesLocalStorage } from './services/storage'
import { closeExpiredProgrammeCycles } from './services/admin'

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
  requestHeaders: Headers,
  requestUrl: string,
  responseHeaders = new Headers(),
) => {
  const db = createDatabase(env.DB)
  return { env, db, loaders: createLoaders(db), requestHeaders, requestUrl, responseHeaders }
}


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
  // Echo only an explicitly trusted origin; wildcard origins cannot be used
  // together with credentialed browser requests.
  if (!origin || !allowedOrigins(env, requestUrl).has(origin)) return false

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
    bindings: ['DB', 'STORAGE', 'QUEUE'],
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

    const result = await bootstrapFirstSuperAdmin(
      {
        currentPassword: (body as { currentPassword: string }).currentPassword,
        bootstrapSecret,
      },
      operationContext(c.env, c.req.raw.headers, c.req.url),
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
    const origin = c.req.header('Origin')
    if (origin && !allowedOrigins(c.env, c.req.url).has(origin)) {
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
 * Uploads on a developer's machine, where there is no bucket to sign a URL for.
 * The handler refuses unless the local storage backend is the selected one, so
 * this is not a second way into a deployed environment.
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
  if (!usesLocalStorage(c.env)) return c.notFound()

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
  const response = await handleLocalStorageRequest(c.req.raw, {
    env: c.env,
    db: createDatabase(c.env.DB),
  })
  if (!response) return c.notFound()

  // The preflight only authorizes the browser to send the request; the answer
  // needs the headers too, or the browser withholds it from the page.
  const headers = new Headers(response.headers)
  applyCorsHeaders(headers, c.req.header('Origin') ?? null, c.env, c.req.url)
  return new Response(response.body, { status: response.status, headers })
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
  const db = createDatabase(env.DB)
  for (const message of pending) {
    // A failure leaves the document unopenable, which is the safe direction.
    // Never the error or the body: both can name a stored object.
    await scanDocumentVersion(db, env, message.documentVersionId)
      .catch(() => console.error('Scanning a queued document failed'))
  }
}

app.on(['GET', 'POST'], '/graphql', async (c) => {
  // Controllers append session cookies here. The Worker merges them into
  // Yoga's immutable response after GraphQL execution completes.
  const responseHeaders = new Headers()
  const response = await handleGraphQLRequest(
    c.req.raw,
    operationContext(c.env, c.req.raw.headers, c.req.url, responseHeaders),
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
    // keep the scheduled task alive after the handler returns.
    const db = createDatabase(env.DB)
    ctx.waitUntil(
      Promise.all([
        cleanupExpiredAuthentication(db),
        cleanupExpiredDocumentUploads({ db, env }),
        // Its own loaders, for the same reason a request gets its own: a
        // scheduled run is a separate instant from anybody's request.
        closeExpiredProgrammeCycles(
          operationContext(env, new Headers(), 'https://scheduled.internal/'),
        ),
      ]).then(() => undefined),
    )
  },
  /**
   * Consumer for queued work.
   *
   * One kind of message exists: a request to scan a stored document. What
   * happens next depends entirely on the environment — locally and on develop
   * the file is accepted without being examined, and the scan history records
   * that in as many words; in production the scanner refuses to exist at all
   * until a real one is configured. `services/document-scanner` holds that
   * decision, and this holds none of it.
   *
   * A message that could not be settled is left unacknowledged so the platform
   * redelivers it. The document stays unopenable until it succeeds, which is
   * the safe direction to fail in.
   */
  async queue(batch: MessageBatch<QueueMessage>, env: CloudflareBindings) {
    const db = createDatabase(env.DB)
    for (const message of batch.messages) {
      try {
        const recorded = await scanDocumentVersion(
          db,
          env as AppBindings,
          message.body.documentVersionId,
        )
        if (recorded) message.ack()
        else message.retry()
      } catch {
        // Never the error and never the body: a scan failure can carry the
        // request it was making, and that request names a stored object.
        console.error('Scanning a queued document failed', message.id)
        message.retry()
      }
    }
  },
}

