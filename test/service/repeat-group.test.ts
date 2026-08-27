/**
 * A repeated group behind a condition.
 *
 * The case that broke: a group is only shown when something else is answered,
 * and its members carry no condition of their own. Ordering by condition edges
 * alone puts the members first — so when each is reached its group has not been
 * decided yet, it reads as hidden, and never becomes visible.
 *
 * Nothing throws. The applicant fills the group in, the save reports success,
 * and their entries come back blank.
 */
import { describe, expect, it } from 'vitest'
import { visibleFields } from '../../src/services/application/form/conditions'
import { pruneHidden } from '../../src/services/application/form/answers'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { answersFor, field, permissivePolicy, templateOf } from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')

/** `PARTNERS` is asked only when `HAS_PARTNERS` is yes; its members are not. */
const withConditionalGroup = () => templateOf(
  [
    field('HAS_PARTNERS', 'BOOLEAN', 1),
    field('PARTNERS', 'REPEAT_GROUP', 2, { repeatMin: 0, repeatMax: 5 }),
    field('PARTNER_NAME', 'TEXT', 3, {
      parentFieldKey: 'PARTNERS', requirement: 'REQUIRED', maxLength: 100,
    }),
  ],
  [{
    fieldKey: 'PARTNERS',
    effect: 'VISIBLE_WHEN',
    groupNumber: 1,
    sequenceNumber: 1,
    sourceFieldKey: 'HAS_PARTNERS',
    operator: 'EQUALS',
    comparisonValue: 'true',
  }],
)

const filledIn = () => {
  const template = withConditionalGroup()
  const answers = normalizeAnswers(template, answersFor(template, {
    HAS_PARTNERS: true,
    PARTNERS: [{ PARTNER_NAME: 'Asha Debbarma' }],
  }), NOW)
  expect(answers.issues).toEqual([])
  return { template, answers: answers.value! }
}

describe('a repeated group that is only asked sometimes', () => {
  it('asks the group once its condition holds', () => {
    const { template, answers } = filledIn()
    expect([...visibleFields(template, answers)]).toContain('PARTNERS')
  })

  /*
   * The member, not just the group. A group nobody can type into is the same
   * as no group at all — and it is the member's visibility that decides
   * whether its answer survives a save.
   */
  it('asks the questions inside it', () => {
    const { template, answers } = filledIn()
    expect([...visibleFields(template, answers)]).toContain('PARTNER_NAME')
  })

  it('keeps the answers when the draft is saved', () => {
    const { template, answers } = filledIn()
    expect(pruneHidden(template, answers).PARTNERS)
      .toEqual([{ PARTNER_NAME: 'Asha Debbarma' }])
  })

  it('still requires a member that is required, once the group is shown', () => {
    const template = withConditionalGroup()
    const answers = normalizeAnswers(template, answersFor(template, {
      HAS_PARTNERS: true,
      PARTNERS: [{ PARTNER_NAME: null }],
    }), NOW).value!
    const report = validateAnswersForSubmission(
      template, answers, new Set(), NOW, permissivePolicy,
    )
    expect(report.issues.map((issue) => issue.field)).toContain('PARTNERS[0].PARTNER_NAME')
  })

  /**
   * A member key sent on its own, as a stale or hand-written client would.
   *
   * The unknown-key gate looked the key up in `byKey`, which holds every field
   * including members — so it was found, no issue was raised, and the loop that
   * builds the answer set skipped it because members are only read inside their
   * group. **The applicant got `success: true` and the answer was never
   * stored**, which is the exact outcome that gate exists to prevent.
   */
  it('refuses a member answered on its own rather than inside its group', () => {
    const template = withConditionalGroup()
    const report = normalizeAnswers(template, {
      ...answersFor(template, { HAS_PARTNERS: true, PARTNERS: [] }),
      PARTNER_NAME: 'Asha Debbarma',
    }, NOW)
    expect(report.value).toBeNull()
    expect(report.issues.map((each) => ({ field: each.field, code: each.code })))
      .toEqual([{ field: 'PARTNER_NAME', code: 'UNKNOWN_FIELD' }])
    expect(report.issues[0]!.message).toBe('PARTNER_NAME is answered inside PARTNERS, not on its own.')
  })

  it('clears the group once its condition stops holding', () => {
    const template = withConditionalGroup()
    const answers = normalizeAnswers(template, answersFor(template, {
      HAS_PARTNERS: false,
      PARTNERS: [{ PARTNER_NAME: 'Asha Debbarma' }],
    }), NOW).value!
    expect([...visibleFields(template, answers)]).not.toContain('PARTNER_NAME')
    expect(pruneHidden(template, answers).PARTNERS).toEqual([])
  })
})
