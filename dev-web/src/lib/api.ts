/**
 * The single place this client talks to the Worker.
 *
 * The Worker issues an HttpOnly `seb_session` cookie. Rather than expose it to
 * the browser and depend on credentialed CORS, every operation goes through
 * this module: on the server it calls the Worker directly, and in the browser
 * it posts to our own `/api/graphql` route, which forwards the cookie in and
 * relays `Set-Cookie` back out. The browser therefore only ever sees its own
 * origin — no preflight, and sign-in works without loosening SameSite.
 */

/**
 * Where the Worker is listening.
 *
 * `npm run local` sets this to port 9999 to match the Worker's own `local`
 * script. The fallback is Wrangler's default port, so a plain `wrangler dev`
 * also works without configuration. Overridden per environment; never
 * hard-coded at a call site.
 */
export const workerOrigin = (): string =>
  process.env.SEB_API_URL ?? 'http://localhost:8787'

/**
 * The API Worker, bound directly rather than addressed over the network.
 *
 * Deployed, both Workers live on the same account, and **one `workers.dev`
 * Worker may not make a subrequest to another** — Cloudflare answers `error
 * code: 1042` and the client's first render fails with a JSON parse error,
 * because an error page is not JSON. A service binding is the way across: the
 * request is routed to the other Worker directly, with no hop out to the edge
 * and no DNS.
 *
 * Absent locally, where the two really are separate origins, so the plain
 * `fetch` below stays the development path. The binding hangs off
 * `globalThis.__env__`, which is where the Cloudflare preset puts a Worker's
 * bindings — Nitro has no typed accessor for them.
 */
const apiBinding = (): { fetch: typeof fetch } | undefined =>
  (globalThis as { __env__?: { API?: { fetch: typeof fetch } } }).__env__?.API

export type GraphQLRequest = {
  query: string
  variables?: Record<string, unknown>
}

/**
 * A GraphQL response as the Worker returns it.
 *
 * `errors` covers malformed documents and unexpected faults only. Expected
 * business failures arrive inside `data` as `{ success: false, message }`
 * envelopes, which is why callers unwrap results rather than catching.
 */
export type GraphQLResponse<TData> = {
  data?: TData
  errors?: Array<{ message: string }>
}

/**
 * Forwards one operation to the Worker.
 *
 * Returns the parsed body together with any `Set-Cookie` headers, because the
 * caller — the server route — is responsible for relaying them to the browser.
 * Kept separate from `execute` so server-side render loaders can call it
 * in-process instead of making an HTTP round trip to their own server.
 */
export const forwardToWorker = async <TData>(
  request: GraphQLRequest,
  cookie: string | undefined,
): Promise<{ body: GraphQLResponse<TData>; setCookie: string[] }> => {
  const target = `${workerOrigin()}/graphql`
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(request),
  }
  /*
   * Called on the binding, never detached from it. `const call = binding.fetch`
   * loses the receiver, and the call then goes nowhere near the bound Worker —
   * which looks identical to the binding being absent.
   */
  const binding = apiBinding()
  const response = binding ? await binding.fetch(target, init) : await fetch(target, init)

  // `getSetCookie` preserves multiple headers; joining them would corrupt the
  // expiry attributes that sign-out relies on.
  const setCookie = response.headers.getSetCookie?.() ?? []
  return { body: (await response.json()) as GraphQLResponse<TData>, setCookie }
}
