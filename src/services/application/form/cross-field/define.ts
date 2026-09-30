/**
 * Cross-field form rules: what a form says about several answers together,
 * which no single question's bounds can — "a grant, a loan, or both", "the two
 * banks must differ".
 *
 * Each rule type is declared in `services/catalogue/workflow.json`, evaluated
 * here on the server, and evaluated again in the browser by a client rule with
 * the same key (`defineClientFormRule`). `check:workflow-catalog` fails if any
 * of the three is missing, and `client-parity.test.ts` runs both evaluators
 * over the same answers.
 *
 * A rule only ever sees the operands the applicant was actually asked: a hidden
 * question's answer reads as unanswered (the form's rule 3), so a rule about a
 * loan says nothing to somebody who asked for no loan.
 */
import type { FormRuleType } from '../../../catalogue/workflow.generated'
import type { AnswerValue, FormFieldType } from '../types'

/** One operand as a rule sees it: its type, and its answer if visible and given. */
export type RuleOperand = { readonly key: string; readonly type: FormFieldType; readonly value: AnswerValue | undefined }

export type FormRuleEvaluator = {
  readonly key: FormRuleType
  /** True when the answers satisfy the rule. */
  readonly holds: (operands: readonly RuleOperand[], limit: number | null) => boolean
}

/** Registers a server rule. The key is the marker `check:workflow-catalog` matches. */
export const defineFormRule = (
  key: FormRuleType,
  evaluator: Omit<FormRuleEvaluator, 'key'>,
): FormRuleEvaluator => ({ key, ...evaluator })

/** A given answer: absent, null and empty do not count. */
export const answered = (value: AnswerValue | undefined): value is Exclude<AnswerValue, null> =>
  value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)
