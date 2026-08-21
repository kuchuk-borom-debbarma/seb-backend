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

/** Enforces one side-effecting operation below each `mutation.auth` document. */
export const singleAuthMutationRule = (context: ValidationContext): ASTVisitor => ({
  Document: {
    leave(document: DocumentNode) {
      const fragments = new Map(
        document.definitions
          .filter((definition): definition is FragmentDefinitionNode =>
            definition.kind === 'FragmentDefinition',
          )
          .map((fragment) => [fragment.name.value, fragment]),
      )

      for (const definition of document.definitions) {
        if (definition.kind !== 'OperationDefinition' || definition.operation !== 'mutation') {
          continue
        }

        let authActionCount = 0
        const authFields = collectFields(definition.selectionSet, fragments, new Set()).filter(
          (field) => field.name.value === 'auth',
        )
        for (const authField of authFields) {
          if (authField.selectionSet) {
            authActionCount += collectFields(authField.selectionSet, fragments, new Set()).length
          }
        }

        if (authActionCount > 1) {
          // Reporting during validation guarantees no resolver has run yet.
          context.reportError(
            new GraphQLError('Only one field may be selected beneath mutation.auth.', {
              nodes: authFields,
            }),
          )
        }
      }
    },
  },
})
