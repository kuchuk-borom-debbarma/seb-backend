/**
 * The form a new cycle starts with.
 *
 * Mission SEP's own questions as the programme now asks them: the owners of
 * the enterprise (a reusable `OWNER` structure, used as a repeated group of up
 * to twenty), the project's cost and funding, previous support and credit, and
 * the evidence. The enterprise's own facts — name, sector, registration,
 * address, establishment date — are **not** asked here: they live on the
 * enterprise entity and are read from it, and the category is computed by the
 * server at submission from the establishment date.
 *
 * **This is a starting point, not a definition.** A cycle owns its questions
 * once it has them: it may add, remove, reword or reorder any of these, and an
 * application is judged against whatever its own cycle version froze.
 *
 * Two questions are **role-bound**: the requested amount (pinned to its key —
 * the queue and the decision bound read it across cycles) and the date of
 * birth inside the owners structure (any key — the age rule resolves it per
 * template and walks the group's entries).
 */
import type { ProgrammeCyclePolicyInput } from '#/graphql/generated/schema'

type Template = ProgrammeCyclePolicyInput['formTemplate']
type Field = Template['fields'][number]

const conditionalOn = (
  fieldKey: string,
  sourceFieldKey: string,
  sourceFieldType: Field['fieldType'],
  operator: Template['conditions'][number]['operator'],
  comparisonValue: string | null,
  { visible = true }: { visible?: boolean } = {},
): Template['conditions'] => [
  ...(visible
    ? [{
        fieldKey, effect: 'VISIBLE_WHEN' as const, sourceFieldKey,
        sourceFieldType, operator, comparisonValue,
      }]
    : []),
  {
    fieldKey, effect: 'REQUIRED_WHEN' as const, sourceFieldKey,
    sourceFieldType, operator, comparisonValue,
  },
]

export const defaultFormTemplate = (): Template => ({
  stages: [
    {
      stageKey: 'OWNERS', title: 'Owners',
      description: 'Everyone who owns the enterprise. Add each owner below.',
      iconName: 'users', estimatedMinutes: 5,
    },
    { stageKey: 'FINANCIAL', title: 'Funding requested' },
    { stageKey: 'PRIOR_FUNDING', title: 'Previous support' },
    { stageKey: 'DOCUMENTS', title: 'Documents' },
  ],
  /*
   * The owner, defined once and used by the OWNERS group below. Editing the
   * structure edits every entry's questions; the members expand under
   * qualified keys (`OWNERS__NAME`) the server derives.
   */
  groupDefinitions: [{
    definitionKey: 'OWNER',
    label: 'Owner',
    members: [
      {
        memberKey: 'NAME', fieldType: 'TEXT', label: 'Full name',
        requirement: 'REQUIRED', maxLength: 120, autocompleteHint: 'name',
      },
      {
        memberKey: 'DESIGNATION', fieldType: 'SINGLE_CHOICE',
        label: 'Role in the enterprise', requirement: 'REQUIRED',
        options: [
          { optionValue: 'PROPRIETOR', optionLabel: 'Proprietor' },
          { optionValue: 'MANAGING_PARTNER', optionLabel: 'Managing partner' },
          { optionValue: 'DIRECTOR', optionLabel: 'Director' },
          { optionValue: 'AUTHORIZED_SIGNATORY', optionLabel: 'Authorized signatory' },
        ],
      },
      {
        memberKey: 'DATE_OF_BIRTH', fieldType: 'DATE', label: 'Date of birth',
        requirement: 'REQUIRED', role: 'APPLICANT_DATE_OF_BIRTH',
        relativeDateBound: 'NOT_FUTURE',
      },
      {
        memberKey: 'GENDER', fieldType: 'SINGLE_CHOICE', label: 'Gender',
        requirement: 'REQUIRED',
        options: [
          { optionValue: 'MALE', optionLabel: 'Male' },
          { optionValue: 'FEMALE', optionLabel: 'Female' },
          { optionValue: 'OTHER', optionLabel: 'Other' },
        ],
      },
      {
        memberKey: 'RELATIONSHIP_TYPE', fieldType: 'SINGLE_CHOICE',
        label: 'Relationship', requirement: 'REQUIRED',
        options: [
          { optionValue: 'SON_OF', optionLabel: 'Son of' },
          { optionValue: 'DAUGHTER_OF', optionLabel: 'Daughter of' },
          { optionValue: 'WIFE_OF', optionLabel: 'Wife of' },
        ],
      },
      {
        memberKey: 'RELATED_PERSON_NAME', fieldType: 'TEXT', label: 'Of (name)',
        requirement: 'REQUIRED', maxLength: 120,
      },
    ],
  }],
  fields: [
    {
      stageKey: 'OWNERS', fieldKey: 'OWNERS', fieldType: 'REPEAT_GROUP',
      label: 'Owners', requirement: 'REQUIRED', repeatMin: 1, repeatMax: 20,
      groupDefinitionKey: 'OWNER',
    },

    // What the applicant asks for: a grant, a bank loan, or both — the form's
    // GRANT_OR_LOAN rule insists on at least one. Each amount hangs off its
    // own yes/no, so the grant role is required only where it is asked.
    {
      stageKey: 'FINANCIAL', fieldKey: 'WANTS_GRANT', fieldType: 'BOOLEAN',
      label: 'Do you want a grant?', requirement: 'REQUIRED',
    },
    {
      stageKey: 'FINANCIAL', fieldKey: 'SEED_FUND_REQUESTED_PAISE',
      fieldType: 'MONEY_PAISE', role: 'SEED_FUND_REQUESTED_PAISE',
      label: 'Desired grant amount', requirement: 'CONDITIONAL', minValue: '1',
      prefixText: '₹',
      helpText: 'The programme reads this amount when deciding how much grant '
        + 'can be approved, so ask for what the project genuinely needs.',
    },
    {
      stageKey: 'FINANCIAL', fieldKey: 'WANTS_BANK_LOAN', fieldType: 'BOOLEAN',
      label: 'Do you want a bank loan?', requirement: 'REQUIRED',
    },
    {
      stageKey: 'FINANCIAL', fieldKey: 'LOAN_BANK_FIRST_CHOICE',
      fieldType: 'SINGLE_CHOICE', label: 'First choice of bank',
      requirement: 'CONDITIONAL',
    },
    {
      stageKey: 'FINANCIAL', fieldKey: 'LOAN_BANK_SECOND_CHOICE',
      fieldType: 'SINGLE_CHOICE', label: 'Second choice of bank',
      requirement: 'OPTIONAL',
    },
    {
      stageKey: 'FINANCIAL', fieldKey: 'LOAN_AMOUNT_REQUESTED_PAISE',
      fieldType: 'MONEY_PAISE', role: 'LOAN_REQUESTED_PAISE',
      label: 'Loan amount requested', requirement: 'CONDITIONAL', minValue: '1',
      prefixText: '₹',
    },

    // Previous support — the stage whose questions hang off a yes/no.
    {
      stageKey: 'PRIOR_FUNDING', fieldKey: 'RECEIVED_GOVERNMENT_FUNDING',
      fieldType: 'BOOLEAN',
      label: 'Has this enterprise received government funding before?',
      requirement: 'REQUIRED',
    },
    {
      stageKey: 'PRIOR_FUNDING', fieldKey: 'GOVERNMENT_SCHEME_NAME',
      fieldType: 'TEXT', label: 'Scheme', requirement: 'CONDITIONAL',
      maxLength: 200,
    },
    {
      stageKey: 'PRIOR_FUNDING', fieldKey: 'GOVERNMENT_FUNDING_AMOUNT_PAISE',
      fieldType: 'MONEY_PAISE', label: 'Amount received',
      requirement: 'CONDITIONAL', minValue: '1', prefixText: '₹',
    },
    {
      stageKey: 'PRIOR_FUNDING', fieldKey: 'GOVERNMENT_FUNDING_SANCTION_YEAR',
      fieldType: 'INTEGER', label: 'Year sanctioned', requirement: 'CONDITIONAL',
      // Past sanctions only: the programme asked for years below 2026.
      minValue: '1900', maxValue: '2025', widthHint: 'CHAR_4',
    },
    // Evidence. Every document is a FILE question; which are required and when
    // is an ordinary condition.
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
     * Optional, no longer conditional: the questions these once followed —
     * the registration type and the GSTIN — live on the enterprise entity,
     * and a condition cannot read the entity.
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
  ],
  options: [
    { fieldKey: 'LOAN_BANK_FIRST_CHOICE', fieldType: 'SINGLE_CHOICE', optionValue: 'SBI', optionLabel: 'State Bank of India' },
    { fieldKey: 'LOAN_BANK_FIRST_CHOICE', fieldType: 'SINGLE_CHOICE', optionValue: 'TGB', optionLabel: 'Tripura Gramin Bank' },
    { fieldKey: 'LOAN_BANK_SECOND_CHOICE', fieldType: 'SINGLE_CHOICE', optionValue: 'SBI', optionLabel: 'State Bank of India' },
    { fieldKey: 'LOAN_BANK_SECOND_CHOICE', fieldType: 'SINGLE_CHOICE', optionValue: 'TGB', optionLabel: 'Tripura Gramin Bank' },
  ],
  conditions: [
    ...conditionalOn('NOC', 'NOC_REQUIRED', 'BOOLEAN', 'EQUALS', 'true', { visible: false }),
    ...conditionalOn('GOVERNMENT_SCHEME_NAME', 'RECEIVED_GOVERNMENT_FUNDING', 'BOOLEAN', 'EQUALS', 'true'),
    ...conditionalOn('GOVERNMENT_FUNDING_AMOUNT_PAISE', 'RECEIVED_GOVERNMENT_FUNDING', 'BOOLEAN', 'EQUALS', 'true'),
    ...conditionalOn('GOVERNMENT_FUNDING_SANCTION_YEAR', 'RECEIVED_GOVERNMENT_FUNDING', 'BOOLEAN', 'EQUALS', 'true'),
    ...conditionalOn('SEED_FUND_REQUESTED_PAISE', 'WANTS_GRANT', 'BOOLEAN', 'EQUALS', 'true'),
    ...conditionalOn('LOAN_BANK_FIRST_CHOICE', 'WANTS_BANK_LOAN', 'BOOLEAN', 'EQUALS', 'true'),
    ...conditionalOn('LOAN_AMOUNT_REQUESTED_PAISE', 'WANTS_BANK_LOAN', 'BOOLEAN', 'EQUALS', 'true'),
    // Asked with the loan, never required: a second choice is a preference.
    { fieldKey: 'LOAN_BANK_SECOND_CHOICE', effect: 'VISIBLE_WHEN', sourceFieldKey: 'WANTS_BANK_LOAN',
      sourceFieldType: 'BOOLEAN', operator: 'EQUALS', comparisonValue: 'true' },
  ],
  rules: [
    {
      ruleKey: 'GRANT_OR_LOAN', ruleType: 'AT_LEAST_ONE_TRUE', stageKey: 'FINANCIAL',
      message: 'Ask for a grant, a bank loan, or both.',
      operands: [
        { fieldKey: 'WANTS_GRANT', fieldType: 'BOOLEAN' },
        { fieldKey: 'WANTS_BANK_LOAN', fieldType: 'BOOLEAN' },
      ],
    },
    {
      ruleKey: 'DIFFERENT_BANKS', ruleType: 'DIFFERENT_VALUES', stageKey: 'FINANCIAL',
      message: 'Choose two different banks.',
      operands: [
        { fieldKey: 'LOAN_BANK_FIRST_CHOICE', fieldType: 'SINGLE_CHOICE' },
        { fieldKey: 'LOAN_BANK_SECOND_CHOICE', fieldType: 'SINGLE_CHOICE' },
      ],
    },
  ],
})
