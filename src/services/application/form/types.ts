/**
 * The shapes the form engine works in.
 *
 * A `ResolvedFormTemplate` is what every consumer sees: the raw rows are turned
 * into one immutable object by `resolveFormTemplate`, and nothing downstream
 * touches a row. That single door is what makes the guarantees checkable — a
 * caller cannot build its own idea of what the form is.
 */
import type {
  FormFieldAutocompleteHint,
  FormFieldChoiceStyle,
  FormFieldRole,
  FormFieldTone,
  FormFieldType,
  FormFieldWidth,
} from '../../../db/schema/seb/form-template'

export type {
  FormFieldAutocompleteHint,
  FormFieldChoiceStyle,
  FormFieldRole,
  FormFieldTone,
  FormFieldType,
  FormFieldWidth,
}

/** What the applicant sent for one field, after coercion. */
export type AnswerValue = string | number | boolean | null | readonly string[]

/**
 * Every answer, keyed by field key.
 *
 * Flat at the top level, with one nested level for a repeated group: a group's
 * key holds a list of entries and each entry is its own map. Deeper nesting is
 * refused by the schema, because it would make the issue path, the change diff
 * and the payload budget all unbounded.
 */
/*
 * `AnswerEntry` and `AnswerValue` are named here and imported by no file
 * directly, which reads to `fallow` as this type leaking private ones. They are
 * the alphabet an answer set is written in and nothing else can express them;
 * hiding them would mean a caller holding an `AnswerMap` could not name what is
 * in it.
 */
export type AnswerMap = {
  readonly [key: string]: AnswerValue | readonly AnswerEntry[]
}
export type AnswerEntry = { readonly [key: string]: AnswerValue }

export type FieldRules = {
  readonly minLength: number | null
  readonly maxLength: number | null
  readonly pattern: string | null
  readonly patternMessage: string | null
  readonly minValue: number | null
  readonly maxValue: number | null
  readonly minDate: string | null
  readonly maxDate: string | null
  /** `NOT_FUTURE` and `NOT_PAST` are resolved against the write's own instant. */
  readonly relativeDateBound: 'NOT_FUTURE' | 'NOT_PAST' | null
  readonly minRepeat: number | null
  readonly maxRepeat: number | null
  readonly maxFileBytes: number | null
}

export type FieldConditionEffect = 'VISIBLE_WHEN' | 'REQUIRED_WHEN'
export type FieldConditionOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'GREATER_THAN'
  | 'GREATER_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_OR_EQUAL'
  | 'IS_PRESENT'
  | 'IS_ABSENT'

/**
 * One comparison against an answer already given.
 *
 * Conditions sharing a `groupNumber` must all hold; separate groups are
 * alternatives. The combinator is stated here rather than implied, because an
 * implied one is what the server and the client would each guess differently.
 */
export type FieldCondition = {
  readonly effect: FieldConditionEffect
  readonly groupNumber: number
  readonly sequenceNumber: number
  readonly sourceFieldKey: string
  readonly operator: FieldConditionOperator
  readonly comparisonValue: string | null
}

export type FieldOption = {
  readonly value: string
  readonly label: string
  readonly position: number
  /** For the card rendering: a sentence under the label, an icon beside it. */
  readonly description: string | null
  readonly iconName: string | null
}

/**
 * How a question is drawn, as distinct from what an answer must satisfy.
 * Every value is the cycle author's; the engine never reads any of them.
 */
export type FieldPresentation = {
  readonly placeholder: string | null
  readonly note: string | null
  readonly tone: FormFieldTone | null
  readonly widthHint: FormFieldWidth | null
  readonly prefixText: string | null
  readonly suffixText: string | null
  readonly autocompleteHint: FormFieldAutocompleteHint | null
  readonly showCharCount: boolean
  readonly textareaRows: number | null
  readonly choiceStyle: FormFieldChoiceStyle | null
}

export type FormField = {
  readonly key: string
  readonly stageKey: string
  readonly type: FormFieldType
  readonly role: FormFieldRole | null
  readonly label: string
  readonly helpText: string | null
  readonly requirement: 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL'
  /** `SERVER_DERIVED` fields are never accepted from an applicant. */
  readonly source: 'APPLICANT' | 'SERVER_DERIVED'
  readonly position: number
  /** The group this field is a member of, or null when it stands alone. */
  readonly repeatGroupKey: string | null
  /**
   * The reusable structure a group was expanded from, or null. Provenance for
   * the editor — the engine never reads it — and exposed rather than inferred,
   * because inferring it from member names can rebind a group to the wrong
   * structure when one definition's members are a subset of another's.
   */
  readonly groupDefinitionKey: string | null
  readonly options: readonly FieldOption[]
  readonly rules: FieldRules
  readonly presentation: FieldPresentation
  readonly conditions: readonly FieldCondition[]
  /** Compiled once and anchored, so an unanchored pattern cannot half-match. */
  readonly compiledPattern: RegExp | null
}

export type FormStage = {
  readonly key: string
  readonly title: string
  readonly description: string | null
  readonly iconName: string | null
  readonly estimatedMinutes: number | null
  readonly position: number
}

/**
 * One cycle version's form, resolved and ready to use.
 *
 * Immutable by construction and produced only by `resolveFormTemplate`, so
 * every consumer — the validator, the writer, the change diff, the client's
 * renderer — is looking at the same thing. That is what makes "the validator
 * and the write agreed" a property rather than a hope.
 */
export type ResolvedFormTemplate = {
  readonly programmeCycleId: string
  readonly programmeCycleVersion: number
  readonly stages: readonly FormStage[]
  /** Template order: stage position, then field position, then key. */
  readonly fields: readonly FormField[]
  readonly byKey: ReadonlyMap<string, FormField>
  /** Keys an applicant may send: every non-FILE field that is not a group member. */
  readonly answerKeys: ReadonlySet<string>
  /** FILE fields, which carry evidence rather than an answer. */
  readonly documentFieldKeys: ReadonlySet<string>
  /** Role → field key, total: a cycle cannot open with a role unbound. */
  readonly roles: Readonly<Record<FormFieldRole, string>>
  /** Topological over the condition graph, so a controller is seen before it acts. */
  readonly evaluationOrder: readonly string[]
}

/**
 * What the policy rules read from the enterprise entity rather than an answer.
 * Lean by design: one fact today, and each addition should have a rule that
 * reads it.
 */
export type EnterpriseFacts = {
  readonly establishmentDate: string | null
}

/**
 * The cycle scalars that are programme policy rather than form structure.
 *
 * These are the three things a field bound cannot express, because their inputs
 * are the cycle's own rules and not anything an applicant answers: how old an
 * applicant may be, how long an enterprise may have traded and still count as
 * new, and the most one application may be awarded. Every one is nullable,
 * because a cycle in draft has not decided them yet and the schema says so.
 *
 * Document rules are deliberately absent. They used to live here as a list of
 * document types and conditions; a FILE field with an ordinary `REQUIRED_WHEN`
 * says the same thing against any question the cycle happens to ask, which is
 * strictly more expressive.
 */
export type CyclePolicy = {
  readonly minimumApplicantAge: number | null
  readonly maximumApplicantAge: number | null
  readonly categoryAMaximumMonths: number | null
  readonly majorityOwnershipRequired: boolean | null
  readonly fundingCeilingState: 'UNRESOLVED' | 'RESOLVED' | null
  readonly fundingCeilingAmountPaise: number | null
  readonly fundingCeilingScope:
    | 'APPLICATION'
    | 'PHASE'
    | 'ENTERPRISE'
    | 'FUNDING_CASE'
    | null
}

/** The rows `resolveFormTemplate` turns into the object above. */
export type FormTemplateRows = {
  readonly programmeCycleId: string
  readonly programmeCycleVersion: number
  readonly stages: readonly {
    stageKey: string
    title: string
    description: string | null
    /* Optional in rows — absent reads as none. `resolveFormTemplate` is the
       single door, and it fills the resolved shape's non-optional fields. */
    iconName?: string | null
    estimatedMinutes?: number | null
    sortOrder: number
  }[]
  readonly fields: readonly {
    stageKey: string
    fieldKey: string
    fieldType: FormFieldType
    role: FormFieldRole | null
    label: string
    helpText: string | null
    requirement: 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL'
    source: 'APPLICANT' | 'SERVER_DERIVED'
    sortOrder: number
    parentFieldKey: string | null
    groupDefinitionKey?: string | null
    repeatMin: number | null
    repeatMax: number | null
    minLength: number | null
    maxLength: number | null
    pattern: string | null
    patternMessage: string | null
    minValue: number | null
    maxValue: number | null
    minDate: string | null
    maxDate: string | null
    relativeDateBound: 'NOT_FUTURE' | 'NOT_PAST' | null
    maxFileBytes: number | null
    /* Presentation, optional in rows for the same reason as the stage's. */
    placeholder?: string | null
    note?: string | null
    tone?: FormFieldTone | null
    widthHint?: FormFieldWidth | null
    prefixText?: string | null
    suffixText?: string | null
    autocompleteHint?: FormFieldAutocompleteHint | null
    showCharCount?: boolean
    textareaRows?: number | null
    choiceStyle?: FormFieldChoiceStyle | null
  }[]
  readonly options: readonly {
    fieldKey: string
    optionValue: string
    optionLabel: string
    optionDescription?: string | null
    iconName?: string | null
    sortOrder: number
  }[]
  readonly conditions: readonly {
    fieldKey: string
    effect: FieldConditionEffect
    groupNumber: number
    sequenceNumber: number
    sourceFieldKey: string
    operator: FieldConditionOperator
    comparisonValue: string | null
  }[]
}
