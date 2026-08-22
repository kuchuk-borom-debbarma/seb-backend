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
  const response = await fetch(`${workerOrigin()}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(request),
  })

  // `getSetCookie` preserves multiple headers; joining them would corrupt the
  // expiry attributes that sign-out relies on.
  const setCookie = response.headers.getSetCookie?.() ?? []
  return { body: (await response.json()) as GraphQLResponse<TData>, setCookie }
}
