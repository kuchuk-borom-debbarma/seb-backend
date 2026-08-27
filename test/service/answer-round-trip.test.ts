/**
 * Storing an answer set and reading it back must not change it.
 *
 * The storage shape is rows with two ordinals; the engine's shape is a map.
 * Every conversion between two representations is somewhere a value can be
 * lost, and the losses are quiet: an amount that becomes a string, a `false`
 * dropped by a falsy check, a multiple choice that comes back reordered. None
 * of those throw, and each would surface much later as a form that "forgot" an
 * answer.
 */
import { describe, expect, it } from 'vitest'
import {
  answersFromRows,
  answersToRows,
} from '../../src/services/application/queries/form-template'
import { answersEqual } from '../../src/services/application/form/answers'
import { normalizeAnswers } from '../../src/services/application/form/engine'
import { answersFor, field, templateOf } from './support/template'

const NOW = new Date('2026-01-15T12:00:00Z')

const roundTrip = (
  template: ReturnType<typeof templateOf>,
  answers: Record<string, unknown>,
) => {
  const normalized = normalizeAnswers(template, answers, NOW)
  expect(normalized.issues).toEqual([])
  const rows = answersToRows(template, normalized.value!)
  const stored = rows.map((row) => ({ ...row, applicationVersionId: 'av1' }))
  return { before: normalized.value!, after: answersFromRows(template, 'av1', stored), rows }
}

describe('an answer survives being stored and read back', () => {
  const cases: [string, Parameters<typeof templateOf>[0], Record<string, unknown>][] = [
    ['text', [field('F', 'TEXT', 1, { maxLength: 50 })], { F: 'Example Foods' }],
    ['an amount', [field('F', 'MONEY_PAISE', 1, { minValue: 0 })], { F: 12_345_678 }],
    ['the largest safe amount', [field('F', 'MONEY_PAISE', 1, { minValue: 0 })], { F: Number.MAX_SAFE_INTEGER }],
    ['a whole number', [field('F', 'INTEGER', 1)], { F: 2026 }],
    ['zero', [field('F', 'INTEGER', 1)], { F: 0 }],
    ['yes', [field('F', 'BOOLEAN', 1)], { F: true }],
    ['no', [field('F', 'BOOLEAN', 1)], { F: false }],
    /*
     * An attestation is stored exactly as a boolean is, and that is the trap.
     * It reads back through the same decoder, so a decoder that lists the
     * types it understands rather than asking what a type *is* returns the
     * string `"true"` here — which is truthy, so nothing downstream throws,
     * and the submission check that demands `=== true` simply refuses a form
     * the applicant did tick.
     */
    ['an attestation', [field('F', 'ATTESTATION', 1)], { F: true }],
    ['a date', [field('F', 'DATE', 1)], { F: '2015-04-01' }],
    ['an unanswered question', [field('F', 'TEXT', 1, { maxLength: 50 })], { F: null }],
  ]

  it.each(cases)('%s', (_label, fields, overrides) => {
    const template = templateOf(fields)
    const { before, after } = roundTrip(template, answersFor(template, overrides))
    expect(answersEqual(template, before, after)).toBe(true)
    expect(after.F).toStrictEqual(before.F)
  })

  /*
   * `false` is the case a falsy check loses. It is an answer — "no" — and
   * storing nothing for it would make it read back as never answered, which is
   * a different thing and one a reviewer would act on differently.
   */
  it('tells "no" apart from unanswered', () => {
    const template = templateOf([field('F', 'BOOLEAN', 1)])
    const answeredNo = roundTrip(template, answersFor(template, { F: false }))
    const neverAsked = roundTrip(template, answersFor(template, { F: null }))
    expect(answeredNo.after.F).toBe(false)
    expect(neverAsked.after.F).toBeNull()
    expect(answersEqual(template, answeredNo.after, neverAsked.after)).toBe(false)
  })

  it('keeps an amount a number rather than the text it was stored as', () => {
    const template = templateOf([field('F', 'MONEY_PAISE', 1, { minValue: 0 })])
    const { after } = roundTrip(template, answersFor(template, { F: 5_000_00 }))
    expect(typeof after.F).toBe('number')
    // String concatenation instead of addition is the failure this prevents,
    // and a total has no way to look wrong.
    expect((after.F as number) + 1).toBe(5_000_01)
  })

  it('stores nothing at all for an unanswered question', () => {
    const template = templateOf([field('F', 'TEXT', 1, { maxLength: 50 })])
    const { rows } = roundTrip(template, answersFor(template, { F: null }))
    expect(rows.some((row) => row.fieldKey === 'F')).toBe(false)
  })
})

describe('several selections', () => {
  const multi = () =>
    templateOf(
      [field('PICK', 'MULTI_CHOICE', 1)],
      [],
      [
        { fieldKey: 'PICK', optionValue: 'ALPHA', optionLabel: 'Alpha', sortOrder: 1 },
        { fieldKey: 'PICK', optionValue: 'BETA', optionLabel: 'Beta', sortOrder: 2 },
        { fieldKey: 'PICK', optionValue: 'GAMMA', optionLabel: 'Gamma', sortOrder: 3 },
      ],
    )

  it('survives the round trip in the template’s own order', () => {
    const template = multi()
    const { after } = roundTrip(template, answersFor(template, { PICK: ['ALPHA', 'GAMMA'] }))
    expect(after.PICK).toStrictEqual(['ALPHA', 'GAMMA'])
  })

  /*
   * A client sends selections in whatever order they were clicked. Without a
   * canonical order, re-picking the same two the other way round would read as
   * an edit — and would show up in the change summary a reviewer reads.
   */
  it('does not read a reordered selection as a change', () => {
    const template = multi()
    const clickedOneWay = roundTrip(template, answersFor(template, { PICK: ['ALPHA', 'GAMMA'] }))
    const clickedTheOther = roundTrip(template, answersFor(template, { PICK: ['GAMMA', 'ALPHA'] }))
    expect(answersEqual(template, clickedOneWay.after, clickedTheOther.after)).toBe(true)
  })
})

describe('a repeated group', () => {
  const withGroup = () =>
    templateOf([
      field('PARTNERS', 'REPEAT_GROUP', 1, { repeatMin: 0, repeatMax: 5 }),
      field('PARTNER_NAME', 'TEXT', 2, { parentFieldKey: 'PARTNERS', maxLength: 50 }),
      field('PARTNER_SHARE', 'INTEGER', 3, { parentFieldKey: 'PARTNERS' }),
    ])

  it('survives the round trip with its entries in order', () => {
    const template = withGroup()
    const { after } = roundTrip(
      template,
      answersFor(template, {
        PARTNERS: [
          { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 },
          { PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 },
        ],
      }),
    )
    expect(after.PARTNERS).toStrictEqual([
      { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 },
      { PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 },
    ])
  })

  /*
   * Entries carry no identity, so "moved" cannot be told from "replaced".
   * Reporting no change for a reorder would be reporting no change for an edit
   * that really happened, which is the failure the change summary exists to
   * prevent.
   */
  it('counts a reordered entry as a change', () => {
    const template = withGroup()
    const first = roundTrip(template, answersFor(template, {
      PARTNERS: [{ PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 }, { PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 }],
    }))
    const swapped = roundTrip(template, answersFor(template, {
      PARTNERS: [{ PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 }, { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 }],
    }))
    expect(answersEqual(template, first.after, swapped.after)).toBe(false)
  })

  /**
   * A multiple choice inside a repeated group, read back out of order.
   *
   * The top-level branch sorts on `value_ordinal` and this one did not — it
   * appended in row-arrival order, which no read guarantees. So the stored
   * answer and the same answer coerced fresh never compared equal, and **every
   * save reported an edit to a group nobody had touched**. Under revision that
   * is the difference between a change being inside the reopened scope and
   * outside it.
   *
   * The rows are handed back deliberately reversed, because a read that
   * happens to return them in order proves nothing about a read that does not.
   */
  const withChoices = () =>
    templateOf(
      [
        field('PARTNERS', 'REPEAT_GROUP', 1, { repeatMin: 0, repeatMax: 5 }),
        field('PARTNER_ROLES', 'MULTI_CHOICE', 2, { parentFieldKey: 'PARTNERS' }),
      ],
      [],
      [
        { fieldKey: 'PARTNER_ROLES', optionValue: 'ALPHA', optionLabel: 'Alpha', sortOrder: 1 },
        { fieldKey: 'PARTNER_ROLES', optionValue: 'BETA', optionLabel: 'Beta', sortOrder: 2 },
        { fieldKey: 'PARTNER_ROLES', optionValue: 'GAMMA', optionLabel: 'Gamma', sortOrder: 3 },
      ],
    )

  it('reads a group’s selections in their stored order, whatever order the rows arrive in', () => {
    const template = withChoices()
    const answers = normalizeAnswers(template, answersFor(template, {
      PARTNERS: [{ PARTNER_ROLES: ['ALPHA', 'GAMMA'] }],
    }), NOW)
    expect(answers.issues).toEqual([])
    const stored = answersToRows(template, answers.value!)
      .map((row) => ({ ...row, applicationVersionId: 'av1' }))
      .reverse()

    const after = answersFromRows(template, 'av1', stored)
    expect(after.PARTNERS).toStrictEqual([{ PARTNER_ROLES: ['ALPHA', 'GAMMA'] }])
    // And so the save that follows reports no change, which is the point.
    expect(answersEqual(template, answers.value!, after)).toBe(true)
  })

  /**
   * An entry nobody has filled in yet is still an entry.
   *
   * Storage is sparse — an unanswered question has no row — and an entry is not
   * a question. Inferring the entry list from the member rows meant a blank one
   * **disappeared**, and every entry after it moved up a place: the applicant's
   * second partner's answers came back as the first's. A trailing blank was the
   * "Add partner" card they had just clicked, gone on the next reload.
   */
  it('keeps a blank entry, and everything after it in place', () => {
    const template = withGroup()
    const { after, rows } = roundTrip(template, answersFor(template, {
      PARTNERS: [
        { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 },
        { PARTNER_NAME: null, PARTNER_SHARE: null },
        { PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 },
      ],
    }))
    expect(after.PARTNERS).toStrictEqual([
      { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 },
      { PARTNER_NAME: null, PARTNER_SHARE: null },
      { PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 },
    ])
    // One row per entry and nothing more for the blank one: the row says the
    // entry is there, not that anything in it was answered.
    expect(rows.filter((row) => row.fieldKey === 'PARTNERS')).toHaveLength(3)
    expect(rows.filter((row) => row.entryIndex === 2)).toHaveLength(1)
  })

  it('keeps a trailing blank entry', () => {
    const template = withGroup()
    const { after } = roundTrip(template, answersFor(template, {
      /*
       * Explicit nulls, not `{}`. The client pushes `{}` when the applicant
       * clicks "add", and its own prune fills every member in before the save —
       * the engine's total-replacement rule refuses an entry that leaves a
       * member out, exactly as it refuses an answer set that does.
       */
      PARTNERS: [
        { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 },
        { PARTNER_NAME: null, PARTNER_SHARE: null },
      ],
    }))
    expect(after.PARTNERS).toHaveLength(2)
  })

  /*
   * And so a save that changes nothing reports nothing. The stored map and the
   * same answers coerced fresh have to agree, or the group's stage reads as
   * edited on every comparison — which under revision is the difference between
   * a change being in scope and being refused.
   */
  it('does not read a blank entry as a change', () => {
    const template = withGroup()
    const { before, after } = roundTrip(template, answersFor(template, {
      PARTNERS: [
        { PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 },
        { PARTNER_NAME: null, PARTNER_SHARE: null },
      ],
    }))
    expect(answersEqual(template, before, after)).toBe(true)
  })

  it('keeps each entry’s answers separate in storage', () => {
    const template = withGroup()
    const { rows } = roundTrip(template, answersFor(template, {
      PARTNERS: [{ PARTNER_NAME: 'Rina', PARTNER_SHARE: 60 }, { PARTNER_NAME: 'Alok', PARTNER_SHARE: 40 }],
    }))
    const names = rows.filter((row) => row.fieldKey === 'PARTNER_NAME')
    expect(names).toHaveLength(2)
    // Distinct entry indexes are what stop one entry overwriting its sibling,
    // which the unique constraint would otherwise refuse at the database.
    expect(new Set(names.map((row) => row.entryIndex)).size).toBe(2)
  })
})


describe('a stored row no engine should have written', () => {
  it('reads a row addressed to a statement as nothing', () => {
    // The engine refuses answers to a STATEMENT, so such a row is corruption.
    // Reading it as null invents nothing — the display shows an unanswered
    // question rather than resurrecting whatever was smuggled in.
    const template = templateOf([
      field('NOTICE', 'STATEMENT', 1, { requirement: 'OPTIONAL' }),
      field('NAME', 'TEXT', 2),
    ])
    const after = answersFromRows(template, 'av1', [
      { applicationVersionId: 'av1', fieldKey: 'NOTICE', entryIndex: 0, valueOrdinal: 0, valueText: 'smuggled' },
      { applicationVersionId: 'av1', fieldKey: 'NAME', entryIndex: 0, valueOrdinal: 0, valueText: 'Kuku' },
    ])
    expect(after.NOTICE ?? null).toBeNull()
    expect(after.NAME).toBe('Kuku')
  })
})
