/**
 * Turning template rows into the one object every consumer uses.
 *
 * This is the only door. Nothing downstream sees a row, so no consumer can
 * build its own idea of what the form is — which is what replaces the
 * compile-time safety the fixed columns used to give. The old `sections.ts`
 * needed a hand-written second copy of the field list and a `keyof` type to
 * stop it drifting; there is now exactly one list and it is the template.
 *
 * ## Total or null, never throwing
 *
 * Every incoherence returns `null`: a duplicate key, a condition naming a field
 * that does not exist, a cycle in the visibility graph, a role bound twice, a
 * pattern that will not compile. None of these should be reachable, because the
 * guarded write that authored the template refused them and the schema refuses
 * most of them again — so `null` here means the rows were edited by hand, and
 * the caller turns it into a refusal rather than a crash.
 */
import {
  ROLE_CANONICAL_KEY,
  formFieldRoles,
  type FormFieldRole,
} from '../../../db/schema/seb/form-template'
import type {
  FieldCondition,
  FormField,
  FormTemplateRows,
  ResolvedFormTemplate,
} from './types'

/**
 * The longest pattern a cycle may declare.
 *
 * A template author supplies a regular expression that runs on a Worker CPU
 * budget against applicant input. Three things bound it and this is the first:
 * the authoring controller screens the source, every patterned field must also
 * declare a length cap (the schema enforces that), and the compiled expression
 * is anchored below so it cannot accidentally accept a substring.
 */
const MAX_PATTERN_LENGTH = 200

/**
 * Compiles a template pattern, anchored at both ends.
 *
 * Anchoring is not a convenience. `RegExp.test` searches, so an unanchored
 * `\d{6}` accepts "abc123456xyz" — the field would look validated and would
 * not be. Wrapping in a non-capturing group first means an alternation like
 * `a|b` anchors as a whole rather than binding `^a` to one branch.
 */
const compilePattern = (pattern: string | null): RegExp | null | 'INVALID' => {
  if (pattern === null) return null
  if (pattern.length > MAX_PATTERN_LENGTH) return 'INVALID'
  try {
    return new RegExp(`^(?:${pattern})$`, 'u')
  } catch {
    return 'INVALID'
  }
}

/**
 * Orders fields so that everything a field's visibility depends on comes
 * before it, and reports a cycle rather than looping.
 *
 * A field whose visibility depends on a hidden field must itself be hidden, so
 * visibility has to be settled in one pass down this order. A cyclic template
 * has no such order and would render nothing — refused at authoring, and
 * refused again here because a request must never spin.
 *
 * **Two kinds of dependency, not one.** A field depends on its conditions'
 * sources, *and* a member of a repeated group depends on the group: a member
 * of a group nobody is being asked is not being asked either.
 *
 * The group edge was missing, and the failure was silent. Members carry no
 * condition of their own, so they had no incoming edges and were ordered
 * first; when each was reached its group had not been decided, it read as
 * hidden, and it never became visible. A group behind a condition therefore
 * had no questions in it, `pruneHidden` cleared every entry on the next save,
 * and the applicant was told the save succeeded. Required members were never
 * enforced either, because a hidden field is never required.
 */
const topologicalOrder = (fields: readonly FormField[]): string[] | null => {
  const remaining = new Map(fields.map((field) => [field.key, field]))
  const ordered: string[] = []
  const placed = new Set<string>()

  // Kahn's algorithm, without a priority queue: the field count is bounded by
  // the authoring cap, so the quadratic walk is cheaper than the bookkeeping.
  while (placed.size < fields.length) {
    const ready = [...remaining.values()].filter((field) =>
      field.conditions.every((condition) => placed.has(condition.sourceFieldKey))
      && (field.repeatGroupKey === null || placed.has(field.repeatGroupKey)),
    )
    // Nothing can be placed and fields remain: every survivor is in a cycle.
    if (ready.length === 0) return null
    for (const field of ready) {
      ordered.push(field.key)
      placed.add(field.key)
      remaining.delete(field.key)
    }
  }
  return ordered
}

/* One row's presentation, with absence reading as none. Split out so the
   resolver's own body stays the invariants rather than the plumbing. */
const presentationOf = (
  row: FormTemplateRows['fields'][number],
): FormField['presentation'] => ({
  placeholder: row.placeholder ?? null,
  note: row.note ?? null,
  tone: row.tone ?? null,
  widthHint: row.widthHint ?? null,
  prefixText: row.prefixText ?? null,
  suffixText: row.suffixText ?? null,
  autocompleteHint: row.autocompleteHint ?? null,
  showCharCount: row.showCharCount ?? false,
  textareaRows: row.textareaRows ?? null,
  choiceStyle: row.choiceStyle ?? null,
})

const rulesOf = (row: FormTemplateRows['fields'][number]): FormField['rules'] => ({
  minLength: row.minLength,
  maxLength: row.maxLength,
  pattern: row.pattern,
  patternMessage: row.patternMessage,
  minValue: row.minValue,
  maxValue: row.maxValue,
  minDate: row.minDate,
  maxDate: row.maxDate,
  relativeDateBound: row.relativeDateBound,
  minRepeat: row.repeatMin,
  maxRepeat: row.repeatMax,
  maxFileBytes: row.maxFileBytes,
})

/*
 * The cross-field invariants, checked after every field resolves. Null means
 * the rows describe a form that cannot be rendered — a condition reading a
 * valueless source, a member of a non-group, a role somewhere it cannot be
 * read — and the caller treats that as "hand-edited rows", not a crash.
 */
const fieldInvariantsHold = (
  fields: readonly FormField[],
  byKey: ReadonlyMap<string, FormField>,
  optionsByField: ReadonlyMap<string, unknown[]>,
): boolean => {
  for (const field of fields) {
    for (const condition of field.conditions) {
      const source = byKey.get(condition.sourceFieldKey)
      // A group holds entries and a statement holds nothing: neither has a
      // value a comparison could read.
      if (!source || source.type === 'REPEAT_GROUP' || source.type === 'STATEMENT') return false
    }
    if (field.repeatGroupKey !== null) {
      const group = byKey.get(field.repeatGroupKey)
      if (!group || group.type !== 'REPEAT_GROUP') return false
      // Server-derived and role-bound fields are only ever read at the top
      // level, so one inside a group is a template that means something other
      // than it says. The schema refuses it too; this is the second layer.
      // The date of birth is the carve-out: the age rule walks the owners
      // group's entries for it, so it may live inside one.
      if (field.source === 'SERVER_DERIVED') return false
      if (field.role !== null && field.role !== 'APPLICANT_DATE_OF_BIRTH') return false
    }
    if (optionsByField.has(field.key) && field.options.length === 0) return false
  }
  return true
}

/* Role → key, or null when a binding is missing, duplicated, or off its pin. */
const roleBindingsOf = (
  fields: readonly FormField[],
): Record<FormFieldRole, string> | null => {
  const roles = {} as Record<FormFieldRole, string>
  for (const field of fields) {
    if (field.role === null) continue
    // A second binding would make "the requested amount" ambiguous, and the
    // partial unique index already refuses it in SQL.
    if (roles[field.role] !== undefined) return null
    // Only pinned roles have a canonical key; the date of birth is resolved
    // per template, under whatever key the cycle gave the member.
    const pinned = ROLE_CANONICAL_KEY[field.role]
    if (pinned !== undefined && field.key !== pinned) return null
    roles[field.role] = field.key
  }
  // Every role bound, because a cycle cannot be opened otherwise and the admin
  // queue, the decision bound and the policy rules all assume it.
  for (const role of formFieldRoles) if (roles[role] === undefined) return null
  return roles
}

export const resolveFormTemplate = (
  rows: FormTemplateRows,
): ResolvedFormTemplate | null => {
  const stages = [...rows.stages]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.stageKey.localeCompare(b.stageKey))
    .map((stage) => ({
      key: stage.stageKey,
      title: stage.title,
      description: stage.description,
      iconName: stage.iconName ?? null,
      estimatedMinutes: stage.estimatedMinutes ?? null,
      position: stage.sortOrder,
    }))
  const stagePosition = new Map(stages.map((stage) => [stage.key, stage.position]))
  if (stagePosition.size !== rows.stages.length) return null

  const optionsByField = new Map<string, FormTemplateRows['options'][number][]>()
  for (const option of rows.options) {
    const list = optionsByField.get(option.fieldKey) ?? []
    list.push(option)
    optionsByField.set(option.fieldKey, list)
  }

  const conditionsByField = new Map<string, FieldCondition[]>()
  for (const row of rows.conditions) {
    const list = conditionsByField.get(row.fieldKey) ?? []
    list.push({
      effect: row.effect,
      groupNumber: row.groupNumber,
      sequenceNumber: row.sequenceNumber,
      sourceFieldKey: row.sourceFieldKey,
      operator: row.operator,
      comparisonValue: row.comparisonValue,
    })
    conditionsByField.set(row.fieldKey, list)
  }

  const fields: FormField[] = []
  for (const row of rows.fields) {
    if (!stagePosition.has(row.stageKey)) return null
    const compiled = compilePattern(row.pattern)
    if (compiled === 'INVALID') return null
    fields.push({
      key: row.fieldKey,
      stageKey: row.stageKey,
      type: row.fieldType,
      role: row.role,
      label: row.label,
      helpText: row.helpText,
      requirement: row.requirement,
      source: row.source,
      position: row.sortOrder,
      repeatGroupKey: row.parentFieldKey,
      groupDefinitionKey: row.groupDefinitionKey ?? null,
      options: (optionsByField.get(row.fieldKey) ?? [])
        .sort((a, b) => a.sortOrder - b.sortOrder || a.optionValue.localeCompare(b.optionValue))
        .map((option) => ({
          value: option.optionValue,
          label: option.optionLabel,
          position: option.sortOrder,
          description: option.optionDescription ?? null,
          iconName: option.iconName ?? null,
        })),
      rules: rulesOf(row),
      presentation: presentationOf(row),
      conditions: (conditionsByField.get(row.fieldKey) ?? []).sort(
        (a, b) =>
          a.effect.localeCompare(b.effect) ||
          a.groupNumber - b.groupNumber ||
          a.sequenceNumber - b.sequenceNumber,
      ),
      compiledPattern: compiled,
    })
  }

  fields.sort(
    (a, b) =>
      (stagePosition.get(a.stageKey) ?? 0) - (stagePosition.get(b.stageKey) ?? 0) ||
      a.position - b.position ||
      a.key.localeCompare(b.key),
  )

  const byKey = new Map(fields.map((field) => [field.key, field]))
  if (byKey.size !== fields.length) return null

  if (!fieldInvariantsHold(fields, byKey, optionsByField)) return null

  const roles = roleBindingsOf(fields)
  if (roles === null) return null

  const evaluationOrder = topologicalOrder(fields)
  if (evaluationOrder === null) return null

  return {
    programmeCycleId: rows.programmeCycleId,
    programmeCycleVersion: rows.programmeCycleVersion,
    stages,
    fields,
    byKey,
    answerKeys: new Set(
      fields
        .filter((field) =>
          field.type !== 'FILE' && field.type !== 'STATEMENT'
          && field.repeatGroupKey === null)
        .map((field) => field.key),
    ),
    documentFieldKeys: new Set(
      fields.filter((field) => field.type === 'FILE').map((field) => field.key),
    ),
    roles,
    evaluationOrder,
  }
}

/** The members of one repeated group, in template order. */
export const groupMembers = (
  template: ResolvedFormTemplate,
  groupKey: string,
): readonly FormField[] =>
  template.fields.filter((field) => field.repeatGroupKey === groupKey)
