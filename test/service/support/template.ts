/**
 * One template fixture, built the way a cycle actually declares one.
 *
 * Deliberately a builder over a single default rather than a second literal:
 * the two hand-written complete-draft fixtures this replaces drifted apart —
 * they described the same applicant under different names — because each was
 * maintained separately. Tests that need a different form vary this one.
 */
import { resolveFormTemplate } from '../../../src/services/application/form/template'
import type {
  CyclePolicy,
  FormTemplateRows,
  ResolvedFormTemplate,
} from '../../../src/services/application/form/types'

export type FieldRow = FormTemplateRows['fields'][number]

export const field = (
  fieldKey: string,
  fieldType: FieldRow['fieldType'],
  sortOrder: number,
  extra: Partial<FieldRow> = {},
): FieldRow => ({
  stageKey: 'MAIN',
  fieldKey,
  fieldType,
  role: null,
  label: fieldKey,
  helpText: null,
  requirement: 'OPTIONAL',
  source: 'APPLICANT',
  sortOrder,
  parentFieldKey: null,
  repeatMin: null,
  repeatMax: null,
  minLength: null,
  maxLength: null,
  pattern: null,
  patternMessage: null,
  minValue: null,
  maxValue: null,
  minDate: null,
  maxDate: null,
  relativeDateBound: null,
  maxFileBytes: null,
  ...extra,
})

/**
 * The two bindings every cycle must carry before it can open.
 *
 * Present in every fixture because a template without them does not resolve:
 * the decision bound and the age rule reach their inputs through a role, so a
 * form that binds neither is one no staff screen could read. The date of
 * birth is top-level here — the group-membered shape is the main fixture's —
 * because the unit suites want the smallest resolving template.
 */
export const roleFields: FieldRow[] = [
  field('DATE_OF_BIRTH', 'DATE', 94, { role: 'APPLICANT_DATE_OF_BIRTH' }),
  field('SEED_FUND_REQUESTED_PAISE', 'MONEY_PAISE', 95, {
    role: 'SEED_FUND_REQUESTED_PAISE',
    minValue: 0,
  }),
]

export const roleOptions: FormTemplateRows['options'] = []

/** Answers to the role-bound fields, complete and valid. */
export const roleAnswers: Record<string, unknown> = {
  DATE_OF_BIRTH: '1990-06-15',
  SEED_FUND_REQUESTED_PAISE: 50_000_00,
}

export const templateOf = (
  fields: FieldRow[] = [],
  conditions: FormTemplateRows['conditions'] = [],
  options: FormTemplateRows['options'] = [],
  stages: FormTemplateRows['stages'] = [
    { stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 },
  ],
): ResolvedFormTemplate => {
  const resolved = resolveFormTemplate({
    programmeCycleId: 'c1',
    programmeCycleVersion: 1,
    stages,
    fields: [...fields, ...roleFields],
    options: [...options, ...roleOptions],
    conditions,
  })
  if (!resolved) throw new Error('fixture template did not resolve')
  return resolved
}

/** A complete answer set for `templateOf(extra)`, with the extras filled in. */
export const answersFor = (
  template: ResolvedFormTemplate,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const answers: Record<string, unknown> = {}
  for (const f of template.fields) {
    if (f.type === 'FILE' || f.type === 'STATEMENT' || f.repeatGroupKey !== null) continue
    if (f.source === 'SERVER_DERIVED') continue
    answers[f.key] =
      roleAnswers[f.key] ?? (f.type === 'MULTI_CHOICE' || f.type === 'REPEAT_GROUP' ? [] : null)
  }
  return { ...answers, ...overrides }
}

/** The cycle policy a fixture validates against, with nothing enforced. */
export const permissivePolicy: CyclePolicy = {
  minimumApplicantAge: null,
  maximumApplicantAge: null,
  categoryAMaximumMonths: null,
  majorityOwnershipRequired: null,
  fundingCeilingState: 'UNRESOLVED' as const,
  fundingCeilingAmountPaise: null,
  fundingCeilingScope: null,
}
