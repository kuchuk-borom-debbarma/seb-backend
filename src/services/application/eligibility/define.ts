/**
 * Eligibility rules: whether an enterprise may start an application of a kind
 * a cycle declares — a first application, an expansion, whatever a future cycle
 * calls its kinds.
 *
 * Each rule type is declared in `services/catalogue/workflow.json` and evaluated
 * here, over a history the start operation reads in one statement. Pure, so a
 * cycle's eligibility is a function of that history and can be tested without
 * a database, and so the reasons an applicant is shown are exactly what was
 * evaluated.
 */
import type { z } from 'zod'
import type { EligibilityRuleType } from '../../catalogue/workflow.generated'
import type { AnswerValue } from '../form/types'

/** One earlier application of the enterprise, as eligibility reads it. */
export type PriorApplication = {
  readonly kind: string
  readonly pipelineKey: string
  /** Not yet submitted. */
  readonly draft: boolean
  /** Holds a flag that ended its pipeline. */
  readonly finished: boolean
  readonly flags: readonly string[]
  /** When each held flag was last added, from the stage-action history. */
  readonly flagAddedAt: Readonly<Record<string, Date>>
  readonly recorded: Readonly<Record<string, AnswerValue>>
}

export type EligibilityHistory = {
  readonly now: Date
  readonly enterpriseEstablishedOn: string | null
  readonly applications: readonly PriorApplication[]
}

/** Either the rule holds, or the sentence the applicant is shown. */
export type EligibilityVerdict = { readonly eligible: true } | { readonly eligible: false; readonly reason: string }

export type EligibilityEvaluator<S extends z.ZodObject = z.ZodObject> = {
  readonly key: EligibilityRuleType
  readonly params: S
  readonly evaluate: (params: z.infer<S>, history: EligibilityHistory) => EligibilityVerdict
}

/** Registers a rule. The key is the marker `check:workflow-catalog` matches. */
export const defineEligibility = <S extends z.ZodObject>(
  key: EligibilityRuleType,
  evaluator: Omit<EligibilityEvaluator<S>, 'key'>,
): EligibilityEvaluator<S> => ({ key, ...evaluator })

/** Whole calendar months from one instant to another, never rounding up. */
export const monthsBetween = (from: Date, to: Date): number => {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  if (to.getUTCDate() < from.getUTCDate()) months -= 1
  return months
}

export const ELIGIBLE: EligibilityVerdict = { eligible: true }
