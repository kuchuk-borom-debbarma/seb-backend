import { GraphQLScalarType, Kind } from 'graphql'
import { createSchema, createYoga } from 'graphql-yoga'
import type { AppBindings } from '../bindings'
import authMutationTypeDefs from './mutations/auth/auth.graphql'
import authQueryTypeDefs from './queries/auth/auth.graphql'
import { authResolvers } from './resolvers/auth/auth'
import baseTypeDefs from './schema.graphql'
import type { GraphQLContext } from './types'
import { singleAuthMutationRule } from './validation'

export type { AppBindings } from '../bindings'

// GraphQL serializes service-layer Date objects as ISO-8601 strings. Parsing is
// implemented as well so the scalar remains correct if it is used by inputs later.
const dateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value) {
    const date = value instanceof Date ? value : new Date(value as string | number)
    if (Number.isNaN(date.getTime())) throw new TypeError('DateTime cannot represent an invalid date.')
    return date.toISOString()
  },
  parseValue(value) {
    if (typeof value !== 'string') throw new TypeError('DateTime input must be an ISO string.')
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) throw new TypeError('DateTime cannot represent an invalid date.')
    return date
  },
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) throw new TypeError('DateTime input must be an ISO string.')
    const date = new Date(node.value)
    if (Number.isNaN(date.getTime())) throw new TypeError('DateTime cannot represent an invalid date.')
    return date
  },
})

// SDL is split by domain while schema assembly stays in one discoverable place.
const schema = createSchema<GraphQLContext>({
  typeDefs: [baseTypeDefs, authQueryTypeDefs, authMutationTypeDefs],
  resolvers: [
    {
      DateTime: dateTimeScalar,
      Query: {
        health: () => ({
          name: 'seb-backend',
          status: 'ok',
          bindings: ['DB', 'STORAGE', 'QUEUE'],
        }),
      },
    },
    authResolvers,
  ],
})

// CORS is disabled in Yoga because Hono owns origin validation and cookie headers.
const graphqlServer = createYoga<GraphQLContext>({
  schema,
  graphqlEndpoint: '/graphql',
  cors: false,
  plugins: [
    {
      // Rejecting multi-action auth mutations during validation guarantees that
      // no resolver has performed a partial side effect before the error is raised.
      onValidate({
        addValidationRule,
      }: {
        addValidationRule: (rule: typeof singleAuthMutationRule) => void
      }) {
        addValidationRule(singleAuthMutationRule)
      },
    },
  ],
})

/** Keeps Yoga's context type private while exposing the one operation used by Hono. */
export const handleGraphQLRequest = async (
  request: Request,
  context: {
    env: AppBindings
    db: import('../db').Database
    requestHeaders: Headers
    requestUrl: string
    responseHeaders: Headers
  },
): Promise<Response> => graphqlServer.handleRequest(request as never, context)
