import type {
  FormFieldAutocompleteHint,
  FormFieldChoiceStyle,
  FormFieldRole,
  FormFieldTone,
  FormFieldType,
  FormFieldWidth,
} from '../../db/schema/seb/form-template'
import type { deskReviewIdentifierKinds } from '../../db/schema'
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
import type { IdentifierKind } from './identifiers'
export type { IdentifierKind } from './identifiers'
import type {
  awardAssessmentTypes,
  bankOutcomes,
  deskReviewChecks,
  deskReviewCheckResults,
  deskReviewOutcomes,
  fundingCeilingScopes,
  fundingCeilingStates,
  programmeJurisdictions,
  programmeReasonContexts,
  recoveryComponents,
  decisionOutcomes,
} from '../../db/schema'

/**
 * The named work queues staff actually operate from.
 *
 * Most map to a single application status, but two do not, which is why this is
 * its own vocabulary rather than a reuse of `ApplicationStatus`: a first
 * submission and an answer to a revision request are both `SUBMITTED` and need
 * completely different handling, so they are separated by submission number.
 */
export const intakeQueueKeys = [
  'NEW_SUBMISSIONS',
  'DESK_REVIEW',
  'REVISION_RESPONSES',
  'PARTNER_BANK_EVALUATION',
  'AWAITING_DECISION',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
] as const
export type IntakeQueueKey = (typeof intakeQueueKeys)[number]

export type AdminOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type AdminResult<T> = Envelope<T>

export type ProgrammeReasonContext = (typeof programmeReasonContexts)[number]
export type ProgrammeJurisdiction = (typeof programmeJurisdictions)[number]
export type FundingCeilingState = (typeof fundingCeilingStates)[number]
export type FundingCeilingScope = (typeof fundingCeilingScopes)[number]
export type AssessmentType = (typeof awardAssessmentTypes)[number]
export type DeskReviewCheckType = (typeof deskReviewChecks)[number]
export type DeskReviewCheckResult = (typeof deskReviewCheckResults)[number]
export type DeskReviewOutcome = (typeof deskReviewOutcomes)[number]
export type BankOutcome = (typeof bankOutcomes)[number]
export type DecisionOutcome = (typeof decisionOutcomes)[number]
export type RecoveryComponent = (typeof recoveryComponents)[number]

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
}

export type ProgrammeCycleReasonInput = {
  context: ProgrammeReasonContext
  code: string
  label: string
  applicantMessageTemplate?: string | null
}

export type ProgrammeCyclePolicyInput = {
  minimumApplicantAge: number | null
  maximumApplicantAge: number | null
  categoryAMaximumMonths: number | null
  expansionWaitMonths: number | null
  majorityOwnershipRequired: boolean | null
  jurisdiction: ProgrammeJurisdiction | null
  fundingCeilingState: FundingCeilingState | null
  fundingCeilingAmountPaise: number | null
  fundingCeilingScope: FundingCeilingScope | null
  requiredAssessmentTypes: AssessmentType[]
  /**
   * The questions this cycle asks, sent complete on every write.
   *
   * A replacement rather than a patch, like the rest of the policy: each write
   * makes a new cycle version, and applications keep the version they were
   * submitted against. Documents live here too — a required document is a
   * FILE field with an ordinary conditional requirement.
   */
  formTemplate: FormTemplateInput
  /** Absent means the cycle collects nothing and compares nothing. */
  identifierRules?: ProgrammeCycleIdentifierRuleInput[]
  reasons: ProgrammeCycleReasonInput[]
}

export type ProgrammeCycleInput = {
  cycleCode: string
  displayName: string
  cycleYear: number
  policyReference?: string | null
  applicantGuidance?: string | null
  partnerBankGuidance?: string | null
  opensAt?: Date | null
  closesAt?: Date | null
  policy: ProgrammeCyclePolicyInput
}

export type DeskReviewCheckInput = {
  checkType: DeskReviewCheckType
  result: DeskReviewCheckResult
  internalNote?: string | null
}

/**
 * One number read off a document, as the reviewer typed it.
 *
 * `branchCode` belongs only to a bank account, where the account number alone
 * does not identify a destination. `matchedReason` is supplied on the second
 * attempt, once the reviewer has been told the value already exists elsewhere.
 */
export type DeskReviewIdentifierInput = {
  kind: IdentifierKind
  value: string
  branchCode?: string | null
  matchedReason?: string | null
}

/**
 * One stage a reviewer sends back for revision.
 *
 * `stageKey` was a closed enum of the six sections the form used to have. It is
 * open text now because the stages are a cycle's own, and membership is checked
 * against the pinned template instead — which is stronger, since the enum could
 * never tell that `EXPANSION` was not a stage of *this* cycle's form.
 */
export type RevisionRequestInput = {
  stageKey: string
  reasonCategoryId: string
  note: string
}

export type { PageInfo } from '../application/types'


/**
 * One frozen rule about an identifier a reviewer transcribes.
 *
 * `requirement` and `duplicatePolicy` are independent on purpose: a value can
 * be worth recording without being worth refusing on, and worth comparing
 * without being demanded.
 */
export type ProgrammeCycleIdentifierRuleInput = {
  kind: (typeof deskReviewIdentifierKinds)[number]
  requirement: 'REQUIRED_ON_PASS' | 'OPTIONAL' | 'OFF'
  duplicatePolicy: 'CHECKED' | 'NOT_CHECKED'
  checkType?: string | null
}

export type IdentifierRule = {
  kind: (typeof deskReviewIdentifierKinds)[number]
  requirement: 'REQUIRED_ON_PASS' | 'OPTIONAL' | 'OFF'
  duplicatePolicy: 'CHECKED' | 'NOT_CHECKED'
  /** The check this is evidence for. Null unless it is required on a pass. */
  checkType: string | null
}
