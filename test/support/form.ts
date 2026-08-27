/**
 * The form a test cycle asks, and a complete set of answers to it.
 *
 * ## One fixture, not two
 *
 * There used to be two complete drafts — `completeDraft` in the application
 * suite and `completeSnapshot()` in the unit suite — and they had drifted into
 * describing the same applicant under different names, because each was
 * maintained separately. They differed *only* because the `Money` scalar
 * coerced strings to numbers, and with answers stored as rows there is no such
 * coercion left, so there is one fixture here and tests that need a different
 * form vary it.
 *
 * ## The labels are transcribed, not invented
 *
 * Every label below is the one the hand-built form used, character for
 * character. That is what makes the ~150 `getByLabel` calls in the end-to-end
 * suite a proof that the cutover preserved behaviour rather than a set of
 * assertions to rewrite — and it is why `{ exact: true }` matches still work.
 *
 * ## Two roles, bound
 *
 * A cycle cannot open with one unbound: the amount a decision is bounded by
 * and the age rule reach their input through a role. The requested amount is
 * pinned to its canonical key; the date of birth lives inside the owners
 * group under the key this fixture chose for it.
 *
 * ## No enterprise questions, no declaration
 *
 * The enterprise facts live on the enterprise entity and are read from there;
 * asking them again made two places the same fact lives. The declaration
 * stage is gone with them — the moment of submission is stamped by the server
 * (`declaration_accepted_at`), not ticked by a box.
 */
import type { FormTemplateInput } from '../../src/services/admin/types'
import type { FormTemplateRows } from '../../src/services/application/form/types'

type Field = FormTemplateInput['fields'][number]
type Option = FormTemplateInput['options'][number]

const choice = (fieldKey: string, values: readonly [string, string][]): Option[] =>
  values.map(([optionValue, optionLabel]) => ({
    fieldKey,
    fieldType: 'SINGLE_CHOICE' as const,
    optionValue,
    optionLabel,
  }))

/* One option carries the card affordances, so the whole chain — authoring,
   storage, copy-forward, resolve — moves them rather than only defaulting. */
const withCard = (options: Option[], value: string, description: string, icon: string) =>
  options.map((option) => option.optionValue === value
    ? { ...option, optionDescription: description, iconName: icon }
    : option)

const STAGES = [
  // The first stage carries the optional presentation columns, so the whole
  // chain — authoring, storage, copy-forward, resolve — is exercised by the
  // fixture rather than only by the tests that name them.
  {
    stageKey: 'OWNERS', title: 'Owners',
    description: 'Everyone who owns the enterprise. Add each owner below.',
    iconName: 'users', estimatedMinutes: 5,
  },
  { stageKey: 'FINANCIAL', title: 'Project cost and funding' },
  { stageKey: 'PRIOR_FUNDING', title: 'Previous support and credit' },
  { stageKey: 'DOCUMENTS', title: 'Evidence' },
]

const FIELDS: Field[] = [
  /*
   * The owners, as a repeated group: one entry per owner, up to twenty.
   *
   * This is the fixture's group — the suites that exercise entry bounds,
   * member requiredness and the per-entry age rule all drive it. The date of
   * birth member carries the role, which is the shape the age rule reads.
   */
  {
    stageKey: 'OWNERS', fieldKey: 'OWNERS', fieldType: 'REPEAT_GROUP',
    label: 'Owners', requirement: 'REQUIRED', repeatMin: 1, repeatMax: 20,
  },
  {
    stageKey: 'OWNERS', fieldKey: 'NAME', fieldType: 'TEXT',
    parentFieldKey: 'OWNERS', label: 'Full name', requirement: 'REQUIRED',
    // 120, not 200: twenty entries count against the answer byte budget.
    maxLength: 120, autocompleteHint: 'name',
  },
  {
    stageKey: 'OWNERS', fieldKey: 'DESIGNATION', fieldType: 'SINGLE_CHOICE',
    parentFieldKey: 'OWNERS', label: 'Role in the enterprise',
    requirement: 'REQUIRED',
  },
  {
    stageKey: 'OWNERS', fieldKey: 'DATE_OF_BIRTH', fieldType: 'DATE',
    parentFieldKey: 'OWNERS', role: 'APPLICANT_DATE_OF_BIRTH',
    label: 'Date of birth', requirement: 'REQUIRED',
    relativeDateBound: 'NOT_FUTURE',
  },
  {
    stageKey: 'OWNERS', fieldKey: 'GENDER', fieldType: 'SINGLE_CHOICE',
    parentFieldKey: 'OWNERS', label: 'Gender', requirement: 'REQUIRED',
  },
  {
    stageKey: 'OWNERS', fieldKey: 'RELATIONSHIP_TYPE', fieldType: 'SINGLE_CHOICE',
    parentFieldKey: 'OWNERS', label: 'Relationship', requirement: 'REQUIRED',
  },
  {
    stageKey: 'OWNERS', fieldKey: 'RELATED_PERSON_NAME', fieldType: 'TEXT',
    parentFieldKey: 'OWNERS', label: 'Of (name)', requirement: 'REQUIRED',
    maxLength: 120,
  },

  // What the project costs and who pays for it.
  {
    stageKey: 'FINANCIAL', fieldKey: 'TOTAL_PROJECT_COST_PAISE', fieldType: 'MONEY_PAISE',
    label: 'Total project cost', requirement: 'REQUIRED', minValue: 1,
    prefixText: '₹',
  },
  {
    stageKey: 'FINANCIAL', fieldKey: 'SEED_FUND_REQUESTED_PAISE', fieldType: 'MONEY_PAISE',
    role: 'SEED_FUND_REQUESTED_PAISE', label: 'Seed fund requested',
    requirement: 'REQUIRED', minValue: 1, prefixText: '₹',
  },
  {
    stageKey: 'FINANCIAL', fieldKey: 'BANK_LOAN_PROPOSED_PAISE', fieldType: 'MONEY_PAISE',
    label: 'Bank loan proposed', requirement: 'OPTIONAL', minValue: 0,
  },
  {
    stageKey: 'FINANCIAL', fieldKey: 'PROMOTER_CONTRIBUTION_PAISE', fieldType: 'MONEY_PAISE',
    label: 'Your own contribution', requirement: 'OPTIONAL', minValue: 0,
  },

  /*
   * Previous support and credit — the stage that exercises conditions.
   *
   * Three questions hang off one yes/no answer, which is the shape the old form
   * hard-coded and the reason `pruneHidden` runs to a fixed point.
   */
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'RECEIVED_GOVERNMENT_FUNDING', fieldType: 'BOOLEAN',
    label: 'Has this enterprise received government funding before?',
    requirement: 'REQUIRED',
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'GOVERNMENT_SCHEME_NAME', fieldType: 'TEXT',
    label: 'Scheme', requirement: 'CONDITIONAL', maxLength: 200,
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'GOVERNMENT_FUNDING_AMOUNT_PAISE',
    fieldType: 'MONEY_PAISE', label: 'Amount received', requirement: 'CONDITIONAL',
    minValue: 1,
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'GOVERNMENT_FUNDING_SANCTION_YEAR',
    fieldType: 'INTEGER', label: 'Year sanctioned', requirement: 'CONDITIONAL',
    // Past sanctions only: the programme asked for years below 2026.
    minValue: 1900, maxValue: 2025, widthHint: 'CHAR_4',
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'HAS_EXISTING_BANK_CREDIT', fieldType: 'BOOLEAN',
    label: 'Does this enterprise have existing bank credit?', requirement: 'REQUIRED',
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'EXISTING_BANK_NAME', fieldType: 'TEXT',
    label: 'Bank', requirement: 'CONDITIONAL', maxLength: 200,
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'EXISTING_CREDIT_AMOUNT_PAISE',
    fieldType: 'MONEY_PAISE', label: 'Amount outstanding', requirement: 'CONDITIONAL',
    minValue: 1,
  },
  {
    stageKey: 'PRIOR_FUNDING', fieldKey: 'EXISTING_CREDIT_STATUS', fieldType: 'SINGLE_CHOICE',
    label: 'Account status', requirement: 'CONDITIONAL',
  },

  // Evidence. Every document is a FILE question, so which are required and when
  // is an ordinary condition rather than four hard-coded ones.
  {
    stageKey: 'DOCUMENTS', fieldKey: 'NOC_REQUIRED', fieldType: 'BOOLEAN',
    label: 'Is a no-objection certificate needed for these premises?',
    requirement: 'REQUIRED',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'IDENTITY_AGE_PROOF', fieldType: 'FILE',
    label: 'Identity and age proof', requirement: 'REQUIRED',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'ST_CERTIFICATE', fieldType: 'FILE',
    label: 'Scheduled Tribe certificate', requirement: 'REQUIRED',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'ADDRESS_PROOF', fieldType: 'FILE',
    label: 'Address proof', requirement: 'REQUIRED',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'DPR', fieldType: 'FILE',
    label: 'Detailed project report', requirement: 'REQUIRED',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'BANK_DETAILS', fieldType: 'FILE',
    label: 'Bank account details', requirement: 'REQUIRED',
  },
  /*
   * Optional, no longer conditional: the questions these followed — the
   * registration type and the GSTIN — moved to the enterprise entity, and a
   * condition cannot read the entity. A stated capability loss: cycles that
   * want these documents enforced must ask their own question.
   */
  {
    stageKey: 'DOCUMENTS', fieldKey: 'BUSINESS_REGISTRATION', fieldType: 'FILE',
    label: 'Business registration', requirement: 'OPTIONAL',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'GST_REGISTRATION', fieldType: 'FILE',
    label: 'GST registration', requirement: 'OPTIONAL',
  },
  {
    stageKey: 'DOCUMENTS', fieldKey: 'NOC', fieldType: 'FILE',
    label: 'No-objection certificate', requirement: 'CONDITIONAL',
  },

]

const OPTIONS: Option[] = [
  ...withCard(choice('DESIGNATION', [
    ['PROPRIETOR', 'Proprietor'],
    ['MANAGING_PARTNER', 'Managing partner'],
    ['DIRECTOR', 'Director'],
    ['AUTHORIZED_SIGNATORY', 'Authorized signatory'],
  ]), 'PROPRIETOR', 'Owns and runs the enterprise themselves.', 'user-round'),
  ...choice('GENDER', [
    ['MALE', 'Male'],
    ['FEMALE', 'Female'],
    ['OTHER', 'Other'],
  ]),
  ...choice('EXISTING_CREDIT_STATUS', [
    ['STANDARD', 'Standard'],
    ['NPA', 'NPA'],
  ]),
  ...choice('RELATIONSHIP_TYPE', [
    ['SON_OF', 'Son of'],
    ['DAUGHTER_OF', 'Daughter of'],
    ['WIFE_OF', 'Wife of'],
  ]),
]

const CONDITIONS: FormTemplateInput['conditions'] = [
  // The certificate follows the answer that says it applies.
  {
    fieldKey: 'NOC', effect: 'REQUIRED_WHEN',
    sourceFieldKey: 'NOC_REQUIRED', sourceFieldType: 'BOOLEAN',
    operator: 'EQUALS', comparisonValue: 'true',
  },
  ...(
    [
      ['GOVERNMENT_SCHEME_NAME', 'RECEIVED_GOVERNMENT_FUNDING'],
      ['GOVERNMENT_FUNDING_AMOUNT_PAISE', 'RECEIVED_GOVERNMENT_FUNDING'],
      ['GOVERNMENT_FUNDING_SANCTION_YEAR', 'RECEIVED_GOVERNMENT_FUNDING'],
      ['EXISTING_BANK_NAME', 'HAS_EXISTING_BANK_CREDIT'],
      ['EXISTING_CREDIT_AMOUNT_PAISE', 'HAS_EXISTING_BANK_CREDIT'],
      ['EXISTING_CREDIT_STATUS', 'HAS_EXISTING_BANK_CREDIT'],
    ] as const
  ).flatMap(([fieldKey, sourceFieldKey]) => [
    {
      fieldKey, effect: 'VISIBLE_WHEN' as const, sourceFieldKey,
      sourceFieldType: 'BOOLEAN' as const, operator: 'EQUALS' as const,
      comparisonValue: 'true',
    },
    {
      fieldKey, effect: 'REQUIRED_WHEN' as const, sourceFieldKey,
      sourceFieldType: 'BOOLEAN' as const, operator: 'EQUALS' as const,
      comparisonValue: 'true',
    },
  ]),
]

/**
 * The default form, and the one door to varying it.
 *
 * `vary` and `withoutField` are how a test asks a different question rather
 * than declaring a second template — two templates maintained separately is
 * exactly what this replaced.
 */
export const defaultTemplate = (
  vary: (template: FormTemplateInput) => FormTemplateInput = (each) => each,
): FormTemplateInput =>
  vary({
    stages: STAGES.map((stage) => ({ ...stage })),
    fields: FIELDS.map((field) => ({ ...field })),
    options: OPTIONS.map((option) => ({ ...option })),
    conditions: CONDITIONS.map((condition) => ({ ...condition })),
  })

export const withoutField = (fieldKey: string) => (template: FormTemplateInput) => ({
  ...template,
  fields: template.fields.filter((field) => field.fieldKey !== fieldKey),
  options: template.options.filter((option) => option.fieldKey !== fieldKey),
  conditions: template.conditions.filter(
    (condition) =>
      condition.fieldKey !== fieldKey && condition.sourceFieldKey !== fieldKey,
  ),
})

/**
 * A complete, valid answer to `defaultTemplate()`.
 *
 * The same applicant the two old fixtures described, reconciled. Every
 * conditional question is answered "no", so the hidden ones are absent — which
 * is what a real complete draft looks like and what `pruneHidden` produces.
 */
export const completeAnswers = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  OWNERS: [{
    NAME: 'Rina Debbarma',
    DESIGNATION: 'PROPRIETOR',
    DATE_OF_BIRTH: '1995-02-10',
    GENDER: 'FEMALE',
    RELATIONSHIP_TYPE: 'DAUGHTER_OF',
    RELATED_PERSON_NAME: 'Maya Debbarma',
  }],

  TOTAL_PROJECT_COST_PAISE: 50_000_000,
  SEED_FUND_REQUESTED_PAISE: 10_000_000,
  BANK_LOAN_PROPOSED_PAISE: 0,
  PROMOTER_CONTRIBUTION_PAISE: 1_000_000,

  RECEIVED_GOVERNMENT_FUNDING: false,
  GOVERNMENT_SCHEME_NAME: null,
  GOVERNMENT_FUNDING_AMOUNT_PAISE: null,
  GOVERNMENT_FUNDING_SANCTION_YEAR: null,
  HAS_EXISTING_BANK_CREDIT: false,
  EXISTING_BANK_NAME: null,
  EXISTING_CREDIT_AMOUNT_PAISE: null,
  EXISTING_CREDIT_STATUS: null,

  NOC_REQUIRED: false,

  ...overrides,
})

/** The documents `completeAnswers()` makes required, for a fixture to attach. */
export const requiredDocuments = [
  'IDENTITY_AGE_PROOF',
  'ST_CERTIFICATE',
  'ADDRESS_PROOF',
  'DPR',
  'BANK_DETAILS',
] as const

/**
 * An authoring input as the cycle write stores it.
 *
 * The template on the wire and the template in the database are different
 * shapes — the second carries the cycle pin and fills every optional column.
 * Anything that wants to *resolve* a fixture template has to cross that gap,
 * and it crossed it in two places before this existed.
 */
export const templateRowsFor = (template: FormTemplateInput): FormTemplateRows => {
  return {
    programmeCycleId: 'c1',
    programmeCycleVersion: 1,
    stages: template.stages.map((stage, index) => ({
      stageKey: stage.stageKey,
      title: stage.title,
      description: stage.description ?? null,
      iconName: stage.iconName ?? null,
      estimatedMinutes: stage.estimatedMinutes ?? null,
      sortOrder: index + 1,
    })),
    fields: template.fields.map((field, index) => ({
      stageKey: field.stageKey,
      fieldKey: field.fieldKey,
      fieldType: field.fieldType,
      role: field.role ?? null,
      label: field.label,
      helpText: field.helpText ?? null,
      requirement: field.requirement,
      source: field.source ?? 'APPLICANT',
      sortOrder: field.sortOrder ?? index + 1,
      parentFieldKey: field.parentFieldKey ?? null,
      repeatMin: field.repeatMin ?? null,
      repeatMax: field.repeatMax ?? null,
      minLength: field.minLength ?? null,
      maxLength: field.maxLength ?? null,
      pattern: field.pattern ?? null,
      patternMessage: field.patternMessage ?? null,
      minValue: field.minValue ?? null,
      maxValue: field.maxValue ?? null,
      minDate: field.minDate ?? null,
      maxDate: field.maxDate ?? null,
      relativeDateBound: field.relativeDateBound ?? null,
      maxFileBytes: field.maxFileBytes ?? null,
      placeholder: field.placeholder ?? null,
      note: field.note ?? null,
      tone: field.tone ?? null,
      widthHint: field.widthHint ?? null,
      prefixText: field.prefixText ?? null,
      suffixText: field.suffixText ?? null,
      autocompleteHint: field.autocompleteHint ?? null,
      showCharCount: field.showCharCount ?? false,
      textareaRows: field.textareaRows ?? null,
      choiceStyle: field.choiceStyle ?? null,
    })),
    options: template.options.map((option, index) => ({
      fieldKey: option.fieldKey,
      optionValue: option.optionValue,
      optionLabel: option.optionLabel,
      optionDescription: option.optionDescription ?? null,
      iconName: option.iconName ?? null,
      sortOrder: option.sortOrder ?? index + 1,
    })),
    conditions: template.conditions.map((condition, index) => ({
      fieldKey: condition.fieldKey,
      effect: condition.effect,
      groupNumber: condition.groupNumber ?? 1,
      sequenceNumber: condition.sequenceNumber ?? index + 1,
      sourceFieldKey: condition.sourceFieldKey,
      operator: condition.operator,
      comparisonValue: condition.comparisonValue ?? null,
    })),
  }
}
