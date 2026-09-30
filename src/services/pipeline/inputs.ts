/**
 * An action's inputs, run through the application form's own engine.
 *
 * An officer typing an approved amount and an applicant typing a requested one
 * obey one set of rules — coercion, bounds, visibility, what "answered" means —
 * because both are validated by the same code. So an action's inputs are
 * adapted into a one-stage form and handed to `normalizeAnswers` and
 * `validateAnswersForSubmission`, rather than checked by a second validator
 * that would, sooner or later, disagree with the first.
 */
import { normalizeAnswers, validateAnswersForSubmission } from '../application/form/engine'
import { pruneHidden } from '../application/form/answers'
import { resolveFormTemplate } from '../application/form/template'
import type { ValidationIssue } from '../application/form/codes'
import type {
  AnswerValue,
  CyclePolicy,
  FormTemplateRows,
  ResolvedFormTemplate,
} from '../application/form/types'
import type { PipelineAction } from './definition'

/** The one form stage an action's inputs live on. */
export const INPUT_STAGE_KEY = 'ACTION_INPUTS'

/** No programme policy applies to an officer's inputs; every scalar is unset. */
const NO_POLICY: CyclePolicy = {
  minimumApplicantAge: null,
  maximumApplicantAge: null,
  categoryAMaximumMonths: null,
  majorityOwnershipRequired: null,
  fundingCeilingState: null,
  fundingCeilingAmountPaise: null,
  fundingCeilingScope: null,
}

/** The action's inputs as the rows a form template is resolved from. */
const actionInputRows = (action: PipelineAction): FormTemplateRows => ({
  programmeCycleId: `ACTION:${action.key}`,
  programmeCycleVersion: 1,
  stages: [{ stageKey: INPUT_STAGE_KEY, title: action.label, description: action.description, sortOrder: 0 }],
  fields: action.inputs.map((input, position) => ({
    stageKey: INPUT_STAGE_KEY,
    fieldKey: input.key,
    fieldType: input.type,
    role: null,
    label: input.label,
    helpText: input.helpText,
    // A hidden input is never required (the form's rule 4), so REQUIRED here
    // means "required whenever it is shown".
    requirement: input.requirement,
    source: 'APPLICANT' as const,
    sortOrder: position,
    parentFieldKey: null,
    repeatMin: null,
    repeatMax: null,
    minLength: input.minLength,
    maxLength: input.maxLength,
    pattern: null,
    patternMessage: null,
    minValue: input.minValue,
    maxValue: input.maxValue,
    minDate: input.minDate,
    maxDate: input.maxDate,
    relativeDateBound: input.relativeDateBound,
    maxFileBytes: null,
  })),
  options: action.inputs.flatMap((input) =>
    input.options.map((option, position) => ({
      fieldKey: input.key,
      optionValue: option.value,
      optionLabel: option.label,
      sortOrder: position,
    })),
  ),
  conditions: action.inputs.flatMap((input) =>
    input.visibleWhen.map((condition, position) => ({
      fieldKey: input.key,
      effect: 'VISIBLE_WHEN' as const,
      groupNumber: condition.group,
      sequenceNumber: position + 1,
      sourceFieldKey: condition.key,
      operator: condition.operator,
      comparisonValue: condition.value,
    })),
  ),
})

/** The inputs as a resolved form, or null when they do not form one. */
export const actionInputTemplate = (action: PipelineAction): ResolvedFormTemplate | null =>
  resolveFormTemplate(actionInputRows(action))

export type ValidatedInputs =
  | { ok: true; values: Readonly<Record<string, AnswerValue>> }
  | { ok: false; issues: readonly ValidationIssue[] }

/**
 * The inputs as sent, with every input the officer was not sent as null.
 *
 * The form engine reads its answer map as a snapshot, where a missing key is a
 * client that lost part of the form. An action's inputs are not a snapshot: a
 * dialog that never drew a hidden input has nothing to send for it, and
 * refusing the action for that would make every client re-derive which inputs
 * are hidden. A value that is not an object is passed on untouched, for the
 * engine to refuse.
 */
const withEveryInput = (template: ResolvedFormTemplate, submitted: unknown): unknown => {
  if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) return submitted
  const completed: Record<string, unknown> = { ...(submitted as Record<string, unknown>) }
  for (const key of template.answerKeys) if (!(key in completed)) completed[key] = null
  return completed
}

/**
 * The officer's inputs, normalized and checked exactly as a form submission is.
 * A hidden input's value is dropped, so an effect never reads what the officer
 * was not asked.
 */
export const validateActionInputs = (
  action: PipelineAction,
  submitted: unknown,
  now: Date,
): ValidatedInputs => {
  const template = actionInputTemplate(action)
  // A published action always resolves — `pipelineProblem` refused any that
  // did not — so this is a stored document a later build no longer accepts.
  if (!template) {
    return {
      ok: false,
      issues: [{ stageKey: INPUT_STAGE_KEY, field: '', code: 'INVALID_TYPE', message: 'This action can no longer be taken.' }],
    }
  }
  const normalized = normalizeAnswers(template, withEveryInput(template, submitted ?? {}), now)
  if (normalized.issues.length > 0 || normalized.value === null) {
    return { ok: false, issues: normalized.issues }
  }
  const report = validateAnswersForSubmission(template, normalized.value, new Set(), now, NO_POLICY)
  if (!report.valid) return { ok: false, issues: report.issues }
  return { ok: true, values: pruneHidden(template, normalized.value) as Record<string, AnswerValue> }
}
