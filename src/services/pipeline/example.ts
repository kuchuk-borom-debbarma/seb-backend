/**
 * The Mission SEP pipeline, as a worked example: TTC checks the file, Industries
 * & Commerce approves the grant and chooses the bank, and the chosen bank —
 * State Bank of India or Tripura Gramin Bank — fulfils the loan.
 *
 * One definition, used three ways: the pipeline editor offers it as a starting
 * point (through `admin.pipeline.catalogue`), the service tests run a file
 * through it end to end, and `docs/pipeline-guide.md` walks through it. It is
 * data like any other pipeline — nothing in the engine knows its stage names —
 * and `workflow-catalogue.test.ts` proves it passes `pipelineProblems` and pins
 * cleanly to the default form.
 *
 * It reads five answers from the default form: `WANTS_GRANT`,
 * `SEED_FUND_REQUESTED_PAISE`, `WANTS_BANK_LOAN`, `LOAN_BANK_FIRST_CHOICE` and
 * `LOAN_AMOUNT_REQUESTED_PAISE`.
 */
import type { PipelineDefinition } from './definition'

const note = {
  key: 'NOTE',
  type: 'LONG_TEXT' as const,
  label: 'Note for the previous stage',
  helpText: 'Say what needs another look. Only the office sees this.',
  requirement: 'REQUIRED' as const,
  minLength: null,
  maxLength: 2000,
  minValue: null,
  maxValue: null,
  minDate: null,
  maxDate: null,
  relativeDateBound: null,
  options: [],
  visibleWhen: [],
  defaultFrom: null,
}

const sendBack = {
  key: 'SEND_BACK',
  label: 'Send back with a note',
  description: 'Returns the application to the stage it came from.',
  confirmation: null,
  inputs: [note],
  availableWhen: [],
  effects: [
    { type: 'RETURN_TO_PREVIOUS' as const, params: {}, when: [] },
    { type: 'ADD_INTERNAL_NOTE' as const, params: { input: 'NOTE' }, when: [] },
  ],
}

const answer = (key: string, answerType: 'BOOLEAN', value: string, group = 1) => ({
  group,
  source: 'ANSWER' as const,
  key,
  operator: 'EQUALS' as const,
  value,
  answerType,
})

const money = (key: string, label: string, defaultFrom: string) => ({
  key,
  type: 'MONEY_PAISE' as const,
  label,
  helpText: null,
  requirement: 'REQUIRED' as const,
  minLength: null,
  maxLength: null,
  minValue: 1,
  maxValue: null,
  minDate: null,
  maxDate: null,
  relativeDateBound: null,
  options: [],
  visibleWhen: [],
  defaultFrom: { source: 'ANSWER' as const, key: defaultFrom },
})

const finish = [
  { type: 'REMOVE_STATUS' as const, params: { flag: 'IN_REVIEW' }, when: [] },
  {
    type: 'NOTIFY_APPLICANT' as const,
    params: { message: 'Your application has been completed. See its page for the outcome.', email: true },
    when: [],
  },
]

const bankStage = (key: 'SBI_BANK' | 'TGB_BANK', name: string) => ({
  key,
  name,
  description: `Where ${name} considers the loan.`,
  applicantLabel: `With ${name}`,
  applicantExplanation: `${name} is considering your loan. They may contact you directly.`,
  presenceFlags: ['BANKING_STAGE'],
  actions: [
    sendBack,
    {
      key: 'FULFIL_LOAN',
      label: 'Mark the loan fulfilled',
      description: 'Records the loan the bank sanctioned and completes the application.',
      confirmation: 'This completes the application. It cannot be undone.',
      inputs: [
        money('AMOUNT', 'Loan sanctioned', 'LOAN_AMOUNT_REQUESTED_PAISE'),
        {
          ...note,
          key: 'REFERENCE',
          type: 'TEXT' as const,
          label: 'Bank sanction reference',
          helpText: null,
          maxLength: 60,
        },
        {
          ...note,
          key: 'SANCTION_DATE',
          type: 'DATE' as const,
          label: 'Date the bank sanctioned it',
          helpText: null,
          maxLength: null,
          relativeDateBound: 'NOT_FUTURE' as const,
        },
      ],
      availableWhen: [],
      effects: [
        { type: 'ADD_STATUS' as const, params: { flag: 'LOAN_APPROVED' }, when: [] },
        {
          type: 'SET_RECORDED_VALUE' as const,
          params: { input: 'AMOUNT', target: 'FULFILLED_LOAN_PAISE', atMostAnswer: 'LOAN_AMOUNT_REQUESTED_PAISE' },
          when: [],
        },
        { type: 'SET_RECORDED_VALUE' as const, params: { input: 'REFERENCE', target: 'LOAN_REFERENCE' }, when: [] },
        { type: 'SET_RECORDED_VALUE' as const, params: { input: 'SANCTION_DATE', target: 'LOAN_SANCTIONED_ON' }, when: [] },
        { type: 'COMPLETE_PIPELINE' as const, params: { flag: 'COMPLETED' }, when: [] },
        ...finish,
      ],
    },
  ],
})

export const examplePipeline: PipelineDefinition = {
  schema: 1,
  initialStageKey: 'TTC',
  onSubmit: { addFlags: ['IN_REVIEW'] },
  statusFlags: [
    { key: 'IN_REVIEW', label: 'In review', applicantLabel: 'Being reviewed', explanation: 'The programme office is working through your application.', applicantVisible: true, kind: 'PROGRESS', terminal: false, applicantEdit: 'NONE' },
    { key: 'REVISION_REQUIRED', label: 'Revision requested', applicantLabel: 'Needs your correction', explanation: 'Correct the sections named on your application and resubmit.', applicantVisible: true, kind: 'PROGRESS', terminal: false, applicantEdit: 'REVISION_SCOPED' },
    { key: 'GRANT_APPROVED', label: 'Grant approved', applicantLabel: 'Grant approved', explanation: 'Industries & Commerce approved your grant.', applicantVisible: true, kind: 'OUTCOME', terminal: false, applicantEdit: 'NONE' },
    { key: 'BANKING_STAGE', label: 'With the bank', applicantLabel: 'With your bank', explanation: 'Your loan request is with the bank.', applicantVisible: true, kind: 'PROGRESS', terminal: false, applicantEdit: 'NONE' },
    { key: 'LOAN_APPROVED', label: 'Loan approved', applicantLabel: 'Loan approved', explanation: 'The bank sanctioned your loan.', applicantVisible: true, kind: 'OUTCOME', terminal: false, applicantEdit: 'NONE' },
    { key: 'COMPLETED', label: 'Completed', applicantLabel: 'Completed', explanation: 'Your application has been worked to the end.', applicantVisible: true, kind: 'OUTCOME', terminal: true, applicantEdit: 'NONE' },
    { key: 'REJECTED', label: 'Rejected', applicantLabel: 'Not approved', explanation: 'Your application was not approved.', applicantVisible: true, kind: 'OUTCOME', terminal: true, applicantEdit: 'NONE' },
  ],
  recordedValues: [
    { key: 'APPROVED_GRANT_PAISE', label: 'Grant approved', type: 'MONEY_PAISE', applicantVisible: true },
    { key: 'FULFILLED_LOAN_PAISE', label: 'Loan sanctioned', type: 'MONEY_PAISE', applicantVisible: true },
    { key: 'LOAN_REFERENCE', label: 'Bank sanction reference', type: 'TEXT', applicantVisible: true },
    { key: 'LOAN_SANCTIONED_ON', label: 'Loan sanctioned on', type: 'DATE', applicantVisible: true },
  ],
  stages: [
    {
      key: 'TTC',
      name: 'TTC review',
      description: 'The first look: is the application complete and eligible?',
      applicantLabel: 'Under first review',
      applicantExplanation: 'Your application is being checked for completeness and eligibility.',
      presenceFlags: [],
      actions: [
        {
          key: 'ASK_REVISION',
          label: 'Ask the applicant to correct it',
          description: 'Unlocks the sections you name; the application returns here when they resubmit.',
          confirmation: null,
          inputs: [],
          availableWhen: [],
          effects: [
            { type: 'REQUEST_REVISION', params: { flag: 'REVISION_REQUIRED' }, when: [] },
            { type: 'NOTIFY_APPLICANT', params: { message: 'Please correct the sections named on your application and resubmit.', email: true }, when: [] },
          ],
        },
        {
          key: 'TO_INDUSTRIES_COMMERCE',
          label: 'Move to Industries & Commerce',
          description: null,
          confirmation: null,
          inputs: [],
          availableWhen: [],
          effects: [{ type: 'MOVE_TO_STAGE', params: { target: 'INDUSTRIES_COMMERCE' }, when: [] }],
        },
        {
          key: 'REJECT',
          label: 'Reject',
          description: 'Closes the application without funding.',
          confirmation: 'This closes the application. It cannot be undone.',
          inputs: [{ ...note, key: 'REASON', label: 'Why it is rejected', helpText: 'Kept as a staff-only note.' }],
          availableWhen: [],
          effects: [
            { type: 'CLOSE_APPLICATION', params: { flag: 'REJECTED' }, when: [] },
            { type: 'ADD_INTERNAL_NOTE', params: { input: 'REASON' }, when: [] },
            ...finish.map((effect) =>
              effect.type === 'NOTIFY_APPLICANT'
                ? { ...effect, params: { message: 'Your application was not approved.', email: true } }
                : effect,
            ),
          ],
        },
      ],
    },
    {
      key: 'INDUSTRIES_COMMERCE',
      name: 'Industries & Commerce',
      description: 'Approves the grant and chooses the bank for a loan.',
      applicantLabel: 'With Industries & Commerce',
      applicantExplanation: 'Your application is being considered for a grant and, if you asked for one, a loan.',
      presenceFlags: [],
      actions: [
        sendBack,
        {
          key: 'APPROVE_GRANT',
          label: 'Approve the grant',
          description: 'Records the grant approved. The application stays here.',
          confirmation: null,
          inputs: [money('AMOUNT', 'Grant approved', 'SEED_FUND_REQUESTED_PAISE')],
          availableWhen: [
            answer('WANTS_GRANT', 'BOOLEAN', 'true'),
            { group: 1, source: 'STATUS_FLAG', key: 'GRANT_APPROVED', operator: 'IS_ABSENT', value: null, answerType: null },
          ],
          effects: [
            { type: 'ADD_STATUS', params: { flag: 'GRANT_APPROVED' }, when: [] },
            {
              type: 'SET_RECORDED_VALUE',
              params: { input: 'AMOUNT', target: 'APPROVED_GRANT_PAISE', atMostAnswer: 'SEED_FUND_REQUESTED_PAISE', atMostCycleCeiling: true },
              when: [],
            },
            { type: 'NOTIFY_APPLICANT', params: { message: 'Your grant has been approved.', email: true }, when: [] },
          ],
        },
        {
          key: 'SEND_TO_BANK',
          label: 'Send to the bank',
          description: 'Sends the loan request to the bank you choose.',
          confirmation: null,
          inputs: [
            {
              ...note,
              key: 'BANK',
              type: 'SINGLE_CHOICE',
              label: 'Bank',
              helpText: 'Starts at the applicant’s first choice.',
              maxLength: null,
              options: [
                { value: 'SBI', label: 'State Bank of India' },
                { value: 'TGB', label: 'Tripura Gramin Bank' },
              ],
              defaultFrom: { source: 'ANSWER', key: 'LOAN_BANK_FIRST_CHOICE' },
            },
          ],
          availableWhen: [answer('WANTS_BANK_LOAN', 'BOOLEAN', 'true')],
          effects: [{ type: 'MOVE_BY_CHOICE', params: { input: 'BANK', routes: { SBI: 'SBI_BANK', TGB: 'TGB_BANK' } }, when: [] }],
        },
        {
          key: 'COMPLETE_WITHOUT_LOAN',
          label: 'Complete (no loan asked for)',
          description: null,
          confirmation: 'This completes the application. It cannot be undone.',
          inputs: [],
          availableWhen: [answer('WANTS_BANK_LOAN', 'BOOLEAN', 'false')],
          effects: [{ type: 'COMPLETE_PIPELINE', params: { flag: 'COMPLETED' }, when: [] }, ...finish],
        },
      ],
    },
    bankStage('SBI_BANK', 'State Bank of India'),
    bankStage('TGB_BANK', 'Tripura Gramin Bank'),
  ],
}
