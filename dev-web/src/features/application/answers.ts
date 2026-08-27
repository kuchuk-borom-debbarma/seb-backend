/**
 * The answer map, as the client holds it.
 *
 * The same shape the API's `JSON` scalar carries, written here rather than
 * generated because a scalar has no structure for codegen to read. `codegen.ts`
 * maps `JSON` onto `AnswerMap`, so the two cannot drift without the build
 * saying so.
 *
 * Flat at the top level, with **one** nested level for a repeated group: a
 * group's key holds a list of entries and each entry is its own map. The server
 * refuses anything deeper, so a third level cannot arrive.
 */
export type AnswerValue = string | number | boolean | null | readonly string[]

export type AnswerEntry = { readonly [key: string]: AnswerValue }

export type AnswerMap = {
  readonly [key: string]: AnswerValue | readonly AnswerEntry[]
}

/** The entries of a repeated group, or none where it has not been started. */
export const entriesOf = (
  answers: AnswerMap,
  groupKey: string,
): readonly AnswerEntry[] => {
  const value = answers[groupKey]
  return Array.isArray(value) ? (value as readonly AnswerEntry[]) : []
}

/** One field's answer, or null where it has not been given. */
export const answerOf = (answers: AnswerMap, key: string): AnswerValue => {
  const value = answers[key]
  return Array.isArray(value) && value.some((item) => typeof item === 'object')
    ? null
    : (value as AnswerValue ?? null)
}

/**
 * The issue path a repeated group's member is addressed by.
 *
 * `GROUP[0].MEMBER`, indexed from 0. The server produces exactly this string in
 * `ValidationIssue.field`, and the renderer must put it on the control's DOM
 * `id` — one definition, so the two cannot disagree.
 */
export const issuePath = (
  fieldKey: string,
  groupKey?: string | null,
  entryIndex?: number | null,
): string =>
  groupKey && entryIndex !== null && entryIndex !== undefined
    ? `${groupKey}[${entryIndex}].${fieldKey}`
    : fieldKey
