import {
  GraphQLError,
  type ASTVisitor,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type SelectionNode,
  type SelectionSetNode,
  type ValidationContext,
} from "graphql";

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
  const fields: FieldNode[] = [];
  for (const selection of selectionSet.selections) {
    if (selection.kind === "Field") {
      fields.push(selection);
      continue;
    }
    if (selection.kind === "InlineFragment") {
      fields.push(
        ...collectFields(selection.selectionSet, fragments, visitedFragments),
      );
      continue;
    }
    if (visitedFragments.has(selection.name.value)) continue;

    const fragment = fragments.get(selection.name.value);
    if (fragment) {
      visitedFragments.add(selection.name.value);
      fields.push(
        ...collectFields(fragment.selectionSet, fragments, visitedFragments),
      );
    }
  }
  return fields;
};

const fragmentMap = (document: DocumentNode) =>
  new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === "FragmentDefinition",
      )
      .map((fragment) => [fragment.name.value, fragment]),
  );

// GraphQL clients commonly add __typename automatically. Meta-fields describe
// the response shape and never invoke a business action, so they must not count
// toward the one-mutation limit.
const actionFields = (fields: FieldNode[]): FieldNode[] =>
  fields.filter((field) => field.name.value !== "__typename");

/*
 * How much work one document may ask for.
 *
 * `first` is already clamped to 100 on every connection, so no single list can
 * be asked for a million rows. What that does not stop is asking for a modest
 * list many times over in one document — aliases make a field repeatable:
 *
 *     query { admin { intake {
 *       a: workspace(applicationId: "…") { …ten collections… }
 *       b: workspace(applicationId: "…") { …ten collections… }
 *       …five hundred more…
 *     } } }
 *
 * Each `workspace` is a dozen database reads. Five hundred of them is one HTTP
 * request that costs thousands, from an account that is allowed to make it. A
 * per-field limit cannot see this; only the whole document can.
 *
 * The numbers come from measuring the real client rather than from taste. Its
 * largest operation, `IntakeWorkspace`, selects 114 fields at depth 7 — so 500
 * fields is four times the largest thing anyone legitimately sends, and depth
 * 12 is nearly twice the deepest. Both are generous enough that a screen can
 * grow without tripping them, and small enough that amplification is bounded.
 */
const MAX_FIELDS = 500;
const MAX_DEPTH = 12;

/**
 * Refuses a document that asks for too much at once.
 *
 * Counted at validation, before a single resolver runs — the cost has to be
 * refused before it is paid, not measured while it is being paid.
 *
 * Fragment spreads are expanded so the limit cannot be evaded by moving the
 * selections into a fragment, and each spread is counted at every place it is
 * used, because that is how many times the server will resolve it. Recursive
 * fragments are left to standard validation; this rule only guards its own
 * recursion.
 */
/** What a selection asks for: how many fields, and how deep it reaches. */
type Cost = { fields: number; depth: number };

type Fragments = Map<string, FragmentDefinitionNode>;

/** Folds one selection's cost into the running total for its selection set. */
const combineCost = (total: Cost, part: Cost): Cost => ({
  fields: total.fields + part.fields,
  depth: Math.max(total.depth, part.depth),
});

/**
 * What a whole selection set costs, with fragments expanded.
 *
 * `depth` is the level the set itself sits at; the returned depth is the
 * deepest level anything inside it reaches.
 */
const measureSelectionSet = (
  selectionSet: SelectionSetNode,
  depth: number,
  fragments: Fragments,
  seen: Set<string>,
): Cost =>
  selectionSet.selections.reduce<Cost>(
    (total, selection) =>
      combineCost(total, measureSelection(selection, depth, fragments, seen)),
    { fields: 0, depth },
  );

/** What one selection costs — a field, an inline fragment, or a named spread. */
const measureSelection = (
  selection: SelectionNode,
  depth: number,
  fragments: Fragments,
  seen: Set<string>,
): Cost => {
  if (selection.kind === "InlineFragment") {
    return measureSelectionSet(selection.selectionSet, depth, fragments, seen);
  }
  if (selection.kind === "FragmentSpread") {
    return measureSpread(selection, depth, fragments, seen);
  }
  // __typename describes the response shape rather than invoking anything, so
  // it costs the server nothing and must not count against the limit.
  if (selection.name.value === "__typename") return { fields: 0, depth };
  const inner = selection.selectionSet
    ? measureSelectionSet(selection.selectionSet, depth + 1, fragments, seen)
    : { fields: 0, depth: depth + 1 };
  return { fields: inner.fields + 1, depth: inner.depth };
};

/**
 * What a named fragment costs where it is spread.
 *
 * Counted at every place it is used, because that is how many times the server
 * will resolve it — deduplicating here would let a document hide its real cost
 * behind one fragment. `seen` guards only this rule's own recursion; a
 * recursive fragment is reported by standard validation.
 */
const measureSpread = (
  spread: FragmentSpreadNode,
  depth: number,
  fragments: Fragments,
  seen: Set<string>,
): Cost => {
  const name = spread.name.value;
  const fragment = seen.has(name) ? undefined : fragments.get(name);
  if (!fragment) return { fields: 0, depth };
  seen.add(name);
  const cost = measureSelectionSet(
    fragment.selectionSet,
    depth,
    fragments,
    seen,
  );
  seen.delete(name);
  return cost;
};

export const documentCostRule = (context: ValidationContext): ASTVisitor => {
  const fragments = fragmentMap(context.getDocument());

  return {
    OperationDefinition(operation) {
      const { fields, depth } = measureSelectionSet(
        operation.selectionSet,
        0,
        fragments,
        new Set(),
      );
      if (fields > MAX_FIELDS) {
        context.reportError(
          new GraphQLError(
            `This query asks for ${fields} fields; the limit is ${MAX_FIELDS}. Ask for less in one request.`,
            { nodes: operation },
          ),
        );
      }
      if (depth > MAX_DEPTH) {
        context.reportError(
          new GraphQLError(
            `This query nests ${depth} levels deep; the limit is ${MAX_DEPTH}.`,
            { nodes: operation },
          ),
        );
      }
    },
  };
};

/** Builds the shared one-action rule used by the auth and SEB namespaces. */
const singleMutationNamespaceRule = (
  context: ValidationContext,
  namespaceName: "auth" | "access" | "seb" | "admin",
  nestedNamespaces: boolean,
  message: string,
): ASTVisitor => ({
  Document: {
    leave(document: DocumentNode) {
      const fragments = fragmentMap(document);
      for (const definition of document.definitions) {
        if (
          definition.kind !== "OperationDefinition" ||
          definition.operation !== "mutation"
        ) {
          continue;
        }

        const namespaceFields = collectFields(
          definition.selectionSet,
          fragments,
          new Set(),
        ).filter((field) => field.name.value === namespaceName);
        const selectedFields = actionFields(
          namespaceFields.flatMap((field) =>
            field.selectionSet
              ? collectFields(field.selectionSet, fragments, new Set())
              : [],
          ),
        );
        const actionCount = nestedNamespaces
          ? selectedFields.reduce(
              (count, namespace) =>
                count +
                (namespace.selectionSet
                  ? actionFields(
                      collectFields(
                        namespace.selectionSet,
                        fragments,
                        new Set(),
                      ),
                    ).length
                  : 0),
              0,
            )
          : selectedFields.length;
        if (actionCount > 1) {
          context.reportError(
            new GraphQLError(message, {
              nodes: namespaceFields,
            }),
          );
        }
      }
    },
  },
});

/** Enforces one side-effecting operation below each `mutation.auth` document. */
export const singleAuthMutationRule = (
  context: ValidationContext,
): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    "auth",
    false,
    "Only one field may be selected beneath mutation.auth.",
  );

/**
 * Enforces one side-effecting operation below each `mutation.access` document.
 * Role changes are audited individually, so two in one request would produce a
 * partial side effect before any error could be raised.
 */
export const singleAccessMutationRule = (
  context: ValidationContext,
): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    "access",
    false,
    "Only one field may be selected beneath mutation.access.",
  );

/**
 * Allows one side-effecting field across `mutation.seb.enterprise` and
 * `mutation.seb.application`. Namespace fields themselves are harmless; the
 * action immediately below either namespace is what must be singular.
 */
export const singleSebMutationRule = (context: ValidationContext): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    "seb",
    true,
    "Only one action may be selected beneath mutation.seb.",
  );

/** Allows exactly one action across the four administrative subdomains. */
export const singleAdminMutationRule = (
  context: ValidationContext,
): ASTVisitor =>
  singleMutationNamespaceRule(
    context,
    "admin",
    true,
    "Only one action may be selected beneath mutation.admin.",
  );
