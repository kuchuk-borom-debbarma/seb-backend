/**
 * Every way a repeated group's answers can be wrong.
 *
 * `repeat-group.test.ts` is about a group behind a condition; this is about the
 * shape of what arrives. The save tier walks a group by hand — a second, nested
 * copy of the top-level loop — and a rule enforced at the top level and not
 * inside a group is a boundary maintained by vigilance rather than by
 * construction, which this repository already has a scar for.
 *
 * So each assertion below has a sibling at the top level, and the point is that
 * both hold.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeAnswers,
  validateAnswersForSubmission,
} from '../../src/services/application/form/engine'
import { answersFor, field, permissivePolicy, templateOf } from './support/template'

const NOW = new Date('2026-06-01T00:00:00Z')

/** A group with one of everything the loop treats differently. */
const withGroup = (extra: Record<string, unknown> = {}) => templateOf(
  [
    field('PARTNERS', 'REPEAT_GROUP', 1, { repeatMin: 1, repeatMax: 3, ...extra }),
    field('PARTNER_NAME', 'TEXT', 2, {
      parentFieldKey: 'PARTNERS', requirement: 'REQUIRED', minLength: 2, maxLength: 40,
    }),
    field('PARTNER_SHARE', 'INTEGER', 3, {
      parentFieldKey: 'PARTNERS', minValue: 0, maxValue: 100,
    }),
    /*
     * A document inside a group is skipped exactly as one outside it is.
     *
     * There is deliberately no `SERVER_DERIVED` member here: `resolveFormTemplate`
     * refuses a template that declares one, and the schema's own CHECK refuses
     * it being authored at all. The loop still skips it, which is defence
     * against a template that could not exist — worth keeping, and not
     * something a test can reach.
     */
    field('PARTNER_PROOF', 'FILE', 4, { parentFieldKey: 'PARTNERS', maxFileBytes: 1024 }),
  ],
)

const save = (entries: unknown, template = withGroup()) =>
  normalizeAnswers(template, answersFor(template, { PARTNERS: entries }), NOW)

const codes = (report: ReturnType<typeof save>) =>
  report.issues.map((each) => ({ field: each.field, code: each.code }))

describe('what a repeated group will accept on a save', () => {
  it('takes a well-formed entry', () => {
    const report = save([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 }])
    expect(report.issues).toEqual([])
    expect(report.value!.PARTNERS).toEqual([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 }])
  })

  /*
   * An unanswered group is an empty list rather than an error. The bound on how
   * many it must have belongs to the submission tier — refusing it here would
   * mean a draft could not be saved before it was finished.
   */
  it.each([[null], [undefined]])('reads %s as no entries at all', (given) => {
    const report = save(given)
    expect(report.issues).toEqual([])
    expect(report.value!.PARTNERS).toEqual([])
  })

  it('refuses something that is not a list', () => {
    expect(codes(save({ PARTNER_NAME: 'Asha' })))
      .toEqual([{ field: 'PARTNERS', code: 'INVALID_TYPE' }])
  })

  it.each([['a string'], [7], [true], [null]])(
    'refuses an entry that is not a set of answers (%s)',
    (entry) => {
      expect(codes(save([entry])))
        .toEqual([{ field: 'PARTNERS[0]', code: 'INVALID_TYPE' }])
    },
  )

  it('refuses an entry that is a list rather than an object', () => {
    expect(codes(save([[]]))).toEqual([{ field: 'PARTNERS[0]', code: 'INVALID_TYPE' }])
  })

  /*
   * The same total-replacement rule the top level keeps: an absent key is an
   * error and an explicit null is a cleared answer, because otherwise there is
   * no way to take an optional answer back.
   */
  it('refuses an entry that leaves a question out', () => {
    expect(codes(save([{ PARTNER_NAME: 'Asha' }])))
      .toEqual([{ field: 'PARTNERS[0].PARTNER_SHARE', code: 'MISSING_SNAPSHOT_FIELD' }])
  })

  it('takes an explicit null as a cleared answer', () => {
    const report = save([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: null }])
    expect(report.issues).toEqual([])
    expect(report.value!.PARTNERS).toEqual([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: null }])
  })

  it('names the entry and the question when a value is the wrong type', () => {
    expect(codes(save([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: 'sixty' }])))
      .toEqual([{ field: 'PARTNERS[0].PARTNER_SHARE', code: 'INVALID_INTEGER' }])
  })

  it('applies a member’s own rules inside the entry', () => {
    expect(codes(save([{ PARTNER_NAME: 'A', PARTNER_SHARE: 101 }]))).toEqual([
      { field: 'PARTNERS[0].PARTNER_NAME', code: 'TOO_SHORT' },
      { field: 'PARTNERS[0].PARTNER_SHARE', code: 'TOO_LARGE' },
    ])
  })

  it('names the right entry when it is not the first', () => {
    expect(codes(save([
      { PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 },
      { PARTNER_NAME: 'A', PARTNER_SHARE: 40 },
    ]))).toEqual([{ field: 'PARTNERS[1].PARTNER_NAME', code: 'TOO_SHORT' }])
  })

  /**
   * The exclusion the top-level loop makes, made here too.
   *
   * A guard that holds at two of three entry points is the failure this
   * repository already found once — the server-derived guard was missing from
   * exactly this loop, so a template modelling prior grants as a group would
   * have let an applicant write figures a reviewer reads as programme-derived
   * fact. A document is the same shape of mistake: evidence has its own
   * versioned row, and an answer claiming to be one is not one.
   */
  it('never stores a document answered from inside an entry', () => {
    const report = save([{
      PARTNER_NAME: 'Asha',
      PARTNER_SHARE: 60,
      PARTNER_PROOF: 'smuggled',
    }])
    expect(report.issues).toEqual([])
    expect(report.value!.PARTNERS).toEqual([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 }])
  })

  // Nor is it demanded — a group whose entries omit it is complete.
  it('does not demand a document inside an entry', () => {
    expect(save([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 }]).issues).toEqual([])
  })
})

describe('how many entries a group may have', () => {
  const submit = (entries: unknown, template = withGroup()) => {
    const saved = normalizeAnswers(template, answersFor(template, { PARTNERS: entries }), NOW)
    expect(saved.issues).toEqual([])
    return validateAnswersForSubmission(
      template, saved.value!, new Set(), NOW, permissivePolicy,
    ).issues.map((each) => ({ field: each.field, code: each.code }))
  }

  it('accepts a count inside the bounds', () => {
    expect(submit([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 }])).toEqual([])
  })

  it('accepts the largest count allowed', () => {
    expect(submit([1, 2, 3].map((n) => ({ PARTNER_NAME: `Name ${n}`, PARTNER_SHARE: n })))).toEqual([])
  })

  it('refuses one fewer than the smallest', () => {
    expect(submit([])).toEqual([{ field: 'PARTNERS', code: 'TOO_FEW_ENTRIES' }])
  })

  it('refuses one more than the largest', () => {
    expect(submit([1, 2, 3, 4].map((n) => ({ PARTNER_NAME: `Name ${n}`, PARTNER_SHARE: n }))))
      .toEqual([{ field: 'PARTNERS', code: 'TOO_MANY_ENTRIES' }])
  })

  it('bounds nothing where the cycle bounded nothing', () => {
    const unbounded = withGroup({ repeatMin: 0, repeatMax: 50 })
    expect(submit([], unbounded)).toEqual([])
  })

  /*
   * A member that is required is required in *every* entry, and the issue names
   * which one — an applicant told only that a partner's name is missing has to
   * check each card themselves.
   */
  it('demands a required member in the entry that lacks it', () => {
    expect(submit([
      { PARTNER_NAME: 'Asha', PARTNER_SHARE: 60 },
      { PARTNER_NAME: null, PARTNER_SHARE: 40 },
    ])).toEqual([{ field: 'PARTNERS[1].PARTNER_NAME', code: 'REQUIRED' }])
  })

  it('does not demand a member the cycle made optional', () => {
    expect(submit([{ PARTNER_NAME: 'Asha', PARTNER_SHARE: null }])).toEqual([])
  })
})
