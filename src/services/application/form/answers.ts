/**
 * Comparing and tidying answer sets.
 *
 * One definition of "did this change", used by three callers that used to have
 * three: the no-op check on save, the revision guard that refuses edits outside
 * the stages a reviewer opened, and the change summary both portals show. The
 * old code compared a whole draft by `JSON.stringify` in one place, each
 * section by `JSON.stringify` in another, and field-by-field with a `Date`
 * special case in a third — so the three could and did disagree.
 */
import { isAnswered, visibleFields } from './conditions'
import { groupMembers } from './template'
import type {
  AnswerEntry,
  AnswerMap,
  AnswerValue,
  ResolvedFormTemplate,
} from './types'

const sameValue = (
  left: AnswerValue | readonly AnswerEntry[] | undefined,
  right: AnswerValue | readonly AnswerEntry[] | undefined,
): boolean => {
  const a = left ?? null
  const b = right ?? null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((entry, index) => {
      const other = (b as unknown[])[index]
      if (typeof entry === 'object' && entry !== null) {
        // A repeated entry. Compared positionally, so a reorder counts as a
        // change: entries carry no identity, "moved" is indistinguishable from
        // "replaced", and reporting no change for an edit that happened is the
        // failure this whole module exists to prevent.
        const entryKeys = new Set([
          ...Object.keys(entry as AnswerEntry),
          ...Object.keys((other ?? {}) as AnswerEntry),
        ])
        return [...entryKeys].every((key) =>
          sameValue((entry as AnswerEntry)[key], (other as AnswerEntry | undefined)?.[key]),
        )
      }
      return entry === other
    })
  }
  return a === b
}

/**
 * The stages whose answers differ between two snapshots.
 *
 * Walks the template rather than the two objects, so a key present in one and
 * absent in the other is still compared — and so the result is in template
 * order, which is the order both portals list them in.
 *
 * If the two snapshots were filled against different cycle versions, every
 * stage is reported changed rather than guessed at. That cannot happen today,
 * because a draft never re-pins; it becomes possible the day a resubmission is
 * allowed to, and a silently wrong diff is worse than a conservative one.
 */
export const changedStageKeys = (
  template: ResolvedFormTemplate,
  previous: AnswerMap,
  next: AnswerMap,
): string[] => {
  const changed = new Set<string>()
  for (const field of template.fields) {
    /*
     * Group members are compared through their group's entry list, and the
     * difference lands on the group's own stage.
     *
     * Sound because a member must be declared in its group's stage —
     * `formTemplateProblem` refuses anything else, for this reason among
     * others. Without that rule a member's edits would be reported against a
     * stage it does not belong to, which under revision decides whether the
     * change is in scope.
     */
    if (field.repeatGroupKey !== null) continue
    if (!sameValue(previous[field.key], next[field.key])) changed.add(field.stageKey)
  }
  return template.stages.map((stage) => stage.key).filter((key) => changed.has(key))
}

/** Whether two answer sets say the same thing, by the same rule as the diff. */
export const answersEqual = (
  template: ResolvedFormTemplate,
  previous: AnswerMap,
  next: AnswerMap,
): boolean => changedStageKeys(template, previous, next).length === 0

/**
 * Drops the answers to questions the latest answers have put away.
 *
 * A hidden question's answer is not merely invisible, it is wrong: it would be
 * stored, shown to a reviewer, and read as though somebody had been asked for
 * it. The old form did this with four hand-written clearing closures beside
 * four hand-written conditionals; this is the same rule stated once.
 *
 * **Run to a fixed point**, because hiding a question can hide the one that
 * depended on it: answering "no" to prior funding hides the scheme name, and a
 * question conditional on the scheme name has to go too. A single pass leaves
 * the third answer behind, and the form then looks right while the draft is
 * wrong — which nothing downstream would notice.
 *
 * Terminates because each pass either removes at least one answer or stops, and
 * the answer count is finite.
 */
export const pruneHidden = (template: ResolvedFormTemplate, answers: AnswerMap): AnswerMap => {
  let current: AnswerMap = answers
  /*
   * Bounded by the field count: each pass that changes anything clears at
   * least one answer, and an unbounded loop in a request is never acceptable.
   *
   * **A bound, not a requirement.** In practice one pass is always enough,
   * because a hidden question's answer already reads as absent — so the first
   * evaluation of visibility is already the final one, however long the chain.
   * `test/service/engine-conditions.test.ts` records the attempt to find a
   * template needing two, including one where clearing an answer makes another
   * question appear; a single-pass build passed every case. The loop stays
   * because it costs nothing and the day a new effect breaks that property is
   * not the day to discover the code assumed it.
   */
  for (let pass = 0; pass <= template.fields.length; pass += 1) {
    const visible = visibleFields(template, current)
    const next: Record<string, AnswerValue | readonly AnswerEntry[]> = {}
    let cleared = false

    for (const field of template.fields) {
      if (field.repeatGroupKey !== null || field.type === 'FILE') continue
      const value = current[field.key]
      if (value === undefined) continue

      if (!visible.has(field.key)) {
        const empty: AnswerValue | readonly AnswerEntry[] =
          field.type === 'MULTI_CHOICE' || field.type === 'REPEAT_GROUP' ? [] : null
        if (isAnswered(value)) cleared = true
        next[field.key] = empty
        continue
      }

      if (field.type === 'REPEAT_GROUP' && Array.isArray(value)) {
        const members = groupMembers(template, field.key)
        next[field.key] = (value as readonly AnswerEntry[]).map((entry) => {
          const entryVisible = visibleFields(template, current, entry, field.key)
          const kept: Record<string, AnswerValue> = {}
          for (const member of members) {
            const memberValue = entry[member.key]
            if (memberValue === undefined) continue
            if (!entryVisible.has(member.key)) {
              if (isAnswered(memberValue)) cleared = true
              kept[member.key] = member.type === 'MULTI_CHOICE' ? [] : null
              continue
            }
            kept[member.key] = memberValue
          }
          return kept
        })
        continue
      }

      next[field.key] = value
    }

    current = next
    if (!cleared) return current
  }
  return current
}
