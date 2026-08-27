/**
 * Layer 5: one broken answer at a time, generated from the real form.
 *
 * For every question the fixture cycle asks, and every way that question can
 * be answered wrongly, the form is filled in correctly and exactly one answer
 * is spoiled.
 *
 * **The assertion is not that validation failed.** An engine that refuses
 * everything passes `valid === false` on all of these and is completely
 * broken. What is asserted is that the report names *the question that was
 * spoiled*, with *the code that describes how* — so a refusal that blames the
 * wrong field, or gives an unrelated reason, is a failure here even though the
 * applicant was correctly stopped.
 *
 * Generated from the template, so a question added to the fixture brings its
 * cases with it.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import type { ValidationIssueCode } from '../../src/services/application/form/codes'
import type { ResolvedFormTemplate } from '../../src/services/application/form/types'
import {
  completeAnswers,
  defaultTemplate,
  requiredDocuments,
  templateRowsFor,
} from '../support/form'
import { permissivePolicy } from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')

/*
 * The fixture form, plus an attestation. The product's default form dropped
 * its declaration, but the engine still implements ATTESTATION and its "no is
 * a refusal, blank is a gap" distinction has to stay proven — so this suite
 * asks one of its own.
 */
const template: ResolvedFormTemplate = resolveFormTemplate(templateRowsFor(
  defaultTemplate((each) => ({
    ...each,
    fields: [...each.fields, {
      stageKey: 'DOCUMENTS', fieldKey: 'TERMS_ACCEPTED',
      fieldType: 'ATTESTATION', label: 'I accept the terms.',
      requirement: 'REQUIRED',
    }],
  })),
))!
const attached = new Set(requiredDocuments)

/** The whole form, with one answer replaced. */
const spoil = (key: string, value: unknown) => {
  const answers = { ...completeAnswers({ TERMS_ACCEPTED: true }), [key]: value }
  const normalized = normalizeAnswers(template, answers, NOW)
  if (normalized.value === null) {
    return normalized.issues.map((issue) => ({ field: issue.field, code: issue.code }))
  }
  return validateAnswersForSubmission(
    template, normalized.value, attached, NOW, permissivePolicy,
  ).issues.map((issue) => ({ field: issue.field, code: issue.code }))
}

/**
 * The mutations each type admits, and what each one should be blamed for.
 *
 * A `null` mutation only applies to a question that must be answered — for an
 * optional one, clearing it is a legitimate edit rather than a mistake, so
 * those cases are not generated.
 */
type Mutation = { label: string; value: unknown; code: ValidationIssueCode }

const mutationsFor = (field: ResolvedFormTemplate['fields'][number]): Mutation[] => {
  const wrongType: Mutation = {
    label: 'a value of the wrong type',
    value: { not: 'a scalar' },
    code: 'INVALID_TYPE',
  }
  switch (field.type) {
    case 'TEXT':
    case 'LONG_TEXT':
      return [
        wrongType,
        ...(field.rules.maxLength !== null
          ? [{
              label: 'one character too many',
              value: 'x'.repeat(field.rules.maxLength + 1),
              code: 'TOO_LONG' as const,
            }]
          : []),
      ]
    case 'EMAIL':
      return [wrongType, { label: 'not an address', value: 'not-an-email', code: 'INVALID_EMAIL' }]
    case 'PHONE':
      return [wrongType, { label: 'not a number', value: 'ring-me', code: 'INVALID_PHONE' }]
    case 'DATE':
      return [
        wrongType,
        { label: 'a date that never happened', value: '2026-02-31', code: 'INVALID_DATE' },
        { label: 'not a date at all', value: 'yesterday', code: 'INVALID_DATE' },
      ]
    case 'INTEGER':
      return [
        { label: 'a fraction', value: 1.5, code: 'INVALID_INTEGER' },
        { label: 'text', value: 'twelve', code: 'INVALID_INTEGER' },
      ]
    case 'MONEY_PAISE':
      return [
        { label: 'a fraction of a paisa', value: 1.5, code: 'INVALID_MONEY' },
        /*
         * One below the floor — but a floor of zero puts that value below
         * zero, and money cannot be negative whatever the cycle says. So the
         * expected refusal follows the floor: `TOO_SMALL` where the cycle set
         * one, `INVALID_MONEY` where the only floor is arithmetic.
         */
        ...(field.rules.minValue !== null
          ? [{
              label: 'one below the floor',
              value: field.rules.minValue - 1,
              code: (field.rules.minValue > 0 ? 'TOO_SMALL' : 'INVALID_MONEY') as
                ValidationIssueCode,
            }]
          : []),
      ]
    case 'BOOLEAN':
    case 'ATTESTATION':
      return [{ label: 'text where yes or no belongs', value: 'yes', code: 'INVALID_BOOLEAN' }]
    case 'SINGLE_CHOICE':
      return [{ label: 'a choice not offered', value: 'NOT_AN_OPTION', code: 'INVALID_ENUM' }]
    case 'MULTI_CHOICE':
      return [
        { label: 'a choice not offered', value: ['NOT_AN_OPTION'], code: 'INVALID_ENUM' },
        { label: 'the same choice twice', value: sameTwice(field), code: 'DUPLICATE_SELECTION' },
      ]
    default:
      return []
  }
}

const sameTwice = (field: ResolvedFormTemplate['fields'][number]): unknown => {
  const first = field.options[0]?.value
  return first === undefined ? [] : [first, first]
}

/**
 * Only the questions the completed form actually answers.
 *
 * A question the fixture leaves blank — one behind a condition that does not
 * hold — cannot be spoiled without changing what the form asks, which would
 * make the case about something else.
 */
const answered = completeAnswers({ TERMS_ACCEPTED: true })
/**
 * The members of the owners group, spoiled inside the first entry. The issue
 * path a member's refusal carries is `OWNERS[0].MEMBER` — the control id the
 * client scrolls to — and this is the suite that proves the blame lands there.
 */
const spoilMember = (memberKey: string, value: unknown) => {
  const base = completeAnswers({ TERMS_ACCEPTED: true })
  const entries = (base.OWNERS as Record<string, unknown>[]).map((entry) => ({ ...entry }))
  entries[0]![memberKey] = value
  const normalized = normalizeAnswers(template, { ...base, OWNERS: entries }, NOW)
  if (normalized.value === null) {
    return normalized.issues.map((issue) => ({ field: issue.field, code: issue.code }))
  }
  return validateAnswersForSubmission(
    template, normalized.value, attached, NOW, permissivePolicy,
  ).issues.map((issue) => ({ field: issue.field, code: issue.code }))
}

const memberSubjects = template.fields.filter((field) =>
  field.repeatGroupKey === 'OWNERS' && field.source === 'APPLICANT',
)

const memberCases = memberSubjects.flatMap((field) =>
  mutationsFor(field).map((mutation) => [
    `OWNERS[0].${field.key}: ${mutation.label}`, field.key, mutation,
  ] as const),
)

const subjects = template.fields.filter((field) =>
  field.type !== 'FILE'
  && field.type !== 'REPEAT_GROUP'
  && field.repeatGroupKey === null
  && field.source === 'APPLICANT'
  && answered[field.key] !== undefined
  && answered[field.key] !== null,
)

const cases = subjects.flatMap((field) =>
  mutationsFor(field).map((mutation) => [
    `${field.key}: ${mutation.label}`, field.key, mutation,
  ] as const),
)

describe('one broken answer at a time', () => {
  it('starts from a form with nothing wrong with it', () => {
    expect(spoil('__none__', undefined).filter((issue) => issue.field !== '__none__')).toEqual([])
  })

  it('generates a case for every answered question', () => {
    // 7 top-level answered questions and 6 owner members; a generator that
    // silently shrank below that is testing less form than the fixture asks.
    expect(subjects.length + memberSubjects.length).toBeGreaterThan(12)
    expect(cases.length + memberCases.length).toBeGreaterThan(20)
    /*
     * Counted, because a generator that silently produced nothing would report
     * a fast green run — and the whole family would be testing the empty set.
     */
    expect(new Set(cases.map(([, key]) => key)).size).toBe(subjects.length)
  })

  it.each(cases)('%s', (_label, key, mutation) => {
    const issues = spoil(key, mutation.value)
    /*
     * Named and explained. Asserting only that something failed would pass on
     * an engine that blamed the wrong question, which is worse than refusing
     * for no reason: the applicant is sent to fix an answer that is correct.
     */
    expect(issues, 'nothing was refused').not.toEqual([])
    expect(issues.map((issue) => issue.field)).toContain(key)
    expect(
      issues.filter((issue) => issue.field === key).map((issue) => issue.code),
      `${key} was refused, but not for ${mutation.code}`,
    ).toContain(mutation.code)
  })

  it.each(memberCases)('%s', (_label, memberKey, mutation) => {
    const issues = spoilMember(memberKey, mutation.value)
    const path = `OWNERS[0].${memberKey}`
    expect(issues, 'nothing was refused').not.toEqual([])
    // The blame lands on the entry's own control, not the group, not the key
    // alone — `OWNERS[0].MEMBER` is what the client puts on the input's id.
    expect(issues.map((issue) => issue.field)).toContain(path)
    expect(
      issues.filter((issue) => issue.field === path).map((issue) => issue.code),
      `${path} was refused, but not for ${mutation.code}`,
    ).toContain(mutation.code)
  })

  /**
   * Clearing a required answer is blamed on that question, not on the stage.
   *
   * The old validator reported completeness per section, so an applicant with
   * one blank field was told a whole section was incomplete and had to find it
   * themselves.
   */
  const required = subjects.filter((field) => field.requirement === 'REQUIRED')

  it.each(required.map((field) => [field.key] as const))(
    '%s: cleared, and named as the question that is missing',
    (key) => {
      const issues = spoil(key, null)
      expect(issues.filter((issue) => issue.field === key).map((issue) => issue.code))
        .toContain('REQUIRED')
    },
  )

  /**
   * An attestation answered "no" is a different refusal from one left blank.
   *
   * Blank is `REQUIRED` — the applicant has not reached it. `false` is
   * `MUST_BE_TRUE` — they reached it and declined, and telling them the
   * question is *missing* would be untrue and unhelpable. This is the
   * distinction the `ATTESTATION` type exists for: a required `BOOLEAN` must
   * be *answered*, and "no" answers it.
   */
  const attestations = subjects.filter((field) => field.type === 'ATTESTATION')

  it('has attestations to test', () => {
    expect(attestations.length).toBeGreaterThan(0)
  })

  it.each(attestations.map((field) => [field.key] as const))(
    '%s: declined, and told it must be confirmed rather than that it is missing',
    (key) => {
      const codes = spoil(key, false)
        .filter((issue) => issue.field === key).map((issue) => issue.code)
      expect(codes).toContain('MUST_BE_TRUE')
      expect(codes).not.toContain('REQUIRED')
    },
  )

  /*
   * The other half of the same distinction: a required yes/no question is
   * satisfied by "no". Without this the two types are indistinguishable and
   * `ATTESTATION` earns nothing.
   */
  it('accepts "no" to a required yes/no question that is not an attestation', () => {
    const booleans = subjects.filter(
      (field) => field.type === 'BOOLEAN' && field.requirement === 'REQUIRED',
    )
    expect(booleans.length).toBeGreaterThan(0)
    for (const field of booleans) {
      expect(spoil(field.key, false).filter((issue) => issue.field === field.key)).toEqual([])
    }
  })
})
