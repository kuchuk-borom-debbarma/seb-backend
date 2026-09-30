/**
 * The one function every screen uses to reach the API.
 *
 * It is a TanStack Start server function, which means the same call works from
 * a route loader during server rendering and from a component in the browser.
 * Either way the operation executes on our server, where the incoming
 * `seb_session` cookie is read and forwarded to the Worker, and any
 * `Set-Cookie` the Worker returns is relayed back. The browser never talks to
 * the Worker directly, so there is no preflight and no CORS configuration to
 * keep in step.
 *
 * Performance note: when a loader calls this during server rendering, Start
 * invokes it in-process. The forwarding hop costs one local fetch to the
 * Worker, not a round trip through our own HTTP server.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server'
import type { TypedDocumentString } from '#/graphql/generated/operations'
import { forwardToWorker, type GraphQLRequest, type GraphQLResponse } from './api'

/** Raised for transport and schema faults, never for expected business refusals. */
export class GraphQLRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphQLRequestError'
  }
}

/** Sign-in, sign-out and session revocation all depend on this relay. */
const relayCookies = (setCookie: readonly string[]) => {
  // Each header is appended separately because clearing writes several at once.
  for (const cookie of setCookie) setResponseHeader('set-cookie', cookie)
}

/**
 * An operation's data, or why there is none. A GraphQL error here means a
 * malformed document or an unexpected server fault; expected failures travel
 * inside `data` as result envelopes.
 */
/** What a response's `data` is: parsed JSON, which is what makes it serializable. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

const outcomeOf = (body: GraphQLResponse<Json>): { data: Json } | { error: string } => {
  if (body.errors?.length) return { error: body.errors.map((error) => error.message).join('; ') }
  if (!body.data) return { error: 'The API returned no data.' }
  return { data: body.data }
}

const execute = createServerFn({ method: 'POST' })
  .validator((request: GraphQLRequest) => request)
  .handler(async ({ data }) => {
    const { body, setCookie } = await forwardToWorker<GraphQLResponse<Json>>(
      data,
      getRequestHeader('cookie'),
    )
    relayCookies(setCookie)
    const outcome = outcomeOf(body)
    if ('error' in outcome) throw new GraphQLRequestError(outcome.error)
    return outcome.data
  })

/** Several queries as one request to the Worker, answered in order. */
const executeBatch = createServerFn({ method: 'POST' })
  .validator((requests: GraphQLRequest[]) => requests)
  .handler(async ({ data }) => {
    const { body, setCookie } = await forwardToWorker<GraphQLResponse<Json>[]>(
      data,
      getRequestHeader('cookie'),
    )
    relayCookies(setCookie)
    return body.map(outcomeOf)
  })

/*
 * ─── Coalescing ──────────────────────────────────────────────────────────────
 *
 * The queries a screen issues together — a route loader's, the components
 * that mount with it — leave as one request, which the Worker answers over
 * one connection, reading the session and any shared data once
 * (docs/rules/frontend.md). Collected until the current task ends, so the
 * callers need not know about each other: each still asks for exactly what it
 * renders, through its own document and cache key.
 *
 * Only in the browser. On the server this module serves every visitor at once,
 * and a queue there could put two people's queries into one request under one
 * of their cookies. Only queries: a mutation is sent alone, because the Worker
 * allows one per request and its effects must not wait on a read.
 */
const MAX_BATCH = 10 // the Worker's limit (src/graphql/index.ts)

type Pending = {
  request: GraphQLRequest
  resolve: (data: unknown) => void
  reject: (error: unknown) => void
}

let queued: Pending[] = []

const flush = async () => {
  const batch = queued
  queued = []
  for (let start = 0; start < batch.length; start += MAX_BATCH) {
    const chunk = batch.slice(start, start + MAX_BATCH)
    if (chunk.length === 1) {
      const [only] = chunk
      execute({ data: only!.request }).then(only!.resolve, only!.reject)
      continue
    }
    executeBatch({ data: chunk.map((each) => each.request) }).then(
      (outcomes) => chunk.forEach((each, index) => {
        const outcome = outcomes[index]
        if (outcome && 'data' in outcome) each.resolve(outcome.data)
        else each.reject(new GraphQLRequestError(outcome?.error ?? 'The API returned no data.'))
      }),
      (error) => chunk.forEach((each) => each.reject(error)),
    )
  }
}

const isMutation = (query: string) => /^\s*mutation\b/m.test(query)

const send = (request: GraphQLRequest): Promise<unknown> => {
  if (typeof window === 'undefined' || isMutation(request.query)) return execute({ data: request })
  return new Promise((resolve, reject) => {
    queued.push({ request, resolve, reject })
    if (queued.length === 1) setTimeout(flush, 0)
  })
}

/**
 * Runs one generated operation and returns its `data`.
 *
 * Both the result and the variables are inferred from the document, so asking
 * for a field the Worker does not expose, or omitting a required variable,
 * fails `npm run typecheck` rather than at runtime.
 */
export const gql = async <TData, TVariables>(
  document: TypedDocumentString<TData, TVariables>,
  ...[variables]: TVariables extends Record<string, never>
    ? [variables?: undefined]
    : [variables: TVariables]
): Promise<TData> =>
  (await send({
    query: document.toString(),
    variables: variables as Record<string, unknown> | undefined,
  })) as TData
