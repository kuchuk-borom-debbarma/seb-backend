/**
 * A refused transition must leave nothing behind.
 *
 * Every guarded write is one transaction: an `UPDATE` carrying the expected
 * version in its `WHERE`, then inserts that fire only if that update landed.
 * The second half is the fragile one — it cannot see the update's result, so
 * it re-states the condition, and a re-stated condition can be true for a
 * reason the update was not.
 *
 * The case here is the one that actually happens: an officer whose page is one
 * version stale. Their update matches nothing, which is right. Their *inserts*
 * must match nothing either, or the application acquires a decision nobody
 * decided — invisible, because the caller was told the write was refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { graphql, openCycle, signIn, submittedApplication } from '../support/api'
import { completeAnswers } from '../support/form'
import { activeDatabase } from '../support/harness'
import { createLoaders } from '../../src/loaders'
import { recordDecisionWrite } from '../../src/services/admin/queries/decision'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const deskChecks = [
  'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
  'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
  'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE',
].map((checkType) => ({
  checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
}))

const identifiers = [
  { kind: 'BANK_ACCOUNT', value: '123456789012', branchCode: 'SBIN0001234' },
  { kind: 'IDENTITY_DOCUMENT', value: '123412341234', branchCode: null },
  { kind: 'ST_CERTIFICATE', value: 'ST/2020/0001', branchCode: null },
]

/** An application carried to the point where it can be decided. */
const readyToDecide = async (
  requestedPaise = 10_000_000,
): Promise<{
  applicationId: string
  cycleId: string
  cookie: string
  reasonId: (context: string) => Promise<string>
  live: () => Promise<number>
  decisionCount: () => Promise<number>
}> => {
    const officer = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(officer.cookie)
    const submitted = await submittedApplication(officer.cookie, officer.userId, cycle.id, {
      answers: { ...completeAnswers(), SEED_FUND_REQUESTED_PAISE: requestedPaise },
    })
    const applicationId = submitted.applicationId

    const reasonId = async (context: string) => (await env.DB.prepare(
      `SELECT id FROM seb_programme_cycle_reason WHERE programme_cycle_id = ?
         AND programme_cycle_version = 2 AND context = ? LIMIT 1`,
    ).bind(cycle.id, context).first<{ id: string }>())!.id
    const live = async () => (await env.DB.prepare(
      `SELECT status_version AS "v" FROM seb_application WHERE id = ?`,
    ).bind(applicationId).first<{ v: number }>())!.v
    const decisionCount = async () => (await env.DB.prepare(
      `SELECT count(*)::int AS "n" FROM seb_programme_decision WHERE application_id = ?`,
    ).bind(applicationId).first<{ n: number }>())!.n

    // Desk review, bank referral and a bank outcome, so a decision is possible.
    await graphql<any>(`mutation($i: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $i) { success } } } }`,
      { i: { applicationId, expectedStatusVersion: await live() } }, officer.cookie)
    const review = await graphql<any>(`mutation($i: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $i) { success message response { reviews { id } } } } } }`,
      { i: {
        conflictAcknowledged: true, applicationId, expectedStatusVersion: await live(),
        outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
        checks: deskChecks, identifiers, revisions: [],
      } }, officer.cookie)
    expect(review.data.admin.intake.completeDeskReview.success,
      review.data.admin.intake.completeDeskReview.message).toBe(true)
    const reviewId = review.data.admin.intake.completeDeskReview.response.reviews[0].id
    const referral = await graphql<any>(`mutation($i: BankReferralInput!) {
      admin { decision { referToBank(input: $i) { success message response { referrals { id } } } } } }`,
      { i: {
        applicationId, submissionId: submitted.submissionId, deskReviewId: reviewId,
        expectedStatusVersion: await live(), bankName: 'Tripura Gramin Bank',
        referralReference: `REF-${applicationId}`, referralDate: '2026-05-01',
        applicantMessage: 'Referred.',
      } }, officer.cookie)
    expect(referral.data.admin.decision.referToBank.success,
      referral.data.admin.decision.referToBank.message).toBe(true)
    const bank = await graphql<any>(`mutation($i: BankOutcomeInput!) {
      admin { decision { recordBankOutcome(input: $i) { success message } } } }`,
      { i: {
        applicationId, referralId: referral.data.admin.decision.referToBank.response.referrals[0].id,
        expectedStatusVersion: await live(), expectedReferralVersion: 1,
        outcome: 'RECOMMENDED', decisionReference: `BO-${applicationId}`,
        decisionDate: '2026-05-10', availableLoanAmountPaise: '500000',
        applicantSummary: 'Recommended.', internalNote: null, revisions: [],
      } }, officer.cookie)
    expect(bank.data.admin.decision.recordBankOutcome.success,
      bank.data.admin.decision.recordBankOutcome.message).toBe(true)
  return { applicationId, cycleId: cycle.id, cookie: officer.cookie, reasonId, live, decisionCount }
}

describe('a refused transition', () => {
  it('writes no decision when the caller quotes a version one behind', async () => {
    const { applicationId, cookie: officerCookie, reasonId, live, decisionCount } =
      await readyToDecide()

    const current = await live()
    expect(await decisionCount()).toBe(0)

    /*
     * One version behind. The update's `WHERE status_version = current - 1`
     * matches nothing — but the follow-on insert asked whether the head had
     * reached `(current - 1) + 1`, which is where it already was, so the
     * decision row landed anyway.
     */
    const stale = await graphql<any>(`mutation($i: DecisionInput!) {
      admin { decision { recordDecision(input: $i) { success message } } } }`,
      { i: {
        conflictAcknowledged: true, applicationId, expectedStatusVersion: current - 1,
        outcome: 'REJECTED', decisionReference: `STALE-${applicationId}`,
        decisionDate: '2026-06-15', approvedAmountPaise: null, applicantConditions: null,
        reasonCategoryId: await reasonId('REJECTION'),
        applicantMessage: 'Recorded from a stale page.', revisions: [],
      } }, officerCookie)

    expect(stale.data.admin.decision.recordDecision.success).toBe(false)
    expect(await live(), 'the head must not move').toBe(current)
    expect(await decisionCount(), 'a refused decision must leave no row').toBe(0)
  })
})

describe('what a decision may approve', () => {
  /**
   * The bound is arithmetic, not alphabetical.
   *
   * The guard read `${approved} > 0 AND ${approved} <= ${requested}`, which
   * binds the amount twice — leaving the second comparison with an untyped
   * parameter on both sides, which Postgres resolves as `text`. Both amounts
   * here are chosen so the string order and the numeric order disagree, which
   * is the ordinary case rather than a contrived one: any pair whose digit
   * counts differ will do.
   */
  const approve = async (
    seeded: Awaited<ReturnType<typeof readyToDecide>>,
    approvedAmountPaise: string,
  ) => {
    const body = await graphql<any>(`mutation($i: DecisionInput!) {
      admin { decision { recordDecision(input: $i) { success message } } } }`,
      { i: {
        conflictAcknowledged: true, applicationId: seeded.applicationId,
        expectedStatusVersion: await seeded.live(), outcome: 'APPROVED',
        decisionReference: `APPROVE-${seeded.applicationId}`, decisionDate: '2026-06-15',
        approvedAmountPaise, applicantConditions: null, reasonCategoryId: null,
        applicantMessage: 'Approved.', revisions: [],
      } }, seeded.cookie)
    return body.data.admin.decision.recordDecision
  }

  it('allows an approval smaller than the request, whatever the digits say', async () => {
    // '900000' > '10000000' as text, so the string comparison refuses this.
    const seeded = await readyToDecide(10_000_000)
    expect(await approve(seeded, '900000')).toMatchObject({ success: true })
  })

  it('refuses an approval larger than the request', async () => {
    const seeded = await readyToDecide(900_000)
    expect(await approve(seeded, '5000000')).toMatchObject({ success: false })
    expect(await seeded.decisionCount(), 'and left nothing behind').toBe(0)
  })

  /**
   * The same bound, at the layer below.
   *
   * The controller checks it too, and refuses first — so the test above passes
   * whether or not the write's own guard works, and it did pass while the
   * guard was inverted. This one calls the write directly, which is the only
   * way to see the layer this repository deliberately duplicates.
   *
   * `'5000000' <= '900000'` is true as text. With the bound applied to digits
   * rather than numbers, this write accepted an approval more than five times
   * what the applicant asked for.
   */
  it('refuses it in the write as well, not only in the controller', async () => {
    const seeded = await readyToDecide(900_000)
    const submissionId = (await env.DB.prepare(
      `SELECT id FROM seb_application_submission WHERE application_id = ?
        ORDER BY submission_number DESC LIMIT 1`,
    ).bind(seeded.applicationId).first<{ id: string }>())!.id
    const actorId = (await env.DB.prepare(
      `SELECT applicant_user_id AS "id" FROM seb_application WHERE id = ?`,
    ).bind(seeded.applicationId).first<{ id: string }>())!.id

    const wrote = await recordDecisionWrite({
      db: activeDatabase(),
      loaders: createLoaders(activeDatabase()),
      env,
      requestHeaders: new Headers(),
      requestUrl: 'https://api.example.test/graphql',
      responseHeaders: new Headers(),
    } as never, {
      applicationId: seeded.applicationId,
      submissionId,
      expectedStatusVersion: await seeded.live(),
      actorId,
      outcome: 'APPROVED',
      reference: `OVER-${seeded.applicationId}`,
      date: '2026-06-15',
      approvedAmountPaise: 5_000_000,
      conditions: null,
      reasonCategoryId: null,
      applicantMessage: 'More than was asked for.',
      revisions: [],
      requestedAmountPaise: 900_000,
      conflictAcknowledged: true,
      now: new Date(),
    })

    expect(wrote, 'the write must refuse it on its own').toBe(false)
    expect(await seeded.decisionCount(), 'and record nothing').toBe(0)
  })

  it('refuses an approval of nothing', async () => {
    const seeded = await readyToDecide(900_000)
    expect(await approve(seeded, '0')).toMatchObject({ success: false })
  })
})
