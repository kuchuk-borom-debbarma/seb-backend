/**
 * Every eligibility rule, keyed by the catalogue's own union, and the one
 * function that decides a kind.
 */
import type { EligibilityRuleType } from '../../catalogue/workflow.generated'
import type { EligibilityEvaluator, EligibilityHistory } from './define'
import { enterpriseAgeAtLeast } from './enterprise-age-at-least'
import { maxApplicationsOfKind } from './max-applications-of-kind'
import { noOpenApplicationOfKind } from './no-open-application-of-kind'
import { priorApplicationHasFlag } from './prior-application-has-flag'
import { priorRecordedValueAtLeast } from './prior-recorded-value-at-least'

export const eligibilityEvaluators = {
  PRIOR_APPLICATION_HAS_FLAG: priorApplicationHasFlag,
  PRIOR_RECORDED_VALUE_AT_LEAST: priorRecordedValueAtLeast,
  NO_OPEN_APPLICATION_OF_KIND: noOpenApplicationOfKind,
  MAX_APPLICATIONS_OF_KIND: maxApplicationsOfKind,
  ENTERPRISE_AGE_AT_LEAST: enterpriseAgeAtLeast,
} satisfies Record<EligibilityRuleType, { readonly key: EligibilityRuleType }>

/** One configured rule, as a cycle stores it. */
export type EligibilityRule = { readonly type: EligibilityRuleType; readonly params: unknown }

/**
 * Whether a kind may be started, and every reason it may not.
 *
 * All rules are evaluated, not the first to fail: an applicant told one reason
 * at a time learns the rules by trial.
 */
export const eligibilityOf = (
  rules: readonly EligibilityRule[],
  history: EligibilityHistory,
): { eligible: boolean; reasons: string[] } => {
  const reasons: string[] = []
  for (const rule of rules) {
    const evaluator = eligibilityEvaluators[rule.type] as unknown as EligibilityEvaluator
    const params = evaluator.params.safeParse(rule.params)
    // A stored rule this build no longer accepts refuses rather than passing.
    const verdict = params.success
      ? evaluator.evaluate(params.data, history)
      : { eligible: false as const, reason: 'This kind of application cannot be started at the moment.' }
    if (!verdict.eligible) reasons.push(verdict.reason)
  }
  return { eligible: reasons.length === 0, reasons }
}

export type { EligibilityHistory, PriorApplication } from './define'
