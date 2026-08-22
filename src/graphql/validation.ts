import {
  GraphQLError,
  type ASTVisitor,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql'

/**
 * Expands fields through inline and named fragments. GraphQL fragments may be
 * recursive in an invalid document, so `visitedFragments` also prevents this
 * custom rule from recursing forever before standard validation reports it.
 */
const collectFields = (
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  visitedFragments: Set<string>,
): FieldNode[] => {
  // Inline fragments and named fragments still represent sibling operations,
  // so expand them while guarding against recursive fragment definitions.
  const fields: FieldNode[] = []
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      fields.push(selection)
      continue
    }
    if (selection.kind === 'InlineFragment') {
      fields.push(...collectFields(selection.selectionSet, fragments, visitedFragments))
      continue
    }
    if (visitedFragments.has(selection.name.value)) continue

    const fragment = fragments.get(selection.name.value)
    if (fragment) {
      visitedFragments.add(selection.name.value)
      fields.push(...collectFields(fragment.selectionSet, fragments, visitedFragments))
    }
  }
  return fields
}

const fragmentMap = (document: DocumentNode) => new Map(
  document.definitions
    .filter((definition): definition is FragmentDefinitionNode =>
      definition.kind === 'FragmentDefinition',
    )
    .map((fragment) => [fragment.name.value, fragment]),
)

// GraphQL clients commonly add __typename automatically. Meta-fields describe
// the response shape and never invoke a business action, so they must not count
// toward the one-mutation limit.
const actionFields = (fields: FieldNode[]): FieldNode[] =>
  fields.filter((field) => field.name.value !== '__typename')

/** Builds the shared one-action rule used by the auth and SEB namespaces. */
const singleMutationNamespaceRule = (
  context: ValidationContext,
  namespaceName: 'auth' | 'seb' | 'admin',
  nestedNamespaces: boolean,
  message: string,
): ASTVisitor => ({
  Document: {
    leave(document: DocumentNode) {
      const fragments = fragmentMap(document)
      for (const definition of document.definitions) {
        if (definition.kind !== 'OperationDefinition' || definition.operation !== 'mutation') {
          continue
        }

        const namespaceFields = collectFields(
          definition.selectionSet,
          fragments,
          new Set(),
        ).filter(
          (field) => field.name.value === namespaceName,
        )
        const selectedFields = actionFields(namespaceFields.flatMap((field) =>
          field.selectionSet
            ? collectFields(field.selectionSet, fragments, new Set())
            : [],
        ))
        const actionCount = nestedNamespaces
          ? selectedFields.reduce(
              (count, namespace) => count + (
                namespace.selectionSet
                  ? actionFields(
                      collectFields(namespace.selectionSet, fragments, new Set()),
                    ).length
                  : 0
              ),
              0,
            )
          : selectedFields.length
        if (actionCount > 1) {
          context.reportError(
            new GraphQLError(message, {
              nodes: namespaceFields,
            }),
          )
        }
      }
    },
  },
})

/** Enforces one side-effecting operation below each `mutation.auth` document. */
export const singleAuthMutationRule = (context: ValidationContext): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    'auth',
    false,
    'Only one field may be selected beneath mutation.auth.',
  )

/**
 * Allows one side-effecting field across `mutation.seb.enterprise` and
 * `mutation.seb.application`. Namespace fields themselves are harmless; the
 * action immediately below either namespace is what must be singular.
 */
export const singleSebMutationRule = (context: ValidationContext): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    'seb',
    true,
    'Only one action may be selected beneath mutation.seb.',
  )

/** Allows exactly one action across the four administrative subdomains. */
export const singleAdminMutationRule = (context: ValidationContext): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    'admin',
    true,
    'Only one action may be selected beneath mutation.admin.',
  )
