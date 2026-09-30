/**
 * Each eligibility rule, against a history built by hand.
 *
 * A cycle's application kinds are configured, so what makes an enterprise
 * eligible for an expansion is a list of these rules rather than code. Each is
 * pure over an `EligibilityHistory`, which is what makes them testable without
 * a database: the one read that builds the history is exercised by the
 * application suite, and this proves what each rule concludes from it —
 * including the direction that matters, that a missing fact refuses rather
 * than passes.
 */
import { describe, expect, it } from 'vitest'
import { eligibilityOf, type EligibilityHistory, type PriorApplication } from '../../src/services/application/eligibility'
import { monthsBetween } from '../../src/services/application/eligibility/define'

const now = new Date('2026-09-30T00:00:00Z')

const prior = (overrides: Partial<PriorApplication> = {}): PriorApplication => ({
  kind: 'INITIAL',
  pipelineKey: 'MISSION_SEP',
  draft: false,
  finished: true,
  flags: ['COMPLETED', 'GRANT_APPROVED'],
  flagAddedAt: { GRANT_APPROVED: new Date('2025-06-15T00:00:00Z'), COMPLETED: new Date('2025-07-01T00:00:00Z') },
  recorded: { APPROVED_GRANT_PAISE: 25_000_000 },
  ...overrides,
})

const history = (applications: PriorApplication[], established: string | null = '2020-01-01'): EligibilityHistory => ({
  now,
  enterpriseEstablishedOn: established,
  applications,
})

describe('PRIOR_APPLICATION_HAS_FLAG', () => {
  const rule = (params: Record<string, unknown>) => [{ type: 'PRIOR_APPLICATION_HAS_FLAG' as const, params }]

  it('needs an earlier application holding the flag', () => {
    expect(eligibilityOf(rule({ flag: 'GRANT_APPROVED' }), history([prior()])).eligible).toBe(true)
    expect(eligibilityOf(rule({ flag: 'LOAN_APPROVED' }), history([prior()]))).toEqual({
      eligible: false,
      reasons: ['This needs an earlier application that reached the required outcome.'],
    })
  })

  it('reads only the pipeline it names, when it names one', () => {
    expect(eligibilityOf(rule({ flag: 'GRANT_APPROVED', pipelineKey: 'MISSION_SEP' }), history([prior()])).eligible).toBe(true)
    expect(eligibilityOf(rule({ flag: 'GRANT_APPROVED', pipelineKey: 'OTHER_SCHEME' }), history([prior()])).eligible).toBe(false)
  })

  it('opens only once enough months have passed since the flag was added', () => {
    expect(eligibilityOf(rule({ flag: 'GRANT_APPROVED', minMonthsSinceFlag: 12 }), history([prior()])).eligible).toBe(true)
    expect(eligibilityOf(rule({ flag: 'GRANT_APPROVED', minMonthsSinceFlag: 18 }), history([prior()]))).toEqual({
      eligible: false,
      reasons: ['This opens 18 months after the earlier application\'s outcome.'],
    })
  })

  it('refuses a flag held with no record of when it was added', () => {
    expect(eligibilityOf(rule({ flag: 'GRANT_APPROVED' }), history([prior({ flagAddedAt: {} })])).eligible).toBe(false)
  })
})

describe('PRIOR_RECORDED_VALUE_AT_LEAST', () => {
  const rule = (amountPaise: number) => [{ type: 'PRIOR_RECORDED_VALUE_AT_LEAST' as const, params: { value: 'APPROVED_GRANT_PAISE', amountPaise } }]

  it('needs an earlier recorded amount at least as large', () => {
    expect(eligibilityOf(rule(25_000_000), history([prior()])).eligible).toBe(true)
    expect(eligibilityOf(rule(25_000_001), history([prior()]))).toEqual({
      eligible: false,
      reasons: ['This needs an earlier application with a larger recorded outcome.'],
    })
  })

  it('refuses a value that was never recorded as an amount', () => {
    expect(eligibilityOf(rule(1), history([prior({ recorded: { APPROVED_GRANT_PAISE: 'lots' } })])).eligible).toBe(false)
    expect(eligibilityOf(rule(1), history([])).eligible).toBe(false)
  })
})

describe('NO_OPEN_APPLICATION_OF_KIND', () => {
  const rule = [{ type: 'NO_OPEN_APPLICATION_OF_KIND' as const, params: { kind: 'EXPANSION' } }]

  it('refuses while one of the kind is unfinished, draft or not', () => {
    expect(eligibilityOf(rule, history([prior()])).eligible).toBe(true)
    expect(eligibilityOf(rule, history([prior({ kind: 'EXPANSION', finished: false })]))).toEqual({
      eligible: false,
      reasons: ['You already have an application of this kind in progress.'],
    })
    expect(eligibilityOf(rule, history([prior({ kind: 'EXPANSION', draft: true, finished: false })])).eligible).toBe(false)
  })
})

describe('MAX_APPLICATIONS_OF_KIND', () => {
  const rule = (max: number) => [{ type: 'MAX_APPLICATIONS_OF_KIND' as const, params: { kind: 'INITIAL', max } }]

  it('counts submitted applications of the kind, never drafts', () => {
    expect(eligibilityOf(rule(2), history([prior()])).eligible).toBe(true)
    expect(eligibilityOf(rule(1), history([prior()]))).toEqual({
      eligible: false,
      reasons: ['Your enterprise has already made as many applications of this kind as the programme allows.'],
    })
    expect(eligibilityOf(rule(1), history([prior({ draft: true, finished: false })])).eligible).toBe(true)
  })
})

describe('ENTERPRISE_AGE_AT_LEAST', () => {
  const rule = (months: number) => [{ type: 'ENTERPRISE_AGE_AT_LEAST' as const, params: { months } }]

  it('needs the enterprise to be old enough', () => {
    expect(eligibilityOf(rule(12), history([], '2025-09-30')).eligible).toBe(true)
    expect(eligibilityOf(rule(13), history([], '2025-09-30'))).toEqual({
      eligible: false,
      reasons: ['Your enterprise must have been established at least 13 months ago.'],
    })
  })

  it('refuses an enterprise that has not said when it was established', () => {
    expect(eligibilityOf(rule(0), history([], null))).toEqual({
      eligible: false,
      reasons: ['Add your enterprise’s establishment date to its profile.'],
    })
  })
})

describe('a kind’s rules together', () => {
  it('passes with no rules, and lists every reason when several fail', () => {
    expect(eligibilityOf([], history([]))).toEqual({ eligible: true, reasons: [] })
    const both = eligibilityOf([
      { type: 'ENTERPRISE_AGE_AT_LEAST', params: { months: 0 } },
      { type: 'PRIOR_APPLICATION_HAS_FLAG', params: { flag: 'COMPLETED' } },
    ], history([], null))
    expect(both.reasons).toHaveLength(2)
  })

  it('refuses a stored rule whose parameters this build no longer accepts, rather than passing it', () => {
    expect(eligibilityOf([{ type: 'MAX_APPLICATIONS_OF_KIND', params: { kind: 'INITIAL', max: -1 } }], history([]))).toEqual({
      eligible: false,
      reasons: ['This kind of application cannot be started at the moment.'],
    })
  })

  it('counts a month only once its day has come round', () => {
    expect(monthsBetween(new Date('2026-01-31T00:00:00Z'), new Date('2026-02-28T00:00:00Z'))).toBe(0)
    expect(monthsBetween(new Date('2026-01-15T00:00:00Z'), new Date('2026-02-15T00:00:00Z'))).toBe(1)
  })
})
