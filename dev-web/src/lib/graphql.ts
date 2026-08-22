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
import {
  getRequestHeader,
  setResponseHeader,
} from '@tanstack/react-start/server'
import type { TypedDocumentString } from '#/graphql/generated/operations'
import { forwardToWorker, type GraphQLRequest } from './api'

/** Raised for transport and schema faults, never for expected business refusals. */
export class GraphQLRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphQLRequestError'
  }
}

const execute = createServerFn({ method: 'POST' })
  .validator((request: GraphQLRequest) => request)
  .handler(async ({ data }) => {
    const { body, setCookie } = await forwardToWorker<unknown>(
      data,
      getRequestHeader('cookie'),
    )

    // Sign-in, sign-out and session revocation all depend on this relay. Each
    // header is appended separately because clearing writes several at once.
    for (const cookie of setCookie) {
      setResponseHeader('set-cookie', cookie)
    }

    if (body.errors?.length) {
      // A GraphQL error here means a malformed document or an unexpected server
      // fault. Expected failures travel inside `data` as result envelopes.
      throw new GraphQLRequestError(
        body.errors.map((error) => error.message).join('; '),
      )
    }
    if (!body.data) throw new GraphQLRequestError('The API returned no data.')
    return body.data
  })

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
  (await execute({
    data: {
      query: document.toString(),
      variables: variables as Record<string, unknown> | undefined,
    },
  })) as TData
