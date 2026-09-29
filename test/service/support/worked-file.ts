/**
 * A file carried through desk review and the bank to the point of decision,
 * through the real mutations.
 *
 * Shared because two suites ask about the same history from two sides: what
 * each row says (`casework-audit.test.ts`) and whether the migration derives
 * exactly what the row builder wrote (`audit-backfill.test.ts`).
 */
import { expect } from 'vitest'
import { env } from '../../support/worker'
import { graphql, openCycle, signIn, submittedApplication } from '../../support/api'
import { completeAnswers } from '../../support/form'

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

export type AuditRow = {
  action: string
  payload: Record<string, unknown> | null
  payload_version: number
  metadata_json: string | null
  application_id: string | null
  subject_user_id: string | null
}

/**
 * A file carried through desk review and the bank to the point of decision.
 *
 * The officer is also the applicant and says so, which is what makes the
 * self-review disclosures fire — and what makes the subject of every row,
 * the applicant, a person this test knows.
 */
export const workedFile = async (options: {
  /**
   * A different person applies than works the file. Off by default, because the
   * self-review disclosures need the officer to be the applicant; on wherever
   * "who acted" and "whose file" must be told apart.
   */
  separateApplicant?: boolean
} = {}) => {
  const officer = await signIn({ roles: options.separateApplicant ? ['SUPER_ADMIN'] : ['APPLICANT', 'SUPER_ADMIN'] })
  const applicant = options.separateApplicant ? await signIn({ roles: ['APPLICANT'] }) : officer
  const cycle = await openCycle(officer.cookie)
  const submitted = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, {
    answers: { ...completeAnswers(), SEED_FUND_REQUESTED_PAISE: 10_000_000 },
  })
  const applicationId = submitted.applicationId
  const live = async () => (await env.DB.prepare(
    `SELECT status_version AS "v" FROM seb_application WHERE id = ?`,
  ).bind(applicationId).first<{ v: number }>())!.v

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
  const referral = await graphql<any>(`mutation($i: BankReferralInput!) {
    admin { decision { referToBank(input: $i) { success message response { referrals { id } } } } } }`,
  { i: {
    applicationId, submissionId: submitted.submissionId,
    deskReviewId: review.data.admin.intake.completeDeskReview.response.reviews[0].id,
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

  const decide = async (expectedStatusVersion: number) => (await graphql<any>(
    `mutation($i: DecisionInput!) {
      admin { decision { recordDecision(input: $i) { success message } } } }`,
    { i: {
      conflictAcknowledged: true, applicationId, expectedStatusVersion,
      outcome: 'APPROVED', decisionReference: `DEC-${applicationId}`,
      decisionDate: '2026-06-15', approvedAmountPaise: '900000', applicantConditions: null,
      reasonCategoryId: null, applicantMessage: 'Approved.', revisions: [],
    } }, officer.cookie,
  )).data.admin.decision.recordDecision

  const rows = async () => (await env.DB.prepare(
    `SELECT action, payload, payload_version, metadata_json, application_id, subject_user_id
       FROM core_audit_event
      WHERE action IN ('SEB.DESK_REVIEW_STARTED', 'SEB.DESK_REVIEW_COMPLETED',
        'SEB.SELF_REVIEW_DISCLOSED', 'SEB.BANK_REFERRED', 'SEB.BANK_OUTCOME_RECORDED',
        'SEB.DECISION_RECORDED')
      ORDER BY created_at, id`,
  ).all<AuditRow>()).results

  return { applicantId: applicant.userId, officerId: officer.userId, applicationId, live, decide, rows }
}

