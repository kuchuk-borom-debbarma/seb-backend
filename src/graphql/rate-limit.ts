/**
 * Applying the rate-limit policy to one GraphQL operation.
 *
 * This is the GraphQL half of the seam: it knows about documents, aliases and
 * envelopes, and the service in `services/rate-limit` knows about none of them.
 * Everything it decides comes from the policy table there — adding a limit is a
 * row in that file, never a line here.
 *
 * ## Why an operation limit cannot live in the HTTP layer
 *
 * `/graphql` is a single POST. Hono sees one request and cannot tell
 * `auth.signIn` from `admin.intake.queue`, so an HTTP-layer limit can only ever
 * be "so many requests a minute". That coarse budget exists too, in
 * `src/index.ts`; this is what makes "five sign-in attempts" possible.
 *
 * ## Why every attempt spends, and not only the failures
 *
 * Counting only failed sign-ins would be kinder, and it cannot be done with a
 * limiter that has no way to look without spending: an allowance spent *after* a
 * failure is never consulted *before* the next attempt, so it fills up and
 * refuses nothing. That was built and the test caught it. Every attempt spends,
 * and the limits accommodate a person signing in from several devices.
 *
 * ## Why a refusal is an envelope and not an error
 *
 * Every expected failure in this API travels inside `data` as a result
 * envelope; `errors` means the request was malformed or the server broke, and
 * the client raises on it (`dev-web/src/lib/graphql.ts`). Being rate limited is
 * an expected failure, so it arrives as `success: false` with a message the
 * existing client already renders. Delivering it as a GraphQL error would have
 * meant a generic thrown error in place of the written one.
 */
import {
  Kind,
  valueFromASTUntyped,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql'
import {
  bucketsFor,
  enforce,
  operationSubject,
  rateLimiter,
  RATE_LIMITED_MESSAGE,
} from '../services/rate-limit'
import type { GraphQLContext } from './types'

/** A field the policy names, and where it sits in the response. */
type LimitedField = {
  /** Dotted field names, which is how the policy identifies an operation. */
  readonly operation: string
  /** Dotted response keys, which is where the envelope has to be built. */
  readonly responsePath: readonly string[]
  readonly node: FieldNode
}

/** The operation this document runs, honouring an explicit name. */
const mutationOperation = (
  document: DocumentNode,
  operationName: string | null | undefined,
): OperationDefinitionNode | null => {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation === 'mutation',
  )
  if (operations.length === 0) return null
  // Unnamed, or the only one: validation has already refused a document that
  // names an operation it does not contain, so the first is the one that runs.
  if (!operationName) return operations[0]!
  return operations.find((entry) => entry.name?.value === operationName) ?? null
}

/**
 * The fields in a selection set, with fragments expanded.
 *
 * **A fragment is not a hiding place.** Skipping over spreads would let
 * `mutation { auth { ...F } }` carry a limited operation past every limit,
 * which is a bypass rather than an omission — the same reason the validation
 * rules expand them before counting fields.
 *
 * Needs no guard against a fragment that spreads itself, and no check that a
 * spread names a fragment that exists. **This runs at execution, which only
 * ever sees a validated document** — a cycle and an unknown fragment are both
 * refused before it, so a guard here would be a branch nothing could take.
 */
const fieldsIn = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): FieldNode[] => {
  const fields: FieldNode[] = []
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      fields.push(selection)
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      fields.push(...fieldsIn(selection.selectionSet, fragments))
    } else {
      fields.push(...fieldsIn(fragments.get(selection.name.value)!.selectionSet, fragments))
    }
  }
  return fields
}

/**
 * Finds every field the policy names, walking down through the namespaces.
 *
 * Matching is on the field's **name** and the envelope is built at its
 * **response key**, which differ whenever a caller uses an alias. Matching on
 * the alias would let `mutation { a: auth { b: signIn(…) } }` slip past every
 * limit; building at the name would return an envelope the caller cannot find.
 *
 * **All of them, not the first.** The single-mutation validation rules police
 * one namespace each, so a document may select several roots — and stopping at
 * the first match let a caller put an operation whose allowance does not apply
 * to them in front of the one they wanted unlimited. An upload authorization is
 * counted by session, which resolves to nothing for somebody not signed in and
 * is skipped, and sign-in was then never counted at all.
 */
const limitedFields = (
  document: DocumentNode,
  operationName: string | null | undefined,
): LimitedField[] => {
  const operation = mutationOperation(document, operationName)
  if (!operation) return []

  const fragments = new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((definition) => [definition.name.value, definition]),
  )

  const found: LimitedField[] = []
  const walk = (
    node: FieldNode,
    names: readonly string[],
    keys: readonly string[],
  ): void => {
    const operationPath = [...names, node.name.value]
    const responsePath = [...keys, node.alias?.value ?? node.name.value]
    if (bucketsFor(operationPath.join('.')).length > 0) {
      found.push({ operation: operationPath.join('.'), responsePath, node })
      return
    }
    if (!node.selectionSet) return
    for (const child of fieldsIn(node.selectionSet, fragments)) {
      walk(child, operationPath, responsePath)
    }
  }

  for (const field of fieldsIn(operation.selectionSet, fragments)) walk(field, [], [])
  return found
}

/**
 * What the caller actually sent for this field's arguments.
 *
 * Resolved from the document with the request's variables, so an address
 * written inline — `signIn(input: { email: "…" })` — is read exactly as one
 * passed in a variable. Reading only the variables would leave an inlined
 * literal unkeyed, which is a bypass rather than an omission.
 *
 * Every operation the policy names takes an input, and validation has already
 * refused a document that omitted a required one — so `arguments` is present.
 * Were that ever to stop being true, this throws inside the guard below and the
 * operation is refused, which is the safe direction to fail.
 */
const argumentValues = (
  node: FieldNode,
  variables: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {}
  for (const argument of node.arguments!) {
    values[argument.name.value] = valueFromASTUntyped(argument.value, variables ?? {})
  }
  return values
}

/** The refusal, shaped so it lands where the caller is looking for it. */
const refusalAt = (responsePath: readonly string[]): { data: unknown } => {
  let value: unknown = { success: false, message: RATE_LIMITED_MESSAGE, response: null }
  for (const key of [...responsePath].reverse()) value = { [key]: value }
  return { data: value }
}

/**
 * The plugin, in the shape Yoga's `plugins` array takes.
 *
 * Typed structurally rather than as envelop's `Plugin`, so this file does not
 * depend on the generic parameters of a version of that package.
 */
export const rateLimitPlugin = () => ({
  onExecute({
    args,
    setResultAndStopExecution,
  }: {
    args: {
      document: DocumentNode
      operationName?: string | null
      variableValues?: Readonly<Record<string, unknown>> | null
      contextValue: GraphQLContext
    }
    setResultAndStopExecution: (result: unknown) => void
  }) {
    const fields = limitedFields(args.document, args.operationName)
    if (fields.length === 0) return undefined

    const context = args.contextValue

    return (async () => {
      /*
       * Every limited field is enforced, and the first one refused decides the
       * response. Enforcing only one of several would leave the others
       * uncounted, which is how a document naming two namespaces slipped a
       * sign-in past its allowance.
       *
       * Everything that could fail is inside the guard, not only the counting:
       * reading the arguments, building the limiter and spending the allowance.
       * Anything that cannot answer refuses, because protection is never
       * silently absent — and the message is the same either way, so a caller
       * cannot tell a spent allowance from a broken limiter.
       */
      let refused: LimitedField | null = null
      for (const field of fields) {
        let allowed: boolean
        try {
          /*
           * Built inside the guard along with everything else that can fail.
           * It is an object literal over module-level state, so building it
           * per field costs nothing and keeps a refusal to build it — which is
           * what a production Worker with counting switched off does — on the
           * same path as every other failure.
           */
          allowed = (await enforce(rateLimiter(context.env), {
            operation: field.operation,
            headers: context.requestHeaders,
            /*
             * Keys the session digest. Empty is not a fallback that weakens
             * anything: with no secret there is no digest, so the session
             * dimension simply does not apply — and a Worker without one
             * cannot serve a session at all.
             */
            secret: context.env.AUTH_SECRET ?? '',
            subject: operationSubject(argumentValues(field.node, args.variableValues)),
          })).allowed
        } catch {
          allowed = false
        }
        /*
         * The first refusal is reported, and the rest are still spent: a caller
         * refused by one has made the attempt the others are counting, and
         * stopping early would let a wide allowance be exhausted for free.
         */
        if (!allowed && !refused) refused = field
      }
      if (refused) setResultAndStopExecution(refusalAt(refused.responsePath))
      return undefined
    })()
  },
})
