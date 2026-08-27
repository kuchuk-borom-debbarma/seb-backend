/**
 * Which questions are asked, and which of those must be answered.
 *
 * Four rules decide it, and each is stated because an unstated one is what two
 * implementations guess differently — the server's and the client's.
 *
 * 1. **Conditions sharing a group must all hold; separate groups are
 *    alternatives.** Ands within a group, ors between them. No third
 *    combinator, and no nesting: a rule language grows until nobody can predict
 *    what a form will do, and a question whose relevance genuinely needs more
 *    than this is two questions.
 *
 * 2. **A field controlled by a hidden field is itself hidden.** Visibility is
 *    settled in one pass down the template's topological order, so a chain
 *    resolves in a single walk rather than converging by repetition.
 *
 * 3. **A hidden field's answer reads as unanswered.** Anything else makes the
 *    prune and the evaluator disagree: the prune clears the value, so a second
 *    evaluation over the pruned answers would see a different world from the
 *    first, and the fixed point would oscillate.
 *
 * 4. **A hidden field is never required, whatever its flags say.** Without this
 *    precedence a template can deadlock a form — a question that must be
 *    answered and cannot be shown blocks submission with an issue pointing at a
 *    control that is not on the screen.
 */
import type {
  AnswerEntry,
  AnswerMap,
  AnswerValue,
  FieldCondition,
  FormField,
  ResolvedFormTemplate,
} from './types'

/** Whether an answer counts as given. Empty text and an empty list do not. */
export const isAnswered = (value: AnswerValue | readonly AnswerEntry[] | undefined): boolean => {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * Compares one answer against a template value.
 *
 * The template stores every comparison value as text, because the column is one
 * column. The field's declared type is what says how to read it back, which is
 * why the source field is passed rather than just its answer.
 */
const compare = (
  operator: FieldCondition['operator'],
  answer: AnswerValue | readonly AnswerEntry[] | undefined,
  expected: string | null,
  source: FormField,
): boolean => {
  if (operator === 'IS_PRESENT') return isAnswered(answer)
  if (operator === 'IS_ABSENT') return !isAnswered(answer)
  if (expected === null || !isAnswered(answer)) return false

  if (operator === 'EQUALS' || operator === 'NOT_EQUALS') {
    const matches = Array.isArray(answer)
      ? (answer as readonly string[]).includes(expected)
      : String(answer) === expected
    return operator === 'EQUALS' ? matches : !matches
  }

  // Ordering. The schema already refuses these against a non-ordered type, so
  // reaching here with something unparseable means hand-edited rows.
  const left =
    source.type === 'DATE'
      ? Date.parse(`${String(answer)}T00:00:00Z`)
      : Number(answer)
  const right =
    source.type === 'DATE' ? Date.parse(`${expected}T00:00:00Z`) : Number(expected)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false

  switch (operator) {
    case 'GREATER_THAN':
      return left > right
    case 'GREATER_OR_EQUAL':
      return left >= right
    case 'LESS_THAN':
      return left < right
    case 'LESS_OR_EQUAL':
      return left <= right
  }
}

/** Ands within a group, ors between groups. Empty means the effect never fires. */
const holds = (
  conditions: readonly FieldCondition[],
  effect: FieldCondition['effect'],
  read: (fieldKey: string) => { field: FormField; answer: AnswerValue | readonly AnswerEntry[] | undefined } | null,
): boolean | 'NONE' => {
  const applicable = conditions.filter((condition) => condition.effect === effect)
  if (applicable.length === 0) return 'NONE'

  const groups = new Map<number, FieldCondition[]>()
  for (const condition of applicable) {
    groups.set(condition.groupNumber, [...(groups.get(condition.groupNumber) ?? []), condition])
  }
  return [...groups.values()].some((group) =>
    group.every((condition) => {
      const source = read(condition.sourceFieldKey)
      if (!source) return false
      return compare(condition.operator, source.answer, condition.comparisonValue, source.field)
    }),
  )
}

/**
 * Which fields this answer set actually asks for.
 *
 * Walks the template's topological order so a source is always decided before
 * whatever depends on it, and reads a hidden source as unanswered (rule 3).
 */
export const visibleFields = (
  template: ResolvedFormTemplate,
  answers: AnswerMap,
  entry?: AnswerEntry,
  entryGroupKey?: string,
): ReadonlySet<string> => {
  const visible = new Set<string>()

  const read = (fieldKey: string) => {
    const field = template.byKey.get(fieldKey)
    if (!field) return null
    // A source that has already been decided hidden reads as unanswered.
    if (!visible.has(fieldKey)) return { field, answer: undefined }
    // Inside a repeated entry, a sibling member is read from that entry;
    // anything outside the group is read from the top level.
    const answer =
      entry && field.repeatGroupKey === entryGroupKey ? entry[fieldKey] : answers[fieldKey]
    return { field, answer }
  }

  for (const key of template.evaluationOrder) {
    const field = template.byKey.get(key)
    if (!field) continue
    // A member of a group is only asked when its group is.
    if (field.repeatGroupKey !== null && !visible.has(field.repeatGroupKey)) continue
    const result = holds(field.conditions, 'VISIBLE_WHEN', read)
    if (result === 'NONE' || result) visible.add(key)
  }
  return visible
}

/**
 * Whether a visible field must carry an answer.
 *
 * `CONDITIONAL` means "required exactly when its `REQUIRED_WHEN` rules hold";
 * `REQUIRED` means always. A field that is not visible is never required — see
 * rule 4, and note that this function is only ever asked about visible fields
 * so the precedence is structural rather than a check somebody must remember.
 */
export const isRequiredWhenVisible = (
  template: ResolvedFormTemplate,
  field: FormField,
  answers: AnswerMap,
  visible: ReadonlySet<string>,
  entry?: AnswerEntry,
  entryGroupKey?: string,
): boolean => {
  if (field.requirement === 'REQUIRED') return true
  if (field.requirement === 'OPTIONAL') {
    // An optional field may still be made required by a rule; that is what
    // `CONDITIONAL` is for, so an OPTIONAL field carrying one is a template
    // the authoring write should have refused. Treat it as optional.
    return false
  }
  const read = (fieldKey: string) => {
    const source = template.byKey.get(fieldKey)
    if (!source) return null
    if (!visible.has(fieldKey)) return { field: source, answer: undefined }
    const answer =
      entry && source.repeatGroupKey === entryGroupKey ? entry[fieldKey] : answers[fieldKey]
    return { field: source, answer }
  }
  const result = holds(field.conditions, 'REQUIRED_WHEN', read)
  return result === 'NONE' ? false : result
}
