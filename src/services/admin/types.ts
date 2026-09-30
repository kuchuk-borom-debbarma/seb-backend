import type {
  FormFieldAutocompleteHint,
  FormFieldChoiceStyle,
  FormFieldRole,
  FormFieldTone,
  FormFieldType,
  FormFieldWidth,
} from '../../db/schema/seb/form-template'
import type { Envelope } from '../envelope'

/*
 * Re-exported so a caller naming one of the aliases below can name its shape
 * too. Without this the alias would resolve to a type nothing else can reach.
 */
export type { Envelope } from '../envelope'
import type { AppBindings } from '../../bindings'
import type { Loaders } from '../../loaders'

// Re-exported because the operation contexts below name it.
export type { Loaders } from '../../loaders'
import type { Database } from '../../db'
import type { Defer } from '../../deferred'
import type { EligibilityRuleType, FormRuleType } from '../catalogue/workflow.generated'
import type {
  fundingCeilingScopes,
  fundingCeilingStates,
  programmeJurisdictions,
} from '../../db/schema'

export type AdminOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
  /** Runs work after the response; absent where there is none to run after. */
  defer?: Defer
}

export type AdminResult<T> = Envelope<T>

export type ProgrammeJurisdiction = (typeof programmeJurisdictions)[number]
export type FundingCeilingState = (typeof fundingCeilingStates)[number]
export type FundingCeilingScope = (typeof fundingCeilingScopes)[number]

export type FormTemplateInput = {
  stages: Array<{
    stageKey: string
    title: string
    description?: string | null
    iconName?: string | null
    estimatedMinutes?: number | null
  }>
  fields: Array<{
    stageKey: string
    fieldKey: string
    fieldType: FormFieldType
    role?: FormFieldRole | null
    label: string
    helpText?: string | null
    requirement: 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL'
    source?: 'APPLICANT' | 'SERVER_DERIVED' | null
    sortOrder?: number | null
    parentFieldKey?: string | null
    /** The reusable structure this group expands from; REPEAT_GROUP only. */
    groupDefinitionKey?: string | null
    repeatMin?: number | null
    repeatMax?: number | null
    minLength?: number | null
    maxLength?: number | null
    pattern?: string | null
    patternMessage?: string | null
    minValue?: number | null
    maxValue?: number | null
    minDate?: string | null
    maxDate?: string | null
    relativeDateBound?: 'NOT_FUTURE' | 'NOT_PAST' | null
    maxFileBytes?: number | null
    placeholder?: string | null
    note?: string | null
    tone?: FormFieldTone | null
    widthHint?: FormFieldWidth | null
    prefixText?: string | null
    suffixText?: string | null
    autocompleteHint?: FormFieldAutocompleteHint | null
    showCharCount?: boolean | null
    textareaRows?: number | null
    choiceStyle?: FormFieldChoiceStyle | null
  }>
  options: Array<{
    fieldKey: string
    fieldType: FormFieldType
    optionValue: string
    optionLabel: string
    optionDescription?: string | null
    iconName?: string | null
    sortOrder?: number | null
  }>
  /**
   * Reusable structures: defined once, used by any repeated group that names
   * one. Members are question shapes without a stage — they take their use's
   * stage on expansion — and carry no conditions in this version.
   */
  groupDefinitions?: Array<{
    definitionKey: string
    label: string
    members: Array<{
      memberKey: string
      fieldType: FormFieldType
      role?: FormFieldRole | null
      label: string
      helpText?: string | null
      requirement: 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL'
      minLength?: number | null
      maxLength?: number | null
      pattern?: string | null
      patternMessage?: string | null
      minValue?: number | null
      maxValue?: number | null
      minDate?: string | null
      maxDate?: string | null
      relativeDateBound?: 'NOT_FUTURE' | 'NOT_PAST' | null
      placeholder?: string | null
      note?: string | null
      tone?: FormFieldTone | null
      widthHint?: FormFieldWidth | null
      prefixText?: string | null
      suffixText?: string | null
      autocompleteHint?: FormFieldAutocompleteHint | null
      showCharCount?: boolean | null
      textareaRows?: number | null
      choiceStyle?: FormFieldChoiceStyle | null
      options?: Array<{
        optionValue: string
        optionLabel: string
        optionDescription?: string | null
        iconName?: string | null
      }>
    }>
  }>
  conditions: Array<{
    fieldKey: string
    effect: 'VISIBLE_WHEN' | 'REQUIRED_WHEN'
    groupNumber?: number | null
    sequenceNumber?: number | null
    sourceFieldKey: string
    sourceFieldType: FormFieldType
    operator:
      | 'EQUALS' | 'NOT_EQUALS'
      | 'GREATER_THAN' | 'GREATER_OR_EQUAL' | 'LESS_THAN' | 'LESS_OR_EQUAL'
      | 'IS_PRESENT' | 'IS_ABSENT'
    comparisonValue?: string | null
  }>
  /**
   * Rules about several answers at once — "a grant, a loan, or both". Operands
   * are field keys, in order; the rule is shown against `stageKey`.
   */
  rules?: Array<{
    ruleKey: string
    ruleType: FormRuleType
    stageKey: string
    message: string
    limitValue?: number | null
    operands: Array<{ fieldKey: string; fieldType: FormFieldType }>
  }>
}

/**
 * A kind of application the cycle accepts, and the rules an enterprise must
 * meet to start one. Rule parameters are validated against the rule type's
 * declared parameters in `services/catalogue/workflow.json`.
 */
export type ApplicationKindInput = {
  kindKey: string
  label: string
  description?: string | null
  /** Parameters are checked against the rule's own schema, so they arrive untyped. */
  rules: Array<{ ruleType: EligibilityRuleType; params: unknown }>
}

export type ProgrammeCyclePolicyInput = {
  minimumApplicantAge: number | null
  maximumApplicantAge: number | null
  categoryAMaximumMonths: number | null
  majorityOwnershipRequired: boolean | null
  jurisdiction: ProgrammeJurisdiction | null
  fundingCeilingState: FundingCeilingState | null
  fundingCeilingAmountPaise: number | null
  fundingCeilingScope: FundingCeilingScope | null
  /**
   * The questions this cycle asks, sent complete on every write.
   *
   * A replacement rather than a patch, like the rest of the policy: each write
   * makes a new cycle version, and applications keep the version they were
   * submitted against. Documents live here too — a required document is a
   * FILE field with an ordinary conditional requirement.
   */
  formTemplate: FormTemplateInput
  /**
   * The pipeline this cycle's applications are worked in. Its published
   * version is pinned when the cycle opens.
   */
  pipelineId: string
  /** The kinds of application this cycle accepts. */
  applicationKinds: ApplicationKindInput[]
}

export type ProgrammeCycleInput = {
  cycleCode: string
  displayName: string
  cycleYear: number
  applicantGuidance?: string | null
  opensAt?: Date | null
  closesAt?: Date | null
  policy: ProgrammeCyclePolicyInput
}

export type { PageInfo } from '../application/types'
