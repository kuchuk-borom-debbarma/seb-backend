import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../src/db'
import {
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
} from '../src/db/schema'
import { eq } from 'drizzle-orm'
import {
  calculateRecoveryBalance,
  closeExpiredProgrammeCycles,
  createProgrammeCycle,
  recordDocumentScanResult,
} from '../src/services/admin'
import {
  adminAudit,
  changedExactlyOne,
  constraintSafe,
  failure,
  normalizeOptionalText,
  normalizeRequiredText,
  success,
} from '../src/services/admin/support'
import { sessionTokenDigest } from '../src/services/auth/crypto'
import { findSubmissionPolicy } from '../src/services/application/queries/application'
import { adminResolvers } from '../src/graphql/resolvers/admin/admin'

type GraphQLBody<T> = { data?: T; errors?: Array<{ message: string }> }

const adminSession = async (roles: Array<'APPLICANT' | 'ADMIN' | 'SUPER_ADMIN'>) => {
  const userId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_user (
        id, email, password_hash, email_verified_at, row_version, created_at, updated_at
      ) VALUES (?, ?, 'unused', ?, 1, ?, ?)`,
    ).bind(userId, `${userId}@example.test`, now, now, now),
    ...roles.map((role) => env.DB.prepare(
      `INSERT INTO core_user_role_grant (
        id, user_id, role, grant_reason, granted_at
      ) VALUES (?, ?, ?, 'ADMIN_TEST', ?)`,
    ).bind(crypto.randomUUID(), userId, role, now)),
    env.DB.prepare(
      `INSERT INTO core_session (
        id, user_id, token_digest, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      userId,
      await sessionTokenDigest(env.AUTH_SECRET, token),
      now + 86_400_000,
      now,
      now,
    ),
  ])
  return { userId, cookie: `seb_session=${token}` }
}

const adminContext = (cookie: string) => ({
  db: createDatabase(env.DB), env,
  requestHeaders: new Headers({ cookie, origin: 'https://app.example.test' }),
  requestUrl: 'https://api.example.test/graphql', responseHeaders: new Headers(),
})

const graphql = async <T>(query: string, variables: unknown, cookie?: string) => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: 'https://app.example.test',
  })
  if (cookie) headers.set('cookie', cookie)
  const response = await SELF.fetch('https://api.example.test/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })
  return (await response.json()) as GraphQLBody<T>
}

const policy = {
  minimumApplicantAge: 18,
  maximumApplicantAge: 60,
  categoryAMaximumMonths: 24,
  expansionWaitMonths: 12,
  majorityOwnershipRequired: true,
  jurisdiction: 'TTAADC',
  fundingCeilingState: 'UNRESOLVED',
  fundingCeilingAmountPaise: null,
  fundingCeilingScope: null,
  requiredAssessmentTypes: ['UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT'],
  documentRules: [
    'IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF', 'BUSINESS_REGISTRATION',
    'GST_REGISTRATION', 'DPR', 'BANK_DETAILS', 'NOC',
  ].map((documentType) => ({ documentType, condition: 'ALWAYS' })),
  reasons: [
    'CYCLE_CLOSE', 'ASSIGNMENT_RELEASE', 'ASSIGNMENT_REASSIGN', 'REVISION',
    'REJECTION', 'BANK_REFERRAL_CANCEL', 'BANK_OUTCOME_CORRECTION', 'TTM_DEFERRAL',
    'TTM_DECISION_CORRECTION', 'AWARD_AMENDMENT', 'AWARD_SUSPENSION',
    'AWARD_CANCELLATION', 'AWARD_CLOSURE', 'RELEASE_REVERSAL', 'RECOVERY',
    'RECOVERY_WAIVER',
  ].map((context) => ({ context, code: `${context}_TEST`, label: `${context} reason` })),
}

const deskCheckTypes = [
  'IDENTITY_KYC', 'ST_ELIGIBILITY', 'MAJORITY_OWNERSHIP', 'JURISDICTION',
  'FORM_COMPLETENESS', 'DOCUMENT_COMPLETENESS', 'ANSWER_DOCUMENT_CONSISTENCY',
  'DPR_FEASIBILITY', 'EXPANSION_EVIDENCE',
]

/**
 * The numbers a reviewer would read off the documents, distinct per call.
 *
 * Distinct because they have to be: two applications carrying the same
 * certificate number is exactly what the duplicate check refuses, so a shared
 * fixture would make every second review in this file fail — which would be the
 * feature working, not a fixture problem.
 */
let identifierSequence = 0
const passingIdentifiers = () => {
  identifierSequence += 1
  const n = String(identifierSequence).padStart(6, '0')
  return [
    { kind: 'ST_CERTIFICATE', value: `TR-ST-2026-${n}` },
    { kind: 'IDENTITY_DOCUMENT', value: `9${n}000${n}`.slice(0, 12) },
    { kind: 'BANK_ACCOUNT', value: `500100${n}`, branchCode: 'SBIN0007890' },
  ]
}

const createOpenedCycle = async (cookie: string) => {
  const cycle = {
    cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    displayName: 'Mission SEP Administrative Test', cycleYear: 2026,
    policyReference: 'TTAADC/MSEP/2026', applicantGuidance: 'Applicant guide.',
    partnerBankGuidance: 'Published partner-bank roster.',
    opensAt: new Date(Date.now() - 1_000).toISOString(),
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), policy,
  }
  const created = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
    admin { programmeCycle { create(input: $input) { response { head { id currentVersion } } } } }
  }`, { input: cycle }, cookie)
  const head = created.data?.admin.programmeCycle.create.response.head
  const opened = await graphql<any>(`mutation($input: CycleTransitionInput!) {
    admin { programmeCycle { open(input: $input) { response { head { id currentVersion } } } } }
  }`, { input: { id: head.id, expectedVersion: head.currentVersion, reason: 'Publish' } }, cookie)
  return opened.data.admin.programmeCycle.open.response.head as { id: string; currentVersion: number }
}

const createSubmittedApplication = async (cookie: string, userId: string, cycleId: string) => {
  const enterprise = await graphql<any>(`mutation($input: EnterpriseProfileInput!) {
    seb { enterprise { create(input: $input) { response { id } } } }
  }`, { input: {
    name: 'Administrative Test Enterprise', establishmentDate: '2026-01-01',
    registrationType: 'NONE', registrationNumber: null, gstin: null,
    businessSector: 'FOOD_PROCESSING', otherBusinessSector: null,
    businessBlockOrVillage: 'Khumulwng', businessDistrict: 'West Tripura',
    businessPinCode: '799045', contactNumber: '+919876543210',
    contactEmail: 'rina@example.test',
  } }, cookie)
  const enterpriseId = enterprise.data.seb.enterprise.create.response.id as string
  const application = await graphql<any>(`mutation($input: StartApplicationInput!) {
    seb { application { startInitial(input: $input) { response { id } } } }
  }`, { input: { enterpriseId, programmeCycleId: cycleId } }, cookie)
  const applicationId = application.data.seb.application.startInitial.response.id as string
  const submissionId = crypto.randomUUID()
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(`UPDATE seb_application SET reference_number = ?, status = 'SUBMITTED',
      status_version = 2, first_submitted_at = ?, status_changed_at = ?, updated_at = ?
      WHERE id = ?`).bind(`SEP-2026-${applicationId.slice(0, 8)}`, now, now, now, applicationId),
    env.DB.prepare(`UPDATE seb_application_version SET seed_fund_requested_paise = 1000000,
      application_category = 'CATEGORY_A'
      WHERE application_id = ? AND version = 1`).bind(applicationId),
    env.DB.prepare(`INSERT INTO seb_application_submission (
      id, application_id, submission_number, application_version,
      submitted_by_user_id, submitted_at
    ) VALUES (?, ?, 1, 1, ?, ?)`).bind(submissionId, applicationId, userId, now),
  ])
  return { applicationId, submissionId }
}

const reasonId = async (cycleId: string, context: string) => {
  const row = await env.DB.prepare(`SELECT id FROM seb_programme_cycle_reason
    WHERE programme_cycle_id = ? AND programme_cycle_version = 2 AND context = ? LIMIT 1`)
    .bind(cycleId, context).first<{ id: string }>()
  if (!row) throw new Error(`Missing reason ${context}`)
  return row.id
}

describe('Mission SEP administration', () => {
  it('requires a live administrative role for every admin query and mutation', async () => {
    const calls = [
      'query { admin { programmeCycle { list { success } } } }',
      'query { admin { programmeCycle { byId(id: "x") { success } } } }',
      'query { admin { programmeCycle { counts(id: "x") { success } } } }',
      'query { admin { programmeCycle { events(id: "x") { success } } } }',
      'query { admin { intake { queue { success } } } }',
      'query { admin { intake { byReference(referenceNumber: "x") { success } } } }',
      'query { admin { intake { workspace(applicationId: "x") { success } } } }',
      'query { admin { intake { documentDownloadUrl(applicationId: "x", submissionDocumentId: "x") { success } } } }',
      'query { admin { decision { meetings { success } } } }',
      'query { admin { decision { meetingById(meetingId: "x") { success } } } }',
      'query { admin { funding { byApplication(applicationId: "x") { success } } } }',
      'query { admin { funding { recoveryById(recoveryCaseId: "x") { success } } } }',
      `mutation { admin { programmeCycle { create(input: {
        cycleCode: "SEP-X", displayName: "X", cycleYear: 2026,
        policy: { requiredAssessmentTypes: [], documentRules: [], reasons: [] }
      }) { success } } } }`,
      `mutation { admin { programmeCycle { updateDraft(input: {
        id: "x", expectedVersion: 1, reason: "x", cycle: {
          cycleCode: "SEP-X", displayName: "X", cycleYear: 2026,
          policy: { requiredAssessmentTypes: [], documentRules: [], reasons: [] }
        }
      }) { success } } } }`,
      'mutation { admin { programmeCycle { softDeleteDraft(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { restoreDraft(id: "x", expectedVersion: 1) { success } } } }',
      'mutation { admin { programmeCycle { open(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { close(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { archive(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { updateOpenGuidance(input: { id: "x", expectedVersion: 1, applicantGuidance: "x", partnerBankGuidance: "x", reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { changeClosingTime(input: { id: "x", expectedVersion: 1, closesAt: "2030-01-01T00:00:00Z", reason: "x" }) { success } } } }',
      'mutation { admin { intake { claim(input: { applicationId: "x", expectedAssignmentVersion: 0, conflictAcknowledged: false }) { success } } } }',
      'mutation { admin { intake { release(input: { applicationId: "x", expectedAssignmentVersion: 1, reasonCategoryId: "x", reason: "x" }) { success } } } }',
      'mutation { admin { intake { reassign(input: { applicationId: "x", expectedAssignmentVersion: 1, toUserId: "x", reasonCategoryId: "x", reason: "x", conflictAcknowledged: false }) { success } } } }',
      'mutation { admin { intake { addInternalNote(input: { applicationId: "x", note: "x" }) { success } } } }',
      'mutation { admin { intake { startDeskReview(input: { applicationId: "x", expectedStatusVersion: 1 }) { success } } } }',
      `mutation { admin { intake { completeDeskReview(input: {
        applicationId: "x", expectedStatusVersion: 1, outcome: ADVANCE_TO_BANK,
        checks: [], revisions: [], identifiers: []
      }) { success } } } }`,
      'mutation { admin { intake { cancelRevision(input: { applicationId: "x", revisionRequestId: "x", expectedStatusVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { decision { cancelBankReferral(input: { applicationId: "x", referralId: "x", expectedReferralVersion: 1, reasonCategoryId: "x", reason: "x", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { decision { referToBank(input: { applicationId: "x", submissionId: "x", deskReviewId: "x", expectedStatusVersion: 1, bankName: "x", referralReference: "x", referralDate: "2026-01-01", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { decision { recordBankOutcome(input: { applicationId: "x", referralId: "x", expectedStatusVersion: 1, expectedReferralVersion: 1, outcome: RECOMMENDED, decisionReference: "x", decisionDate: "2026-01-01", applicantSummary: "x", revisions: [] }) { success } } } }',
      'mutation { admin { decision { correctBankOutcome(input: { applicationId: "x", referralId: "x", supersedesOutcomeId: "x", expectedStatusVersion: 1, outcome: RECOMMENDED, decisionReference: "x", decisionDate: "2026-01-01", applicantSummary: "x", correctionReasonCategoryId: "x", correctionReason: "x", revisions: [] }) { success } } } }',
      'mutation { admin { decision { createMeeting(input: { meetingReference: "x", scheduledAt: "2030-01-01T00:00:00Z", venue: "x" }) { success } } } }',
      'mutation { admin { decision { updateMeeting(input: { meetingId: "x", expectedVersion: 1, meetingReference: "x", scheduledAt: "2030-01-01T00:00:00Z", venue: "x", reason: "x" }) { success } } } }',
      'mutation { admin { decision { cancelMeeting(input: { meetingId: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { decision { addAgendaItem(input: { meetingId: "x", applicationId: "x", submissionId: "x", bankOutcomeId: "x", position: 1 }) { success } } } }',
      'mutation { admin { decision { reorderAgendaItem(input: { meetingId: "x", agendaItemId: "x", expectedVersion: 1, position: 2, reason: "x" }) { success } } } }',
      'mutation { admin { decision { removeAgendaItem(input: { meetingId: "x", agendaItemId: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { decision { startMeeting(input: { meetingId: "x", expectedVersion: 1 }) { success } } } }',
      'mutation { admin { decision { finalizeMeeting(input: { meetingId: "x", expectedVersion: 1 }) { success } } } }',
      'mutation { admin { decision { recordDecision(input: { applicationId: "x", agendaItemId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "x", decisionDate: "2026-01-01", approvedAmountPaise: "1", applicantMessage: "x", revisions: [] }) { success } } } }',
      'mutation { admin { decision { correctDecision(input: { applicationId: "x", agendaItemId: "x", supersedesDecisionId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "x", decisionDate: "2026-01-01", approvedAmountPaise: "1", correctionReasonCategoryId: "x", correctionReason: "x", applicantMessage: "x", revisions: [] }) { success } } } }',
      'mutation { admin { funding { createAward(input: { applicationId: "x", decisionId: "x", expectedStatusVersion: 1, sanctionOrderNumber: "x", sanctionDate: "2026-01-01" }) { success } } } }',
      'mutation { admin { funding { changeAward(input: { awardId: "x", applicationId: "x", expectedVersion: 1, expectedStatusVersion: 1, status: ACTIVE, sanctionedAmountPaise: "1", reasonCategoryId: "x", reason: "x" }) { success } } } }',
      'mutation { admin { funding { recordAssessment(input: { awardId: "x", applicationId: "x", assessmentType: PERFORMANCE, outcome: PASSED, evidenceReference: "x", applicantSummary: "x", assessedAt: "2030-01-01T00:00:00Z" }) { success } } } }',
      'mutation { admin { funding { recordRelease(input: { awardId: "x", applicationId: "x", expectedLedgerVersion: 0, amountPaise: "1", occurredAt: "2030-01-01T00:00:00Z", externalReference: "x", ttmApprovalReference: "x", ttmApprovalDate: "2026-01-01", bankAccountVerifiedAt: "2030-01-01T00:00:00Z", performanceAgreementReference: "x", performanceAgreementExecutedAt: "2030-01-01T00:00:00Z", physicalVerificationRequired: false, applicantMessage: "x" }) { success } } } }',
      'mutation { admin { funding { reverseRelease(input: { awardId: "x", applicationId: "x", releaseId: "x", expectedLedgerVersion: 0, amountPaise: "1", occurredAt: "2030-01-01T00:00:00Z", externalReference: "x", reasonCategoryId: "x", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { funding { openRecovery(input: { awardId: "x", officialDecisionReference: "x", officialDecisionDate: "2026-01-01", reasonCategoryId: "x", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { funding { recordRecoveryEntry(input: { recoveryCaseId: "x", expectedLedgerVersion: 0, entryType: DEMAND, component: PRINCIPAL, amountPaise: "1", externalReference: "x", occurredAt: "2030-01-01T00:00:00Z", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { funding { cancelRecovery(input: { recoveryCaseId: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { funding { closeRecovery(input: { recoveryCaseId: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
    ]
    for (const query of calls) {
      const result = await graphql<any>(query, {})
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
  })

  it('loads live administrative roles and rejects applicants safely', async () => {
    const applicant = await adminSession(['APPLICANT'])
    const denied = await graphql<{
      admin: { programmeCycle: { list: { success: boolean; message: string } } }
    }>('query { admin { programmeCycle { list { success message } } } }', {}, applicant.cookie)
    expect(denied.data?.admin.programmeCycle.list).toEqual({
      success: false,
      message: 'Administrator access is required.',
    })

    const administrator = await adminSession(['ADMIN'])
    const allowed = await graphql<{
      admin: { programmeCycle: { list: { success: boolean } } }
    }>('query { admin { programmeCycle { list { success } } } }', {}, administrator.cookie)
    expect(allowed.data?.admin.programmeCycle.list.success).toBe(true)

    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'TEST'
       WHERE user_id = ? AND role = 'ADMIN' AND revoked_at IS NULL`,
    ).bind(Date.now(), administrator.userId).run()
    const revoked = await graphql<{
      admin: { programmeCycle: { list: { success: boolean; message: string } } }
    }>('query { admin { programmeCycle { list { success message } } } }', {}, administrator.cookie)
    expect(revoked.data?.admin.programmeCycle.list.message).toBe('Administrator access is required.')
  })

  it('creates and opens a complete versioned cycle through GraphQL', async () => {
    const administrator = await adminSession(['SUPER_ADMIN'])
    const cycle = {
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Mission SEP 2026 Test',
      cycleYear: 2026,
      policyReference: 'TTAADC/MSEP/2026',
      applicantGuidance: 'Read the policy and submit complete evidence.',
      partnerBankGuidance: 'Partner-bank roster maintained by TTAADC.',
      opensAt: new Date(Date.now() - 1_000).toISOString(),
      closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      policy,
    }
    const created = await graphql<{
      admin: { programmeCycle: { create: { success: boolean; message: string | null; response: { head: { id: string; currentVersion: number; status: string } } } } }
    }>(`mutation Create($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) {
        success message response { head { id currentVersion status } }
      } } }
    }`, { input: cycle }, administrator.cookie)
    expect(created.errors).toBeUndefined()
    expect(created.data?.admin.programmeCycle.create.success).toBe(true)
    const head = created.data?.admin.programmeCycle.create.response.head
    if (!head) throw new Error('Cycle creation failed.')

    const opened = await graphql<{
      admin: { programmeCycle: { open: { success: boolean; response: { head: { status: string; currentVersion: number } } } } }
    }>(`mutation Open($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) {
        success response { head { status currentVersion } }
      } } }
    }`, { input: { id: head.id, expectedVersion: head.currentVersion, reason: 'Publish test policy' } }, administrator.cookie)
    expect(opened.errors).toBeUndefined()
    expect(opened.data?.admin.programmeCycle.open.response.head).toEqual({
      status: 'OPEN',
      currentVersion: 2,
    })

    const policyRows = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM seb_programme_cycle_document_rule WHERE programme_cycle_id = ?) AS documents,
        (SELECT COUNT(*) FROM seb_programme_cycle_assessment_rule WHERE programme_cycle_id = ?) AS assessments,
        (SELECT COUNT(*) FROM seb_programme_cycle_reason WHERE programme_cycle_id = ?) AS reasons`,
    ).bind(head.id, head.id, head.id).first<{ documents: number; assessments: number; reasons: number }>()
    // Opening copies the normalized rules to immutable version 2.
    expect(policyRows).toEqual({ documents: 16, assessments: 6, reasons: 32 })
  })

  it('versions, publishes, revises, closes, and archives a programme cycle without rewriting policy', async () => {
    const administrator = await adminSession(['SUPER_ADMIN'])
    const code = `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
    const draft = {
      cycleCode: code,
      displayName: 'Mission SEP Draft',
      cycleYear: 2027,
      policyReference: null,
      applicantGuidance: null,
      partnerBankGuidance: null,
      opensAt: null,
      closesAt: null,
      policy: {
        minimumApplicantAge: null, maximumApplicantAge: null,
        categoryAMaximumMonths: null, expansionWaitMonths: null,
        majorityOwnershipRequired: null, jurisdiction: null,
        fundingCeilingState: null, fundingCeilingAmountPaise: null,
        fundingCeilingScope: null, requiredAssessmentTypes: [],
        documentRules: [], reasons: [],
      },
    }
    const created = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success response { head { id currentVersion status } } } } }
    }`, { input: draft }, administrator.cookie)
    const head = created.data.admin.programmeCycle.create.response.head
    expect(head).toMatchObject({ currentVersion: 1, status: 'DRAFT' })

    const incomplete = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) { success message } } }
    }`, { input: { id: head.id, expectedVersion: 1, reason: 'Publish' } }, administrator.cookie)
    expect(incomplete.data.admin.programmeCycle.open).toMatchObject({
      success: false, message: 'Complete every cycle policy field before opening the cycle.',
    })

    const deleted = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { softDeleteDraft(input: $input) { response { head { deletedAt currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 1, reason: 'Draft entered in error' } }, administrator.cookie)
    expect(deleted.data.admin.programmeCycle.softDeleteDraft.response.head).toMatchObject({ currentVersion: 1 })
    const restored = await graphql<any>(`mutation($id: ID!, $version: Int!) {
      admin { programmeCycle { restoreDraft(id: $id, expectedVersion: $version) { response { head { deletedAt currentVersion } } } } }
    }`, { id: head.id, version: 1 }, administrator.cookie)
    expect(restored.errors).toBeUndefined()
    expect(restored.data.admin.programmeCycle.restoreDraft.response.head).toEqual(
      expect.objectContaining({ deletedAt: null, currentVersion: 1 }),
    )

    const complete = {
      ...draft,
      displayName: 'Mission SEP 2027',
      policyReference: 'TTAADC/MSEP/2027',
      applicantGuidance: 'Read the 2027 policy before applying.',
      partnerBankGuidance: 'Published 2027 partner-bank roster.',
      opensAt: new Date(Date.now() - 1_000).toISOString(),
      closesAt: new Date(Date.now() + 172_800_000).toISOString(),
      policy,
    }
    const updated = await graphql<any>(`mutation($input: UpdateProgrammeCycleInput!) {
      admin { programmeCycle { updateDraft(input: $input) { response { head { currentVersion displayName } } } } }
    }`, { input: {
      id: head.id, expectedVersion: 1, reason: 'Complete approved policy', cycle: complete,
    } }, administrator.cookie)
    expect(updated.errors).toBeUndefined()
    expect(updated.data.admin.programmeCycle.updateDraft.response).toMatchObject({
      head: { currentVersion: 2, displayName: 'Mission SEP 2027' },
    })

    const opened = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) { response { head { status currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 2, reason: 'Publish approved cycle' } }, administrator.cookie)
    expect(opened.data.admin.programmeCycle.open.response.head).toMatchObject({ status: 'OPEN', currentVersion: 3 })
    expect(await findSubmissionPolicy(createDatabase(env.DB), head.id, 3)).toMatchObject({
      minimumApplicantAge: 18, maximumApplicantAge: 60,
      fundingCeilingState: 'UNRESOLVED',
    })
    expect(await findSubmissionPolicy(createDatabase(env.DB), head.id, 999)).toBeNull()

    const guidance = await graphql<any>(`mutation($input: CycleGuidanceInput!) {
      admin { programmeCycle { updateOpenGuidance(input: $input) { response { head { currentVersion applicantGuidance partnerBankGuidance } } } } }
    }`, { input: {
      id: head.id, expectedVersion: 3,
      applicantGuidance: 'Updated public guidance without changing policy.',
      partnerBankGuidance: 'Updated governed roster text.', reason: 'Clarify public wording',
    } }, administrator.cookie)
    expect(guidance.data.admin.programmeCycle.updateOpenGuidance.response.head.currentVersion).toBe(4)

    const newClosing = new Date(Date.now() + 259_200_000).toISOString()
    const closing = await graphql<any>(`mutation($input: CycleClosingInput!) {
      admin { programmeCycle { changeClosingTime(input: $input) { response { head { currentVersion closesAt } } } } }
    }`, { input: {
      id: head.id, expectedVersion: 4, closesAt: newClosing, reason: 'Extend the public window',
    } }, administrator.cookie)
    expect(closing.data.admin.programmeCycle.changeClosingTime.response.head.currentVersion).toBe(5)

    // A second, still-draft cycle proves list cursors and nullable draft
    // updates. Clearing optional policy text must create history rather than
    // silently retaining the old value.
    const secondDraft = {
      ...draft,
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Future policy draft',
    }
    const secondCreated = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { response { head { id currentVersion } } } } }
    }`, { input: secondDraft }, administrator.cookie)
    const secondHead = secondCreated.data.admin.programmeCycle.create.response.head
    const secondUpdated = await graphql<any>(`mutation($input: UpdateProgrammeCycleInput!) {
      admin { programmeCycle { updateDraft(input: $input) { response { head { currentVersion policyReference opensAt closesAt } } } } }
    }`, { input: {
      id: secondHead.id, expectedVersion: 1, reason: 'Clarify draft name',
      cycle: { ...secondDraft, displayName: 'Future policy draft revised' },
    } }, administrator.cookie)
    expect(secondUpdated.data.admin.programmeCycle.updateDraft.response.head).toMatchObject({
      currentVersion: 2, policyReference: null, opensAt: null, closesAt: null,
    })

    const listed = await graphql<any>(`query($id: ID!) { admin {
      programmeCycle {
        list(first: 1, includeDeleted: true) { response { nodes { id } pageInfo { hasNextPage endCursor } } }
        byId(id: $id) { response { head { currentVersion } } }
        counts(id: $id) { response { counts { status count } } }
        events(id: $id, first: 20) { response { events { eventType message } } }
      }
    } }`, { id: head.id }, administrator.cookie)
    expect(listed.errors).toBeUndefined()
    expect(listed.data.admin.programmeCycle.byId.response.head.currentVersion).toBe(5)
    expect(listed.data.admin.programmeCycle.events.response.events.map((event: any) => event.eventType))
      .toEqual(expect.arrayContaining(['OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED']))
    expect(listed.data.admin.programmeCycle.list.response.pageInfo.hasNextPage).toBe(true)
    const nextPage = await graphql<any>(`query($after: String!) { admin { programmeCycle {
      list(first: 10, after: $after, includeDeleted: true) {
        response { nodes { id } pageInfo { hasNextPage } }
      }
    } } }`, { after: listed.data.admin.programmeCycle.list.response.pageInfo.endCursor }, administrator.cookie)
    expect(nextPage.data.admin.programmeCycle.list.response.nodes).not.toHaveLength(0)

    const closed = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { close(input: $input) { response { head { status currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 5, reason: 'Window complete' } }, administrator.cookie)
    expect(closed.data.admin.programmeCycle.close.response.head).toMatchObject({ status: 'CLOSED', currentVersion: 6 })
    const archived = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { archive(input: $input) { response { head { status currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 6, reason: 'No unfinished applications' } }, administrator.cookie)
    expect(archived.data.admin.programmeCycle.archive.response.head).toMatchObject({ status: 'ARCHIVED', currentVersion: 7 })

    const duplicate = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success message } } }
    }`, { input: complete }, administrator.cookie)
    expect(duplicate.data.admin.programmeCycle.create.success).toBe(false)
  })

  it('rejects ambiguous, duplicate, and internally inconsistent programme policy', async () => {
    const administrator = await adminSession(['ADMIN'])
    const base = {
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Policy validation', cycleYear: 2028,
      policyReference: 'TTAADC/MSEP/2028', applicantGuidance: 'Guidance',
      partnerBankGuidance: 'Roster',
      opensAt: new Date(Date.now() + 86_400_000).toISOString(),
      closesAt: new Date(Date.now() + 172_800_000).toISOString(), policy,
    }
    const create = (input: any) => graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success message response { head { id currentVersion } } } } }
    }`, { input }, administrator.cookie)
    const unknownDocument = await createProgrammeCycle({
      ...base,
      policy: {
        ...policy,
        documentRules: [{ documentType: 'UNKNOWN_DOCUMENT', condition: 'ALWAYS' }],
      },
    } as never, adminContext(administrator.cookie))
    expect(unknownDocument).toMatchObject({
      success: false, message: 'The cycle contains an unknown document rule.',
    })
    const cases: Array<[any, string]> = [
      [{ ...base, cycleCode: 'bad' }, 'Cycle code must contain 3–32 uppercase letters, numbers, or hyphens.'],
      [{ ...base, displayName: ' ' }, 'Enter a cycle display name.'],
      [{ ...base, cycleYear: 1999 }, 'Enter a valid policy year.'],
      [{ ...base, closesAt: base.opensAt }, 'The closing time must be later than the opening time.'],
      [{ ...base, policy: { ...policy, documentRules: [...policy.documentRules, policy.documentRules[0]] } }, 'Cycle policy entries must be unique.'],
      [{ ...base, policy: { ...policy, requiredAssessmentTypes: ['UTILIZATION', 'UTILIZATION'] } }, 'Cycle policy entries must be unique.'],
      [{ ...base, policy: { ...policy, reasons: [...policy.reasons, policy.reasons[0]] } }, 'Cycle policy entries must be unique.'],
      [{ ...base, policy: { ...policy, reasons: Array.from({ length: 51 }, (_, index) => ({ context: 'REVISION', code: `R_${index}`, label: 'Reason' })) } }, 'A cycle may contain at most 50 reason categories.'],
      [{ ...base, policy: { ...policy, reasons: [{ context: 'REVISION', code: 'x', label: 'Reason' }] } }, 'One or more reason categories are invalid.'],
      [{ ...base, policy: { ...policy, reasons: [{ context: 'REVISION', code: 'VALID', label: ' ' }] } }, 'One or more reason categories are invalid.'],
      [{ ...base, policy: { ...policy, reasons: [{ context: 'REVISION', code: 'VALID', label: 'Reason', applicantMessageTemplate: 'x'.repeat(501) }] } }, 'One or more reason categories are invalid.'],
      [{ ...base, policy: { ...policy, minimumApplicantAge: -1 } }, 'Minimum age must be a non-negative whole number.'],
      [{ ...base, policy: { ...policy, maximumApplicantAge: -1 } }, 'Maximum age must be a non-negative whole number.'],
      [{ ...base, policy: { ...policy, minimumApplicantAge: 60, maximumApplicantAge: 18 } }, 'Maximum age cannot be lower than minimum age.'],
      [{ ...base, policy: { ...policy, categoryAMaximumMonths: -1 } }, 'Category A month limit must be a non-negative whole number.'],
      [{ ...base, policy: { ...policy, expansionWaitMonths: 0 } }, 'Expansion waiting time must be a positive whole number of months.'],
      [{ ...base, policy: { ...policy, fundingCeilingAmountPaise: '1' } }, 'An unresolved funding ceiling cannot contain an amount or scope.'],
      [{ ...base, policy: { ...policy, fundingCeilingScope: 'APPLICATION' } }, 'An unresolved funding ceiling cannot contain an amount or scope.'],
      [{ ...base, policy: { ...policy, fundingCeilingState: 'RESOLVED' } }, 'A resolved funding ceiling requires a positive amount and scope.'],
      [{ ...base, policy: { ...policy, fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '0', fundingCeilingScope: 'APPLICATION' } }, 'A resolved funding ceiling requires a positive amount and scope.'],
      [{ ...base, policy: { ...policy, fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '1', fundingCeilingScope: null } }, 'A resolved funding ceiling requires a positive amount and scope.'],
    ]
    for (const [input, message] of cases) {
      const result = await create(input)
      expect(result.errors, message).toBeUndefined()
      expect(result.data.admin.programmeCycle.create, message).toMatchObject({ success: false, message })
    }

    const missingCollections = [
      {
        policy: { ...policy, documentRules: [] },
        message: 'Define exactly one rule for every supported document type.',
      },
      {
        policy: { ...policy, requiredAssessmentTypes: [] },
        message: 'Define the assessment requirements before opening the cycle.',
      },
      {
        policy: { ...policy, reasons: [] },
        message: 'Define at least one approved reason for every administrative action.',
      },
    ]
    for (const [index, candidate] of missingCollections.entries()) {
      const result = await create({
        ...base, cycleCode: `SEP-OPEN-${index}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`,
        policy: candidate.policy,
      })
      const head = result.data.admin.programmeCycle.create.response.head
      const opened = await graphql<any>(`mutation($input: CycleTransitionInput!) {
        admin { programmeCycle { open(input: $input) { success message } } }
      }`, { input: { id: head.id, expectedVersion: 1, reason: 'Publish' } }, administrator.cookie)
      expect(opened.data.admin.programmeCycle.open).toMatchObject({ success: false, message: candidate.message })
    }

    const mutable = await create({
      ...base, cycleCode: `SEP-STATE-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
    })
    const mutableHead = mutable.data.admin.programmeCycle.create.response.head
    const stateCalls = [
      [`mutation($input: UpdateProgrammeCycleInput!) { admin { programmeCycle { updateDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Change', cycle: { ...base, cycleCode: 'bad' } } }],
      [`mutation($input: UpdateProgrammeCycleInput!) { admin { programmeCycle { updateDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: ' ', cycle: base } }],
      [`mutation($input: UpdateProgrammeCycleInput!) { admin { programmeCycle { updateDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, reason: 'Stale', cycle: base } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: ' ' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: 'missing', expectedVersion: 1, reason: 'Publish' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, reason: 'Stale publish' } }],
      [`mutation($input: CycleGuidanceInput!) { admin { programmeCycle { updateOpenGuidance(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, applicantGuidance: 'Guide', partnerBankGuidance: 'Roster', reason: 'Change' } }],
      [`mutation($input: CycleClosingInput!) { admin { programmeCycle { changeClosingTime(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, closesAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Change' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Close' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { archive(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Archive' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { softDeleteDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: ' ' } }],
    ] as const
    for (const [query, variables] of stateCalls) {
      const result = await graphql<any>(query, variables, administrator.cookie)
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
    const openedMutable = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) { response { head { currentVersion } } } } }
    }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Publish' } }, administrator.cookie)
    expect(openedMutable.data.admin.programmeCycle.open.response.head.currentVersion).toBe(2)
    const openStateCalls = [
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: 'Again' } }],
      [`mutation($input: CycleGuidanceInput!) { admin { programmeCycle { updateOpenGuidance(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, applicantGuidance: ' ', partnerBankGuidance: 'Roster', reason: 'Change' } }],
      [`mutation($input: CycleGuidanceInput!) { admin { programmeCycle { updateOpenGuidance(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, applicantGuidance: 'Guide', partnerBankGuidance: 'Roster', reason: 'Change' } }],
      [`mutation($input: CycleClosingInput!) { admin { programmeCycle { changeClosingTime(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, closesAt: new Date(Date.now() - 1_000).toISOString(), reason: 'Past' } }],
      [`mutation($input: CycleClosingInput!) { admin { programmeCycle { changeClosingTime(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, closesAt: new Date(Date.now() + 259_200_000).toISOString(), reason: 'Stale' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: ' ' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: 'missing', expectedVersion: 1, reason: 'Close' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { archive(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: 'Archive' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, reason: 'Stale' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { softDeleteDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: 'Cannot delete published cycle' } }],
    ] as const
    for (const [query, variables] of openStateCalls) {
      const result = await graphql<any>(query, variables, administrator.cookie)
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
    const badPages = await graphql<any>(`query { admin { programmeCycle {
      list(first: 0) { success }
      events(id: "missing", first: 0) { success }
      byId(id: "missing") { success }
    } } }`, {}, administrator.cookie)
    expect(badPages.errors).toBeUndefined()
    expect(badPages.data.admin.programmeCycle).toMatchObject({
      list: { success: false }, events: { success: false }, byId: { success: false },
    })
  })

  it('rejects multiple administrative actions before either executes', async () => {
    const administrator = await adminSession(['ADMIN'])
    const result = await graphql<unknown>(`mutation {
      admin {
        programmeCycle {
          softDeleteDraft(input: { id: "missing", expectedVersion: 1, reason: "x" }) { success }
          restoreDraft(id: "missing", expectedVersion: 1) { success }
        }
      }
    }`, {}, administrator.cookie)
    expect(result.errors?.[0]?.message).toContain('Only one action')
  })

  it('closes only the bounded expired open cycles without inventing an actor', async () => {
    const administrator = await adminSession(['ADMIN'])
    const now = Date.now()
    const cycleId = crypto.randomUUID()
    const code = `EXP-${cycleId}`
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_programme_cycle (
          id, cycle_code, display_name, cycle_year, status, opens_at, closes_at,
          current_version, created_at, updated_at
        ) VALUES (?, ?, 'Expired cycle', 2026, 'OPEN', ?, ?, 1, ?, ?)`,
      ).bind(cycleId, code, now - 10_000, now - 1_000, now, now),
      env.DB.prepare(
        `INSERT INTO seb_programme_cycle_version (
          id, programme_cycle_id, version, cycle_code, display_name, cycle_year,
          status, opens_at, closes_at, change_type, changed_by_user_id, created_at
        ) VALUES (?, ?, 1, ?, 'Expired cycle', 2026, 'OPEN', ?, ?, 'OPENED', ?, ?)`,
      ).bind(crypto.randomUUID(), cycleId, code, now - 10_000, now - 1_000, administrator.userId, now),
    ])
    await closeExpiredProgrammeCycles({
      db: createDatabase(env.DB), env,
      requestHeaders: new Headers(), requestUrl: 'https://scheduled.internal/',
      responseHeaders: new Headers(),
    })
    expect(await env.DB.prepare(
      `SELECT status, current_version AS version FROM seb_programme_cycle WHERE id = ?`,
    ).bind(cycleId).first()).toEqual({ status: 'CLOSED', version: 2 })
    expect(await env.DB.prepare(
      `SELECT changed_by_user_id AS actor FROM seb_programme_cycle_version
       WHERE programme_cycle_id = ? AND version = 2`,
    ).bind(cycleId).first()).toEqual({ actor: null })
  })

  it('derives recovery balances from retained compensating entries', () => {
    expect(calculateRecoveryBalance([
      { id: 'principal', entryType: 'DEMAND', component: 'PRINCIPAL', relatedEntryId: null, amountPaise: 1_000 },
      { id: 'interest', entryType: 'DEMAND', component: 'PENAL_INTEREST', relatedEntryId: null, amountPaise: 200 },
      { id: 'receipt', entryType: 'RECEIPT', component: 'PRINCIPAL', relatedEntryId: null, amountPaise: 500 },
      { id: 'waiver', entryType: 'WAIVER', component: 'PENAL_INTEREST', relatedEntryId: null, amountPaise: 100 },
      { id: 'correction', entryType: 'REVERSAL', component: 'PRINCIPAL', relatedEntryId: 'receipt', amountPaise: 50 },
    ])).toEqual({
      principalDemanded: 1_000,
      interestDemanded: 200,
      receipts: 450,
      waivers: 100,
      outstanding: 650,
    })
  })

  it('keeps administrative response, normalization, constraint, and audit helpers safe', async () => {
    expect(success({ id: 'public' })).toEqual({ success: true, message: null, response: { id: 'public' } })
    expect(success(true, 'Completed.')).toEqual({ success: true, message: 'Completed.', response: true })
    expect(failure('Safe failure.')).toEqual({ success: false, message: 'Safe failure.', response: null })
    expect(normalizeRequiredText(' value ', 5)).toBe('value')
    expect(normalizeRequiredText(' ', 5)).toBeNull()
    expect(normalizeRequiredText('toolong', 2)).toBeNull()
    expect(normalizeOptionalText(undefined, 5)).toBeNull()
    expect(normalizeOptionalText(null, 5)).toBeNull()
    expect(normalizeOptionalText('  ', 5)).toBeNull()
    expect(normalizeOptionalText(' ok ', 5)).toBe('ok')
    expect(normalizeOptionalText('toolong', 2)).toBe('INVALID')
    expect(changedExactlyOne([{ id: 'one' }])).toBe(true)
    expect(changedExactlyOne([])).toBe(false)
    expect(changedExactlyOne({ meta: { changes: 1 } })).toBe(true)
    expect(changedExactlyOne({ meta: {} })).toBe(false)
    await expect(constraintSafe(async () => {
      throw new Error('UNIQUE constraint failed')
    })).resolves.toBeNull()
    await expect(constraintSafe(async () => {
      throw new Error('network unavailable')
    })).rejects.toThrow('network unavailable')
    await expect(constraintSafe(async () => 'ok')).resolves.toBe('ok')
    const requestHeaders = new Headers({
      'CF-Ray': 'ray-1', 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'vitest',
    })
    const context = {
      db: createDatabase(env.DB), env, requestHeaders,
      requestUrl: 'https://api.example.test/graphql', responseHeaders: new Headers(),
    }
    expect(adminAudit(context, {
      actorUserId: null, action: 'SEB.CYCLE_CLOSED', entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: 'cycle', now: new Date(0), metadata: { status: 'CLOSED' },
    })).toMatchObject({
      requestId: 'ray-1', ipAddress: '192.0.2.1', userAgent: 'vitest',
      metadataJson: '{"status":"CLOSED"}',
    })
    requestHeaders.delete('CF-Ray')
    requestHeaders.set('X-Request-ID', 'request-1')
    expect(adminAudit(context, {
      actorUserId: null, action: 'SEB.CYCLE_CLOSED', entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: 'cycle', now: new Date(0),
    })).toMatchObject({ requestId: 'request-1', metadataJson: null })
    expect(adminResolvers.AdminWorkspace.notes({})).toEqual([])
    expect(adminResolvers.AdminWorkspace.notes({ internalNotes: [{ id: 'note' }] })).toEqual([
      { id: 'note' },
    ])
  })

  it('appends trusted scanner results and rejects malformed or unknown callbacks', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const { applicationId, submissionId } = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const documentId = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    const submissionDocumentId = crypto.randomUUID()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO seb_application_document (
        id, application_id, document_type, current_version, created_at, updated_at
      ) VALUES (?, ?, 'DPR', 1, ?, ?)`).bind(documentId, applicationId, now, now),
      env.DB.prepare(`INSERT INTO seb_application_document_version (
        id, document_id, version, operation, r2_object_key, original_filename,
        content_type, size_bytes, checksum, uploaded_by_user_id, created_at
      ) VALUES (?, ?, 1, 'UPLOAD', ?, 'dpr.pdf', 'application/pdf', 10, ?, ?, ?)`)
        .bind(versionId, documentId, `test/${versionId}`, 'A'.repeat(43) + '=', administrator.userId, now),
      env.DB.prepare(`INSERT INTO seb_application_document_scan (
        id, document_version_id, sequence_number, status, scanner_reference,
        scanned_at, created_at
      ) VALUES (?, ?, 1, 'PENDING', 'UPLOAD_FINALIZATION', ?, ?)`)
        .bind(crypto.randomUUID(), versionId, null, now),
      env.DB.prepare(`INSERT INTO seb_application_submission_document (
        id, submission_id, application_id, document_id, document_version,
        document_type, created_at
      ) VALUES (?, ?, ?, ?, 1, 'DPR', ?)`)
        .bind(submissionDocumentId, submissionId, applicationId, documentId, now),
    ])
    const db = createDatabase(env.DB)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'ACCEPTED', scannerReference: 'SCAN-1',
      safeMessage: 'File accepted.', scannedAt: new Date(),
    })).toBe(true)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'ERROR', scannerReference: 'SCAN-RETRY',
      scannedAt: new Date(),
    })).toBe(true)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: 'missing', status: 'ERROR', scannerReference: 'SCAN-2',
      scannedAt: new Date(),
    })).toBe(false)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'REJECTED', scannerReference: ' ',
      scannedAt: new Date(Number.NaN),
    })).toBe(false)
    expect(await env.DB.prepare(`SELECT status, sequence_number AS sequence
      FROM seb_application_document_scan WHERE document_version_id = ?
      ORDER BY sequence_number DESC LIMIT 1`).bind(versionId).first()).toEqual({
      status: 'ERROR', sequence: 3,
    })
    await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success } } }
    }`, { input: {
      applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: true,
    } }, administrator.cookie)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const blockedReview = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success message } } }
    }`, { input: {
      applicationId, expectedStatusVersion: 3, outcome: 'ADVANCE_TO_BANK',
      checks: deskCheckTypes.map((checkType) => ({
        checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
      })), reasonCategoryId: null, applicantMessage: null, revisions: [],
      identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(blockedReview.data.admin.intake.completeDeskReview.message)
      .toBe('Every submitted document must pass malware scanning first.')
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'ACCEPTED', scannerReference: 'SCAN-FINAL',
      safeMessage: 'Accepted after retry.', scannedAt: new Date(),
    })).toBe(true)
    const download = await graphql<any>(`query($applicationId: ID!, $documentId: ID!) {
      admin { intake { documentDownloadUrl(
        applicationId: $applicationId, submissionDocumentId: $documentId
      ) { success response { downloadUrl expiresAt } } } }
    }`, { applicationId, documentId: submissionDocumentId }, administrator.cookie)
    expect(download.data.admin.intake.documentDownloadUrl).toMatchObject({
      // Local environment: served by the Worker. Signing is covered where the
      // context says it is deployed.
      success: true,
      response: { downloadUrl: expect.stringContaining('/internal/storage/objects?key=') },
    })
  })

  it('retains cancelled revisions, replaced bank referrals, and removed meeting agenda evidence', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const first = await createSubmittedApplication(administrator.cookie, administrator.userId, cycle.id)
    await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success } } }
    }`, { input: {
      applicationId: first.applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: true,
    } }, administrator.cookie)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: first.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const revisionReason = await reasonId(cycle.id, 'REVISION')
    const requested = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { response { application { status statusVersion } revisions { id section } } } } }
    }`, { input: {
      applicationId: first.applicationId, expectedStatusVersion: 3,
      outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReason,
      applicantMessage: 'Please correct the financial section.',
      checks: deskCheckTypes.map((checkType) => ({
        checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
      })),
      identifiers: passingIdentifiers(),
      revisions: [{
        section: 'FINANCIAL', reasonCategoryId: revisionReason,
        note: 'Correct the requested-funding details.',
      }],
    } }, administrator.cookie)
    const revisionWorkspace = requested.data.admin.intake.completeDeskReview.response
    expect(revisionWorkspace.application.status).toBe('REVISION_REQUIRED')
    const cancelledRevision = await graphql<any>(`mutation($input: CancelRevisionInput!) {
      admin { intake { cancelRevision(input: $input) { response { application { status statusVersion } revisions { id cancelledAt } } } } }
    }`, { input: {
      applicationId: first.applicationId, revisionRequestId: revisionWorkspace.revisions[0].id,
      expectedStatusVersion: 4, reason: 'Request was issued against the wrong section.',
    } }, administrator.cookie)
    expect(cancelledRevision.data.admin.intake.cancelRevision.response).toMatchObject({
      application: { status: 'DESK_REVIEW', statusVersion: 5 },
    })
    expect(cancelledRevision.data.admin.intake.cancelRevision.response.revisions[0].cancelledAt).not.toBeNull()
    const staleRevisionCancellation = await graphql<any>(`mutation($input: CancelRevisionInput!) {
      admin { intake { cancelRevision(input: $input) { success message } } }
    }`, { input: {
      applicationId: first.applicationId, revisionRequestId: revisionWorkspace.revisions[0].id,
      expectedStatusVersion: 4, reason: 'Repeat a stale cancellation.',
    } }, administrator.cookie)
    expect(staleRevisionCancellation.data.admin.intake.cancelRevision.success).toBe(false)

    const second = await createSubmittedApplication(administrator.cookie, administrator.userId, cycle.id)
    await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success } } }
    }`, { input: {
      applicationId: second.applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: true,
    } }, administrator.cookie)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: second.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const advanced = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { response { reviews { id } application { statusVersion } } } } }
    }`, { input: {
      applicationId: second.applicationId, expectedStatusVersion: 3,
      outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
      checks: deskCheckTypes.map((checkType) => ({
        checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
      })), revisions: [], identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    const reviewId = advanced.data.admin.intake.completeDeskReview.response.reviews[0].id
    const refer = async (suffix: string, statusVersion: number) => graphql<any>(`mutation($input: BankReferralInput!) {
      admin { decision { referToBank(input: $input) { response { referrals { id currentVersion status } application { statusVersion } } } } }
    }`, { input: {
      applicationId: second.applicationId, submissionId: second.submissionId, deskReviewId: reviewId,
      expectedStatusVersion: statusVersion, bankName: 'Tripura State Co-operative Bank',
      bankBranch: null, referralReference: `REF-${suffix}-${second.applicationId}`,
      referralDate: '2026-05-01', applicantMessage: 'Referral recorded.', internalNote: null,
    } }, administrator.cookie)
    const firstReferral = await refer('ONE', 4)
    const referralOne = firstReferral.data.admin.decision.referToBank.response.referrals[0]
    const cancelReason = await reasonId(cycle.id, 'BANK_REFERRAL_CANCEL')
    const cancelledReferral = await graphql<any>(`mutation($input: CancelBankReferralInput!) {
      admin { decision { cancelBankReferral(input: $input) { response { referrals { id status currentVersion } } } } }
    }`, { input: {
      applicationId: second.applicationId, referralId: referralOne.id,
      expectedReferralVersion: 1, reasonCategoryId: cancelReason,
      reason: 'Wrong bank selected.', applicantMessage: 'The bank referral was replaced.',
    } }, administrator.cookie)
    expect(cancelledReferral.data.admin.decision.cancelBankReferral.response.referrals[0])
      .toMatchObject({ status: 'CANCELLED', currentVersion: 2 })
    const staleReferralCancellation = await graphql<any>(`mutation($input: CancelBankReferralInput!) {
      admin { decision { cancelBankReferral(input: $input) { success } } }
    }`, { input: {
      applicationId: second.applicationId, referralId: referralOne.id,
      expectedReferralVersion: 1, reasonCategoryId: cancelReason,
      reason: 'Repeat stale cancellation.', applicantMessage: 'The referral was already cancelled.',
    } }, administrator.cookie)
    expect(staleReferralCancellation.data.admin.decision.cancelBankReferral.success).toBe(false)
    const secondReferral = await refer('TWO', 5)
    const referralTwo = secondReferral.data.admin.decision.referToBank.response.referrals[1]
    const bank = await graphql<any>(`mutation($input: BankOutcomeInput!) {
      admin { decision { recordBankOutcome(input: $input) { response { bankOutcomes { id } application { statusVersion } } } } }
    }`, { input: {
      applicationId: second.applicationId, referralId: referralTwo.id,
      expectedStatusVersion: 6, expectedReferralVersion: 1, outcome: 'NOT_RECOMMENDED',
      decisionReference: `NEG-${second.applicationId}`, decisionDate: '2026-05-15',
      availableLoanAmountPaise: null, applicantSummary: 'Negative feedback will still go to TTM.',
      internalNote: null, revisions: [],
    } }, administrator.cookie)
    expect(bank.data.admin.decision.recordBankOutcome.response.application.statusVersion).toBe(7)
    const meeting = await graphql<any>(`mutation($input: CreateTtmMeetingInput!) {
      admin { decision { createMeeting(input: $input) { response { meeting { id currentVersion } } } } }
    }`, { input: {
      meetingReference: `REMOVE-${second.applicationId}`, scheduledAt: new Date().toISOString(),
      venue: 'Meeting Room', description: null,
    } }, administrator.cookie)
    const meetingId = meeting.data.admin.decision.createMeeting.response.meeting.id
    const added = await graphql<any>(`mutation($input: AddAgendaItemInput!) {
      admin { decision { addAgendaItem(input: $input) { response { agenda { id currentVersion } } } } }
    }`, { input: {
      meetingId, applicationId: second.applicationId, submissionId: second.submissionId,
      bankOutcomeId: bank.data.admin.decision.recordBankOutcome.response.bankOutcomes[0].id,
      position: 1,
    } }, administrator.cookie)
    const agendaId = added.data.admin.decision.addAgendaItem.response.agenda[0].id
    const removed = await graphql<any>(`mutation($input: RemoveAgendaItemInput!) {
      admin { decision { removeAgendaItem(input: $input) { response { agenda { id status currentVersion } } } } }
    }`, { input: {
      meetingId, agendaItemId: agendaId, expectedVersion: 1, reason: 'Move to a future meeting.',
    } }, administrator.cookie)
    expect(removed.data.admin.decision.removeAgendaItem.response.agenda[0])
      .toMatchObject({ status: 'REMOVED', currentVersion: 2 })
    const cancelledMeeting = await graphql<any>(`mutation($input: CancelTtmMeetingInput!) {
      admin { decision { cancelMeeting(input: $input) { response { meeting { status currentVersion } } } } }
    }`, { input: { meetingId, expectedVersion: 1, reason: 'Meeting is no longer required.' } }, administrator.cookie)
    expect(cancelledMeeting.data.admin.decision.cancelMeeting.response.meeting)
      .toMatchObject({ status: 'CANCELLED', currentVersion: 2 })
    const closedCycle = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { close(input: $input) { response { head { currentVersion status } } } } }
    }`, { input: { id: cycle.id, expectedVersion: 2, reason: 'Close intake.' } }, administrator.cookie)
    expect(closedCycle.data.admin.programmeCycle.close.response.head.status).toBe('CLOSED')
    const blockedArchive = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { archive(input: $input) { success message } } }
    }`, { input: { id: cycle.id, expectedVersion: 3, reason: 'Archive.' } }, administrator.cookie)
    expect(blockedArchive.data.admin.programmeCycle.archive.message)
      .toBe('Finish the cycle’s active applications before archiving it.')
  })

  it('fails intake validation, ownership conflicts, stale writes, and unsafe desk-review transitions safely', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const submitted = await createSubmittedApplication(administrator.cookie, administrator.userId, cycle.id)
    const reference = await env.DB.prepare('SELECT reference_number AS reference FROM seb_application WHERE id = ?')
      .bind(submitted.applicationId).first<{ reference: string }>()

    const queueQueries = [
      'query { admin { intake { queue(input: { first: 0 }) { success message } } } }',
      'query { admin { intake { queue(input: { after: "not-a-cursor" }) { success message } } } }',
      'query { admin { intake { queue(input: { phaseNumber: 0 }) { success message } } } }',
      'query { admin { intake { queue(input: { submittedFrom: "2030-01-02T00:00:00Z", submittedTo: "2030-01-01T00:00:00Z" }) { success message } } } }',
      'query { admin { intake { byReference(referenceNumber: " ") { success message } } } }',
      'query { admin { intake { byReference(referenceNumber: "UNKNOWN") { success message } } } }',
      'query { admin { intake { workspace(applicationId: "missing") { success message } } } }',
    ]
    for (const query of queueQueries) {
      const result = await graphql<any>(query, {}, administrator.cookie)
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
    const filtered = await graphql<any>(`query($cycle: ID!, $assignee: ID!, $reference: String!) {
      admin { intake {
        oldest: queue(input: { first: 1, cycleId: $cycle, status: SUBMITTED, phaseNumber: 1, applicationType: INITIAL, sector: FOOD_PROCESSING, category: CATEGORY_A, referenceNumber: $reference, order: OLDEST_WAITING }) { response { nodes { id } pageInfo { endCursor hasNextPage } } }
        newest: queue(input: { first: 20, assigneeUserId: $assignee, order: NEWEST_SUBMISSION }) { response { nodes { id } } }
        activity: queue(input: { first: 20, submittedFrom: "2020-01-01T00:00:00Z", submittedTo: "2035-01-01T00:00:00Z", order: LAST_ACTIVITY }) { response { nodes { id } } }
        byReference(referenceNumber: $reference) { response { id } }
        workspace(applicationId: "${submitted.applicationId}") { response { application { id } notes { id } } }
      } }
    }`, { cycle: cycle.id, assignee: administrator.userId, reference: reference?.reference }, administrator.cookie)
    expect(filtered.errors).toBeUndefined()
    expect(filtered.data.admin.intake.oldest.response.nodes[0].id).toBe(submitted.applicationId)
    expect(filtered.data.admin.intake.newest.response.nodes).toHaveLength(0)
    expect(filtered.data.admin.intake.byReference.response.id).toBe(submitted.applicationId)

    const later = await createSubmittedApplication(administrator.cookie, administrator.userId, cycle.id)
    for (const order of ['OLDEST_WAITING', 'NEWEST_SUBMISSION', 'LAST_ACTIVITY']) {
      const firstPage = await graphql<any>(`query($order: AdminIntakeOrder!) { admin { intake {
        queue(input: { first: 1, order: $order }) {
          response { nodes { id } pageInfo { hasNextPage endCursor } }
        }
      } } }`, { order }, administrator.cookie)
      expect(firstPage.data.admin.intake.queue.response.pageInfo.hasNextPage).toBe(true)
      const secondPage = await graphql<any>(`query($order: AdminIntakeOrder!, $after: String!) {
        admin { intake { queue(input: { first: 1, order: $order, after: $after }) {
          response { nodes { id } pageInfo { hasNextPage } }
        } } }
      }`, {
        order, after: firstPage.data.admin.intake.queue.response.pageInfo.endCursor,
      }, administrator.cookie)
      expect(secondPage.data.admin.intake.queue.response.nodes[0].id)
        .not.toBe(firstPage.data.admin.intake.queue.response.nodes[0].id)
      expect(new Set([
        firstPage.data.admin.intake.queue.response.nodes[0].id,
        secondPage.data.admin.intake.queue.response.nodes[0].id,
      ])).toEqual(new Set([submitted.applicationId, later.applicationId]))
    }

    // An unclaimed application, an application that does not exist, and an
    // unsubmitted draft are all refused identically, so probing identifiers
    // cannot reveal which of them a reviewer is looking at.
    const downloadQuery = `query($id: ID!) { admin { intake {
      documentDownloadUrl(applicationId: $id, submissionDocumentId: "missing") { success message }
    } } }`
    for (const applicationId of [submitted.applicationId, 'missing', crypto.randomUUID()]) {
      const refused = await graphql<any>(downloadQuery, { id: applicationId },
        administrator.cookie)
      expect(refused.data.admin.intake.documentDownloadUrl).toMatchObject({
        success: false,
        message: 'Claim the application before opening its documents.',
      })
    }
    const missingClaim = await graphql<any>(`mutation { admin { intake {
      claim(input: { applicationId: "missing", expectedAssignmentVersion: 0, conflictAcknowledged: false }) { success }
    } } }`, {}, administrator.cookie)
    expect(missingClaim.data.admin.intake.claim.success).toBe(false)
    const missingReassign = await graphql<any>(`mutation($input: ReassignApplicationInput!) {
      admin { intake { reassign(input: $input) { success } } }
    }`, { input: {
      applicationId: 'missing', expectedAssignmentVersion: 1,
      toUserId: administrator.userId, reasonCategoryId: 'missing',
      reason: 'Reassign.', conflictAcknowledged: false,
    } }, administrator.cookie)
    expect(missingReassign.data.admin.intake.reassign.success).toBe(false)
    const missingReview = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success } } }
    }`, { input: {
      applicationId: 'missing', expectedStatusVersion: 1,
      outcome: 'ADVANCE_TO_BANK', checks: [], identifiers: [], reasonCategoryId: null,
      applicantMessage: null, revisions: [],
    } }, administrator.cookie)
    expect(missingReview.data.admin.intake.completeDeskReview.success).toBe(false)

    const ownConflict = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success message } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: false,
    } }, administrator.cookie)
    expect(ownConflict.data.admin.intake.claim.message).toContain('Acknowledge')
    const claimed = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success response { assignmentVersion } } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: true,
    } }, administrator.cookie)
    expect(claimed.data.admin.intake.claim.success).toBe(true)
    const staleClaim = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success message } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: true,
    } }, administrator.cookie)
    expect(staleClaim.data.admin.intake.claim.success).toBe(false)
    const unsafeDownload = await graphql<any>(`query($id: ID!) { admin { intake {
      documentDownloadUrl(applicationId: $id, submissionDocumentId: "missing") { success message }
    } } }`, { id: submitted.applicationId }, administrator.cookie)
    expect(unsafeDownload.data.admin.intake.documentDownloadUrl.message)
      .toBe('The submitted document has not passed malware scanning.')

    const releaseReason = await reasonId(cycle.id, 'ASSIGNMENT_RELEASE')
    const badRelease = await graphql<any>(`mutation($input: ReleaseApplicationInput!) {
      admin { intake { release(input: $input) { success message } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 1,
      reasonCategoryId: releaseReason, reason: ' ',
    } }, administrator.cookie)
    expect(badRelease.data.admin.intake.release.success).toBe(false)
    const missingRelease = await graphql<any>(`mutation($input: ReleaseApplicationInput!) {
      admin { intake { release(input: $input) { success } } }
    }`, { input: {
      applicationId: 'missing', expectedAssignmentVersion: 1,
      reasonCategoryId: releaseReason, reason: 'Return to queue.',
    } }, administrator.cookie)
    expect(missingRelease.data.admin.intake.release.success).toBe(false)
    const staleRelease = await graphql<any>(`mutation($input: ReleaseApplicationInput!) {
      admin { intake { release(input: $input) { success } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 99,
      reasonCategoryId: releaseReason, reason: 'Return to queue.',
    } }, administrator.cookie)
    expect(staleRelease.data.admin.intake.release.success).toBe(false)
    const reassignReason = await reasonId(cycle.id, 'ASSIGNMENT_REASSIGN')
    const conflictReassign = await graphql<any>(`mutation($input: ReassignApplicationInput!) {
      admin { intake { reassign(input: $input) { success message } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 1,
      toUserId: administrator.userId, reasonCategoryId: reassignReason,
      reason: 'Retain ownership.', conflictAcknowledged: false,
    } }, administrator.cookie)
    expect(conflictReassign.data.admin.intake.reassign.message).toContain('Acknowledge')
    const staleReassign = await graphql<any>(`mutation($input: ReassignApplicationInput!) {
      admin { intake { reassign(input: $input) { success } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedAssignmentVersion: 99,
      toUserId: administrator.userId, reasonCategoryId: reassignReason,
      reason: 'Retain ownership.', conflictAcknowledged: true,
    } }, administrator.cookie)
    expect(staleReassign.data.admin.intake.reassign.success).toBe(false)
    const blankNote = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success message } } }
    }`, { input: { applicationId: submitted.applicationId, note: ' ' } }, administrator.cookie)
    expect(blankNote.data.admin.intake.addInternalNote.success).toBe(false)
    const badCorrection = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success message } } }
    }`, { input: {
      applicationId: submitted.applicationId, note: 'Correction.', correctionOfNoteId: 'missing',
    } }, administrator.cookie)
    expect(badCorrection.data.admin.intake.addInternalNote.success).toBe(false)

    const staleStart = await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: submitted.applicationId, expectedStatusVersion: 99 } }, administrator.cookie)
    expect(staleStart.data.admin.intake.startDeskReview.success).toBe(false)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: submitted.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const checks = deskCheckTypes.map((checkType) => ({
      checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
    }))
    const revisionReasonPlaceholder = await reasonId(cycle.id, 'REVISION')
    const rejectionReason = await reasonId(cycle.id, 'REJECTION')
    const reviewCases = [
      { checks: [], outcome: 'ADVANCE_TO_BANK', revisions: [], identifiers: [] },
      { checks: checks.map((check) => check.checkType === 'EXPANSION_EVIDENCE' ? { ...check, result: 'PASS' } : check), outcome: 'ADVANCE_TO_BANK', revisions: [], identifiers: passingIdentifiers() },
      { checks: checks.map((check) => check.checkType === 'IDENTITY_KYC' ? { ...check, internalNote: 'x'.repeat(2001) } : check), outcome: 'ADVANCE_TO_BANK', revisions: [] },
      { checks: checks.map((check) => check.checkType === 'DPR_FEASIBILITY' ? { ...check, result: 'FAIL' } : check), outcome: 'ADVANCE_TO_BANK', revisions: [] },
      { checks, outcome: 'ADVANCE_TO_BANK', revisions: [{ section: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Change.' }] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: null, applicantMessage: 'Safe.', revisions: [] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: null, revisions: [{
        section: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Clarify funding.',
      }] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [
        { section: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'First.' },
        { section: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Second.' },
      ] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [
        { section: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: ' ' },
      ] },
      { checks, outcome: 'REJECT', reasonCategoryId: rejectionReason, applicantMessage: 'Safe.', revisions: [
        { section: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Change.' },
      ] },
    ]
    for (const candidate of reviewCases) {
      const result = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
        admin { intake { completeDeskReview(input: $input) { success message } } }
      }`, { input: {
        applicationId: submitted.applicationId, expectedStatusVersion: 3,
        reasonCategoryId: null, applicantMessage: null,
        identifiers: passingIdentifiers(), ...candidate,
      } }, administrator.cookie)
      expect(result.data.admin.intake.completeDeskReview.success).toBe(false)
    }
    const staleReview = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedStatusVersion: 99,
      outcome: 'REJECT', checks, reasonCategoryId: rejectionReason,
      applicantMessage: 'Safe.', revisions: [], identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(staleReview.data.admin.intake.completeDeskReview.success).toBe(false)
    const rejected = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { response { application { status assignedToUserId } } } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedStatusVersion: 3,
      outcome: 'REJECT', checks, reasonCategoryId: rejectionReason,
      applicantMessage: 'The submitted evidence did not meet desk-review requirements.',
      revisions: [], identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(rejected.data.admin.intake.completeDeskReview.response.application)
      .toMatchObject({ status: 'REJECTED', assignedToUserId: null })
    const invalidCancel = await graphql<any>(`mutation($input: CancelRevisionInput!) {
      admin { intake { cancelRevision(input: $input) { success } } }
    }`, { input: {
      applicationId: submitted.applicationId, revisionRequestId: 'missing',
      expectedStatusVersion: 0, reason: ' ',
    } }, administrator.cookie)
    expect(invalidCancel.data.admin.intake.cancelRevision.success).toBe(false)

    const expansion = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    await env.DB.prepare(`UPDATE seb_application SET application_type = 'EXPANSION',
      phase_number = 2 WHERE id = ?`).bind(expansion.applicationId).run()
    await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success } } }
    }`, { input: {
      applicationId: expansion.applicationId, expectedAssignmentVersion: 0,
      conflictAcknowledged: true,
    } }, administrator.cookie)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: expansion.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const uncheckedExpansion = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success message } } }
    }`, { input: {
      applicationId: expansion.applicationId, expectedStatusVersion: 3,
      outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
      checks, revisions: [], identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(uncheckedExpansion.data.admin.intake.completeDeskReview.message)
      .toBe('Expansion evidence must be checked for an expansion application.')
  })

  it('returns safe envelopes for malformed or stale bank, TTM, award, release, and recovery actions', async () => {
    const administrator = await adminSession(['ADMIN'])
    const calls = [
      'query { admin { decision { meetingById(meetingId: "missing") { success message } } } }',
      'query { admin { funding { byApplication(applicationId: "missing") { success message } } } }',
      'query { admin { funding { recoveryById(recoveryCaseId: "missing") { success message } } } }',
      'mutation { admin { decision { referToBank(input: { applicationId: "x", submissionId: "x", deskReviewId: "x", expectedStatusVersion: 0, bankName: " ", referralReference: " ", referralDate: "2026-01-01", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { decision { referToBank(input: { applicationId: "x", submissionId: "x", deskReviewId: "x", expectedStatusVersion: 1, bankName: "Bank", referralReference: "R", referralDate: "2026-01-01", applicantMessage: "Safe" }) { success message } } } }',
      'mutation { admin { decision { recordBankOutcome(input: { applicationId: "x", referralId: "x", expectedStatusVersion: 0, expectedReferralVersion: 0, outcome: RECOMMENDED, decisionReference: " ", decisionDate: "2026-01-01", availableLoanAmountPaise: "0", applicantSummary: " ", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { recordBankOutcome(input: { applicationId: "x", referralId: "x", expectedStatusVersion: 1, expectedReferralVersion: 1, outcome: RECOMMENDED, decisionReference: "R", decisionDate: "2026-01-01", applicantSummary: "Safe", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { cancelBankReferral(input: { applicationId: "x", referralId: "x", expectedReferralVersion: 0, reasonCategoryId: "x", reason: " ", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { decision { correctBankOutcome(input: { applicationId: "x", referralId: "x", supersedesOutcomeId: "x", expectedStatusVersion: 0, outcome: RECOMMENDED, decisionReference: " ", decisionDate: "2026-01-01", applicantSummary: " ", correctionReasonCategoryId: "x", correctionReason: " ", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { createMeeting(input: { meetingReference: " ", scheduledAt: "2030-01-01T00:00:00Z", venue: " " }) { success message } } } }',
      'mutation { admin { decision { updateMeeting(input: { meetingId: "x", expectedVersion: 0, meetingReference: " ", scheduledAt: "2030-01-01T00:00:00Z", venue: " ", reason: " " }) { success message } } } }',
      'mutation { admin { decision { updateMeeting(input: { meetingId: "x", expectedVersion: 1, meetingReference: "R", scheduledAt: "2030-01-01T00:00:00Z", venue: "V", reason: "Reason" }) { success message } } } }',
      'mutation { admin { decision { cancelMeeting(input: { meetingId: "x", expectedVersion: 0, reason: " " }) { success message } } } }',
      'mutation { admin { decision { cancelMeeting(input: { meetingId: "x", expectedVersion: 1, reason: "Reason" }) { success message } } } }',
      'mutation { admin { decision { addAgendaItem(input: { meetingId: "x", applicationId: "x", submissionId: "x", bankOutcomeId: "x", position: 0 }) { success message } } } }',
      'mutation { admin { decision { addAgendaItem(input: { meetingId: "x", applicationId: "x", submissionId: "x", bankOutcomeId: "x", position: 1 }) { success message } } } }',
      'mutation { admin { decision { reorderAgendaItem(input: { meetingId: "x", agendaItemId: "x", expectedVersion: 0, position: 0, reason: " " }) { success message } } } }',
      'mutation { admin { decision { reorderAgendaItem(input: { meetingId: "x", agendaItemId: "x", expectedVersion: 1, position: 1, reason: "Reason" }) { success message } } } }',
      'mutation { admin { decision { removeAgendaItem(input: { meetingId: "x", agendaItemId: "x", expectedVersion: 1, reason: "Reason" }) { success message } } } }',
      'mutation { admin { decision { startMeeting(input: { meetingId: "x", expectedVersion: 0 }) { success message } } } }',
      'mutation { admin { decision { startMeeting(input: { meetingId: "x", expectedVersion: 1 }) { success message } } } }',
      'mutation { admin { decision { finalizeMeeting(input: { meetingId: "x", expectedVersion: 1 }) { success message } } } }',
      'mutation { admin { decision { recordDecision(input: { applicationId: "x", agendaItemId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "R", decisionDate: "2026-01-01", approvedAmountPaise: "1", applicantMessage: "Safe", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { correctDecision(input: { applicationId: "x", agendaItemId: "x", supersedesDecisionId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "R", decisionDate: "2026-01-01", approvedAmountPaise: "1", correctionReasonCategoryId: "x", correctionReason: "Reason", applicantMessage: "Safe", revisions: [] }) { success message } } } }',
      'mutation { admin { funding { createAward(input: { applicationId: "x", decisionId: "x", expectedStatusVersion: 0, sanctionOrderNumber: " ", sanctionDate: "2026-01-01" }) { success message } } } }',
      'mutation { admin { funding { createAward(input: { applicationId: "x", decisionId: "x", expectedStatusVersion: 1, sanctionOrderNumber: "ORDER", sanctionDate: "2026-01-01" }) { success message } } } }',
      'mutation { admin { funding { changeAward(input: { awardId: "x", applicationId: "x", expectedVersion: 0, expectedStatusVersion: 0, status: ACTIVE, sanctionedAmountPaise: "0", reasonCategoryId: "x", reason: " " }) { success message } } } }',
      'mutation { admin { funding { recordRelease(input: { awardId: "x", applicationId: "x", expectedLedgerVersion: 0, amountPaise: "0", occurredAt: "2030-01-01T00:00:00Z", externalReference: " ", ttmApprovalReference: " ", ttmApprovalDate: "2026-01-01", bankAccountVerifiedAt: "2030-01-01T00:00:00Z", performanceAgreementReference: " ", performanceAgreementExecutedAt: "2030-01-01T00:00:00Z", physicalVerificationRequired: false, applicantMessage: " " }) { success message } } } }',
      'mutation { admin { funding { recordRelease(input: { awardId: "x", applicationId: "x", expectedLedgerVersion: 0, amountPaise: "1", occurredAt: "2030-01-01T00:00:00Z", externalReference: "R", ttmApprovalReference: "A", ttmApprovalDate: "2026-01-01", bankAccountVerifiedAt: "2030-01-01T00:00:00Z", performanceAgreementReference: "P", performanceAgreementExecutedAt: "2030-01-01T00:00:00Z", physicalVerificationRequired: true, applicantMessage: "Safe" }) { success message } } } }',
      'mutation { admin { funding { reverseRelease(input: { awardId: "x", applicationId: "x", releaseId: "x", expectedLedgerVersion: 0, amountPaise: "0", occurredAt: "2030-01-01T00:00:00Z", externalReference: " ", reasonCategoryId: "x", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { funding { recordAssessment(input: { awardId: "x", applicationId: "x", assessmentType: UTILIZATION, outcome: PASSED, evidenceReference: " ", applicantSummary: " ", assessedAt: "2030-01-01T00:00:00Z" }) { success message } } } }',
      'mutation { admin { funding { recordAssessment(input: { awardId: "x", applicationId: "x", assessmentType: PERFORMANCE, utilizationObligationId: "unexpected", outcome: PASSED, evidenceReference: "R", applicantSummary: "Safe", assessedAt: "2030-01-01T00:00:00Z" }) { success message } } } }',
      'mutation { admin { funding { openRecovery(input: { awardId: "x", officialDecisionReference: " ", officialDecisionDate: "2026-01-01", reasonCategoryId: "x", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { funding { recordRecoveryEntry(input: { recoveryCaseId: "x", expectedLedgerVersion: 0, entryType: REVERSAL, component: PRINCIPAL, amountPaise: "0", externalReference: " ", occurredAt: "2030-01-01T00:00:00Z", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { funding { recordRecoveryEntry(input: { recoveryCaseId: "x", expectedLedgerVersion: 0, entryType: DEMAND, component: PRINCIPAL, relatedEntryId: "unexpected", amountPaise: "1", externalReference: "R", occurredAt: "2030-01-01T00:00:00Z", applicantMessage: "Safe" }) { success message } } } }',
      'mutation { admin { funding { cancelRecovery(input: { recoveryCaseId: "x", expectedVersion: 0, reason: " " }) { success message } } } }',
      'mutation { admin { funding { closeRecovery(input: { recoveryCaseId: "x", expectedVersion: 0, reason: " " }) { success message } } } }',
      'mutation { admin { funding { closeRecovery(input: { recoveryCaseId: "x", expectedVersion: 1, reason: "Reason" }) { success message } } } }',
    ]
    for (const query of calls) {
      const result = await graphql<any>(query, {}, administrator.cookie)
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
  })

  it('runs the claimed application through desk review, bank, TTM, award, release, assessment, and recovery', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const submitted = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const applicationId = submitted.applicationId
    let submissionId = submitted.submissionId
    const db = createDatabase(env.DB)
    const [firstSnapshot] = await db.select().from(sebApplicationVersion).where(
      eq(sebApplicationVersion.applicationId, applicationId),
    ).limit(1)
    if (!firstSnapshot) throw new Error('first submission snapshot missing')
    submissionId = crypto.randomUUID()
    const evidenceDocumentId = crypto.randomUUID()
    const evidenceVersionId = crypto.randomUUID()
    const evidencePinId = crypto.randomUUID()
    const resubmittedAt = new Date()
    await db.batch([
      db.insert(sebApplicationVersion).values({
        ...firstSnapshot,
        id: crypto.randomUUID(),
        version: 2,
        changeType: 'RESUBMISSION',
        seedFundRequestedPaise: 900_000,
        createdAt: resubmittedAt,
      }),
      db.insert(sebApplicationSubmission).values({
        id: submissionId,
        applicationId,
        submissionNumber: 2,
        applicationVersion: 2,
        submittedByUserId: administrator.userId,
        submittedAt: resubmittedAt,
      }),
      db.update(sebApplication).set({ currentVersion: 2, updatedAt: resubmittedAt })
        .where(eq(sebApplication.id, applicationId)),
    ])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO seb_application_document (
        id, application_id, document_type, current_version, created_at, updated_at
      ) VALUES (?, ?, 'DPR', 1, ?, ?)`).bind(
        evidenceDocumentId, applicationId, resubmittedAt.getTime(), resubmittedAt.getTime(),
      ),
      env.DB.prepare(`INSERT INTO seb_application_document_version (
        id, document_id, version, operation, r2_object_key, original_filename,
        content_type, size_bytes, checksum, uploaded_by_user_id, created_at
      ) VALUES (?, ?, 1, 'UPLOAD', ?, 'project-report.pdf', 'application/pdf', 100,
        'TEST-CHECKSUM', ?, ?)`).bind(
        evidenceVersionId, evidenceDocumentId, `admin-workspace/${evidenceVersionId}`,
        administrator.userId, resubmittedAt.getTime(),
      ),
      env.DB.prepare(`INSERT INTO seb_application_submission_document (
        id, application_id, submission_id, document_id, document_version,
        document_type, created_at
      ) VALUES (?, ?, ?, ?, 1, 'DPR', ?)`).bind(
        evidencePinId, applicationId, submissionId, evidenceDocumentId,
        resubmittedAt.getTime(),
      ),
      env.DB.prepare(`INSERT INTO seb_application_document_scan (
        id, document_version_id, sequence_number, status, scanner_reference,
        safe_message, scanned_at, created_at
      ) VALUES (?, ?, 1, 'ACCEPTED', 'ADMIN-WORKSPACE-TEST', 'Accepted.', ?, ?)`)
        .bind(
          crypto.randomUUID(), evidenceVersionId,
          resubmittedAt.getTime(), resubmittedAt.getTime(),
        ),
    ])
    const applicantTimeline = await graphql<any>(`query($id: ID!) { seb { application {
      timeline(applicationId: $id, first: 20) { response { nodes { eventType message } } }
    } } }`, { id: applicationId }, administrator.cookie)
    expect(applicantTimeline.data.seb.application.timeline.response.nodes.map((event: any) => event.eventType))
      .toContain('CYCLE_OPENED')

    const queue = await graphql<any>(`query { admin { intake { queue(input: {
      first: 20, status: SUBMITTED, order: OLDEST_WAITING
    }) { response { nodes { id submissionNumber sector category } } } } } }`, {}, administrator.cookie)
    expect(queue.errors).toBeUndefined()
    expect(queue.data.admin.intake.queue.response.nodes[0].id).toBe(applicationId)

    const claim = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { response { assignmentVersion } } } }
    }`, { input: { applicationId, expectedAssignmentVersion: 0, conflictAcknowledged: true } }, administrator.cookie)
    expect(claim.data.admin.intake.claim.response.assignmentVersion).toBe(1)

    const firstNote = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success message response { notes { id note correctionOfNoteId } } } } }
    }`, { input: { applicationId, note: 'Initial staff-only observation.' } }, administrator.cookie)
    expect(firstNote.data.admin.intake.addInternalNote, JSON.stringify(firstNote)).toMatchObject({ success: true })
    const noteId = firstNote.data.admin.intake.addInternalNote.response.notes[0].id as string
    const correctionNote = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { response { notes { id correctionOfNoteId } } } } }
    }`, { input: {
      applicationId, note: 'Correction: verified observation.', correctionOfNoteId: noteId,
    } }, administrator.cookie)
    expect(correctionNote.data.admin.intake.addInternalNote.response.notes[1].correctionOfNoteId).toBe(noteId)

    const releaseReason = await reasonId(cycle.id, 'ASSIGNMENT_RELEASE')
    const releasedAssignment = await graphql<any>(`mutation($input: ReleaseApplicationInput!) {
      admin { intake { release(input: $input) { response { assignmentVersion assignedToUserId } } } }
    }`, { input: {
      applicationId, expectedAssignmentVersion: 1, reasonCategoryId: releaseReason,
      reason: 'Temporarily return to the shared queue.',
    } }, administrator.cookie)
    expect(releasedAssignment.data.admin.intake.release.response).toMatchObject({
      assignmentVersion: 2, assignedToUserId: null,
    })
    const unassignedNote = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success message } } }
    }`, { input: {
      applicationId, note: 'This must not be written while the case is unassigned.',
    } }, administrator.cookie)
    expect(unassignedNote.data.admin.intake.addInternalNote.success).toBe(false)
    const secondAdministrator = await adminSession(['ADMIN'])
    const secondClaim = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { response { assignmentVersion } } } }
    }`, { input: {
      applicationId, expectedAssignmentVersion: 2, conflictAcknowledged: false,
    } }, secondAdministrator.cookie)
    expect(secondClaim.data.admin.intake.claim.response.assignmentVersion).toBe(3)
    const reassignReason = await reasonId(cycle.id, 'ASSIGNMENT_REASSIGN')
    const reassigned = await graphql<any>(`mutation($input: ReassignApplicationInput!) {
      admin { intake { reassign(input: $input) { response { assignmentVersion assignedToUserId } } } }
    }`, { input: {
      applicationId, expectedAssignmentVersion: 3, toUserId: administrator.userId,
      reasonCategoryId: reassignReason, reason: 'Return to the original reviewer.',
      conflictAcknowledged: true,
    } }, secondAdministrator.cookie)
    expect(reassigned.data.admin.intake.reassign.response).toMatchObject({
      assignmentVersion: 4, assignedToUserId: administrator.userId,
    })

    const reviewStart = await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { response { status statusVersion } } } }
    }`, { input: { applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    expect(reviewStart.data.admin.intake.startDeskReview.response.status).toBe('DESK_REVIEW')
    const review = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success response { reviews { id } application { status statusVersion } } } } }
    }`, { input: {
      applicationId, expectedStatusVersion: 3, outcome: 'ADVANCE_TO_BANK',
      reasonCategoryId: null, applicantMessage: null, revisions: [],
      checks: deskCheckTypes.map((checkType) => ({
        checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
      })),
      identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(review.data.admin.intake.completeDeskReview.success).toBe(true)
    const reviewId = review.data.admin.intake.completeDeskReview.response.reviews[0].id as string

    const referral = await graphql<any>(`mutation($input: BankReferralInput!) {
      admin { decision { referToBank(input: $input) { response { referrals { id currentVersion } application { statusVersion } } } } }
    }`, { input: {
      applicationId, submissionId, deskReviewId: reviewId, expectedStatusVersion: 4,
      bankName: 'Tripura Gramin Bank', bankBranch: 'Agartala',
      referralReference: `BANK-${applicationId}`, referralDate: '2026-06-01',
      applicantMessage: 'Sent for partner-bank evaluation.', internalNote: 'Offline handover.',
    } }, administrator.cookie)
    const referralWorkspace = referral.data.admin.decision.referToBank.response
    const referralRow = referralWorkspace.referrals[0]
    expect(referralWorkspace.application.statusVersion).toBe(5)
    const bankRevisionReason = await reasonId(cycle.id, 'REVISION')
    const invalidBankCases = [
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [] },
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [
        { section: 'FINANCIAL', reasonCategoryId: bankRevisionReason, note: 'First.' },
        { section: 'FINANCIAL', reasonCategoryId: bankRevisionReason, note: 'Second.' },
      ] },
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [
        { section: 'FINANCIAL', reasonCategoryId: 'missing', note: 'Correction.' },
      ] },
      { outcome: 'RECOMMENDED', revisions: [
        { section: 'FINANCIAL', reasonCategoryId: bankRevisionReason, note: 'Unexpected.' },
      ] },
    ]
    for (const [index, candidate] of invalidBankCases.entries()) {
      const invalid = await graphql<any>(`mutation($input: BankOutcomeInput!) {
        admin { decision { recordBankOutcome(input: $input) { success } } }
      }`, { input: {
        applicationId, referralId: referralRow.id, expectedStatusVersion: 5,
        expectedReferralVersion: 1, decisionReference: `INVALID-BANK-${index}`,
        decisionDate: '2026-06-09', availableLoanAmountPaise: null,
        applicantSummary: 'Safe feedback.', internalNote: null, ...candidate,
      } }, administrator.cookie)
      expect(invalid.data.admin.decision.recordBankOutcome.success).toBe(false)
    }
    const bank = await graphql<any>(`mutation($input: BankOutcomeInput!) {
      admin { decision { recordBankOutcome(input: $input) { success message response { bankOutcomes { id } application { status statusVersion } } } } }
    }`, { input: {
      applicationId, referralId: referralRow.id,
      expectedStatusVersion: referralWorkspace.application.statusVersion,
      expectedReferralVersion: referralRow.currentVersion, outcome: 'MORE_INFORMATION_REQUIRED',
      decisionReference: `BANK-DEC-${applicationId}`, decisionDate: '2026-06-10',
      availableLoanAmountPaise: '0', applicantSummary: 'Bank feedback was recorded for TTM.',
      internalNote: null, revisions: [{
        section: 'FINANCIAL', reasonCategoryId: bankRevisionReason,
        note: 'Clarify the proposed bank-loan component.',
      }],
    } }, administrator.cookie)
    expect(bank.data.admin.decision.recordBankOutcome, JSON.stringify(bank)).toMatchObject({ success: true })
    expect(bank.data.admin.decision.recordBankOutcome.response.application.status).toBe('REVISION_REQUIRED')
    const firstOutcomeId = bank.data.admin.decision.recordBankOutcome.response.bankOutcomes[0].id as string
    const staleBankOutcome = await graphql<any>(`mutation($input: BankOutcomeInput!) {
      admin { decision { recordBankOutcome(input: $input) { success } } }
    }`, { input: {
      applicationId, referralId: referralRow.id, expectedStatusVersion: 5,
      expectedReferralVersion: 1, outcome: 'RECOMMENDED',
      decisionReference: `STALE-BANK-${applicationId}`, decisionDate: '2026-06-10',
      availableLoanAmountPaise: null, applicantSummary: 'This stale write must lose.',
      internalNote: null, revisions: [],
    } }, administrator.cookie)
    expect(staleBankOutcome.data.admin.decision.recordBankOutcome.success).toBe(false)
    const correctionReason = await reasonId(cycle.id, 'BANK_OUTCOME_CORRECTION')
    const invalidCorrectionCases = [
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [] },
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [
        { section: 'DOCUMENTS', reasonCategoryId: bankRevisionReason, note: 'First.' },
        { section: 'DOCUMENTS', reasonCategoryId: bankRevisionReason, note: 'Second.' },
      ] },
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [
        { section: 'DOCUMENTS', reasonCategoryId: 'missing', note: 'Correction.' },
      ] },
      { outcome: 'RECOMMENDED', revisions: [
        { section: 'DOCUMENTS', reasonCategoryId: bankRevisionReason, note: 'Unexpected.' },
      ] },
    ]
    for (const [index, candidate] of invalidCorrectionCases.entries()) {
      const invalid = await graphql<any>(`mutation($input: CorrectBankOutcomeInput!) {
        admin { decision { correctBankOutcome(input: $input) { success } } }
      }`, { input: {
        applicationId, referralId: referralRow.id, supersedesOutcomeId: firstOutcomeId,
        expectedStatusVersion: 6, decisionReference: `INVALID-CORR-${index}`,
        decisionDate: '2026-06-10', availableLoanAmountPaise: null,
        applicantSummary: 'Safe correction.', internalNote: null,
        correctionReasonCategoryId: correctionReason, correctionReason: 'Correct evidence.',
        ...candidate,
      } }, administrator.cookie)
      expect(invalid.data.admin.decision.correctBankOutcome.success).toBe(false)
    }
    const correctedBank = await graphql<any>(`mutation($input: CorrectBankOutcomeInput!) {
      admin { decision { correctBankOutcome(input: $input) { response { bankOutcomes { id outcome } application { statusVersion } } } } }
    }`, { input: {
      applicationId, referralId: referralRow.id, supersedesOutcomeId: firstOutcomeId,
      expectedStatusVersion: 6, outcome: 'MORE_INFORMATION_REQUIRED',
      decisionReference: `BANK-CORR-${applicationId}`, decisionDate: '2026-06-11',
      availableLoanAmountPaise: null, applicantSummary: 'Bank requested corrected supporting evidence.',
      internalNote: 'Signed correction received offline.',
      correctionReasonCategoryId: correctionReason, correctionReason: 'Correct signed outcome received.',
      revisions: [{
        section: 'DOCUMENTS', reasonCategoryId: bankRevisionReason,
        note: 'Replace the unclear bank supporting document.',
      }],
    } }, administrator.cookie)
    const correctedBankWorkspace = correctedBank.data.admin.decision.correctBankOutcome.response
    expect(correctedBankWorkspace.application.statusVersion).toBe(7)
    const moreInformationOutcomeId = correctedBankWorkspace.bankOutcomes[1].id as string
    const recommendedBank = await graphql<any>(`mutation($input: CorrectBankOutcomeInput!) {
      admin { decision { correctBankOutcome(input: $input) { response { bankOutcomes { id } application { statusVersion } } } } }
    }`, { input: {
      applicationId, referralId: referralRow.id, supersedesOutcomeId: moreInformationOutcomeId,
      expectedStatusVersion: 7, outcome: 'RECOMMENDED',
      decisionReference: `BANK-FINAL-${applicationId}`, decisionDate: '2026-06-12',
      availableLoanAmountPaise: '500000', applicantSummary: 'Final corrected feedback for TTM.',
      internalNote: null, correctionReasonCategoryId: correctionReason,
      correctionReason: 'Replacement evidence resolved the query.', revisions: [],
    } }, administrator.cookie)
    const recommendedWorkspace = recommendedBank.data.admin.decision.correctBankOutcome.response
    expect(recommendedWorkspace.application.statusVersion).toBe(8)
    const outcomeId = recommendedWorkspace.bankOutcomes[2].id as string
    const staleBankCorrection = await graphql<any>(`mutation($input: CorrectBankOutcomeInput!) {
      admin { decision { correctBankOutcome(input: $input) { success } } }
    }`, { input: {
      applicationId, referralId: referralRow.id, supersedesOutcomeId: moreInformationOutcomeId,
      expectedStatusVersion: 7, outcome: 'RECOMMENDED',
      decisionReference: `STALE-CORR-${applicationId}`, decisionDate: '2026-06-12',
      availableLoanAmountPaise: null, applicantSummary: 'This stale correction must lose.',
      internalNote: null, correctionReasonCategoryId: correctionReason,
      correctionReason: 'Attempt stale replacement.', revisions: [],
    } }, administrator.cookie)
    expect(staleBankCorrection.data.admin.decision.correctBankOutcome.success).toBe(false)

    const meeting = await graphql<any>(`mutation($input: CreateTtmMeetingInput!) {
      admin { decision { createMeeting(input: $input) { response { meeting { id currentVersion } } } } }
    }`, { input: {
      meetingReference: `TTM-${applicationId}`, scheduledAt: new Date().toISOString(),
      venue: 'TTAADC Secretariat', description: 'Mission SEP decisions',
    } }, administrator.cookie)
    const meetingHead = meeting.data.admin.decision.createMeeting.response.meeting
    const duplicateMeeting = await graphql<any>(`mutation($input: CreateTtmMeetingInput!) {
      admin { decision { createMeeting(input: $input) { success message } } }
    }`, { input: {
      meetingReference: `TTM-${applicationId}`, scheduledAt: new Date().toISOString(),
      venue: 'Another venue', description: null,
    } }, administrator.cookie)
    expect(duplicateMeeting.data.admin.decision.createMeeting.success).toBe(false)
    const updatedMeeting = await graphql<any>(`mutation($input: UpdateTtmMeetingInput!) {
      admin { decision { updateMeeting(input: $input) { response { meeting { currentVersion venue } } } } }
    }`, { input: {
      meetingId: meetingHead.id, expectedVersion: 1,
      meetingReference: `TTM-${applicationId}`, scheduledAt: new Date().toISOString(),
      venue: 'TTAADC Conference Hall', description: 'Mission SEP decisions',
      reason: 'Use the larger meeting room.',
    } }, administrator.cookie)
    expect(updatedMeeting.data.admin.decision.updateMeeting.response.meeting.currentVersion).toBe(2)
    const agenda = await graphql<any>(`mutation($input: AddAgendaItemInput!) {
      admin { decision { addAgendaItem(input: $input) { response { agenda { id } meeting { currentVersion } } } } }
    }`, { input: {
      meetingId: meetingHead.id, applicationId, submissionId,
      bankOutcomeId: outcomeId, position: 1,
    } }, administrator.cookie)
    const agendaId = agenda.data.admin.decision.addAgendaItem.response.agenda[0].id as string
    const reordered = await graphql<any>(`mutation($input: ReorderAgendaItemInput!) {
      admin { decision { reorderAgendaItem(input: $input) { response { agenda { id position currentVersion } } } } }
    }`, { input: {
      meetingId: meetingHead.id, agendaItemId: agendaId, expectedVersion: 1,
      position: 2, reason: 'Adjust the agenda order.',
    } }, administrator.cookie)
    expect(reordered.data.admin.decision.reorderAgendaItem.response.agenda[0]).toMatchObject({
      position: 2, currentVersion: 2,
    })
    await graphql<any>(`mutation($input: TtmMeetingTransitionInput!) {
      admin { decision { startMeeting(input: $input) { success } } }
    }`, { input: { meetingId: meetingHead.id, expectedVersion: 2 } }, administrator.cookie)
    const ttmRejectionReason = await reasonId(cycle.id, 'REJECTION')
    const revisionReason = await reasonId(cycle.id, 'REVISION')
    const deferralReason = await reasonId(cycle.id, 'TTM_DEFERRAL')
    const malformedDecision = await graphql<any>(`mutation($input: TtmDecisionInput!) {
      admin { decision { recordDecision(input: $input) { success message } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, expectedStatusVersion: 0,
      outcome: 'APPROVED', decisionReference: ' ', decisionDate: '2026-06-15',
      approvedAmountPaise: '1', applicantConditions: null, reasonCategoryId: null,
      applicantMessage: ' ', nextAction: null, revisions: [],
    } }, administrator.cookie)
    expect(malformedDecision.data.admin.decision.recordDecision.message)
      .toBe('Enter valid TTM decision details.')
    const invalidDecisionCases = [
      { outcome: 'APPROVED', approvedAmountPaise: '1000001', reasonCategoryId: null, nextAction: null, revisions: [] },
      { outcome: 'REJECTED', approvedAmountPaise: '1', reasonCategoryId: ttmRejectionReason, nextAction: null, revisions: [] },
      { outcome: 'DEFERRED', approvedAmountPaise: null, reasonCategoryId: deferralReason, nextAction: null, revisions: [] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: null, nextAction: 'Unexpected', revisions: [] },
      { outcome: 'REJECTED', approvedAmountPaise: null, reasonCategoryId: null, nextAction: null, revisions: [] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: ttmRejectionReason, nextAction: null, revisions: [] },
      { outcome: 'REVISION_REQUIRED', approvedAmountPaise: null, reasonCategoryId: revisionReason, nextAction: null, revisions: [] },
      { outcome: 'REVISION_REQUIRED', approvedAmountPaise: null, reasonCategoryId: revisionReason, nextAction: null, revisions: [
        { section: 'FINANCIAL', reasonCategoryId: revisionReason, note: 'First.' },
        { section: 'FINANCIAL', reasonCategoryId: revisionReason, note: 'Second.' },
      ] },
      { outcome: 'REVISION_REQUIRED', approvedAmountPaise: null, reasonCategoryId: revisionReason, nextAction: null, revisions: [
        { section: 'FINANCIAL', reasonCategoryId: revisionReason, note: ' ' },
      ] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: null, nextAction: null, revisions: [
        { section: 'FINANCIAL', reasonCategoryId: revisionReason, note: 'Unexpected.' },
      ] },
    ]
    for (const [index, candidate] of invalidDecisionCases.entries()) {
      const invalid = await graphql<any>(`mutation($input: TtmDecisionInput!) {
        admin { decision { recordDecision(input: $input) { success message } } }
      }`, { input: {
        applicationId, agendaItemId: agendaId, expectedStatusVersion: 8,
        decisionReference: `INVALID-${index}-${applicationId}`, decisionDate: '2026-06-15',
        applicantConditions: null, applicantMessage: 'Safe explanation.', ...candidate,
      } }, administrator.cookie)
      expect(invalid.data.admin.decision.recordDecision.success).toBe(false)
    }
    const decision = await graphql<any>(`mutation($input: TtmDecisionInput!) {
      admin { decision { recordDecision(input: $input) { response { decisions { id } application { status statusVersion } } } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, expectedStatusVersion: 8,
      outcome: 'REVISION_REQUIRED', decisionReference: `TTM-DEC-${applicationId}`,
      decisionDate: '2026-06-15', approvedAmountPaise: null,
      applicantConditions: null, reasonCategoryId: revisionReason,
      applicantMessage: 'TTM initially requested a financial correction.',
      nextAction: null, revisions: [{
        section: 'FINANCIAL', reasonCategoryId: revisionReason,
        note: 'Clarify the requested amount.',
      }],
    } }, administrator.cookie)
    expect(decision.data.admin.decision.recordDecision.response.application.status).toBe('REVISION_REQUIRED')
    const initialDecisionId = decision.data.admin.decision.recordDecision.response.decisions[0].id as string
    const staleInitialDecision = await graphql<any>(`mutation($input: TtmDecisionInput!) {
      admin { decision { recordDecision(input: $input) { success } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, expectedStatusVersion: 8,
      outcome: 'DEFERRED', decisionReference: `STALE-TTM-${applicationId}`,
      decisionDate: '2026-06-15', approvedAmountPaise: null,
      applicantConditions: null, reasonCategoryId: deferralReason,
      applicantMessage: 'This stale decision must lose.', nextAction: 'Review later.', revisions: [],
    } }, administrator.cookie)
    expect(staleInitialDecision.data.admin.decision.recordDecision.success).toBe(false)
    const decisionCorrectionReason = await reasonId(cycle.id, 'TTM_DECISION_CORRECTION')
    const invalidDecisionCorrections = [
      { outcome: 'REJECTED', reasonCategoryId: null, revisions: [] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: ttmRejectionReason, revisions: [] },
      { outcome: 'REVISION_REQUIRED', reasonCategoryId: revisionReason, revisions: [] },
      { outcome: 'REVISION_REQUIRED', reasonCategoryId: revisionReason, revisions: [
        { section: 'DOCUMENTS', reasonCategoryId: 'missing', note: 'Correction.' },
      ] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: null, revisions: [
        { section: 'DOCUMENTS', reasonCategoryId: revisionReason, note: 'Unexpected.' },
      ] },
    ]
    for (const [index, candidate] of invalidDecisionCorrections.entries()) {
      const invalid = await graphql<any>(`mutation($input: CorrectTtmDecisionInput!) {
        admin { decision { correctDecision(input: $input) { success } } }
      }`, { input: {
        applicationId, agendaItemId: agendaId, supersedesDecisionId: initialDecisionId,
        expectedStatusVersion: 9, decisionReference: `INVALID-TTM-CORR-${index}`,
        decisionDate: '2026-06-16', approvedAmountPaise: null, applicantConditions: null,
        correctionReasonCategoryId: decisionCorrectionReason, correctionReason: 'Correction.',
        applicantMessage: 'Safe explanation.', nextAction: null, ...candidate,
      } }, administrator.cookie)
      expect(invalid.data.admin.decision.correctDecision.success).toBe(false)
    }
    const rejectedDecision = await graphql<any>(`mutation($input: CorrectTtmDecisionInput!) {
      admin { decision { correctDecision(input: $input) { response { decisions { id } application { status statusVersion assignmentVersion } } } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, supersedesDecisionId: initialDecisionId,
      expectedStatusVersion: 9, outcome: 'REJECTED',
      decisionReference: `TTM-REJECT-${applicationId}`, decisionDate: '2026-06-16',
      approvedAmountPaise: null, applicantConditions: null,
      reasonCategoryId: ttmRejectionReason, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'The initial revision direction was incorrect.',
      applicantMessage: 'TTM rejected the application.', nextAction: null, revisions: [],
    } }, administrator.cookie)
    const rejectedWorkspace = rejectedDecision.data.admin.decision.correctDecision.response
    expect(rejectedWorkspace.application).toMatchObject({
      status: 'REJECTED', statusVersion: 10, assignmentVersion: 5,
    })
    const rejectedDecisionId = rejectedWorkspace.decisions[1].id as string
    const reclaimed = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { response { assignmentVersion } } } }
    }`, { input: {
      applicationId, expectedAssignmentVersion: 5, conflictAcknowledged: true,
    } }, administrator.cookie)
    expect(reclaimed.data.admin.intake.claim.response.assignmentVersion).toBe(6)
    const revisionDecision = await graphql<any>(`mutation($input: CorrectTtmDecisionInput!) {
      admin { decision { correctDecision(input: $input) { response { decisions { id approvedAmountPaise } application { statusVersion } } } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, supersedesDecisionId: rejectedDecisionId,
      expectedStatusVersion: 10, outcome: 'REVISION_REQUIRED',
      decisionReference: `TTM-CORR-${applicationId}`, decisionDate: '2026-06-17',
      approvedAmountPaise: null, applicantConditions: null,
      reasonCategoryId: revisionReason, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Replace the mistaken rejection with a revision request.',
      applicantMessage: 'TTM requires one document correction.', nextAction: null,
      revisions: [{
        section: 'DOCUMENTS', reasonCategoryId: revisionReason,
        note: 'Replace the unclear supporting document.',
      }],
    } }, administrator.cookie)
    const revisionDecisionWorkspace = revisionDecision.data.admin.decision.correctDecision.response
    expect(revisionDecisionWorkspace.application.statusVersion).toBe(11)
    const revisionDecisionId = revisionDecisionWorkspace.decisions[2].id as string
    const deferredDecision = await graphql<any>(`mutation($input: CorrectTtmDecisionInput!) {
      admin { decision { correctDecision(input: $input) { response { decisions { id } application { statusVersion } } } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, supersedesDecisionId: revisionDecisionId,
      expectedStatusVersion: 11, outcome: 'DEFERRED',
      decisionReference: `TTM-DEFER-${applicationId}`, decisionDate: '2026-06-18',
      approvedAmountPaise: null, applicantConditions: null,
      reasonCategoryId: deferralReason, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Additional signed evidence reached TTM.',
      applicantMessage: 'TTM deferred the matter for final verification.',
      nextAction: 'Verify the replacement document.', revisions: [],
    } }, administrator.cookie)
    const deferredWorkspace = deferredDecision.data.admin.decision.correctDecision.response
    expect(deferredWorkspace.application.statusVersion).toBe(12)
    const deferredDecisionId = deferredWorkspace.decisions[3].id as string
    const correctedDecision = await graphql<any>(`mutation($input: CorrectTtmDecisionInput!) {
      admin { decision { correctDecision(input: $input) { response { decisions { id approvedAmountPaise } application { statusVersion } } } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, supersedesDecisionId: deferredDecisionId,
      expectedStatusVersion: 12, outcome: 'APPROVED',
      decisionReference: `TTM-APPROVE-${applicationId}`, decisionDate: '2026-06-19',
      approvedAmountPaise: '900000', applicantConditions: 'Use funds only for approved assets.',
      reasonCategoryId: null, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Final verification completed.',
      applicantMessage: 'TTM approved the corrected application.', nextAction: null, revisions: [],
    } }, administrator.cookie)
    const correctedDecisionWorkspace = correctedDecision.data.admin.decision.correctDecision.response
    expect(correctedDecisionWorkspace.application.statusVersion).toBe(13)
    const decisionId = correctedDecisionWorkspace.decisions[4].id as string
    const staleDecisionCorrection = await graphql<any>(`mutation($input: CorrectTtmDecisionInput!) {
      admin { decision { correctDecision(input: $input) { success } } }
    }`, { input: {
      applicationId, agendaItemId: agendaId, supersedesDecisionId: deferredDecisionId,
      expectedStatusVersion: 12, outcome: 'APPROVED',
      decisionReference: `STALE-APPROVAL-${applicationId}`, decisionDate: '2026-06-19',
      approvedAmountPaise: '900000', applicantConditions: null, reasonCategoryId: null,
      correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Attempt stale correction.',
      applicantMessage: 'This stale correction must lose.', nextAction: null, revisions: [],
    } }, administrator.cookie)
    expect(staleDecisionCorrection.data.admin.decision.correctDecision.success).toBe(false)
    const finalized = await graphql<any>(`mutation($input: TtmMeetingTransitionInput!) {
      admin { decision { finalizeMeeting(input: $input) { response { meeting { status currentVersion } } } } }
    }`, { input: { meetingId: meetingHead.id, expectedVersion: 3 } }, administrator.cookie)
    expect(finalized.data.admin.decision.finalizeMeeting.response.meeting.status).toBe('FINALIZED')
    const meetings = await graphql<any>(`query($id: ID!) { admin { decision {
      meetings { response { nodes { id status } pageInfo { totalCount } } }
      meetingById(meetingId: $id) { response { agenda { id } decisions { id } } }
    } } }`, { id: meetingHead.id }, administrator.cookie)
    expect(meetings.data.admin.decision.meetingById.response.decisions).toHaveLength(5)
    const award = await graphql<any>(`mutation($input: CreateAwardInput!) {
      admin { funding { createAward(input: $input) { response { award { id ledgerVersion } } } } }
    }`, { input: {
      applicationId, decisionId, expectedStatusVersion: 13,
      sanctionOrderNumber: `SANCTION-${applicationId}`, sanctionDate: '2026-06-20',
      applicantConditions: 'Submit utilization evidence.',
    } }, administrator.cookie)
    const awardHead = award.data.admin.funding.createAward.response.award
    const fundingQuery = await graphql<any>(`query($id: ID!) { admin { funding {
      byApplication(applicationId: $id) { success response { award { id } recovery { id } } }
    } } }`, { id: applicationId }, administrator.cookie)
    expect(fundingQuery.data.admin.funding.byApplication).toMatchObject({
      success: true, response: { award: { id: awardHead.id }, recovery: [] },
    })
    const amendmentReason = await reasonId(cycle.id, 'AWARD_AMENDMENT')
    const wrongAmendmentReason = await reasonId(cycle.id, 'AWARD_CANCELLATION')
    const noOpAmendment = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success message } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 1, expectedStatusVersion: 14,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence.',
      reasonCategoryId: amendmentReason, reason: 'No values changed.',
    } }, administrator.cookie)
    expect(noOpAmendment.data.admin.funding.changeAward.success).toBe(false)
    const rejectedAmendment = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success message } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 1, expectedStatusVersion: 14,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: wrongAmendmentReason, reason: 'Wrong category.',
    } }, administrator.cookie)
    expect(rejectedAmendment.data.admin.funding.changeAward.message)
      .toBe('Select an approved award-change reason.')
    const amended = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { response { award { status currentVersion applicantConditions } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 1, expectedStatusVersion: 14,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: amendmentReason, reason: 'Clarify evidence timing.',
    } }, administrator.cookie)
    expect(amended.data.admin.funding.changeAward.response.award.currentVersion).toBe(2)
    const suspensionReason = await reasonId(cycle.id, 'AWARD_SUSPENSION')
    const suspended = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { response { award { status currentVersion } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 2, expectedStatusVersion: 14,
      status: 'SUSPENDED', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: suspensionReason, reason: 'Pause pending verification.',
    } }, administrator.cookie)
    expect(suspended.data.admin.funding.changeAward.response.award).toMatchObject({
      status: 'SUSPENDED', currentVersion: 3,
    })
    const staleResume = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 2, expectedStatusVersion: 14,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: suspensionReason, reason: 'A stale reviewer tries to resume.',
    } }, administrator.cookie)
    expect(staleResume.data.admin.funding.changeAward.success).toBe(false)
    const blockedRelease = await graphql<any>(`mutation($input: RecordReleaseInput!) {
      admin { funding { recordRelease(input: $input) { success message } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedLedgerVersion: 0, amountPaise: '1',
      occurredAt: new Date().toISOString(), externalReference: `BLOCKED-${applicationId}`,
      ttmApprovalReference: 'BLOCKED', ttmApprovalDate: '2026-06-21',
      bankAccountVerifiedAt: new Date().toISOString(), performanceAgreementReference: 'BLOCKED',
      performanceAgreementExecutedAt: new Date().toISOString(),
      physicalVerificationRequired: false, physicalVerificationReference: null,
      physicalVerificationCompletedAt: null, applicantMessage: 'Should not release.',
    } }, administrator.cookie)
    expect(blockedRelease.data.admin.funding.recordRelease.success).toBe(false)
    const resumed = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { response { award { status currentVersion } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 3, expectedStatusVersion: 14,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: suspensionReason, reason: 'Verification complete.',
    } }, administrator.cookie)
    expect(resumed.data.admin.funding.changeAward.response.award).toMatchObject({
      status: 'ACTIVE', currentVersion: 4,
    })
    const release = await graphql<any>(`mutation($input: RecordReleaseInput!) {
      admin { funding { recordRelease(input: $input) { response { award { ledgerVersion } ledger { id } obligations { id } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedLedgerVersion: awardHead.ledgerVersion,
      amountPaise: '600000', occurredAt: new Date().toISOString(),
      externalReference: `PAY-${applicationId}`, ttmApprovalReference: `TTM-REL-${applicationId}`,
      ttmApprovalDate: '2026-06-25', bankAccountVerifiedAt: new Date().toISOString(),
      performanceAgreementReference: `PA-${applicationId}`,
      performanceAgreementExecutedAt: new Date().toISOString(),
      physicalVerificationRequired: true, physicalVerificationReference: `PV-${applicationId}`,
      physicalVerificationCompletedAt: new Date().toISOString(),
      applicantMessage: 'First release recorded.',
    } }, administrator.cookie)
    const funding = release.data.admin.funding.recordRelease.response
    const obligationId = funding.obligations[0].id as string
    const assessment = await graphql<any>(`mutation($input: RecordAssessmentInput!) {
      admin { funding { recordAssessment(input: $input) { response { assessments { assessmentType outcome } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, assessmentType: 'UTILIZATION',
      utilizationObligationId: obligationId, outcome: 'PASSED',
      evidenceReference: `UC-${applicationId}`, applicantSummary: 'Utilization passed.',
      internalNote: null, assessedAt: new Date().toISOString(),
    } }, administrator.cookie)
    expect(assessment.data.admin.funding.recordAssessment.response.assessments[0].outcome).toBe('PASSED')
    const wrongApplicationAssessment = await graphql<any>(`mutation($input: RecordAssessmentInput!) {
      admin { funding { recordAssessment(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, applicationId: 'missing', assessmentType: 'PERFORMANCE',
      utilizationObligationId: null, outcome: 'PASSED', evidenceReference: 'WRONG-APP',
      applicantSummary: 'Must not cross application boundaries.', internalNote: null,
      assessedAt: new Date().toISOString(),
    } }, administrator.cookie)
    expect(wrongApplicationAssessment.data.admin.funding.recordAssessment.success).toBe(false)
    const missingAwardAssessment = await graphql<any>(`mutation($input: RecordAssessmentInput!) {
      admin { funding { recordAssessment(input: $input) { success } } }
    }`, { input: {
      awardId: 'missing', applicationId, assessmentType: 'PERFORMANCE',
      utilizationObligationId: null, outcome: 'PASSED', evidenceReference: 'MISSING-AWARD',
      applicantSummary: 'A missing award must not create an assessment.', internalNote: null,
      assessedAt: new Date().toISOString(),
    } }, administrator.cookie)
    expect(missingAwardAssessment.data.admin.funding.recordAssessment.success).toBe(false)

    const secondRelease = await graphql<any>(`mutation($input: RecordReleaseInput!) {
      admin { funding { recordRelease(input: $input) { response { award { ledgerVersion } ledger { id } obligations { id } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedLedgerVersion: 1,
      amountPaise: '100000', occurredAt: new Date().toISOString(),
      externalReference: `PAY-SECOND-${applicationId}`,
      ttmApprovalReference: `TTM-REL-SECOND-${applicationId}`, ttmApprovalDate: '2026-07-01',
      bankAccountVerifiedAt: new Date().toISOString(),
      performanceAgreementReference: `PA-SECOND-${applicationId}`,
      performanceAgreementExecutedAt: new Date().toISOString(),
      physicalVerificationRequired: false, physicalVerificationReference: null,
      physicalVerificationCompletedAt: null, applicantMessage: 'Second release recorded.',
    } }, administrator.cookie)
    const secondFunding = secondRelease.data.admin.funding.recordRelease.response
    const secondObligationId = secondFunding.obligations[1].id as string
    const secondUtilization = await graphql<any>(`mutation($input: RecordAssessmentInput!) {
      admin { funding { recordAssessment(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, assessmentType: 'UTILIZATION',
      utilizationObligationId: secondObligationId, outcome: 'PASSED',
      evidenceReference: `UC-SECOND-${applicationId}`, applicantSummary: 'Second utilization passed.',
      internalNote: 'Verified against the second release.', assessedAt: new Date().toISOString(),
    } }, administrator.cookie)
    expect(secondUtilization.data.admin.funding.recordAssessment.success).toBe(true)

    for (const assessmentType of ['PERFORMANCE', 'FINANCIAL_AUDIT']) {
      const result = await graphql<any>(`mutation($input: RecordAssessmentInput!) {
        admin { funding { recordAssessment(input: $input) { success } } }
      }`, { input: {
        awardId: awardHead.id, applicationId, assessmentType,
        utilizationObligationId: null, outcome: 'PASSED',
        evidenceReference: `${assessmentType}-${applicationId}`,
        applicantSummary: `${assessmentType} passed.`, internalNote: null,
        assessedAt: new Date().toISOString(),
      } }, administrator.cookie)
      expect(result.data.admin.funding.recordAssessment.success).toBe(true)
    }
    const reassessment = await graphql<any>(`mutation($input: RecordAssessmentInput!) {
      admin { funding { recordAssessment(input: $input) { response { assessments { assessmentType assessmentNumber outcome } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, assessmentType: 'PERFORMANCE',
      utilizationObligationId: null, outcome: 'FAILED',
      evidenceReference: `PERFORMANCE-REASSESS-${applicationId}`,
      applicantSummary: 'Performance reassessment retained a later failure.',
      internalNote: null, assessedAt: new Date().toISOString(),
    } }, administrator.cookie)
    expect(reassessment.data.admin.funding.recordAssessment.response.assessments)
      .toContainEqual(expect.objectContaining({
        assessmentType: 'PERFORMANCE', assessmentNumber: 2, outcome: 'FAILED',
      }))

    const reversalReason = await reasonId(cycle.id, 'RELEASE_REVERSAL')
    const excessiveReversal = await graphql<any>(`mutation($input: ReverseReleaseInput!) {
      admin { funding { reverseRelease(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, releaseId: funding.ledger[0].id,
      expectedLedgerVersion: secondFunding.award.ledgerVersion, amountPaise: '600001',
      occurredAt: new Date().toISOString(), externalReference: `EXCESS-REV-${applicationId}`,
      reasonCategoryId: reversalReason, applicantMessage: 'Must not exceed retained release value.',
    } }, administrator.cookie)
    expect(excessiveReversal.data.admin.funding.reverseRelease.success).toBe(false)
    const reversed = await graphql<any>(`mutation($input: ReverseReleaseInput!) {
      admin { funding { reverseRelease(input: $input) { response { award { ledgerVersion } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, releaseId: funding.ledger[0].id,
      expectedLedgerVersion: secondFunding.award.ledgerVersion, amountPaise: '100000',
      occurredAt: new Date().toISOString(), externalReference: `REV-${applicationId}`,
      reasonCategoryId: reversalReason, applicantMessage: 'Release corrected.',
    } }, administrator.cookie)
    expect(reversed.data.admin.funding.reverseRelease.response.award.ledgerVersion).toBe(3)
    const staleReversal = await graphql<any>(`mutation($input: ReverseReleaseInput!) {
      admin { funding { reverseRelease(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, releaseId: funding.ledger[0].id,
      expectedLedgerVersion: secondFunding.award.ledgerVersion, amountPaise: '1',
      occurredAt: new Date().toISOString(), externalReference: `STALE-REV-${applicationId}`,
      reasonCategoryId: reversalReason, applicantMessage: 'This stale reversal must lose.',
    } }, administrator.cookie)
    expect(staleReversal.data.admin.funding.reverseRelease.success).toBe(false)

    const recoveryReason = await reasonId(cycle.id, 'RECOVERY')
    const prematureRecovery = await graphql<any>(`mutation($input: OpenRecoveryInput!) {
      admin { funding { openRecovery(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, officialDecisionReference: `PREMATURE-REC-${applicationId}`,
      officialDecisionDate: '2026-07-01', reasonCategoryId: recoveryReason,
      applicantMessage: 'Recovery cannot open before support cancellation.',
    } }, administrator.cookie)
    expect(prematureRecovery.data.admin.funding.openRecovery.success).toBe(false)
    const cancelReason = await reasonId(cycle.id, 'AWARD_CANCELLATION')
    const cancelled = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success message response { award { status currentVersion } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 4,
      expectedStatusVersion: 15, status: 'CANCELLED', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.', reasonCategoryId: cancelReason,
      reason: 'Programme support cancelled by official decision.',
    } }, administrator.cookie)
    expect(cancelled.data.admin.funding.changeAward, JSON.stringify(cancelled)).toMatchObject({ success: true })
    expect(cancelled.data.admin.funding.changeAward.response.award.status).toBe('CANCELLED')
    const closureReason = await reasonId(cycle.id, 'AWARD_CLOSURE')
    const missingClosureDisposition = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success message response { award { id } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 5,
      expectedStatusVersion: 16, status: 'CLOSED', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: closureReason, reason: 'Closure requires an explicit disposition.',
    } }, administrator.cookie)
    expect(missingClosureDisposition.data.admin.funding.changeAward).toMatchObject({
      success: false,
      response: null,
    })
    const terminalAwardClosure = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 5,
      expectedStatusVersion: 16, status: 'CLOSED', sanctionedAmountPaise: '900000',
      closureDisposition: 'REMAINDER_NOT_RELEASED',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: closureReason, reason: 'A cancelled award is already terminal.',
    } }, administrator.cookie)
    expect(terminalAwardClosure.data.admin.funding.changeAward.success).toBe(false)

    const openedRecovery = await graphql<any>(`mutation($input: OpenRecoveryInput!) {
      admin { funding { openRecovery(input: $input) { response { recoveryCase { id currentVersion ledgerVersion status } } } } }
    }`, { input: {
      awardId: awardHead.id, officialDecisionReference: `REC-${applicationId}`,
      officialDecisionDate: '2026-07-01', reasonCategoryId: recoveryReason,
      applicantMessage: 'Recovery proceedings opened.',
    } }, administrator.cookie)
    const recovery = openedRecovery.data.admin.funding.openRecovery.response.recoveryCase
    const competingRecovery = await graphql<any>(`mutation($input: OpenRecoveryInput!) {
      admin { funding { openRecovery(input: $input) { success } } }
    }`, { input: {
      awardId: awardHead.id, officialDecisionReference: `REC-DUP-${applicationId}`,
      officialDecisionDate: '2026-07-01', reasonCategoryId: recoveryReason,
      applicantMessage: 'A competing active recovery must not open.',
    } }, administrator.cookie)
    expect(competingRecovery.data.admin.funding.openRecovery.success).toBe(false)
    const entries = [
      { entryType: 'DEMAND', component: 'PRINCIPAL', amountPaise: '500000', reasonCategoryId: null },
      { entryType: 'DEMAND', component: 'PENAL_INTEREST', amountPaise: '10000', reasonCategoryId: null },
      { entryType: 'RECEIPT', component: 'PRINCIPAL', amountPaise: '500000', reasonCategoryId: null },
      { entryType: 'WAIVER', component: 'PENAL_INTEREST', amountPaise: '10000', reasonCategoryId: await reasonId(cycle.id, 'RECOVERY_WAIVER') },
    ]
    let recoveryEntries: Array<{ id: string; entryType: string; component: string }> = []
    for (const [index, entry] of entries.entries()) {
      const result = await graphql<any>(`mutation($input: RecoveryEntryInput!) {
        admin { funding { recordRecoveryEntry(input: $input) { response { recoveryCase { ledgerVersion status } entries { id entryType component } balance { outstanding } } } } }
      }`, { input: {
        recoveryCaseId: recovery.id, expectedLedgerVersion: index, ...entry,
        relatedEntryId: null, externalReference: `REC-ENTRY-${index}-${applicationId}`,
        occurredAt: new Date().toISOString(), applicantMessage: 'Recovery ledger updated.',
      } }, administrator.cookie)
      expect(result.data.admin.funding.recordRecoveryEntry.response.recoveryCase.ledgerVersion).toBe(index + 1)
      recoveryEntries = result.data.admin.funding.recordRecoveryEntry.response.entries
      if (index === 0) {
        const staleEntry = await graphql<any>(`mutation($input: RecoveryEntryInput!) {
          admin { funding { recordRecoveryEntry(input: $input) { success } } }
        }`, { input: {
          recoveryCaseId: recovery.id, expectedLedgerVersion: 0,
          entryType: 'DEMAND', component: 'PRINCIPAL', relatedEntryId: null,
          amountPaise: '1', externalReference: `STALE-REC-${applicationId}`,
          occurredAt: new Date().toISOString(), reasonCategoryId: null,
          applicantMessage: 'This stale ledger write must lose.',
        } }, administrator.cookie)
        expect(staleEntry.data.admin.funding.recordRecoveryEntry.success).toBe(false)
      }
    }
    const receipt = recoveryEntries.find((entry) =>
      entry.entryType === 'RECEIPT' && entry.component === 'PRINCIPAL')
    if (!receipt) throw new Error('Recovery receipt missing.')
    const reversedReceipt = await graphql<any>(`mutation($input: RecoveryEntryInput!) {
      admin { funding { recordRecoveryEntry(input: $input) { response { recoveryCase { ledgerVersion } balance { outstanding } } } } }
    }`, { input: {
      recoveryCaseId: recovery.id, expectedLedgerVersion: 4,
      entryType: 'REVERSAL', component: 'PRINCIPAL', relatedEntryId: receipt.id,
      amountPaise: '100000', externalReference: `REC-REV-${applicationId}`,
      occurredAt: new Date().toISOString(), reasonCategoryId: recoveryReason,
      applicantMessage: 'Incorrect receipt partially reversed.',
    } }, administrator.cookie)
    expect(reversedReceipt.data.admin.funding.recordRecoveryEntry.response).toMatchObject({
      recoveryCase: { ledgerVersion: 5 }, balance: { outstanding: '100000' },
    })
    const settledAgain = await graphql<any>(`mutation($input: RecoveryEntryInput!) {
      admin { funding { recordRecoveryEntry(input: $input) { response { recoveryCase { ledgerVersion } balance { outstanding } } } } }
    }`, { input: {
      recoveryCaseId: recovery.id, expectedLedgerVersion: 5,
      entryType: 'RECEIPT', component: 'PRINCIPAL', relatedEntryId: null,
      amountPaise: '100000', externalReference: `REC-RECEIPT-FINAL-${applicationId}`,
      occurredAt: new Date().toISOString(), reasonCategoryId: null,
      applicantMessage: 'Replacement receipt recorded.',
    } }, administrator.cookie)
    expect(settledAgain.data.admin.funding.recordRecoveryEntry.response).toMatchObject({
      recoveryCase: { ledgerVersion: 6 }, balance: { outstanding: '0' },
    })
    const recoveryQuery = await graphql<any>(`query($id: ID!) { admin { funding {
      recoveryById(recoveryCaseId: $id) { success response { recoveryCase { id } entries { id } balance { outstanding } } }
    } } }`, { id: recovery.id }, administrator.cookie)
    expect(recoveryQuery.data.admin.funding.recoveryById).toMatchObject({
      success: true, response: { recoveryCase: { id: recovery.id }, balance: { outstanding: '0' } },
    })
    const closed = await graphql<any>(`mutation($input: CloseRecoveryInput!) {
      admin { funding { closeRecovery(input: $input) { response { recoveryCase { status currentVersion } balance { outstanding } } } } }
    }`, { input: {
      recoveryCaseId: recovery.id, expectedVersion: recovery.currentVersion,
      reason: 'All authorized recovery balances are settled.',
    } }, administrator.cookie)
    expect(closed.errors).toBeUndefined()
    expect(closed.data.admin.funding.closeRecovery.response).toMatchObject({
      recoveryCase: { status: 'CLOSED', currentVersion: 2 }, balance: { outstanding: '0' },
    })
    const replacementRecovery = await graphql<any>(`mutation($input: OpenRecoveryInput!) {
      admin { funding { openRecovery(input: $input) { response { recoveryCase { id currentVersion } } } }
    } }`, { input: {
      awardId: awardHead.id, officialDecisionReference: `REC-CORRECTION-${applicationId}`,
      officialDecisionDate: '2026-07-02', reasonCategoryId: recoveryReason,
      applicantMessage: 'A replacement recovery was opened for corrected authorization.',
    } }, administrator.cookie)
    expect(replacementRecovery.errors).toBeUndefined()
    const replacement = replacementRecovery.data.admin.funding.openRecovery.response.recoveryCase
    const cancelledRecovery = await graphql<any>(`mutation($input: CloseRecoveryInput!) {
      admin { funding { cancelRecovery(input: $input) {
        response { recoveryCase { status currentVersion } entries { id } }
      } } }
    }`, { input: {
      recoveryCaseId: replacement.id, expectedVersion: replacement.currentVersion,
      reason: 'Opened against the wrong authorization.',
    } }, administrator.cookie)
    expect(cancelledRecovery.errors).toBeUndefined()
    expect(cancelledRecovery.data.admin.funding.cancelRecovery.response).toMatchObject({
      recoveryCase: { status: 'CANCELLED', currentVersion: 2 }, entries: [],
    })
    const repeatedCancellation = await graphql<any>(`mutation($input: CloseRecoveryInput!) {
      admin { funding { cancelRecovery(input: $input) { success } } }
    }`, { input: {
      recoveryCaseId: replacement.id, expectedVersion: 1,
      reason: 'This stale cancellation must lose.',
    } }, administrator.cookie)
    expect(repeatedCancellation.data.admin.funding.cancelRecovery.success).toBe(false)
    const completeWorkspace = await graphql<any>(`query($id: ID!) { admin { intake {
      workspace(applicationId: $id) { response {
        submissions { submissionNumber applicationVersion }
        snapshots { version financial { seedFundRequestedPaise } }
        documents { id submissionId documentType documentVersion originalFilename contentType sizeBytes }
        submissionChanges { fromSubmissionNumber toSubmissionNumber sections }
        assignments { eventType assignmentVersion }
        reviewChecks { checkType result }
        agenda { id status }
        awards { id status }
        releases { id entryType }
        assessments { id assessmentType }
        recoveries { id status }
      } }
    } } }`, { id: applicationId }, administrator.cookie)
    expect(completeWorkspace.errors).toBeUndefined()
    const workspace = completeWorkspace.data.admin.intake.workspace.response
    expect(workspace.submissions).toHaveLength(2)
    expect(workspace.snapshots).toHaveLength(2)
    expect(workspace.documents).toContainEqual(expect.objectContaining({
      id: evidencePinId, submissionId, documentType: 'DPR', documentVersion: 1,
      originalFilename: 'project-report.pdf', contentType: 'application/pdf', sizeBytes: 100,
    }))
    expect(workspace.submissionChanges).toEqual([{
      fromSubmissionNumber: 1, toSubmissionNumber: 2, sections: ['FINANCIAL'],
    }])
    expect(workspace.assignments.length).toBeGreaterThan(0)
    expect(workspace.reviewChecks).toHaveLength(deskCheckTypes.length)
    expect(workspace.agenda).toHaveLength(1)
    expect(workspace.awards).toHaveLength(1)
    expect(workspace.releases.length).toBeGreaterThan(0)
    expect(workspace.assessments.length).toBeGreaterThan(0)
    expect(workspace.recoveries).toHaveLength(2)

    // The same journey, read back by the person it belongs to. Everything below
    // is derived from the ledger the administrator just built, so the applicant
    // view can never drift from the authoritative records.
    const applicantView = await graphql<any>(`query($id: ID!) { seb { application {
      funding(applicationId: $id) { success message response {
        award {
          sanctionOrderNumber sanctionDate sanctionedAmountPaise applicantConditions
          status closureDisposition grossReleasedPaise reversedPaise netReleasedPaise
          remainingPlannedPaise
        }
        releases { sequenceNumber amountPaise paymentReference reversedAmountPaise }
        assessments { assessmentType assessmentNumber outcome summary latest }
      } }
    } } }`, { id: applicationId }, administrator.cookie)
    expect(applicantView.errors).toBeUndefined()
    const applicantFunding = applicantView.data.seb.application.funding
    expect(applicantFunding.success).toBe(true)
    expect(applicantFunding.response.award).toEqual({
      sanctionOrderNumber: `SANCTION-${applicationId}`,
      sanctionDate: '2026-06-20',
      sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      status: 'CANCELLED',
      closureDisposition: null,
      // 600000 + 100000 released, 100000 reversed against the first release.
      grossReleasedPaise: '700000',
      reversedPaise: '100000',
      netReleasedPaise: '600000',
      remainingPlannedPaise: '300000',
    })
    // The reversal is folded into the release it corrects rather than listed as
    // its own ledger entry, so the applicant reads what they were actually paid.
    expect(applicantFunding.response.releases).toEqual([
      {
        sequenceNumber: 1,
        amountPaise: '600000',
        paymentReference: `PAY-${applicationId}`,
        reversedAmountPaise: '100000',
      },
      {
        sequenceNumber: 2,
        amountPaise: '100000',
        paymentReference: `PAY-SECOND-${applicationId}`,
        reversedAmountPaise: '0',
      },
    ])
    // The complete history stays readable in the order it happened, while the
    // current result of each series is identified. Both utilization results are
    // current because utilization is assessed once per release, not once per
    // award; only the superseded PERFORMANCE pass is marked stale.
    expect(applicantFunding.response.assessments).toEqual([
      expect.objectContaining({
        assessmentType: 'UTILIZATION', assessmentNumber: 1,
        outcome: 'PASSED', summary: 'Utilization passed.', latest: true,
      }),
      expect.objectContaining({
        assessmentType: 'UTILIZATION', assessmentNumber: 1,
        outcome: 'PASSED', summary: 'Second utilization passed.', latest: true,
      }),
      expect.objectContaining({
        assessmentType: 'PERFORMANCE', assessmentNumber: 1,
        outcome: 'PASSED', latest: false,
      }),
      expect.objectContaining({
        assessmentType: 'FINANCIAL_AUDIT', assessmentNumber: 1, latest: true,
      }),
      expect.objectContaining({
        assessmentType: 'PERFORMANCE', assessmentNumber: 2,
        outcome: 'FAILED', latest: true,
        summary: 'Performance reassessment retained a later failure.',
      }),
    ])
    // Nothing programme-office-only reached the applicant. These strings are all
    // present on the underlying rows the administrator wrote above.
    const serialized = JSON.stringify(applicantFunding.response)
    for (const internalValue of [
      `TTM-REL-${applicationId}`,
      `PA-${applicationId}`,
      `PV-${applicationId}`,
      `UC-${applicationId}`,
      'Verified against the second release.',
      `REV-${applicationId}`,
    ]) {
      expect(serialized).not.toContain(internalValue)
    }

    // Another applicant cannot read it, and the refusal is the same one an
    // application that never existed would produce.
    const otherApplicant = await adminSession(['APPLICANT'])
    const foreignRead = await graphql<any>(`query($id: ID!) {
      seb { application { funding(applicationId: $id) { success message response { award { sanctionOrderNumber } } } } }
    }`, { id: applicationId }, otherApplicant.cookie)
    expect(foreignRead.data.seb.application.funding).toEqual({
      success: false, message: 'The application was not found.', response: null,
    })
  })

  it('gives administrators a named queue per stage with matching counts', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const first = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const second = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )

    const queueQuery = `query($input: AdminIntakeQueueInput) { admin { intake {
      queue(input: $input) { success message response {
        nodes { id status submissionNumber statusVersion assignmentVersion }
      } }
    } } }`
    const summaryQuery = `query($cycleId: ID) { admin { intake {
      queues(cycleId: $cycleId) { success message response { queues { queue count } } }
    } } }`
    const countFor = (body: any, queue: string) =>
      body.data.admin.intake.queues.response.queues
        .find((entry: any) => entry.queue === queue).count
    const idsIn = (body: any) =>
      body.data.admin.intake.queue.response.nodes.map((node: any) => node.id).sort()
    // Versions are read back rather than assumed, so this test asserts queue
    // membership instead of accidentally asserting version arithmetic.
    const stateOf = async (applicationId: string) => {
      const body = await graphql<any>(queueQuery, { input: { first: 50 } },
        administrator.cookie)
      return body.data.admin.intake.queue.response.nodes
        .find((node: any) => node.id === applicationId)
    }

    const beforeReview = await graphql<any>(summaryQuery, { cycleId: cycle.id },
      administrator.cookie)
    expect(countFor(beforeReview, 'NEW_SUBMISSIONS')).toBe(2)
    expect(countFor(beforeReview, 'DESK_REVIEW')).toBe(0)
    // Every queue is reported even when empty, so the chips do not come and go.
    expect(beforeReview.data.admin.intake.queues.response.queues).toHaveLength(9)

    const newSubmissions = await graphql<any>(queueQuery,
      { input: { first: 10, queue: 'NEW_SUBMISSIONS' } }, administrator.cookie)
    expect(idsIn(newSubmissions)).toEqual([first.applicationId, second.applicationId].sort())

    // Moving one application on, the queues follow its status.
    const beforeClaim = await stateOf(first.applicationId)
    const claimed = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success message } } }
    }`, { input: {
      applicationId: first.applicationId,
      expectedAssignmentVersion: beforeClaim.assignmentVersion,
      conflictAcknowledged: true,
    } }, administrator.cookie)
    expect(claimed.data.admin.intake.claim.success).toBe(true)
    const started = await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success message } } }
    }`, { input: {
      applicationId: first.applicationId,
      expectedStatusVersion: beforeClaim.statusVersion,
    } }, administrator.cookie)
    expect(started.data.admin.intake.startDeskReview.success,
      JSON.stringify(started)).toBe(true)

    const afterReviewStart = await graphql<any>(summaryQuery, { cycleId: cycle.id },
      administrator.cookie)
    expect(countFor(afterReviewStart, 'NEW_SUBMISSIONS')).toBe(1)
    expect(countFor(afterReviewStart, 'DESK_REVIEW')).toBe(1)
    const deskReviewQueue = await graphql<any>(queueQuery,
      { input: { first: 10, queue: 'DESK_REVIEW' } }, administrator.cookie)
    expect(idsIn(deskReviewQueue)).toEqual([first.applicationId])

    // A cancelled application belongs to no queue at all. Written directly
    // because no operation produces that status yet; the guard exists so the
    // first one that does cannot silently appear in staff work lists.
    await env.DB.prepare(`UPDATE seb_application SET status = 'CANCELLED' WHERE id = ?`)
      .bind(second.applicationId)
      .run()
    const afterCancellation = await graphql<any>(summaryQuery, { cycleId: cycle.id },
      administrator.cookie)
    expect(afterCancellation.data.admin.intake.queues.response.queues).toEqual(
      beforeReview.data.admin.intake.queues.response.queues.map((entry: any) => ({
        ...entry,
        count: entry.queue === 'DESK_REVIEW' ? 1 : 0,
      })),
    )

    // A cycle filter narrows the counts; another cycle sees none of this work.
    const otherCycle = await createOpenedCycle(administrator.cookie)
    const otherCycleSummary = await graphql<any>(summaryQuery, { cycleId: otherCycle.id },
      administrator.cookie)
    expect(countFor(otherCycleSummary, 'NEW_SUBMISSIONS')).toBe(0)
    expect(countFor(otherCycleSummary, 'DESK_REVIEW')).toBe(0)

    // The two filters are subsets of one status, so combining them is refused
    // rather than quietly intersected into an empty page.
    const conflicting = await graphql<any>(queueQuery,
      { input: { first: 10, queue: 'NEW_SUBMISSIONS', status: 'DESK_REVIEW' } },
      administrator.cookie)
    expect(conflicting.data.admin.intake.queue).toMatchObject({
      success: false, message: 'Filter by queue or by status, not both.', response: null,
    })

    // A draft has never been formally submitted, so it belongs to no queue and
    // cannot be claimed: reviewers must not be able to reach unsubmitted work.
    const draftEnterprise = await graphql<any>(`mutation($input: EnterpriseProfileInput!) {
      seb { enterprise { create(input: $input) { response { id } } } }
    }`, { input: {
      name: 'Unsubmitted Draft Enterprise', establishmentDate: '2026-01-01',
      registrationType: 'NONE', registrationNumber: null, gstin: null,
      businessSector: 'FOOD_PROCESSING', otherBusinessSector: null,
      businessBlockOrVillage: 'Khumulwng', businessDistrict: 'West Tripura',
      businessPinCode: '799045', contactNumber: '+919876543210',
      contactEmail: 'draft@example.test',
    } }, administrator.cookie)
    const draft = await graphql<any>(`mutation($input: StartApplicationInput!) {
      seb { application { startInitial(input: $input) { response { id } } } }
    }`, { input: {
      enterpriseId: draftEnterprise.data.seb.enterprise.create.response.id,
      programmeCycleId: cycle.id,
    } }, administrator.cookie)
    const draftId = draft.data.seb.application.startInitial.response.id
    const claimedDraft = await graphql<any>(`mutation($input: ClaimApplicationInput!) {
      admin { intake { claim(input: $input) { success message } } }
    }`, { input: {
      applicationId: draftId, expectedAssignmentVersion: 0, conflictAcknowledged: true,
    } }, administrator.cookie)
    expect(claimedDraft.data.admin.intake.claim).toMatchObject({
      success: false, message: 'The application was not found.',
    })
    const withDraft = await graphql<any>(summaryQuery, { cycleId: cycle.id },
      administrator.cookie)
    expect(countFor(withDraft, 'NEW_SUBMISSIONS')).toBe(0)
    expect(countFor(withDraft, 'DESK_REVIEW')).toBe(1)

    const applicantOnly = await adminSession(['APPLICANT'])
    const refused = await graphql<any>(summaryQuery, { cycleId: null }, applicantOnly.cookie)
    expect(refused.data.admin.intake.queues).toMatchObject({
      success: false, message: 'Administrator access is required.',
    })
  })

  it('reports a sanctioned application that has no award yet', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const submitted = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const beforeAward = await graphql<any>(`query($id: ID!) {
      seb { application { funding(applicationId: $id) { success message response { award { sanctionOrderNumber } } } } }
    }`, { id: submitted.applicationId }, administrator.cookie)
    expect(beforeAward.data.seb.application.funding).toEqual({
      success: false,
      message: 'No funding award has been created for this application yet.',
      response: null,
    })

    const signedOut = await graphql<any>(`query($id: ID!) {
      seb { application { funding(applicationId: $id) { success message } } }
    }`, { id: submitted.applicationId })
    expect(signedOut.data.seb.application.funding).toMatchObject({
      success: false, message: 'Applicant authentication is required.',
    })
  })
})

describe('searching the intake queue and the cycle list', () => {
  it('finds an application by the start of its reference or enterprise name', async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const submitted = await createSubmittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const [row] = await env.DB.prepare(
      'SELECT reference_number AS reference FROM seb_application WHERE id = ?',
    ).bind(submitted.applicationId).raw<[string]>()
    const reference = row?.[0] ?? ''
    expect(reference).not.toBe('')

    const search = async (term: string) => {
      const response = await graphql<{
        admin: {
          intake: {
            queue: {
              success: boolean
              response: {
                nodes: { id: string }[]
                pageInfo: { totalCount: number }
              } | null
            }
          }
        }
      }>(
        `query Q($input: AdminIntakeQueueInput) {
          admin { intake { queue(input: $input) {
            success response { nodes { id } pageInfo { totalCount } }
          } } }
        }`,
        { input: { search: term } },
        administrator.cookie,
      )
      return response.data?.admin.intake.queue.response
    }

    // The reference, in the case somebody would type it.
    const byReference = await search(reference.toLowerCase().slice(0, 8))
    expect(byReference?.nodes.map((node) => node.id)).toContain(submitted.applicationId)
    expect(byReference?.pageInfo.totalCount).toBeGreaterThan(0)

    // Or the enterprise name, because that is the other thing on the paper.
    const byName = await search('administrative test')
    expect(byName?.nodes.map((node) => node.id)).toContain(submitted.applicationId)

    // Prefix only, and a miss is empty rather than everything.
    expect((await search('zzzz'))?.nodes).toEqual([])
    expect((await search('zzzz'))?.pageInfo.totalCount).toBe(0)
  })

  it('narrows the cycle list by status, year and code, and refuses a nonsense year', async () => {
    const administrator = await adminSession(['ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const [row] = await env.DB.prepare(
      'SELECT cycle_code AS code, cycle_year AS year FROM seb_programme_cycle WHERE id = ?',
    ).bind(cycle.id).raw<[string, number]>()
    const code = row?.[0] ?? ''
    const year = row?.[1] ?? 0

    const list = async (variables: Record<string, unknown>) => {
      const response = await graphql<{
        admin: {
          programmeCycle: {
            list: {
              success: boolean
              message: string | null
              response: { nodes: { id: string }[]; pageInfo: { totalCount: number } } | null
            }
          }
        }
      }>(
        `query L($status: ProgrammeCycleStatus, $cycleYear: Int, $search: String) {
          admin { programmeCycle { list(status: $status, cycleYear: $cycleYear, search: $search) {
            success message response { nodes { id } pageInfo { totalCount } }
          } } }
        }`,
        variables,
        administrator.cookie,
      )
      return response.data?.admin.programmeCycle.list
    }

    expect((await list({ status: 'OPEN' }))?.response?.nodes.map((node) => node.id))
      .toContain(cycle.id)
    expect((await list({ status: 'ARCHIVED' }))?.response?.pageInfo.totalCount).toBe(0)
    expect((await list({ cycleYear: year }))?.response?.nodes.map((node) => node.id))
      .toContain(cycle.id)
    expect((await list({ search: code.slice(0, 3).toLowerCase() }))?.response?.nodes
      .map((node) => node.id)).toContain(cycle.id)

    // A year that is not a year is named rather than silently matching nothing.
    const refused = await list({ cycleYear: 12 })
    expect(refused?.success).toBe(false)
    expect(refused?.message).toBe('Select a valid programme year.')
  })
})

describe('the committee meetings list', () => {
  it('is a page with a total, not the whole table', async () => {
    const administrator = await adminSession(['ADMIN'])
    for (const index of [1, 2, 3]) {
      await graphql<{ admin: { decision: { createMeeting: { success: boolean } } } }>(
        `mutation M($input: CreateTtmMeetingInput!) {
          admin { decision { createMeeting(input: $input) { success message } } }
        }`,
        {
          input: {
            meetingReference: `TTM-PAGE-${index}`,
            scheduledAt: new Date(Date.now() + index * 86_400_000).toISOString(),
            venue: 'Khumulwng',
          },
        },
        administrator.cookie,
      )
    }

    const list = async (variables: Record<string, unknown>) => {
      const response = await graphql<{
        admin: {
          decision: {
            meetings: {
              success: boolean
              message: string | null
              response: {
                nodes: { meetingReference: string }[]
                pageInfo: { endCursor: string | null; hasNextPage: boolean; totalCount: number }
              } | null
            }
          }
        }
      }>(
        `query M($first: Int, $after: String, $status: TtmMeetingStatus) {
          admin { decision { meetings(first: $first, after: $after, status: $status) {
            success message
            response { nodes { meetingReference } pageInfo { endCursor hasNextPage totalCount } }
          } } }
        }`,
        variables,
        administrator.cookie,
      )
      return response.data?.admin.decision.meetings
    }

    // Bounded: asking for two returns two, and says there are more.
    const firstPage = await list({ first: 2 })
    expect(firstPage?.response?.nodes).toHaveLength(2)
    expect(firstPage?.response?.pageInfo.hasNextPage).toBe(true)
    expect(firstPage?.response?.pageInfo.totalCount).toBeGreaterThanOrEqual(3)

    // And the cursor continues rather than repeating.
    const second = await list({ first: 2, after: firstPage?.response?.pageInfo.endCursor })
    const firstNames = firstPage?.response?.nodes.map((node) => node.meetingReference) ?? []
    for (const node of second?.response?.nodes ?? []) {
      expect(firstNames).not.toContain(node.meetingReference)
    }

    // A meeting is DRAFT until it starts, so this filter reaches the column.
    expect((await list({ status: 'FINALIZED' }))?.response?.pageInfo.totalCount).toBe(0)
    expect((await list({ status: 'DRAFT' }))?.response?.pageInfo.totalCount)
      .toBeGreaterThanOrEqual(3)

    // A cursor from another ordering is refused rather than mis-seeking.
    const foreign = btoa(JSON.stringify(['updatedAt', Date.now(), 'x']))
    expect((await list({ after: foreign }))?.message).toBe('Invalid pagination arguments.')
  })
})

describe('what a reviewer read off the documents', () => {
  /**
   * Takes a fresh application to the point a desk review can be completed, and
   * returns a function that completes it with whatever identifiers are given.
   */
  const readyToReview = async () => {
    const administrator = await adminSession(['APPLICANT', 'ADMIN'])
    const cycle = await createOpenedCycle(administrator.cookie)
    const submitted = await createSubmittedApplication(
      administrator.cookie,
      administrator.userId,
      cycle.id,
    )
    // Claiming is what moves it into this reviewer's hands, and is also what
    // takes the status version from 1 to 2.
    await graphql<any>(
      `
        mutation ($input: ClaimApplicationInput!) {
          admin {
            intake {
              claim(input: $input) {
                success
              }
            }
          }
        }
      `,
      {
        input: {
          applicationId: submitted.applicationId,
          expectedAssignmentVersion: 0,
          conflictAcknowledged: true,
        },
      },
      administrator.cookie,
    )
    await graphql<any>(
      `
        mutation ($input: StartDeskReviewInput!) {
          admin {
            intake {
              startDeskReview(input: $input) {
                success
              }
            }
          }
        }
      `,
      { input: { applicationId: submitted.applicationId, expectedStatusVersion: 2 } },
      administrator.cookie,
    )

    const review = async (identifiers: unknown[], results: Record<string, string> = {}) =>
      graphql<any>(
        `
          mutation ($input: CompleteDeskReviewInput!) {
            admin {
              intake {
                completeDeskReview(input: $input) {
                  success
                  message
                }
              }
            }
          }
        `,
        {
          input: {
            applicationId: submitted.applicationId,
            expectedStatusVersion: 3,
            outcome: 'ADVANCE_TO_BANK',
            checks: deskCheckTypes.map((checkType) => ({
              checkType,
              result:
                results[checkType] ??
                (checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS'),
            })),
            reasonCategoryId: null,
            applicantMessage: null,
            revisions: [],
            identifiers,
          },
        },
        administrator.cookie,
      ).then((result) => result.data.admin.intake.completeDeskReview)

    return { administrator, applicationId: submitted.applicationId, review }
  }

  it('will not let a check be passed without the number behind it', async () => {
    const { review } = await readyToReview()

    // Passing identity, Scheduled Tribe eligibility and document completeness
    // means having read three documents. None of the numbers were given.
    const bare = await review([])
    expect(bare.success).toBe(false)
    expect(bare.message).toContain('Scheduled Tribe certificate number')

    // A check that is not passed asks for nothing: there is nothing being
    // attested to.
    const failedInstead = await review(
      [{ kind: 'BANK_ACCOUNT', value: '50010000111', branchCode: 'SBIN0007890' }],
      { ST_ELIGIBILITY: 'FAIL', IDENTITY_KYC: 'FAIL' },
    )
    expect(failedInstead.success).toBe(false)
    expect(failedInstead.message).not.toContain('Scheduled Tribe certificate number')
  })

  it('refuses a value that is not plausibly off a document', async () => {
    const { review } = await readyToReview()

    for (const identifiers of [
      // Punctuation only: normalizing leaves nothing.
      [{ kind: 'ST_CERTIFICATE', value: ' -- ' }],
      // Too short to be any real instrument.
      [{ kind: 'ST_CERTIFICATE', value: 'TR1' }],
      // An account number identifies a destination only with its branch.
      [{ kind: 'BANK_ACCOUNT', value: '50010000111', branchCode: '' }],
      [{ kind: 'BANK_ACCOUNT', value: '50010000111' }],
      // The same kind twice is a client fault, not a second reading.
      [
        { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-900001' },
        { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-900002' },
      ],
    ]) {
      expect((await review(identifiers)).success).toBe(false)
    }
  })

  it('reads the same certificate through any punctuation', async () => {
    const first = await readyToReview()
    expect(
      await first.review([
        { kind: 'ST_CERTIFICATE', value: 'TR/ST/2026-770001' },
        { kind: 'IDENTITY_DOCUMENT', value: '777700001111' },
        { kind: 'BANK_ACCOUNT', value: '50010000771', branchCode: 'SBIN0007890' },
      ]),
    ).toMatchObject({ success: true })

    // A different case, a different layout, the same certificate. If separators
    // defeated the check it would report a clean file and be believed.
    const second = await readyToReview()
    const restated = await second.review([
      { kind: 'ST_CERTIFICATE', value: 'tr-st-2026-770001' },
      { kind: 'IDENTITY_DOCUMENT', value: '777700002222' },
      { kind: 'BANK_ACCOUNT', value: '50010000772', branchCode: 'SBIN0007890' },
    ])
    expect(restated.success).toBe(false)
    expect(restated.message).toContain('already recorded against')
  })

  it('asks rather than refuses, and keeps the answer', async () => {
    const shared = { kind: 'IDENTITY_DOCUMENT', value: '880000001111' }

    const first = await readyToReview()
    expect(
      (
        await first.review([
          { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-880001' },
          shared,
          { kind: 'BANK_ACCOUNT', value: '50010000881', branchCode: 'SBIN0007890' },
        ])
      ).success,
    ).toBe(true)

    const second = await readyToReview()
    const flagged = await second.review([
      { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-880002' },
      shared,
      { kind: 'BANK_ACCOUNT', value: '50010000882', branchCode: 'SBIN0007890' },
    ])
    expect(flagged.success).toBe(false)
    expect(flagged.message).toContain('identity document number')
    expect(flagged.message).toContain('Say why this is not the same claim')

    /*
     * A match is a question. The same person legitimately returns for a later
     * phase, so answering it is allowed — and the answer is kept beside the
     * number that raised it, which is the whole point of asking.
     */
    const answered = await second.review([
      { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-880002' },
      { ...shared, matchedReason: 'Second-phase expansion by the same promoter.' },
      { kind: 'BANK_ACCOUNT', value: '50010000882', branchCode: 'SBIN0007890' },
    ])
    expect(answered.success).toBe(true)

    const [kept] = (
      await env.DB.prepare(
        `SELECT matched_reason AS reason, comparable_value AS value, last_four AS lastFour
       FROM seb_desk_review_identifier
       WHERE kind = 'IDENTITY_DOCUMENT' AND matched_reason IS NOT NULL`,
      ).all()
    ).results as { reason: string; value: string; lastFour: string }[]
    expect(kept.reason).toBe('Second-phase expansion by the same promoter.')

    // An identity number is the most sensitive thing here. It is stored as a
    // keyed digest and never in the clear; the reviewer confirms the last four.
    expect(kept.value).not.toContain('880000001111')
    expect(kept.value).toMatch(/^[0-9a-f]{64}$/u)
    expect(kept.lastFour).toBe('1111')
  })

  it('stores a public instrument as written, so it can be read back', async () => {
    const { review } = await readyToReview()
    expect(
      await review([
        { kind: 'ST_CERTIFICATE', value: 'TR/ST/2026-660001' },
        { kind: 'IDENTITY_DOCUMENT', value: '660000001111' },
        { kind: 'BANK_ACCOUNT', value: '50010000661', branchCode: 'SBIN0007890' },
        // Never required — an unregistered enterprise has none — but transcribed
        // when there is one.
        { kind: 'BUSINESS_REGISTRATION', value: 'UDYAM-TR-01-0006601' },
      ]),
    ).toMatchObject({ success: true })

    const [row] = (
      await env.DB.prepare(
        `SELECT comparable_value AS value FROM seb_desk_review_identifier
       WHERE kind = 'ST_CERTIFICATE' AND comparable_value LIKE 'TRST2026660001'`,
      ).all()
    ).results as { value: string }[]
    expect(row?.value).toBe('TRST2026660001')
  })
})
