import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppBindings } from './bindings'
import { createDatabase } from './db'
import { handleGraphQLRequest } from './graphql'
import {
  bootstrapFirstSuperAdmin,
  cleanupExpiredAuthentication,
  isValidBootstrapSecret,
} from './services/auth'
import { cleanupExpiredDocumentUploads } from './services/application'
import { handleLocalStorageRequest } from './services/application/local-storage-route'
import { closeExpiredProgrammeCycles } from './services/admin'

const app = new Hono<{ Bindings: AppBindings }>()

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
      {
        env: c.env,
        db: createDatabase(c.env.DB),
        requestHeaders: c.req.raw.headers,
        requestUrl: c.req.url,
        responseHeaders: new Headers(),
      },
    )
    return result.success ? c.json(result) : c.json(result, 403)
  },
)

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
app.on(['GET', 'PUT'], '/internal/storage/*', async (c) => {
  const response = await handleLocalStorageRequest(c.req.raw, {
    env: c.env,
    db: createDatabase(c.env.DB),
    requestHeaders: c.req.raw.headers,
    requestUrl: c.req.url,
    responseHeaders: new Headers(),
  })
  return response ?? c.notFound()
})

app.on(['GET', 'POST'], '/graphql', async (c) => {
  // Controllers append session cookies here. The Worker merges them into
  // Yoga's immutable response after GraphQL execution completes.
  const responseHeaders = new Headers()
  const response = await handleGraphQLRequest(c.req.raw, {
    env: c.env,
    db: createDatabase(c.env.DB),
    requestHeaders: c.req.raw.headers,
    requestUrl: c.req.url,
    responseHeaders,
  })

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
        closeExpiredProgrammeCycles({
          db,
          env,
          requestHeaders: new Headers(),
          requestUrl: 'https://scheduled.internal/',
          responseHeaders: new Headers(),
        }),
      ]).then(() => undefined),
    )
  },
  async queue(batch: MessageBatch, _env: CloudflareBindings) {
    for (const message of batch.messages) {
      // Queue payloads may eventually contain notification data. Log only the
      // Cloudflare message identifier so production logs cannot retain it.
      console.log('Processing queue message', message.id)
    }
  },
}
