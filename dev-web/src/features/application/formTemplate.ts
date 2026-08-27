/**
 * The form template, resolved for rendering.
 *
 * **This is a second implementation of rules the server also holds**, and that
 * is deliberate rather than accidental: the applicant has to see a question
 * appear the moment the answer above it changes, and a round trip per keystroke
 * is not that. The cost is that the two can disagree, so the rules below are
 * transcribed from `src/services/application/form/conditions.ts` and the pair is
 * pinned by a committed fixture both suites read.
 *
 * Rules, in the server's own words:
 *
 * 1. Conditions sharing a group must all hold; separate groups are
 *    alternatives. Ands within, ors between.
 * 2. A field controlled by a hidden field is itself hidden.
 * 3. A hidden field's answer reads as unanswered.
 * 4. A hidden field is never required, whatever its flags say.
 */
import type { FormTemplateFieldsFragment } from '#/graphql/generated/operations'
import type { AnswerEntry, AnswerMap, AnswerValue } from './answers'

export type FormTemplate = FormTemplateFieldsFragment
export type FormField = FormTemplate['fields'][number]
export type FormStage = FormTemplate['stages'][number]
export type FieldCondition = FormField['conditions'][number]

export type ResolvedTemplate = {
  readonly stages: readonly FormStage[]
  readonly fields: readonly FormField[]
  readonly byKey: ReadonlyMap<string, FormField>
  /** Top-level fields of one stage, in order. Group members are drawn by their group. */
  readonly fieldsOfStage: (stageKey: string) => readonly FormField[]
  readonly membersOfGroup: (groupKey: string) => readonly FormField[]
  /** Topological over the condition graph, so a source is decided before its dependents. */
  readonly evaluationOrder: readonly string[]
}

/**
 * Orders the fields so everything a field's visibility depends on comes first.
 *
 * **Two kinds of dependency**: a field depends on its conditions' sources, and
 * a member of a repeated group depends on the group — a member of a group
 * nobody is being asked is not being asked either. The group edge was missing
 * here and on the server, and it renders a conditional group as entry cards
 * with no questions in them.
 *
 * A cycle cannot be authored — the admin write refuses one — so a template that
 * still has one was hand-edited. The remaining fields are appended in template
 * order rather than dropped: a form that renders every question is a better
 * failure than one that silently omits a stage.
 */
const topologicalOrder = (fields: readonly FormField[]): string[] => {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const field of fields) {
    indegree.set(field.key, indegree.get(field.key) ?? 0)
  }
  const dependsOn = (field: FormField): string[] => [
    ...field.conditions.map((condition) => condition.sourceFieldKey),
    ...(field.repeatGroupKey === null ? [] : [field.repeatGroupKey]),
  ]
  for (const field of fields) {
    for (const sourceKey of dependsOn(field)) {
      if (!indegree.has(sourceKey)) continue
      indegree.set(field.key, (indegree.get(field.key) ?? 0) + 1)
      dependents.set(sourceKey, [
        ...(dependents.get(sourceKey) ?? []),
        field.key,
      ])
    }
  }
  const ready = fields.filter((field) => (indegree.get(field.key) ?? 0) === 0).map((f) => f.key)
  const order: string[] = []
  while (ready.length > 0) {
    const key = ready.shift()!
    order.push(key)
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) ready.push(dependent)
    }
  }
  if (order.length === fields.length) return order
  const seen = new Set(order)
  return [...order, ...fields.map((field) => field.key).filter((key) => !seen.has(key))]
}

export const resolveTemplate = (template: FormTemplate): ResolvedTemplate => {
  const stages = [...template.stages].sort((a, b) => a.position - b.position)
  const fields = [...template.fields]
  const byKey = new Map(fields.map((field) => [field.key, field]))
  return {
    stages,
    fields,
    byKey,
    fieldsOfStage: (stageKey) =>
      fields.filter((field) => field.stageKey === stageKey && field.repeatGroupKey === null),
    membersOfGroup: (groupKey) =>
      fields.filter((field) => field.repeatGroupKey === groupKey),
    evaluationOrder: topologicalOrder(fields),
  }
}

/** Whether an answer counts as given. Empty text and an empty list do not. */
export const isAnswered = (
  value: AnswerValue | readonly AnswerEntry[] | undefined,
): boolean => {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

type Read = (
  fieldKey: string,
) => { field: FormField; answer: AnswerValue | readonly AnswerEntry[] | undefined } | null

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
  const left =
    source.type === 'DATE' ? Date.parse(`${String(answer)}T00:00:00Z`) : Number(answer)
  const right =
    source.type === 'DATE' ? Date.parse(`${expected}T00:00:00Z`) : Number(expected)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  if (operator === 'GREATER_THAN') return left > right
  if (operator === 'GREATER_OR_EQUAL') return left >= right
  if (operator === 'LESS_THAN') return left < right
  return left <= right
}

const holds = (
  conditions: readonly FieldCondition[],
  effect: FieldCondition['effect'],
  read: Read,
): boolean | 'NONE' => {
  const applicable = conditions.filter((condition) => condition.effect === effect)
  if (applicable.length === 0) return 'NONE'
  const groups = new Map<number, FieldCondition[]>()
  for (const condition of applicable) {
    groups.set(condition.groupNumber, [
      ...(groups.get(condition.groupNumber) ?? []),
      condition,
    ])
  }
  return [...groups.values()].some((group) =>
    group.every((condition) => {
      const source = read(condition.sourceFieldKey)
      return source
        ? compare(condition.operator, source.answer, condition.comparisonValue, source.field)
        : false
    }),
  )
}

export const visibleFields = (
  template: ResolvedTemplate,
  answers: AnswerMap,
  entry?: AnswerEntry,
  entryGroupKey?: string,
): ReadonlySet<string> => {
  const visible = new Set<string>()
  const read: Read = (fieldKey) => {
    const field = template.byKey.get(fieldKey)
    if (!field) return null
    if (!visible.has(fieldKey)) return { field, answer: undefined }
    const answer =
      entry && field.repeatGroupKey === entryGroupKey ? entry[fieldKey] : answers[fieldKey]
    return { field, answer }
  }
  for (const key of template.evaluationOrder) {
    const field = template.byKey.get(key)
    if (!field) continue
    if (field.repeatGroupKey !== null && !visible.has(field.repeatGroupKey)) continue
    const result = holds(field.conditions, 'VISIBLE_WHEN', read)
    if (result === 'NONE' || result) visible.add(key)
  }
  return visible
}

export const isRequiredWhenVisible = (
  template: ResolvedTemplate,
  field: FormField,
  answers: AnswerMap,
  visible: ReadonlySet<string>,
  entry?: AnswerEntry,
  entryGroupKey?: string,
): boolean => {
  if (field.requirement === 'REQUIRED') return true
  if (field.requirement === 'OPTIONAL') return false
  const read: Read = (fieldKey) => {
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

/**
 * Drops the answers to questions the latest answers have put away.
 *
 * **Run to a fixed point**, because hiding a question can hide the one that
 * depended on it. A single pass leaves the third answer behind, the form then
 * looks right, and the draft that is sent is wrong.
 */
export const pruneHidden = (template: ResolvedTemplate, answers: AnswerMap): AnswerMap => {
  let current = answers
  for (let pass = 0; pass <= template.fields.length; pass += 1) {
    const visible = visibleFields(template, current)
    const next: Record<string, AnswerValue | readonly AnswerEntry[]> = {}
    let cleared = false
    for (const field of template.fields) {
      // STATEMENT is read, never answered: the server refuses even a null
      // addressed to it, so writing its key here would make every save on a
      // statement-bearing cycle fail — the same trap SERVER_DERIVED below
      // records.
      if (field.repeatGroupKey !== null || field.type === 'FILE') continue
      if (field.type === 'STATEMENT') continue
      /*
       * Two exclusions the server's prune makes and this one did not.
       *
       * A `SERVER_DERIVED` answer is the programme office's, not the
       * applicant's, and the server refuses one outright with *"is recorded by
       * the programme office and cannot be answered"*. This wrote a key for
       * every field it walked, so a cycle declaring a single such question
       * made **every save from this client fail**, on a key the applicant had
       * never touched.
       *
       * And a cleared `MULTI_CHOICE` is an empty list rather than null, which
       * is what the server stores. The server coerces null to `[]` anyway, so
       * it was harmless — and a divergence between these two implementations
       * that happens to be harmless is the one that gets copied.
       *
       * **What this must *not* copy from the server is skipping a key that is
       * not there.** The server's prune runs on an already-normalized map where
       * every question has a value; this one runs on browser state that has
       * only what the applicant has touched. A save replaces the whole answer
       * set, so a key left out is `MISSING_SNAPSHOT_FIELD` and the save is
       * refused — the form fills in, says "Saved" from the first field that
       * landed, and nothing after it is stored. Found by `duplicates.spec.ts`,
       * after this had been made to match the server exactly.
       */
      if (field.source === 'SERVER_DERIVED') continue
      const value = current[field.key] ?? null
      if (!visible.has(field.key)) {
        if (isAnswered(value)) cleared = true
        next[field.key] =
          field.type === 'MULTI_CHOICE' || field.type === 'REPEAT_GROUP' ? [] : null
        continue
      }
      if (field.type === 'REPEAT_GROUP') {
        const entries = Array.isArray(value) ? (value as readonly AnswerEntry[]) : []
        next[field.key] = entries.map((entry) => {
          const entryVisible = visibleFields(template, current, entry, field.key)
          const kept: Record<string, AnswerValue> = {}
          for (const member of template.membersOfGroup(field.key)) {
            if (member.type === 'FILE') continue
            const memberValue = entry[member.key] ?? null
            if (!entryVisible.has(member.key)) {
              if (isAnswered(memberValue)) cleared = true
              kept[member.key] = null
              continue
            }
            kept[member.key] = memberValue
          }
          return kept
        })
        continue
      }
      next[field.key] = value === undefined ? null : (value as AnswerValue)
    }
    current = next
    if (!cleared) break
  }
  return current
}
