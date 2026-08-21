import { Hono } from 'hono'
import type { AppBindings } from './bindings'
import { createDatabase } from './db'
import { handleGraphQLRequest } from './graphql'
import { cleanupExpiredAuthentication } from './services/auth'

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

app.use('/graphql', async (c, next) => {
  // Reject an untrusted browser origin before Yoga parses or executes GraphQL.
  const origin = c.req.header('Origin')
  if (origin && !allowedOrigins(c.env, c.req.url).has(origin)) {
    return c.json({ success: false, message: 'Origin is not allowed.' }, 403)
  }
  await next()
})

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
    ctx.waitUntil(cleanupExpiredAuthentication(createDatabase(env.DB)))
  },
  async queue(batch: MessageBatch, _env: CloudflareBindings) {
    for (const message of batch.messages) {
      console.log('Processing queue message', message.id, message.body)
    }
  },
}
