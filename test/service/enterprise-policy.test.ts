/**
 * The enterprise cap, and what makes two enterprises the same one.
 *
 * The cap matters because it is enforced twice — a friendly check in the
 * controller and a term inside the guarded insert — and the two must agree
 * about what the limit is. These pin the reading of the configuration; the
 * concurrency half is proved against a real database where the insert lives.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_ENTERPRISES_PER_USER,
  comparableEnterpriseName,
  enterpriseLimitReached,
  maxEnterprisesPerUser,
} from '../../src/services/application/enterprise-policy'

describe('reading the configured cap', () => {
  it('takes the documented default when nothing is set', () => {
    expect(maxEnterprisesPerUser(undefined)).toEqual({
      ok: true,
      limit: DEFAULT_MAX_ENTERPRISES_PER_USER,
    })
    expect(maxEnterprisesPerUser('')).toEqual({
      ok: true,
      limit: DEFAULT_MAX_ENTERPRISES_PER_USER,
    })
    expect(maxEnterprisesPerUser('   ')).toEqual({
      ok: true,
      limit: DEFAULT_MAX_ENTERPRISES_PER_USER,
    })
  })

  it('takes a configured value', () => {
    expect(maxEnterprisesPerUser('12')).toEqual({ ok: true, limit: 12 })
    expect(maxEnterprisesPerUser(' 3 ')).toEqual({ ok: true, limit: 3 })
  })

  /*
   * A present but unusable value is a deployment mistake. Falling back to the
   * default would hide it, and the deployment would run with a limit nobody
   * chose — the same reason a missing provider key refuses rather than printing
   * one-time codes to a log.
   *
   * `0x10` and `1e3` are the ones a plain `Number()` would have taken as sixteen
   * and a thousand. Surrounding whitespace is deliberately *not* here: it is
   * trimmed, because somebody typing a limit into a deployment console should
   * not be caught out by a trailing space.
   */
  const rejected = [
    'nonsense', '0', '-1', '2.5', '51', 'NaN', 'Infinity', '1e3', '0x10', '+5', '٥',
  ]
  it.each(rejected)('refuses %s rather than falling back', (value) => {
    const result = maxEnterprisesPerUser(value)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/misconfigured/)
  })

  it('accepts the exact bounds and refuses just outside them', () => {
    expect(maxEnterprisesPerUser('1').ok).toBe(true)
    expect(maxEnterprisesPerUser('50').ok).toBe(true)
    expect(maxEnterprisesPerUser('0').ok).toBe(false)
    expect(maxEnterprisesPerUser('51').ok).toBe(false)
  })
})

describe('what the applicant is told', () => {
  it('names the limit, so they can tell whether deleting one would help', () => {
    expect(enterpriseLimitReached(5)).toContain('5 enterprises')
    expect(enterpriseLimitReached(5)).toContain('Delete one')
  })

  it('reads correctly when the limit is one', () => {
    expect(enterpriseLimitReached(1)).toContain('1 enterprise at a time')
  })
})

describe('when two names are the same name', () => {
  it('ignores case, which is what the unique index does', () => {
    expect(comparableEnterpriseName('Example Foods')).toBe(
      comparableEnterpriseName('EXAMPLE FOODS'),
    )
  })

  /*
   * Deliberately *not* whitespace-collapsing.
   *
   * The index is on `lower(current_name)` and nothing else. Collapsing here but
   * not there would make this check refuse a name the database would happily
   * accept — and the applicant would be told a name is taken when it is not.
   */
  it('does not collapse whitespace, because the index does not either', () => {
    expect(comparableEnterpriseName('Example  Foods')).not.toBe(
      comparableEnterpriseName('Example Foods'),
    )
  })
})
