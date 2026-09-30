/**
 * The client's copy of the cross-field form rules — "a grant, a loan, or
 * both", "two different banks".
 *
 * **A second implementation of rules the server also holds**, for the same
 * reason as the visibility rules in `formTemplate.ts`: the applicant should see
 * "choose a grant, a loan or both" when they untick the second box, not after
 * the next save. The server's verdict is still the one that counts —
 * submission re-evaluates every rule — so a disagreement here costs a message
 * shown late or early, never a wrong submission.
 *
 * Each evaluator is registered with `defineClientFormRule` under the catalogue's
 * key. `check:workflow-catalog` fails the build when a rule type in
 * `src/services/catalogue/workflow.json` has no client evaluator, and
 * `test/service/client-parity.test.ts` runs both sides over the same operands.
 *
 * **No runtime imports**, like `formTemplate.ts`, so the parity test can import
 * this file directly.
 */
import type { FormRuleType } from '#/graphql/generated/schema'
import type { AnswerMap, AnswerValue } from './answers'
import type { FormTemplate, ResolvedTemplate } from './formTemplate'

export type FormRule = FormTemplate['rules'][number]

/** One operand as a rule sees it: its type, and its answer if visible and given. */
export type ClientRuleOperand = { readonly key: string; readonly type: string; readonly value: AnswerValue | undefined }

type ClientFormRule = {
  readonly key: FormRuleType
  readonly holds: (operands: readonly ClientRuleOperand[], limit: number | null) => boolean
}

/** Registers a client rule. The key is the marker `check:workflow-catalog` matches. */
const defineClientFormRule = (
  key: FormRuleType,
  evaluator: Omit<ClientFormRule, 'key'>,
): ClientFormRule => ({ key, ...evaluator })

/** A given answer: absent, null, empty text and an empty list do not count. */
const answered = (value: AnswerValue | undefined): boolean =>
  value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)

/** A calendar date compares as a date; anything else as a number. */
const ordinal = (type: string, value: AnswerValue | undefined): number =>
  type === 'DATE' ? Date.parse(`${String(value)}T00:00:00Z`) : Number(value)

export const clientFormRules = {
  // Vacuous when none of the questions is asked: a rule cannot demand an answer
  // to a question that is not on the screen.
  AT_LEAST_ONE_TRUE: defineClientFormRule('AT_LEAST_ONE_TRUE', {
    holds: (operands) =>
      operands.every((operand) => operand.value === undefined) || operands.some((operand) => operand.value === true),
  }),
  DIFFERENT_VALUES: defineClientFormRule('DIFFERENT_VALUES', {
    holds: (operands) => {
      const given = operands.map((operand) => operand.value).filter(answered).map(String)
      return new Set(given).size === given.length
    },
  }),
  SUM_AT_MOST: defineClientFormRule('SUM_AT_MOST', {
    holds: (operands, limit) =>
      limit === null ||
      operands.reduce((sum, operand) => sum + (typeof operand.value === 'number' ? operand.value : 0), 0) <= limit,
  }),
  AT_MOST_FIELD: defineClientFormRule('AT_MOST_FIELD', {
    holds: ([first, second]) => {
      if (!first || !second || !answered(first.value) || !answered(second.value)) return true
      return ordinal(first.type, first.value) <= ordinal(second.type, second.value)
    },
  }),
} satisfies Record<FormRuleType, ClientFormRule>

/**
 * The rules that do not hold for these answers, given which questions are
 * visible. A hidden question reads as unanswered, whatever is stored under it.
 */
export const brokenFormRules = (
  template: ResolvedTemplate,
  rules: readonly FormRule[],
  answers: AnswerMap,
  visible: ReadonlySet<string>,
): FormRule[] =>
  rules.filter((rule) => {
    const operands = rule.operandKeys.map((key) => ({
      key,
      type: template.byKey.get(key)?.type ?? 'TEXT',
      value: visible.has(key) ? (answers[key] as AnswerValue | undefined) : undefined,
    }))
    return !clientFormRules[rule.type].holds(operands, rule.limit ?? null)
  })
