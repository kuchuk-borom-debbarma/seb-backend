/**
 * The three policy rules against the two-role, owners-grouped world.
 *
 * These read cycle scalars and enterprise facts rather than template bounds,
 * so they live outside the per-type matrix — and each has a shape the matrix
 * cannot express: the age rule walks the owners group's entries, the category
 * threshold reads the enterprise entity, and the category itself is computed
 * rather than validated.
 */
import { describe, expect, it } from 'vitest'
import {
  applicationCategoryOf,
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import { completeAnswers, defaultTemplate, requiredDocuments, templateRowsFor } from '../support/form'
import { field, permissivePolicy, templateOf, answersFor } from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')
const template = resolveFormTemplate(templateRowsFor(defaultTemplate()))!
const attached = new Set(requiredDocuments)
const banded = { ...permissivePolicy, minimumApplicantAge: 18, maximumApplicantAge: 60 }

const owner = (dateOfBirth: string) => ({
  NAME: 'Someone Debbarma',
  DESIGNATION: 'PROPRIETOR',
  DATE_OF_BIRTH: dateOfBirth,
  GENDER: 'FEMALE',
  RELATIONSHIP_TYPE: 'DAUGHTER_OF',
  RELATED_PERSON_NAME: 'A Parent',
})

const reportFor = (owners: unknown, policy: typeof permissivePolicy = banded) => {
  const normalized = normalizeAnswers(template, completeAnswers({ OWNERS: owners }), NOW)
  expect(normalized.issues).toEqual([])
  return validateAnswersForSubmission(template, normalized.value!, attached, NOW, policy)
}

describe('the age rule over the owners group', () => {
  it('passes when at least one owner is in band', () => {
    // A 30-year-old founder and a 70-year-old co-owner: eligible. The rule is
    // about having a qualifying owner, not about excluding anybody else.
    const report = reportFor([owner('1996-02-10'), owner('1950-01-01')])
    expect(report.issues).toEqual([])
    expect(report.valid).toBe(true)
  })

  it('refuses when nobody is in band, on the group control', () => {
    const report = reportFor([owner('1950-01-01'), owner('2015-01-01')])
    expect(report.issues).toContainEqual({
      stageKey: 'OWNERS',
      field: 'OWNERS',
      code: 'AGE_INELIGIBLE',
      message: 'At least one owner must be aged 18 to 60.',
    })
  })

  it('says nothing about age when the cycle sets no band', () => {
    expect(reportFor([owner('1950-01-01')], permissivePolicy).issues).toEqual([])
  })

  it('still reads a top-level date of birth where a cycle asks one', () => {
    // The smallest template binds the role at the top level; the rule must
    // work there too, and blame the question itself.
    const flat = templateOf([field('NOTE', 'TEXT', 1, { maxLength: 50 })])
    const answers = normalizeAnswers(
      flat, answersFor(flat, { DATE_OF_BIRTH: '1950-01-01' }), NOW).value!
    const report = validateAnswersForSubmission(flat, answers, new Set(), NOW, banded)
    expect(report.issues.map((issue) => [issue.field, issue.code]))
      .toContainEqual(['DATE_OF_BIRTH', 'AGE_INELIGIBLE'])
  })
})

describe('the band halves', () => {
  it('names the open ends when only one bound is set', () => {
    const onlyMax = { ...permissivePolicy, maximumApplicantAge: 60 }
    expect(reportFor([owner('1950-01-01')], onlyMax).issues[0]?.message)
      .toBe('At least one owner must be aged 0 to 60.')
    const onlyMin = { ...permissivePolicy, minimumApplicantAge: 18 }
    expect(reportFor([owner('2015-01-01')], onlyMin).issues[0]?.message)
      .toBe('At least one owner must be aged 18 to any.')
  })

  it('treats an unreadable stored date as no verdict, not a refusal', () => {
    // Validation can be handed answers that never went through normalize —
    // the two tiers are separate doors — and a date that does not parse must
    // not count as an owner out of band.
    const report = validateAnswersForSubmission(
      template,
      { ...completeAnswers(), OWNERS: [owner('not-a-date'), owner('1996-02-10')] } as never,
      attached, NOW, banded,
    )
    expect(report.issues.map((issue) => issue.code)).not.toContain('AGE_INELIGIBLE')
  })
})

describe('the band edges', () => {
  it('turns eligible on the birthday itself, not the day after', () => {
    // NOW is 2026-06-01. Born 2008-06-01 is 18 today; born a day later is
    // still 17 — the month-and-day comparison is the rule, not year arithmetic.
    const onlyMin = { ...permissivePolicy, minimumApplicantAge: 18 }
    expect(reportFor([owner('2008-06-01')], onlyMin).issues).toEqual([])
    expect(reportFor([owner('2008-06-02')], onlyMin).issues.map((issue) => issue.code))
      .toContain('AGE_INELIGIBLE')
  })

  it('speaks the open ends on a top-level date of birth too', () => {
    const onlyMax = { ...permissivePolicy, maximumApplicantAge: 60 }
    const flat = templateOf([field('NOTE', 'TEXT', 1, { maxLength: 50 })])
    const answers = normalizeAnswers(
      flat, answersFor(flat, { DATE_OF_BIRTH: '1950-01-01' }), NOW).value!
    const report = validateAnswersForSubmission(flat, answers, new Set(), NOW, onlyMax)
    expect(report.issues[0]?.message).toBe('This programme is open to applicants aged 0 to 60.')
  })

  it('skips an owner whose date is not there at all', () => {
    // Validation can be handed entries normalize never blessed; a missing date
    // is the completeness rule's business, not the age rule's.
    const entries = [
      { NAME: 'No Birthday', DESIGNATION: 'PROPRIETOR', GENDER: 'OTHER',
        RELATIONSHIP_TYPE: 'SON_OF', RELATED_PERSON_NAME: 'Somebody' },
      owner('1996-02-10'),
    ]
    const report = validateAnswersForSubmission(
      template,
      { ...completeAnswers(), OWNERS: entries } as never,
      attached, NOW, banded,
    )
    expect(report.issues.map((issue) => issue.code)).not.toContain('AGE_INELIGIBLE')
  })
})

describe('the establishment-date requirement', () => {
  const sorting = { ...permissivePolicy, categoryAMaximumMonths: 24 }

  it('refuses submission when the cycle sorts and the enterprise has no date', () => {
    const normalized = normalizeAnswers(template, completeAnswers(), NOW)
    const report = validateAnswersForSubmission(
      template, normalized.value!, attached, NOW, sorting, { establishmentDate: null },
    )
    expect(report.issues.map((issue) => issue.code)).toContain('ESTABLISHMENT_DATE_MISSING')
    // The fix lives on the enterprise screen, and the message says so.
    expect(report.issues.find((issue) => issue.code === 'ESTABLISHMENT_DATE_MISSING')?.message)
      .toContain('Record it on the enterprise')
  })

  it('passes when the date is recorded', () => {
    const normalized = normalizeAnswers(template, completeAnswers(), NOW)
    const report = validateAnswersForSubmission(
      template, normalized.value!, attached, NOW, sorting, { establishmentDate: '2020-01-01' },
    )
    expect(report.issues).toEqual([])
  })

  it('asks for nothing when the cycle does not sort', () => {
    const normalized = normalizeAnswers(template, completeAnswers(), NOW)
    const report = validateAnswersForSubmission(
      template, normalized.value!, attached, NOW, permissivePolicy, { establishmentDate: null },
    )
    expect(report.issues).toEqual([])
  })
})

describe('the computed category', () => {
  it('sorts an established enterprise into A and a new one into B', () => {
    // Exactly at the threshold counts as established: 24 months to the day.
    expect(applicationCategoryOf('2024-06-01', 24, NOW)).toBe('CATEGORY_A')
    expect(applicationCategoryOf('2024-06-02', 24, NOW)).toBe('CATEGORY_B')
    expect(applicationCategoryOf('2010-01-01', 24, NOW)).toBe('CATEGORY_A')
  })

  it('computes nothing without a threshold, a date, or a readable date', () => {
    expect(applicationCategoryOf('2020-01-01', null, NOW)).toBeNull()
    expect(applicationCategoryOf(null, 24, NOW)).toBeNull()
    expect(applicationCategoryOf('not-a-date', 24, NOW)).toBeNull()
  })
})

/*
 * The refusals under the two-role world that only the resolver can make —
 * these templates pass no authoring check because they are built as raw rows,
 * which is exactly the hand-edited state `resolveFormTemplate`'s null protects
 * against.
 */
describe('resolving role rows directly', () => {
  const rows = (fields: Parameters<typeof resolveFormTemplate>[0]['fields']) => ({
    programmeCycleId: 'c1',
    programmeCycleVersion: 1,
    stages: [{ stageKey: 'MAIN', title: 'Main', description: null, sortOrder: 1 }],
    fields,
    options: [],
    conditions: [],
  })
  const row = (
    fieldKey: string,
    extra: Partial<Parameters<typeof resolveFormTemplate>[0]['fields'][number]> = {},
  ) => ({
    stageKey: 'MAIN', fieldKey, fieldType: 'DATE' as const, role: null,
    label: fieldKey, helpText: null, requirement: 'OPTIONAL' as const,
    source: 'APPLICANT' as const, sortOrder: 1, parentFieldKey: null,
    repeatMin: null, repeatMax: null, minLength: null, maxLength: null,
    pattern: null, patternMessage: null, minValue: null, maxValue: null,
    minDate: null, maxDate: null, relativeDateBound: null, maxFileBytes: null,
    ...extra,
  })
  const money = (fieldKey: string, extra = {}) => row(fieldKey, {
    fieldType: 'MONEY_PAISE' as const, role: 'SEED_FUND_REQUESTED_PAISE' as const,
    minValue: 0, sortOrder: 2, ...extra,
  })

  it('accepts the date of birth under any key the cycle chose', () => {
    const resolved = resolveFormTemplate(rows([
      row('WHEN_BORN', { role: 'APPLICANT_DATE_OF_BIRTH' }),
      money('SEED_FUND_REQUESTED_PAISE'),
    ]))
    expect(resolved?.roles.APPLICANT_DATE_OF_BIRTH).toBe('WHEN_BORN')
  })

  it('refuses two rows claiming one role', () => {
    expect(resolveFormTemplate(rows([
      row('FIRST', { role: 'APPLICANT_DATE_OF_BIRTH' }),
      row('SECOND', { role: 'APPLICANT_DATE_OF_BIRTH', sortOrder: 3 }),
      money('SEED_FUND_REQUESTED_PAISE'),
    ]))).toBeNull()
  })

  it('refuses the pinned role under any other key', () => {
    expect(resolveFormTemplate(rows([
      row('DATE_OF_BIRTH', { role: 'APPLICANT_DATE_OF_BIRTH' }),
      money('AMOUNT_WANTED'),
    ]))).toBeNull()
  })
})

describe('answers to questions the answers above have hidden', () => {
  it('names them all, in one plural sentence', () => {
    // Two dependents answered while their controller says no: the refusal
    // lists both and pluralises — the singular half has its own test in the
    // engine suites.
    const normalized = normalizeAnswers(template, completeAnswers({
      RECEIVED_GOVERNMENT_FUNDING: false,
      GOVERNMENT_SCHEME_NAME: 'PMEGP',
      GOVERNMENT_FUNDING_AMOUNT_PAISE: 100_000,
    }), NOW)
    expect(normalized.issues).toEqual([])
    const report = validateAnswersForSubmission(
      template, normalized.value!, attached, NOW, permissivePolicy,
    )
    const conditional = report.issues.find((issue) => issue.code === 'CONDITIONAL_FIELDS')
    expect(conditional?.message).toContain('they are')
  })
})
