import { GraphQLScalarType, Kind, type ValueNode } from 'graphql'
import { createSchema, createYoga } from 'graphql-yoga'
import type { AppBindings } from '../bindings'
import accessMutationTypeDefs from './mutations/access/access.graphql'
import authMutationTypeDefs from './mutations/auth/auth.graphql'
import adminMutationTypeDefs from './mutations/admin/admin.graphql'
import accessQueryTypeDefs from './queries/access/access.graphql'
import authQueryTypeDefs from './queries/auth/auth.graphql'
import adminQueryTypeDefs from './queries/admin/admin.graphql'
import auditQueryTypeDefs from './queries/audit/audit.graphql'
import sebMutationTypeDefs from './mutations/seb/seb.graphql'
import sebQueryTypeDefs from './queries/seb/seb.graphql'
import publicQueryTypeDefs from './queries/public/public.graphql'
import { accessResolvers } from './resolvers/access/access'
import { authResolvers } from './resolvers/auth/auth'
import { adminResolvers } from './resolvers/admin/admin'
import { publicResolvers } from './resolvers/public/public'
import { auditResolvers } from './resolvers/audit/audit'
import { sebResolvers } from './resolvers/seb/seb'
import { rateLimitPlugin } from './rate-limit'
import baseTypeDefs from './schema.graphql'
import type { GraphQLContext } from './types'
import {
  documentCostRule,
  singleAccessMutationRule,
  singleAdminMutationRule,
  singleAuthMutationRule,
  singleSebMutationRule,
} from './validation'
import { parseDateOnly } from '../services/application/validation'

export type { GraphQLContext } from './types'

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

/*
 * The answer map, as one bounded JSON value.
 *
 * **An unbounded JSON scalar is a hole in two limits at once.** The 64 KB body
 * cap and `documentCostRule`'s 500-field ceiling both count *structure* — they
 * cannot see one enormous value, so a single `answers` argument would walk past
 * both. Everything the document rule enforces for fields is therefore enforced
 * here for the value: size, depth, key count, key shape and leaf length.
 *
 * The engine checks the byte budget again, against the answers it has coerced.
 * That is not redundant: this is a *transport* bound applied before anything is
 * parsed, and the engine's is a *storage* bound applied to what will be written.
 * A value can pass one and fail the other.
 *
 * Depth is two, and that is the grammar rather than a tuning knob: an answer is
 * a leaf, or a repeat group's list of entries whose members are leaves. The
 * schema refuses a nested group, so a third level cannot be a real answer.
 */
const JSON_MAX_BYTES = 64 * 1024
const JSON_MAX_KEYS = 500
const JSON_MAX_ENTRIES = 100
const JSON_MAX_LEAF_LENGTH = 8_192
const JSON_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u

const refuse = (message: string): never => {
  throw new TypeError(`JSON ${message}`)
}

/**
 * One answer, or one member of one.
 *
 * `insideList` is what closes the grammar. An answer is a scalar or a list of
 * scalars — a multiple choice — and nothing deeper: a list inside a list is not
 * something any field type can hold. It used to recurse without a bound, and
 * the header's claim that "depth is two, and that is the grammar" was a
 * description rather than a rule.
 *
 * **No test proves this, and that is stated rather than papered over.** A
 * nested list is the wrong type for every field the engine knows, so the engine
 * refuses one anyway; and at a depth where the recursion would actually matter,
 * `JSON.parse` gives out on the request body long before a scalar is reached.
 * So the bound has no reachable consequence today. It is here because the
 * grammar is written down two files away and a walk over untrusted input should
 * not be the thing relied upon to stay shallow.
 */
const checkLeaf = (value: unknown, insideList = false): unknown => {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    // JSON encodes both as `null`, so an engine that accepted them could not
    // tell either from a deliberate "no answer".
    if (!Number.isFinite(value)) refuse('numbers must be finite.')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > JSON_MAX_LEAF_LENGTH) {
      refuse(`values must be at most ${JSON_MAX_LEAF_LENGTH} characters.`)
    }
    return value
  }
  if (Array.isArray(value)) {
    if (insideList) refuse('a list of values may not hold another list.')
    if (value.length > JSON_MAX_ENTRIES) {
      refuse(`lists must hold at most ${JSON_MAX_ENTRIES} values.`)
    }
    return value.map((each) => checkLeaf(each, true))
  }
  return refuse('values must be a string, number, boolean, null or a list of them.')
}

const checkAnswerMap = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse('must be an object of answers keyed by field.')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length > JSON_MAX_KEYS) refuse(`must hold at most ${JSON_MAX_KEYS} keys.`)
  const checked: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    // Refused rather than skipped: `__proto__` reaching a plain object literal
    // downstream is the one key whose presence changes what an object *is*.
    if (!JSON_KEY_PATTERN.test(key)) refuse(`key ${JSON.stringify(key)} is not a field key.`)
    const entry = object[key]
    if (Array.isArray(entry) && entry.some((item) => item !== null && typeof item === 'object')) {
      if (entry.length > JSON_MAX_ENTRIES) {
        refuse(`group must hold at most ${JSON_MAX_ENTRIES} entries.`)
      }
      checked[key] = entry.map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          refuse('group entries must be objects.')
        }
        const member = item as Record<string, unknown>
        const inner: Record<string, unknown> = Object.create(null)
        for (const memberKey of Object.keys(member)) {
          if (!JSON_KEY_PATTERN.test(memberKey)) {
            refuse(`key ${JSON.stringify(memberKey)} is not a field key.`)
          }
          inner[memberKey] = checkLeaf(member[memberKey])
        }
        return inner
      })
      continue
    }
    checked[key] = checkLeaf(entry)
  }
  return checked
}

const parseAnswers = (value: unknown): Record<string, unknown> => {
  /*
   * Shape first, then size — and that order is the fix, not a preference.
   *
   * This measured first, with a comment claiming a hostile payload was "refused
   * on its size rather than on the work of inspecting it". It bought nothing:
   * `JSON.parse` has already built the whole structure by the time a scalar's
   * `parseValue` runs, so the walk the ordering was avoiding has happened. What
   * it did do was run `JSON.stringify` — which recurses — over a structure of
   * unbounded depth, so a 60 KB payload nested thirty thousand deep overflowed
   * the stack on the very line meant to prevent that.
   *
   * `checkAnswerMap` bounds keys, entries, leaf length and now depth as it
   * walks, so by the time this measures, the value is one the grammar allows
   * and stringifying it is bounded work.
   */
  const checked = checkAnswerMap(value)
  if (new TextEncoder().encode(JSON.stringify(checked)).byteLength > JSON_MAX_BYTES) {
    refuse(`must be at most ${JSON_MAX_BYTES} bytes.`)
  }
  return checked
}

const jsonScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (value) => value,
  parseValue: parseAnswers,
  parseLiteral(node, variables) {
    return parseAnswers(parseLiteralValue(node, variables))
  },
})

/** A literal in the document rather than a variable, turned back into a value. */
const parseLiteralValue = (
  node: ValueNode,
  variables: Record<string, unknown> | null | undefined,
): unknown => {
  switch (node.kind) {
    case Kind.NULL: return null
    case Kind.BOOLEAN: return node.value
    case Kind.INT: return Number.parseInt(node.value, 10)
    case Kind.FLOAT: return Number.parseFloat(node.value)
    case Kind.STRING:
    case Kind.ENUM: return node.value
    case Kind.LIST: return node.values.map((item) => parseLiteralValue(item, variables))
    case Kind.OBJECT: {
      const object: Record<string, unknown> = Object.create(null)
      for (const field of node.fields) {
        object[field.name.value] = parseLiteralValue(field.value, variables)
      }
      return object
    }
    case Kind.VARIABLE: return variables?.[node.name.value]
    default: return refuse('value is not supported.')
  }
}

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
    auditQueryTypeDefs,
    sebQueryTypeDefs,
    sebMutationTypeDefs,
    publicQueryTypeDefs,
  ],
  resolvers: [
    {
      DateTime: dateTimeScalar,
      Date: dateScalar,
      Money: moneyScalar,
      JSON: jsonScalar,
      /*
       * `validation` is `rules` on the resolved object.
       *
       * The engine calls it `rules` because that is what a template declares;
       * the schema calls it `validation` because that is what it means to a
       * client. Nothing bridged the two, and the default resolver looked for a
       * `validation` property that does not exist — so **every field of every
       * form threw**, on the one query the applicant's form is rendered from.
       * Both namespaces return this type, which is why it is declared here
       * beside the scalars rather than in either one.
       *
       * Found only when the admin surface started returning a `FormTemplate`
       * too: the tests until then had asked for a field's key and its label,
       * which the default resolver handles.
       */
      FormField: {
        validation: (parent: { rules: unknown }) => parent.rules,
      },
      Query: {
        health: () => ({
          name: 'seb-backend',
          status: 'ok',
          // `DB` went with D1. `HYPERDRIVE` is what the database is reached
          // through now, and a health check naming a binding that does not
          // exist is worse than one naming none.
          bindings: ['HYPERDRIVE', 'STORAGE', 'QUEUE'],
        }),
      },
    },
    authResolvers,
    accessResolvers,
    auditResolvers,
    adminResolvers,
    sebResolvers,
    publicResolvers,
  ],
})

// CORS is disabled in Yoga because Hono owns origin validation and cookie headers.
const graphqlServer = createYoga<GraphQLContext>({
  schema,
  graphqlEndpoint: '/graphql',
  cors: false,
  plugins: [
    /*
     * Before the per-operation rule, because a document that asks for too much
     * is refused by validation without ever reaching execution — and the
     * limiter should not spend an allowance on a request that was never going
     * to run.
     */
    rateLimitPlugin(),
    {
      // Rejecting multi-action auth mutations during validation guarantees that
      // no resolver has performed a partial side effect before the error is raised.
      onValidate({
        addValidationRule,
      }: {
        addValidationRule: (rule: typeof singleAuthMutationRule) => void
      }) {
        // Cost first: a document that asks for too much is refused before any
        // other rule spends time walking it.
        addValidationRule(documentCostRule)
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
  context: GraphQLContext,
): Promise<Response> => graphqlServer.handleRequest(request as never, context)
