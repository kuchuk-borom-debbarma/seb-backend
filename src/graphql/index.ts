import { GraphQLScalarType, Kind } from 'graphql'
import { createSchema, createYoga } from 'graphql-yoga'
import type { AppBindings } from '../bindings'
import accessMutationTypeDefs from './mutations/access/access.graphql'
import authMutationTypeDefs from './mutations/auth/auth.graphql'
import adminMutationTypeDefs from './mutations/admin/admin.graphql'
import accessQueryTypeDefs from './queries/access/access.graphql'
import authQueryTypeDefs from './queries/auth/auth.graphql'
import adminQueryTypeDefs from './queries/admin/admin.graphql'
import sebMutationTypeDefs from './mutations/seb/seb.graphql'
import sebQueryTypeDefs from './queries/seb/seb.graphql'
import { accessResolvers } from './resolvers/access/access'
import { authResolvers } from './resolvers/auth/auth'
import { adminResolvers } from './resolvers/admin/admin'
import { sebResolvers } from './resolvers/seb/seb'
import baseTypeDefs from './schema.graphql'
import type { GraphQLContext } from './types'
import {
  singleAccessMutationRule,
  singleAdminMutationRule,
  singleAuthMutationRule,
  singleSebMutationRule,
} from './validation'
import { parseDateOnly } from '../services/application/validation'

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

const dateScalar = new GraphQLScalarType({
  name: 'Date',
  serialize(value) {
    if (typeof value !== 'string' || !parseDateOnly(value)) {
      throw new TypeError('Date must be a real date in YYYY-MM-DD format.')
    }
    return value
  },
  parseValue(value) {
    if (typeof value !== 'string' || !parseDateOnly(value)) {
      throw new TypeError('Date must be a real date in YYYY-MM-DD format.')
    }
    return value
  },
  parseLiteral(node) {
    if (node.kind !== Kind.STRING || !parseDateOnly(node.value)) {
      throw new TypeError('Date must be a real date in YYYY-MM-DD format.')
    }
    return node.value
  },
})

const parseMoney = (value: unknown): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('Money must be a non-negative safe integer number of paise.')
  }
  return parsed
}

const moneyScalar = new GraphQLScalarType({
  name: 'Money',
  serialize(value) {
    return String(parseMoney(value))
  },
  parseValue: parseMoney,
  parseLiteral(node) {
    if (node.kind !== Kind.INT && node.kind !== Kind.STRING) {
      throw new TypeError('Money must be an integer number of paise.')
    }
    return parseMoney(node.value)
  },
})

// SDL is split by domain while schema assembly stays in one discoverable place.
const schema = createSchema<GraphQLContext>({
  typeDefs: [
    baseTypeDefs,
    authQueryTypeDefs,
    authMutationTypeDefs,
    accessQueryTypeDefs,
    accessMutationTypeDefs,
    adminQueryTypeDefs,
    adminMutationTypeDefs,
    sebQueryTypeDefs,
    sebMutationTypeDefs,
  ],
  resolvers: [
    {
      DateTime: dateTimeScalar,
      Date: dateScalar,
      Money: moneyScalar,
      Query: {
        health: () => ({
          name: 'seb-backend',
          status: 'ok',
          bindings: ['DB', 'STORAGE', 'QUEUE'],
        }),
      },
    },
    authResolvers,
    accessResolvers,
    adminResolvers,
    sebResolvers,
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
        addValidationRule(singleAccessMutationRule)
        addValidationRule(singleSebMutationRule)
        addValidationRule(singleAdminMutationRule)
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
