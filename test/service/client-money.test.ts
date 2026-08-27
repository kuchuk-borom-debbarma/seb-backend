/**
 * The client's rupees ↔ paise pair, against the server's own idea of an amount.
 *
 * Imported directly for the reason `client-parity.test.ts` imports the client's
 * visibility rules: this is where an applicant's money is converted, and a
 * fixture of expected values would only record what somebody believed when they
 * wrote it.
 *
 * The property that matters is the round trip. Every amount the schema permits
 * must come back as itself — the pair used to divide and multiply by 100 in
 * floating point, which is true for small amounts and stops being true long
 * before the ceiling.
 */
import { describe, expect, it } from 'vitest'
import { paiseToRupees, rupeesToPaise } from '../../dev-web/src/features/application/money'

/** The schema's own ceiling on a money column. */
const MAX_PAISE = 9007199254740991

describe('an amount on its way to and from the screen', () => {
  it.each([
    [0, '0'],
    [7, '0.07'],
    [70, '0.70'],
    [100, '1'],
    [12345, '123.45'],
    [100000000, '1000000'],
    [MAX_PAISE, '90071992547409.91'],
  ])('shows %i paise as %s', (paise, rupees) => {
    expect(paiseToRupees(paise)).toBe(rupees)
  })

  it.each([
    ['', null],
    ['   ', null],
    ['0', 0],
    ['0.07', 7],
    ['.07', 7],
    ['1', 100],
    ['1.5', 150],
    ['123.45', 12345],
    ['90071992547409.91', MAX_PAISE],
  ])('reads %s as %s', (rupees, paise) => {
    expect(rupeesToPaise(rupees)).toBe(paise)
  })

  /**
   * Not an amount is not the same as no amount.
   *
   * `Math.round(Number('abc') * 100)` is `NaN`, and JSON encodes `NaN` as
   * `null` — so a stray character in the box **cleared the answer** instead of
   * being ignored. The two outcomes have to be told apart before the caller
   * can choose to leave the field alone.
   */
  it.each(['abc', '1.2.3', '1e5', '1,000', '-', '1.234', '  12 34 '])(
    'refuses %s as something that is not an amount',
    (typed) => {
      expect(rupeesToPaise(typed)).toBeUndefined()
    },
  )

  it('refuses an amount past what the column can hold', () => {
    expect(rupeesToPaise('90071992547409.92')).toBeUndefined()
  })

  /*
   * The round trip, across the whole permitted range rather than a handful of
   * friendly numbers. Seeded and deterministic, printing the value on failure —
   * the same reasoning as the generated-template properties.
   */
  it('returns every amount it was given', () => {
    let seed = 20260826
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 2000; round += 1) {
      const paise = Math.floor(next() * MAX_PAISE)
      expect(rupeesToPaise(paiseToRupees(paise)), `${paise}`).toBe(paise)
    }
  })

  /*
   * The value the old pair actually lost, kept as a case of its own so the
   * property above cannot be weakened without this going red too.
   */
  it('does not drift at the top of the range, where dividing by 100 did', () => {
    for (const paise of [MAX_PAISE, MAX_PAISE - 1, 4999999999999999, 8999999999999999]) {
      expect(rupeesToPaise(paiseToRupees(paise)), `${paise}`).toBe(paise)
    }
  })
})
