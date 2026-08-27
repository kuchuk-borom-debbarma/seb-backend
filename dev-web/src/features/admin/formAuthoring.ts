/**
 * The pure half of the form-authoring screen.
 *
 * The API returns the template **expanded**: a structure's members appear as
 * ordinary questions under derived keys (`OWNERS__NAME`), because that is what
 * an applicant is asked. The editor works the other way around — it edits the
 * authoring form — so everything here exists to translate between the two:
 * recognising which questions are derived, rebuilding the authoring template
 * for `replace` and `updateDraft`, and building the per-question inputs the
 * narrower mutations take.
 *
 * It also mirrors the server's own presentation matrix. The server refuses an
 * attribute on a type that cannot carry it with an exact sentence; the editor
 * shows only the attributes the chosen type accepts, so most of those refusals
 * never fire. The sets below are copied from
 * `src/services/admin/form-template-input.ts` and the schema CHECKs — if they
 * drift, the server's sentence still arrives and is shown verbatim.
 */
import type {
  CycleAuthoringFieldsFragment,
  GroupDefinitionFieldsFragment,
} from '#/graphql/generated/operations'
import type {
  FieldConditionEffect,
  FieldConditionOperator,
  FormFieldConditionInput,
  FormFieldInput,
  FormFieldOptionInput,
  FormFieldRequirement,
  FormFieldType,
  FormGroupDefinitionInput,
  FormGroupDefinitionMemberInput,
  FormQuestionConditionInput,
  FormQuestionOptionInput,
  FormStageInput,
  FormTemplateInput,
} from '#/graphql/generated/schema'

export type AuthoringCycle = CycleAuthoringFieldsFragment
export type TemplateView = NonNullable<AuthoringCycle['formTemplate']>
export type StageView = TemplateView['stages'][number]
export type FieldView = TemplateView['fields'][number]
export type DefinitionView = GroupDefinitionFieldsFragment
export type MemberView = DefinitionView['members'][number]

/** `SCREAMING_SNAKE_CASE`, as the server's `TEMPLATE_KEY_PATTERN` has it. */
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u

export const FIELD_TYPES: FormFieldType[] = [
  'TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  'INTEGER',
  'MONEY_PAISE',
  'BOOLEAN',
  'ATTESTATION',
  'STATEMENT',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'FILE',
  'REPEAT_GROUP',
]

/** A structure member may not be a group, a document, or a statement. */
export const MEMBER_TYPES: FormFieldType[] = FIELD_TYPES.filter(
  (type) => type !== 'REPEAT_GROUP' && type !== 'FILE' && type !== 'STATEMENT',
)

/* Which attributes each type can carry — the server's matrix, mirrored. */
export const LENGTH_TYPES = new Set<FormFieldType>([
  'TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
])
export const NUMBER_TYPES = new Set<FormFieldType>(['INTEGER', 'MONEY_PAISE'])
export const DATE_TYPES = new Set<FormFieldType>(['DATE'])
export const CHOICE_TYPES = new Set<FormFieldType>(['SINGLE_CHOICE', 'MULTI_CHOICE'])
export const PLACEHOLDER_TYPES = new Set<FormFieldType>([
  'TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  'INTEGER',
  'MONEY_PAISE',
])
export const AFFIX_TYPES = new Set<FormFieldType>(['TEXT', 'INTEGER', 'MONEY_PAISE'])
export const AUTOCOMPLETE_TYPES = new Set<FormFieldType>([
  'TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  'INTEGER',
])
export const CHAR_COUNT_TYPES = new Set<FormFieldType>(['TEXT', 'LONG_TEXT'])

export const TONES = ['INFO', 'WARNING', 'SUCCESS', 'DANGER'] as const
export const WIDTH_HINTS = [
  'FULL',
  'TWO_THIRDS',
  'ONE_HALF',
  'ONE_THIRD',
  'CHAR_2',
  'CHAR_4',
  'CHAR_10',
  'CHAR_20',
] as const
/** The closed autofill token set the API recognises (WCAG 1.3.5). */
export const AUTOCOMPLETE_HINTS = [
  'name',
  'given-name',
  'family-name',
  'email',
  'tel',
  'postal-code',
  'street-address',
  'address-line1',
  'address-line2',
  'address-level1',
  'address-level2',
  'bday',
  'organization',
  'off',
] as const
export const SINGLE_CHOICE_STYLES = ['RADIO', 'DROPDOWN', 'SEGMENTED', 'CARD'] as const
export const MULTI_CHOICE_STYLES = ['CHECKBOX_LIST', 'MULTISELECT'] as const

export const CONDITION_EFFECTS: FieldConditionEffect[] = ['VISIBLE_WHEN', 'REQUIRED_WHEN']
export const CONDITION_OPERATORS: FieldConditionOperator[] = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_OR_EQUAL',
  'LESS_THAN',
  'LESS_OR_EQUAL',
  'IS_PRESENT',
  'IS_ABSENT',
]
/** These compare against nothing, so the value input disappears. */
export const VALUELESS_OPERATORS = new Set<FieldConditionOperator>([
  'IS_PRESENT',
  'IS_ABSENT',
])

/** The server's stale-version refusal, quoted so the screen can offer a reload. */
export const STALE_MESSAGE = 'The record changed. Reload and try again.'

/**
 * Which structure a repeated group expands from — the field's own stored
 * provenance, never inferred. Inference from member names was tried and can
 * rebind a group to the wrong structure when one definition's members are a
 * subset of another's; the server exposes the stored key precisely so this
 * module never has to guess.
 */
export const structureKeyOf = (
  groupKey: string,
  template: TemplateView,
  _definitions: readonly DefinitionView[],
): string | null =>
  template.fields.find((field) => field.key === groupKey)?.groupDefinitionKey ?? null

/**
 * A question the officer did not write: it was materialised from a structure
 * and will be rebuilt from the definition on the next write, so editing it
 * individually would only be overwritten.
 */
export const isDerivedMember = (
  field: FieldView,
  template: TemplateView,
  definitions: readonly DefinitionView[],
): boolean =>
  field.repeatGroupKey !== null &&
  structureKeyOf(field.repeatGroupKey, template, definitions) !== null

const text = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** One expanded question, back in the shape the mutations accept. */
export const toFieldInput = (
  field: FieldView,
  template: TemplateView,
  definitions: readonly DefinitionView[],
): FormFieldInput => ({
  stageKey: field.stageKey,
  fieldKey: field.key,
  fieldType: field.type,
  role: field.role,
  label: field.label,
  helpText: field.helpText,
  requirement: field.requirement,
  source: field.source,
  // sortOrder deliberately omitted: the write keeps an existing question's
  // place and appends a new one after its stage, which is exactly the
  // behaviour the editor wants — and per-stage renumbering here could collide
  // with a neighbour's stored number.
  parentFieldKey: field.repeatGroupKey,
  groupDefinitionKey:
    field.type === 'REPEAT_GROUP'
      ? structureKeyOf(field.key, template, definitions)
      : null,
  repeatMin: field.validation.minRepeat,
  repeatMax: field.validation.maxRepeat,
  minLength: field.validation.minLength,
  maxLength: field.validation.maxLength,
  pattern: field.validation.pattern,
  patternMessage: field.validation.patternMessage,
  minValue: field.validation.minValue,
  maxValue: field.validation.maxValue,
  minDate: field.validation.minDate,
  maxDate: field.validation.maxDate,
  relativeDateBound: field.validation.relativeDateBound,
  maxFileBytes: field.validation.maxFileBytes,
  placeholder: field.presentation.placeholder,
  note: field.presentation.note,
  tone: field.presentation.tone,
  widthHint: field.presentation.widthHint,
  prefixText: field.presentation.prefixText,
  suffixText: field.presentation.suffixText,
  autocompleteHint: field.presentation.autocompleteHint,
  showCharCount: field.presentation.showCharCount,
  textareaRows: field.presentation.textareaRows,
  choiceStyle: field.presentation.choiceStyle,
})

export const toQuestionOptions = (field: FieldView): FormQuestionOptionInput[] =>
  field.options.map((option) => ({
    optionValue: option.value,
    optionLabel: option.label,
    optionDescription: option.description,
    iconName: option.iconName,
    sortOrder: option.position,
  }))

export const toQuestionConditions = (
  field: FieldView,
  template: TemplateView,
): FormQuestionConditionInput[] =>
  field.conditions.flatMap((condition) => {
    // The read model omits the source's type; the mutation input demands it so
    // a single-row CHECK can refuse an ordering comparison against a type that
    // has no order. It is recovered from the question the rule reads.
    const source = template.fields.find((each) => each.key === condition.sourceFieldKey)
    if (!source) return []
    return [
      {
        effect: condition.effect,
        groupNumber: condition.groupNumber,
        sequenceNumber: condition.sequenceNumber,
        sourceFieldKey: condition.sourceFieldKey,
        sourceFieldType: source.type,
        operator: condition.operator,
        comparisonValue: condition.comparisonValue,
      },
    ]
  })

/** One structure, back in the shape `putGroupDefinition` accepts. */
export const toDefinitionInput = (
  definition: DefinitionView,
): FormGroupDefinitionInput => ({
  definitionKey: definition.definitionKey,
  label: definition.label,
  members: definition.members.map((member) => ({
    memberKey: member.memberKey,
    fieldType: member.fieldType,
    role: member.role,
    label: member.label,
    helpText: member.helpText,
    requirement: member.requirement,
    minLength: member.minLength,
    maxLength: member.maxLength,
    pattern: member.pattern,
    patternMessage: member.patternMessage,
    minValue: member.minValue,
    maxValue: member.maxValue,
    minDate: member.minDate,
    maxDate: member.maxDate,
    relativeDateBound: member.relativeDateBound,
    placeholder: member.placeholder,
    note: member.note,
    tone: member.tone,
    widthHint: member.widthHint,
    prefixText: member.prefixText,
    suffixText: member.suffixText,
    autocompleteHint: member.autocompleteHint,
    showCharCount: member.showCharCount,
    textareaRows: member.textareaRows,
    choiceStyle: member.choiceStyle,
    options: member.options.map((option) => ({
      optionValue: option.optionValue,
      optionLabel: option.optionLabel,
      optionDescription: option.optionDescription,
      iconName: option.iconName,
    })),
  })),
})

/**
 * The whole authoring template, rebuilt from the expanded read.
 *
 * Derived members are stripped — they are the expansion's output, and sending
 * them back would collide with the expansion the write performs — and every
 * `sortOrder` is omitted so array order (which the read guarantees) is the
 * order, exactly as the create path does it.
 *
 * Used by the two writes that must carry the whole form: `replace` (the only
 * mutation whose stage input can carry an icon or a time estimate) and
 * `updateDraft` (whose policy replaces everything, template included).
 */
export const toTemplateInput = (
  template: TemplateView,
  definitions: readonly DefinitionView[],
): FormTemplateInput => {
  const kept = template.fields.filter(
    (field) => !isDerivedMember(field, template, definitions),
  )
  return {
    stages: template.stages.map((stage): FormStageInput => ({
      stageKey: stage.key,
      title: stage.title,
      description: stage.description,
      iconName: stage.iconName,
      estimatedMinutes: stage.estimatedMinutes,
    })),
    fields: kept.map((field) => toFieldInput(field, template, definitions)),
    options: kept.flatMap((field): FormFieldOptionInput[] =>
      field.options.map((option) => ({
        fieldKey: field.key,
        fieldType: field.type,
        optionValue: option.value,
        optionLabel: option.label,
        optionDescription: option.description,
        iconName: option.iconName,
      })),
    ),
    conditions: kept.flatMap((field): FormFieldConditionInput[] =>
      toQuestionConditions(field, template).map((condition) => ({
        ...condition,
        fieldKey: field.key,
      })),
    ),
    groupDefinitions: definitions.map(toDefinitionInput),
  }
}

/* ------------------------------------------------------------------------- *
 * The editor's working copy of one question or one structure member.
 *
 * Numbers are held as strings because they live in inputs; conversion happens
 * once, on save, and only the attributes the chosen type accepts are sent —
 * switching a question from LONG_TEXT to DATE must not smuggle its old
 * `textareaRows` into a payload the server would refuse.
 * ------------------------------------------------------------------------- */

export type OptionDraft = {
  value: string
  label: string
  description: string
  iconName: string
}

export type ConditionDraft = {
  effect: FieldConditionEffect
  sourceFieldKey: string
  operator: FieldConditionOperator
  comparisonValue: string
}

export type AttributeDraft = {
  key: string
  fieldType: FormFieldType
  label: string
  helpText: string
  requirement: FormFieldRequirement
  role: string
  placeholder: string
  note: string
  tone: string
  widthHint: string
  prefixText: string
  suffixText: string
  autocompleteHint: string
  showCharCount: boolean
  textareaRows: string
  choiceStyle: string
  minLength: string
  maxLength: string
  pattern: string
  patternMessage: string
  minValue: string
  maxValue: string
  minDate: string
  maxDate: string
  relativeDateBound: string
  maxFileBytes: string
  repeatMin: string
  repeatMax: string
  groupDefinitionKey: string
  options: OptionDraft[]
  conditions: ConditionDraft[]
}

export const blankDraft = (fieldType: FormFieldType = 'TEXT'): AttributeDraft => ({
  key: '',
  fieldType,
  label: '',
  helpText: '',
  requirement: fieldType === 'STATEMENT' ? 'OPTIONAL' : 'REQUIRED',
  role: '',
  placeholder: '',
  note: '',
  tone: '',
  widthHint: '',
  prefixText: '',
  suffixText: '',
  autocompleteHint: '',
  showCharCount: false,
  textareaRows: '',
  choiceStyle: '',
  minLength: '',
  maxLength: '',
  pattern: '',
  patternMessage: '',
  minValue: '',
  maxValue: '',
  minDate: '',
  maxDate: '',
  relativeDateBound: '',
  maxFileBytes: '',
  repeatMin: '1',
  repeatMax: '10',
  groupDefinitionKey: '',
  options: [],
  conditions: [],
})

const asString = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? '' : String(value)

export const draftFromField = (
  field: FieldView,
  template: TemplateView,
  definitions: readonly DefinitionView[],
): AttributeDraft => ({
  key: field.key,
  fieldType: field.type,
  label: field.label,
  helpText: field.helpText ?? '',
  requirement: field.requirement,
  role: field.role ?? '',
  placeholder: field.presentation.placeholder ?? '',
  note: field.presentation.note ?? '',
  tone: field.presentation.tone ?? '',
  widthHint: field.presentation.widthHint ?? '',
  prefixText: field.presentation.prefixText ?? '',
  suffixText: field.presentation.suffixText ?? '',
  autocompleteHint: field.presentation.autocompleteHint ?? '',
  showCharCount: field.presentation.showCharCount,
  textareaRows: asString(field.presentation.textareaRows),
  choiceStyle: field.presentation.choiceStyle ?? '',
  minLength: asString(field.validation.minLength),
  maxLength: asString(field.validation.maxLength),
  pattern: field.validation.pattern ?? '',
  patternMessage: field.validation.patternMessage ?? '',
  minValue: field.validation.minValue ?? '',
  maxValue: field.validation.maxValue ?? '',
  minDate: field.validation.minDate ?? '',
  maxDate: field.validation.maxDate ?? '',
  relativeDateBound: field.validation.relativeDateBound ?? '',
  maxFileBytes: asString(field.validation.maxFileBytes),
  repeatMin: asString(field.validation.minRepeat ?? 1),
  repeatMax: asString(field.validation.maxRepeat ?? 10),
  groupDefinitionKey:
    field.type === 'REPEAT_GROUP'
      ? (structureKeyOf(field.key, template, definitions) ?? '')
      : '',
  options: field.options.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description ?? '',
    iconName: option.iconName ?? '',
  })),
  conditions: field.conditions.map((condition) => ({
    effect: condition.effect,
    sourceFieldKey: condition.sourceFieldKey,
    operator: condition.operator,
    comparisonValue: condition.comparisonValue ?? '',
  })),
})

export const draftFromMember = (member: MemberView): AttributeDraft => ({
  ...blankDraft(member.fieldType),
  key: member.memberKey,
  label: member.label,
  helpText: member.helpText ?? '',
  requirement: member.requirement,
  role: member.role ?? '',
  placeholder: member.placeholder ?? '',
  note: member.note ?? '',
  tone: member.tone ?? '',
  widthHint: member.widthHint ?? '',
  prefixText: member.prefixText ?? '',
  suffixText: member.suffixText ?? '',
  autocompleteHint: member.autocompleteHint ?? '',
  showCharCount: member.showCharCount,
  textareaRows: asString(member.textareaRows),
  choiceStyle: member.choiceStyle ?? '',
  minLength: asString(member.minLength),
  maxLength: asString(member.maxLength),
  pattern: member.pattern ?? '',
  patternMessage: member.patternMessage ?? '',
  minValue: member.minValue ?? '',
  maxValue: member.maxValue ?? '',
  minDate: member.minDate ?? '',
  maxDate: member.maxDate ?? '',
  relativeDateBound: member.relativeDateBound ?? '',
  options: member.options.map((option) => ({
    value: option.optionValue,
    label: option.optionLabel,
    description: option.optionDescription ?? '',
    iconName: option.iconName ?? '',
  })),
})

const asInt = (value: string): number | null => {
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Only what the chosen type accepts, converted once.
 *
 * The pruning is not cosmetic: the server refuses (say) a placeholder on a
 * BOOLEAN, and a draft that used to be TEXT still remembers one.
 */
const prunedShared = (draft: AttributeDraft) => {
  const type = draft.fieldType
  return {
    label: draft.label.trim(),
    helpText: text(draft.helpText),
    requirement: type === 'STATEMENT' ? ('OPTIONAL' as const) : draft.requirement,
    role: text(draft.role),
    minLength: LENGTH_TYPES.has(type) ? asInt(draft.minLength) : null,
    maxLength: LENGTH_TYPES.has(type) ? asInt(draft.maxLength) : null,
    pattern: LENGTH_TYPES.has(type) ? text(draft.pattern) : null,
    patternMessage: LENGTH_TYPES.has(type) ? text(draft.patternMessage) : null,
    minValue: NUMBER_TYPES.has(type) ? text(draft.minValue) : null,
    maxValue: NUMBER_TYPES.has(type) ? text(draft.maxValue) : null,
    minDate: DATE_TYPES.has(type) ? text(draft.minDate) : null,
    maxDate: DATE_TYPES.has(type) ? text(draft.maxDate) : null,
    relativeDateBound: DATE_TYPES.has(type) ? text(draft.relativeDateBound) : null,
    placeholder: PLACEHOLDER_TYPES.has(type) ? text(draft.placeholder) : null,
    note: text(draft.note),
    tone: text(draft.note) ? text(draft.tone) : null,
    widthHint: text(draft.widthHint),
    prefixText: AFFIX_TYPES.has(type) ? text(draft.prefixText) : null,
    suffixText: AFFIX_TYPES.has(type) ? text(draft.suffixText) : null,
    autocompleteHint: AUTOCOMPLETE_TYPES.has(type) ? text(draft.autocompleteHint) : null,
    showCharCount: CHAR_COUNT_TYPES.has(type) && draft.showCharCount,
    textareaRows: type === 'LONG_TEXT' ? asInt(draft.textareaRows) : null,
    choiceStyle: CHOICE_TYPES.has(type) ? text(draft.choiceStyle) : null,
  }
}

export const fieldInputFromDraft = (
  draft: AttributeDraft,
  place: { stageKey: string; parentFieldKey: string | null },
): FormFieldInput => ({
  stageKey: place.stageKey,
  parentFieldKey: place.parentFieldKey,
  fieldKey: draft.key.trim(),
  fieldType: draft.fieldType,
  source: 'APPLICANT',
  ...prunedShared(draft),
  maxFileBytes: draft.fieldType === 'FILE' ? asInt(draft.maxFileBytes) : null,
  repeatMin: draft.fieldType === 'REPEAT_GROUP' ? asInt(draft.repeatMin) : null,
  repeatMax: draft.fieldType === 'REPEAT_GROUP' ? asInt(draft.repeatMax) : null,
  groupDefinitionKey:
    draft.fieldType === 'REPEAT_GROUP' ? text(draft.groupDefinitionKey) : null,
})

export const memberInputFromDraft = (
  draft: AttributeDraft,
): FormGroupDefinitionMemberInput => ({
  memberKey: draft.key.trim(),
  fieldType: draft.fieldType,
  ...prunedShared(draft),
  options: CHOICE_TYPES.has(draft.fieldType)
    ? draft.options.map((option) => ({
        optionValue: option.value.trim(),
        optionLabel: option.label.trim(),
        optionDescription: text(option.description),
        iconName: text(option.iconName),
      }))
    : null,
})

export const questionOptionsFromDraft = (
  draft: AttributeDraft,
): FormQuestionOptionInput[] | null =>
  CHOICE_TYPES.has(draft.fieldType)
    ? draft.options.map((option) => ({
        optionValue: option.value.trim(),
        optionLabel: option.label.trim(),
        optionDescription: text(option.description),
        iconName: text(option.iconName),
      }))
    : null

export const questionConditionsFromDraft = (
  draft: AttributeDraft,
  template: TemplateView,
): FormQuestionConditionInput[] =>
  draft.conditions.flatMap((condition) => {
    const source = template.fields.find((each) => each.key === condition.sourceFieldKey)
    if (!source) return []
    return [
      {
        effect: condition.effect,
        sourceFieldKey: condition.sourceFieldKey,
        sourceFieldType: source.type,
        operator: condition.operator,
        comparisonValue: VALUELESS_OPERATORS.has(condition.operator)
          ? null
          : text(condition.comparisonValue),
      },
    ]
  })
