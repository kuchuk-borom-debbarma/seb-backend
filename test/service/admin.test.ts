import { env, SELF } from '../support/worker'
import { failure, success } from '../../src/services/envelope'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLoaders } from '../../src/loaders'
import {
  auditActions,
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
  sebApplicationVersionAnswer,
} from '../../src/db/schema'
import { desc, eq, sql } from 'drizzle-orm'
import {
  calculateRecoveryBalance,
  closeExpiredProgrammeCycles,
  createProgrammeCycle,
  recordDocumentScanResult,
} from '../../src/services/admin'
import {
  adminAudit,
  changedExactlyOne,
  constraintSafe,
  normalizeOptionalText,
  normalizeRequiredText,
} from '../../src/services/admin/support'
import { sessionTokenDigest } from '../../src/services/auth/crypto'
import { NO_SCANNER_REFERENCE } from '../../src/services/document-scanner'
import { scanDocumentVersion } from '../../src/services/document-scanner/consume'
import { findSubmissionPolicy } from '../../src/services/application/queries/application'
import { adminResolvers } from '../../src/graphql/resolvers/admin/admin'

import { batch } from '../../src/db'
import { completeAnswers, defaultTemplate } from '../support/form'
import {
  attachEvidence,
  emptyFormTemplate,
  recordScan,
  graphql,
  openCycle,
  signIn,
  submittedApplication,
  testPolicy,
} from '../support/api'
import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { seededDecision, submittedProfile } from './support/intake-fixtures'

/*
 * One schema per file, emptied between tests. `isolatedStorage` gave the
 * Workers pool the same guarantee; applying the schema per test instead costs
 * four and a half seconds a time.
 */
beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})


const adminContext = (cookie: string) => ({
  db: activeDatabase(), loaders: createLoaders(activeDatabase()), env,
  requestHeaders: new Headers({ cookie, origin: 'https://app.example.test' }),
  requestUrl: 'https://api.example.test/graphql', responseHeaders: new Headers(),
})

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

/**
 * Attempts to create a cycle and returns the refusal, for tests that are about
 * one.
 *
 * Separate from `createOpenedCycle` on purpose. That one is a precondition for
 * almost every test in this file, so it returns the created head directly and a
 * caller never has to check a shape; giving it a "might refuse" mode would push
 * that check onto forty call sites that cannot refuse.
 */
const cycleRefusedFor = async (
  cookie: string,
  policyOverride: Record<string, unknown>,
): Promise<string | null> => {
  const attempt = await graphql<{
    admin: { programmeCycle: { create: { success: boolean; message: string | null } } }
  }>(`mutation($input: ProgrammeCycleInput!) {
    admin { programmeCycle { create(input: $input) { success message } } }
  }`, { input: {
    cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    displayName: 'Mission SEP Administrative Test', cycleYear: 2026,
    policyReference: 'TTAADC/MSEP/2026', applicantGuidance: 'Applicant guide.',
    partnerBankGuidance: 'Published partner-bank roster.',
    opensAt: new Date(Date.now() - 1_000).toISOString(),
    closesAt: new Date(Date.now() + 86_400_000).toISOString(),
    policy: { ...testPolicy(), ...policyOverride },
  } }, cookie)
  const result = attempt.data!.admin.programmeCycle.create
  expect(result.success).toBe(false)
  return result.message
}

/**
 * The actions recorded against one record, oldest first.
 *
 * Read straight from `core_audit_event` rather than through the audit query,
 * because the question is whether the row was **written**. A filter that
 * happened to exclude it would look exactly like it never existing, which is
 * the failure this is here to catch.
 */
const auditActionsFor = async (entityId: string): Promise<string[]> => {
  const rows = await env.DB.prepare(
    `SELECT action FROM core_audit_event WHERE entity_id = ?
       -- Only to make the order repeatable. \`rowid\` was SQLite's insertion
       -- order and did mean "later"; an id does not, so no assertion below
       -- reads this as a sequence, and none should start to.
       ORDER BY created_at, id`,
  ).bind(entityId).all()
  return (rows.results as { action: string }[]).map((row) => row.action)
}

/**
 * An open recovery case, ready to have entries posted against it.
 *
 * The award and its one release are seeded rather than reached through desk
 * review, bank and committee. What these tests are about is whether recovery
 * writes an audit row; replaying the whole decision path to get here would make
 * them slow and would fail for reasons that have nothing to do with the trail.
 *
 * The award is `CANCELLED` and has paid something out, because those are the
 * two conditions the open-recovery predicate insists on — recovery is money
 * already given on an award that no longer stands.
 */
const recoverableCase = async (
  administrator: { cookie: string; userId: string },
  cycle: { id: string },
): Promise<string> => {
  const submitted = await submittedApplication(
    administrator.cookie, administrator.userId, cycle.id,
  )
  const awardId = crypto.randomUUID()
  const [caseRow] = (await env.DB.prepare(
    'SELECT funding_case_id AS "fundingCaseId" FROM seb_application WHERE id = ?',
  ).bind(submitted.applicationId).all()).results as { fundingCaseId: string }[]
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO seb_funding_award (
    id, funding_case_id, application_id, sanction_order_number, sanction_date,
    sanctioned_amount_paise, status, ledger_version, current_version,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, '2026-06-01', 1000000, 'CANCELLED', 0, 1, ?, ?)`)
    .bind(awardId, caseRow!.fundingCaseId, submitted.applicationId,
      `SO-AUDIT-${awardId.slice(0, 8)}`, now, now)
    .run()
  await env.DB.prepare(`INSERT INTO seb_disbursement (
    id, funding_award_id, sequence_number, entry_type, amount_paise,
    occurred_at, approval_reference, approval_date,
    bank_account_verified_at, performance_agreement_reference,
    performance_agreement_executed_at, physical_verification_required,
    recorded_by_user_id, created_at
  ) VALUES (?, ?, 1, 'RELEASE', 1000000, ?, 'TTM/1', '2026-06-01', ?, 'PA/1', ?, false, ?, ?)`)
    .bind(crypto.randomUUID(), awardId, now, now, now, administrator.userId, now)
    .run()

  const opened = await graphql<any>(`mutation($input: OpenRecoveryInput!) {
    admin { funding { openRecovery(input: $input) { success message response { recoveryCase { id } } } } }
  }`, { input: {
    awardId,
    officialDecisionReference: `REC-AUDIT-${submitted.applicationId}`,
    officialDecisionDate: '2026-07-01',
    reasonCategoryId: await reasonId(cycle.id, 'RECOVERY'),
    applicantMessage: 'Recovery proceedings opened.',
  } }, administrator.cookie)
  expect(opened.data.admin.funding.openRecovery.success, JSON.stringify(opened)).toBe(true)
  return opened.data.admin.funding.openRecovery.response.recoveryCase.id as string
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
      'query { admin { funding { byApplication(applicationId: "x") { success } } } }',
      'query { admin { funding { recoveryById(recoveryCaseId: "x") { success } } } }',
      `mutation { admin { programmeCycle { create(input: {
        cycleCode: "SEP-X", displayName: "X", cycleYear: 2026,
        policy: { requiredAssessmentTypes: [], reasons: [], formTemplate: ${emptyFormTemplate} }
      }) { success } } } }`,
      `mutation { admin { programmeCycle { updateDraft(input: {
        id: "x", expectedVersion: 1, reason: "x", cycle: {
          cycleCode: "SEP-X", displayName: "X", cycleYear: 2026,
          policy: { requiredAssessmentTypes: [], reasons: [], formTemplate: ${emptyFormTemplate} }
        }
      }) { success } } } }`,
      'mutation { admin { programmeCycle { softDeleteDraft(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { restoreDraft(id: "x", expectedVersion: 1) { success } } } }',
      'mutation { admin { programmeCycle { open(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { close(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { archive(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { updateOpenGuidance(input: { id: "x", expectedVersion: 1, applicantGuidance: "x", partnerBankGuidance: "x", reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { changeClosingTime(input: { id: "x", expectedVersion: 1, closesAt: "2030-01-01T00:00:00Z", reason: "x" }) { success } } } }',
      'mutation { admin { intake { addInternalNote(input: { applicationId: "x", note: "x" }) { success } } } }',
      'mutation { admin { intake { startDeskReview(input: { applicationId: "x", expectedStatusVersion: 1 }) { success } } } }',
      `mutation { admin { intake { completeDeskReview(input: {
      conflictAcknowledged: true,
        applicationId: "x", expectedStatusVersion: 1, outcome: ADVANCE_TO_BANK,
        checks: [], revisions: [], identifiers: []
      }) { success } } } }`,
      'mutation { admin { intake { cancelRevision(input: { applicationId: "x", revisionRequestId: "x", expectedStatusVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { decision { cancelBankReferral(input: { applicationId: "x", referralId: "x", expectedReferralVersion: 1, reasonCategoryId: "x", reason: "x", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { decision { referToBank(input: { applicationId: "x", submissionId: "x", deskReviewId: "x", expectedStatusVersion: 1, bankName: "x", referralReference: "x", referralDate: "2026-01-01", applicantMessage: "x" }) { success } } } }',
      'mutation { admin { decision { recordBankOutcome(input: { applicationId: "x", referralId: "x", expectedStatusVersion: 1, expectedReferralVersion: 1, outcome: RECOMMENDED, decisionReference: "x", decisionDate: "2026-01-01", applicantSummary: "x", revisions: [] }) { success } } } }',
      'mutation { admin { decision { correctBankOutcome(input: { applicationId: "x", referralId: "x", supersedesOutcomeId: "x", expectedStatusVersion: 1, outcome: RECOMMENDED, decisionReference: "x", decisionDate: "2026-01-01", applicantSummary: "x", correctionReasonCategoryId: "x", correctionReason: "x", revisions: [] }) { success } } } }',
      'mutation { admin { decision { recordDecision(input: { applicationId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "x", decisionDate: "2026-01-01", approvedAmountPaise: "1", applicantMessage: "x", revisions: [] }) { success } } } }',
      'mutation { admin { decision { correctDecision(input: { applicationId: "x", supersedesDecisionId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "x", decisionDate: "2026-01-01", approvedAmountPaise: "1", correctionReasonCategoryId: "x", correctionReason: "x", applicantMessage: "x", revisions: [] }) { success } } } }',
      'mutation { admin { funding { createAward(input: { applicationId: "x", decisionId: "x", expectedStatusVersion: 1, sanctionOrderNumber: "x", sanctionDate: "2026-01-01" }) { success } } } }',
      'mutation { admin { funding { changeAward(input: { awardId: "x", applicationId: "x", expectedVersion: 1, expectedStatusVersion: 1, status: ACTIVE, sanctionedAmountPaise: "1", reasonCategoryId: "x", reason: "x" }) { success } } } }',
      'mutation { admin { funding { recordAssessment(input: { awardId: "x", applicationId: "x", assessmentType: PERFORMANCE, outcome: PASSED, evidenceReference: "x", applicantSummary: "x", assessedAt: "2030-01-01T00:00:00Z" }) { success } } } }',
      'mutation { admin { funding { recordRelease(input: { awardId: "x", applicationId: "x", expectedLedgerVersion: 0, amountPaise: "1", occurredAt: "2030-01-01T00:00:00Z", externalReference: "x", approvalReference: "x", approvalDate: "2026-01-01", bankAccountVerifiedAt: "2030-01-01T00:00:00Z", performanceAgreementReference: "x", performanceAgreementExecutedAt: "2030-01-01T00:00:00Z", physicalVerificationRequired: false, applicantMessage: "x" }) { success } } } }',
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
    const applicant = await signIn(['APPLICANT'])
    const denied = await graphql<{
      admin: { programmeCycle: { list: { success: boolean; message: string } } }
    }>('query { admin { programmeCycle { list { success message } } } }', {}, applicant.cookie)
    expect(denied.data?.admin.programmeCycle.list).toEqual({
      success: false,
      message: 'You do not have permission to do that.',
    })

    const administrator = await signIn(['ADMIN'])
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
    expect(revoked.data?.admin.programmeCycle.list.message).toBe('You do not have permission to do that.')
  })

  /*
   * The role boundaries, tested by what each role is *refused*.
   *
   * The refusal is the interesting half: a reviewer who can read is only
   * useful if they genuinely cannot write, and a capability that silently
   * widened would still pass every test that only checks the happy path.
   *
   * These assert against the permission refusal specifically rather than
   * `success: false`, because almost anything returns `success: false` when
   * handed an id that does not exist — including an operation the caller was
   * in fact allowed to attempt.
   */


  it('lets staff open a document only once something has scanned it', async () => {
    /*
     * The whole reason the scanner seam exists.
     *
     * Administrative download fails closed until an ACCEPTED scan result is
     * appended, and until this was built nothing appended one — so no
     * administrator could open any document at all, and the review workflow
     * could not be demonstrated. This walks the gate from shut to open.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    // Exactly what finalization leaves behind: a request to scan, no verdict.
    const { applicationId, pins } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id, { scan: 'PENDING' },
    )
    const { submissionDocumentId, versionId } = pins.DPR!

    const download = () => graphql<{
      admin: { intake: { documentDownloadUrl: { success: boolean; message: string | null } } }
    }>(`query { admin { intake { documentDownloadUrl(
      applicationId: "${applicationId}", submissionDocumentId: "${submissionDocumentId}"
    ) { success message } } } }`, {}, administrator.cookie)

    // Shut, and it says why rather than pretending the document is missing.
    expect((await download()).data?.admin.intake.documentDownloadUrl).toMatchObject({
      success: false,
      message: 'The submitted document has not passed malware scanning.',
    })

    // What the queue consumer does when it reads a scan request.
    expect(await scanDocumentVersion(activeDatabase(), env, versionId)).toBe('RECORDED')

    // Open. And the history is honest about what actually happened.
    expect((await download()).data?.admin.intake.documentDownloadUrl.success).toBe(true)
    expect(await env.DB.prepare(
      `SELECT status, scanner_reference AS reference FROM seb_application_document_scan
       WHERE document_version_id = ? ORDER BY sequence_number DESC LIMIT 1`,
    ).bind(versionId).first()).toEqual({
      status: 'ACCEPTED',
      reference: NO_SCANNER_REFERENCE,
    })
  })

  it('records nothing for a document that no longer exists', async () => {
    /*
     * Deleted between the request being queued and read: nothing to scan and
     * nothing to write down, rather than an invented result.
     *
     * `GONE` rather than a plain failure because the distinction is what the
     * consumer settles on. No later attempt can find a row that was deleted, so
     * retrying spends a budget shared with failures a retry really can fix, and
     * ends by dropping the message anyway.
     */
    expect(await scanDocumentVersion(activeDatabase(), env, crypto.randomUUID()))
      .toBe('GONE')
  })

  it('defers when the verdict could not be appended', async () => {
    /*
     * A version that exists with no scan history at all — which finalization
     * never produces, since it writes the PENDING row itself. `append` refuses
     * rather than inventing sequence 1, because a scan history that did not
     * begin at finalization is not one this can reason about.
     *
     * Distinct from `GONE` on purpose: the row is there, so this is deferred
     * rather than settled, and the consumer retries it.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const { documents } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id, { scan: 'NONE' },
    )
    const { versionId } = documents.find((each) => each.fieldKey === 'DPR')!

    expect(await scanDocumentVersion(activeDatabase(), env, versionId))
      .toBe('NOT_RECORDED')
  })


  it('names who holds an application, resolved once for the whole page', async () => {
    /*
     * Before this the queue returned only an id, so the office could see that
     * somebody was working an application but never who.
     *
     * Resolved as a field through the request's loader rather than joined into
     * the queue query — a join would duplicate an application once per role
     * its assignee holds, which is the bug the audit query already had to
     * avoid.
     */
    const administrator = await signIn(['APPLICANT', 'REVIEWER', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const { applicationId } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )

    const queueRow = async () => {
      const result = await graphql<{
        admin: { intake: { queue: { response: { nodes: Array<{
          id: string
          assignedToUserId: string | null
          assignedTo: { id: string; email: string; roles: string[] } | null
        }> } } } }
      }>(`query { admin { intake { queue(input: { first: 50 }) { response { nodes {
        id assignedToUserId assignedTo { id email roles }
      } } } } } }`, {}, administrator.cookie)
      return result.data!.admin.intake.queue.response.nodes
        .filter((node) => node.id === applicationId)
    }

    // Nobody has worked it, so there is nobody to name — rather than a lookup
    // of an id that is not there.
    const before = await queueRow()
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ assignedToUserId: null, assignedTo: null })

    // Starting the review is what records the actor now; there is no separate
    // step that reserves it first.
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: {
      applicationId, expectedStatusVersion: 2,
    } }, administrator.cookie)

    const after = await queueRow()
    expect(after[0]?.assignedTo).toMatchObject({
      id: administrator.userId,
      email: `${administrator.userId}@example.test`,
    })
    // Three roles, still one row: folded rather than joined.
    expect(after[0]?.assignedTo?.roles.sort()).toEqual(['APPLICANT', 'REVIEWER', 'SUPER_ADMIN'])
    expect(after).toHaveLength(1)

  })


  describe('with nothing reserved before acting', () => {
    /*
     * Claiming used to be required before acting, and `assignedToUserId =
     * actorId` sat inside eight write predicates. These are the two properties
     * that had to survive removing it.
     */

    it('still lets exactly one of two simultaneous reviews land', async () => {
      /*
       * The most important assertion in this change.
       *
       * The assignment was never what serialised concurrent writers — the
       * version term was, and it is still there. Two officers completing the
       * same desk review at the same moment must produce one completion and
       * one stale refusal, exactly as two takeover attempts used to.
       */
      const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
      const cycle = await openCycle(administrator.cookie)
      const submitted = await submittedApplication(
        administrator.cookie, administrator.userId, cycle.id,
      )
      await graphql<any>(`mutation($input: StartDeskReviewInput!) {
        admin { intake { startDeskReview(input: $input) { success } } }
      }`, { input: {
        applicationId: submitted.applicationId, expectedStatusVersion: 2,
      } }, administrator.cookie)

      // Two officers, neither of whom claimed anything, on the same version.
      const complete = () => graphql<{
        admin: { intake: { completeDeskReview: { success: boolean } } }
      }>(`mutation($input: CompleteDeskReviewInput!) {
        admin { intake { completeDeskReview(input: $input) { success } } }
      }`, { input: {
      conflictAcknowledged: true,
        applicationId: submitted.applicationId, expectedStatusVersion: 3,
        outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
        checks: deskCheckTypes.map((checkType) => ({
          checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
        })), revisions: [], identifiers: passingIdentifiers(),
      } }, administrator.cookie)

      const both = await Promise.all([complete(), complete()])
      const landed = both.filter((one) => one.data?.admin.intake.completeDeskReview.success)
      expect(landed).toHaveLength(1)

      // And the losing one did not half-apply: one review exists, not two.
      const reviews = await env.DB.prepare(
        'SELECT COUNT(*)::int AS n FROM seb_desk_review WHERE application_id = ?',
      ).bind(submitted.applicationId).first<{ n: number }>()
      expect(reviews?.n).toBe(1)
    })


    it('will not review your own application without saying so', async () => {
      /*
       * The disclosure used to live on claiming, which was the first act on a
       * file. There is nothing to reserve now, so a disclosure attached to it
       * would simply never be collected. It moved to the act that decides
       * something.
       *
       * `docs/policy-alignment.md` records self-review as permitted **with
       * disclosure**, so the permission and the disclosure have to travel
       * together.
       */
      const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
      const cycle = await openCycle(administrator.cookie)
      const submitted = await submittedApplication(
        administrator.cookie, administrator.userId, cycle.id,
      )
      await graphql<any>(`mutation($input: StartDeskReviewInput!) {
        admin { intake { startDeskReview(input: $input) { success } } }
      }`, { input: {
        applicationId: submitted.applicationId, expectedStatusVersion: 2,
      } }, administrator.cookie)

      const complete = (acknowledged: boolean | undefined) => graphql<{
        admin: { intake: { completeDeskReview: {
          success: boolean; message: string | null
        } } }
      }>(`mutation($input: CompleteDeskReviewInput!) {
        admin { intake { completeDeskReview(input: $input) { success message } } }
      }`, { input: {
        applicationId: submitted.applicationId, expectedStatusVersion: 3,
        outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
        checks: deskCheckTypes.map((checkType) => ({
          checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
        })), revisions: [], identifiers: passingIdentifiers(),
        ...(acknowledged === undefined ? {} : { conflictAcknowledged: acknowledged }),
      } }, administrator.cookie)

      // Absent and explicitly false are the same answer: not disclosed.
      for (const acknowledged of [undefined, false]) {
        expect(
          (await complete(acknowledged)).data?.admin.intake.completeDeskReview,
          String(acknowledged),
        ).toMatchObject({
          success: false,
          message: 'Acknowledge that you are acting on your own application.',
        })
      }

      expect((await complete(true)).data?.admin.intake.completeDeskReview.success).toBe(true)

      /*
       * Permitting the act is half of it. The policy is "permitted *with
       * disclosure*", so the disclosure has to survive the transition — a
       * guard that refuses and then discards the answer leaves nobody able to
       * tell, afterwards, that anyone was ever asked.
       */
      const review = await env.DB.prepare(
        'SELECT conflict_acknowledged AS acknowledged FROM seb_desk_review WHERE application_id = ?',
      ).bind(submitted.applicationId).first<{ acknowledged: boolean }>()
      expect(review?.acknowledged).toBe(true)

      // And it is findable by action, rather than only by joining actor to
      // applicant on every decided file.
      const disclosures = await env.DB.prepare(
        `SELECT COUNT(*)::int AS n FROM core_audit_event
         WHERE action = 'SEB.SELF_REVIEW_DISCLOSED' AND actor_user_id = ?`,
      ).bind(administrator.userId).first<{ n: number }>()
      expect(disclosures?.n).toBe(1)

      /*
       * And the same on the decision, which is the other place a self-review
       * is decided. Asserted against an application that has not reached the
       * committee, because the disclosure is checked before anything about the
       * decision itself — being refused for the wrong reason would prove
       * nothing.
       */
      const decide = await graphql<{
        admin: { decision: { recordDecision: { success: boolean; message: string | null } } }
      }>(`mutation($input: DecisionInput!) {
        admin { decision { recordDecision(input: $input) { success message } } }
      }`, { input: {
        applicationId: submitted.applicationId,
        expectedStatusVersion: 4, outcome: 'APPROVED', decisionReference: 'TTM/1',
        decisionDate: '2026-01-01', applicantMessage: 'Recorded.', revisions: [],
      } }, administrator.cookie)
      expect(decide.data?.admin.decision.recordDecision).toMatchObject({
        success: false,
        message: 'Acknowledge that you are acting on your own application.',
      })
    })

    it('records no disclosure when the reviewer is somebody else', async () => {
      /*
       * The ordinary case, and the one every other fixture in this file skips:
       * the officer and the applicant are different people. Worth asserting
       * because the disclosure is only meaningful if it is absent from reviews
       * that are not self-reviews — a column set on every row would say
       * nothing, and neither would an audit action written every time.
       */
      const officer = await signIn(['SUPER_ADMIN'])
      const applicant = await signIn(['APPLICANT'])
      const cycle = await openCycle(officer.cookie)
      const submitted = await submittedApplication(
        applicant.cookie, applicant.userId, cycle.id,
      )
      await graphql<any>(`mutation($input: StartDeskReviewInput!) {
        admin { intake { startDeskReview(input: $input) { success } } }
      }`, { input: {
        applicationId: submitted.applicationId, expectedStatusVersion: 2,
      } }, officer.cookie)

      /*
       * Sent as `true` even though this is not the officer's own application.
       * The server knows whose it is, so the claim is refused rather than
       * recorded: a copied payload or a client regression must not be able to
       * mark an independent review as a self-review, which would put a false
       * statement in a record kept for an auditor and would make the audit
       * action mean nothing.
       */
      const completed = await graphql<{
        admin: { intake: { completeDeskReview: { success: boolean } } }
      }>(`mutation($input: CompleteDeskReviewInput!) {
        admin { intake { completeDeskReview(input: $input) { success } } }
      }`, { input: {
        conflictAcknowledged: true,
        applicationId: submitted.applicationId, expectedStatusVersion: 3,
        outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
        checks: deskCheckTypes.map((checkType) => ({
          checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
        })), revisions: [], identifiers: passingIdentifiers(),
      } }, officer.cookie)
      expect(completed.data?.admin.intake.completeDeskReview.success).toBe(true)

      const review = await env.DB.prepare(
        'SELECT conflict_acknowledged AS acknowledged FROM seb_desk_review WHERE application_id = ?',
      ).bind(submitted.applicationId).first<{ acknowledged: boolean }>()
      expect(review?.acknowledged).toBe(false)

      const disclosures = await env.DB.prepare(
        `SELECT COUNT(*)::int AS n FROM core_audit_event
         WHERE action = 'SEB.SELF_REVIEW_DISCLOSED' AND actor_user_id = ?`,
      ).bind(officer.userId).first<{ n: number }>()
      expect(disclosures?.n).toBe(0)
    })

    it('lets a reviewer open a document without holding the file', async () => {
      /*
       * The bug that prompted the whole change. Reading was gated on
       * ownership, and a reviewer cannot claim — so the role that exists to
       * read casework could never open a single piece of evidence.
       */
      const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
      const cycle = await openCycle(administrator.cookie)
      const submitted = await submittedApplication(
        administrator.cookie, administrator.userId, cycle.id,
      )
      const { submissionDocumentId } = submitted.pins.DPR!

      // A reviewer, who cannot write anything and never reserved this.
      const reviewer = await signIn(['REVIEWER'])
      const download = await graphql<{
        admin: { intake: { documentDownloadUrl: {
          success: boolean; message: string | null
        } } }
      }>(`query { admin { intake { documentDownloadUrl(
        applicationId: "${submitted.applicationId}",
        submissionDocumentId: "${submissionDocumentId}"
      ) { success message } } } }`, {}, reviewer.cookie)

      expect(download.data?.admin.intake.documentDownloadUrl.success).toBe(true)
    })
  })

  describe('what each staff role may do', () => {
    const DENIED = 'You do not have permission to do that.'

    const messageOf = async (query: string, cookie: string): Promise<string | null> => {
      const result = await graphql<any>(query, {}, cookie)
      expect(result.errors, query).toBeUndefined()
      // The one message is wherever the single operation's envelope landed.
      const found = JSON.stringify(result.data).match(/"message":("[^"]*"|null)/u)
      return found ? (JSON.parse(found[1]) as string | null) : null
    }

    const READ = 'query { admin { programmeCycle { list { success message } } } }'
    const WRITE = `mutation { admin { intake { startDeskReview(input: {
      applicationId: "${crypto.randomUUID()}", expectedStatusVersion: 1
    }) { success message } } } }`
    const DECIDE = `mutation { admin { decision { recordDecision(input: {
      applicationId: "${crypto.randomUUID()}",
      expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "TTM/1",
      decisionDate: "2026-01-01", applicantMessage: "Recorded.", revisions: []
    }) { success message } } } }`

    it('lets a reviewer read, and refuses every write', async () => {
      const reviewer = await signIn(['REVIEWER'])
      const read = await graphql<{
        admin: { programmeCycle: { list: { success: boolean } } }
      }>(READ, {}, reviewer.cookie)
      expect(read.data?.admin.programmeCycle.list.success).toBe(true)

      // Read-only means read-only: not the desk review its name suggests, and
      // not the decision either.
      expect(await messageOf(WRITE, reviewer.cookie)).toBe(DENIED)
      expect(await messageOf(DECIDE, reviewer.cookie)).toBe(DENIED)
    })

    it('lets an approver decide, and nothing else that writes', async () => {
      const approver = await signIn(['APPROVER'])
      const read = await graphql<{
        admin: { programmeCycle: { list: { success: boolean } } }
      }>(READ, {}, approver.cookie)
      expect(read.data?.admin.programmeCycle.list.success).toBe(true)

      expect(await messageOf(WRITE, approver.cookie)).toBe(DENIED)
      /*
       * Past the permission gate. The application id is invented, so this
       * still refuses — but for a business reason rather than an authorization
       * one, which is exactly the difference being asserted.
       */
      expect(await messageOf(DECIDE, approver.cookie)).not.toBe(DENIED)
    })

    it('gives an administrator every staff capability', async () => {
      const administrator = await signIn(['ADMIN'])
      for (const query of [WRITE, DECIDE]) {
        expect(await messageOf(query, administrator.cookie)).not.toBe(DENIED)
      }

      /*
       * Every *casework* capability, that is. Creating a cycle rewrites the
       * programme's own rulebook, which is `CYCLE_ADMIN` and reserved for the
       * super-administrator — the one staff thing an administrator cannot do.
       */
      const CREATE_CYCLE = `mutation { admin { programmeCycle { create(input: {
        cycleCode: "SEP-GATE", displayName: "Gate probe", cycleYear: 2026,
        policyReference: "TTAADC/MSEP/2026", applicantGuidance: "Guide.",
        partnerBankGuidance: "Roster.",
        opensAt: "2026-01-01T00:00:00.000Z", closesAt: "2026-02-01T00:00:00.000Z",
        policy: { requiredAssessmentTypes: [], reasons: [], formTemplate: ${emptyFormTemplate} }
      }) { success message } } } }`
      expect(await messageOf(CREATE_CYCLE, administrator.cookie)).toBe(DENIED)
    })

    it('admits every reading role to the shared preamble, and no one else', async () => {
      /*
       * `administratorWithApplication` is the one preamble serving more than
       * one operation, and it once named its own capability instead of taking
       * the caller's. The write that shared it silently inherited the read's
       * answer, which let a reviewer reach it.
       *
       * It now takes the capability as an argument and has a single caller, so
       * the shape cannot recur without someone passing a second one. What is
       * asserted here is the behaviour that would break first: the gate runs
       * before the record is looked up, so a caller without the capability is
       * refused identically whether or not the application exists.
       */
      const READ_DOCUMENT = `query { admin { intake { documentDownloadUrl(
        applicationId: "${crypto.randomUUID()}",
        submissionDocumentId: "${crypto.randomUUID()}"
      ) { success message } } } }`

      // Not staff at all: refused by the capability, never told whether the
      // application is real.
      const applicant = await signIn(['APPLICANT'])
      expect(await messageOf(READ_DOCUMENT, applicant.cookie)).toBe(DENIED)

      /*
       * Every staff role reaches past the gate and lands on the business
       * refusal instead. A reviewer getting the same answer as an
       * administrator is the whole point: reading casework is the job.
       */
      for (const roles of [['REVIEWER'], ['APPROVER'], ['ADMIN']]) {
        const caller = await signIn(roles as Array<'REVIEWER' | 'APPROVER' | 'ADMIN'>)
        expect(await messageOf(READ_DOCUMENT, caller.cookie), roles.join())
          .toBe('The application was not found.')
      }
    })

    it('unions the capabilities of somebody holding two roles', async () => {
      // Holding a role must never subtract one. A reviewer who is also an
      // approver can do both, and neither role narrows the other.
      const both = await signIn(['REVIEWER', 'APPROVER'])
      expect(await messageOf(DECIDE, both.cookie)).not.toBe(DENIED)
      expect(await messageOf(WRITE, both.cookie)).toBe(DENIED)
    })
  })

  it('creates and opens a complete versioned cycle through GraphQL', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = {
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Mission SEP 2026 Test',
      cycleYear: 2026,
      policyReference: 'TTAADC/MSEP/2026',
      applicantGuidance: 'Read the policy and submit complete evidence.',
      partnerBankGuidance: 'Partner-bank roster maintained by TTAADC.',
      opensAt: new Date(Date.now() - 1_000).toISOString(),
      closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      policy: testPolicy(),
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
        (SELECT COUNT(*)::int FROM seb_programme_cycle_form_field WHERE programme_cycle_id = ?) AS questions,
        (SELECT COUNT(*)::int FROM seb_programme_cycle_assessment_rule WHERE programme_cycle_id = ?) AS assessments,
        (SELECT COUNT(*)::int FROM seb_programme_cycle_reason WHERE programme_cycle_id = ?) AS reasons`,
    ).bind(head.id, head.id, head.id).first<{ questions: number; assessments: number; reasons: number }>()
    /*
     * Opening copies the normalized rules to immutable version 2, and the form
     * is now one of them. The question count is asserted against the fixture
     * rather than written as a literal: a copy-forward that misses the field
     * table empties the entire form for every draft in the cycle, and the
     * number that proves it did not must move when the fixture does.
     */
    expect(policyRows).toEqual({
      questions: defaultTemplate().fields.length * 2,
      assessments: 6,
      reasons: (testPolicy().reasons as unknown[]).length * 2,
    })
  })

  it('versions, publishes, revises, closes, and archives a programme cycle without rewriting policy', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
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
        fundingCeilingScope: null, requiredAssessmentTypes: [], reasons: [],
        /*
         * Everything else on this draft is null or empty, deliberately — the
         * point is that a draft need not be complete. The form is the one
         * exception: a template with no questions is refused at authoring
         * time, before the draft exists, so there is no such thing as a cycle
         * carrying an empty one.
         */
        formTemplate: defaultTemplate(),
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
      success: false,
      message: 'Before this cycle can open, fill in the policy reference, the guidance for applicants, the opening date, the closing date, the minimum applicant age, the maximum applicant age, the category threshold, the expansion wait, the ownership rule, the jurisdiction and the funding ceiling.',
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
      policy: testPolicy(),
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
    expect(await findSubmissionPolicy(activeDatabase(), head.id, 3)).toMatchObject({
      minimumApplicantAge: 18, maximumApplicantAge: 60,
      fundingCeilingState: 'UNRESOLVED',
    })
    expect(await findSubmissionPolicy(activeDatabase(), head.id, 999)).toBeNull()

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
    const administrator = await signIn(['SUPER_ADMIN'])
    const base = {
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Policy validation', cycleYear: 2028,
      policyReference: 'TTAADC/MSEP/2028', applicantGuidance: 'Guidance',
      partnerBankGuidance: 'Roster',
      opensAt: new Date(Date.now() + 86_400_000).toISOString(),
      closesAt: new Date(Date.now() + 172_800_000).toISOString(), policy: testPolicy(),
    }
    const create = (input: any) => graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success message response { head { id currentVersion } } } } }
    }`, { input }, administrator.cookie)
    /*
     * The direct successor to the old unknown-document-type rule. That rule
     * could only ever name one of eight enum members, so "unknown" meant a
     * typo. A condition can name any question at all, so the same class of
     * mistake now reaches much further — a rule reading a question the cycle
     * does not ask is a question nothing can ever make required.
     */
    const unknownDocument = await createProgrammeCycle({
      ...base,
      policy: {
        ...testPolicy(),
        formTemplate: defaultTemplate((template) => ({
          ...template,
          conditions: [...template.conditions, {
            fieldKey: 'NOC', effect: 'REQUIRED_WHEN', groupNumber: 2,
            sequenceNumber: 1, sourceFieldKey: 'NO_SUCH_QUESTION',
            sourceFieldType: 'BOOLEAN' as const,
            operator: 'EQUALS' as const, comparisonValue: 'true',
          }],
        })),
      },
    } as never, adminContext(administrator.cookie))
    expect(unknownDocument).toMatchObject({
      success: false,
      // Both keys named: the rule's own question, and the one it reads.
      message: 'NOC has a rule that reads NO_SUCH_QUESTION, '
        + 'which this cycle does not ask.',
    })
    /*
     * Called directly rather than through GraphQL, because the schema's enum
     * refuses an unknown kind before a resolver ever runs. The guard is still
     * worth having: the controller is also reachable from the cron and from
     * any future caller that is not a GraphQL request, and a vocabulary check
     * that only exists in the transport is one refactor from being gone.
     */
    const unknownIdentifier = await createProgrammeCycle({
      ...base,
      policy: {
        ...testPolicy(),
        identifierRules: [{
          kind: 'UNKNOWN_IDENTIFIER', requirement: 'OPTIONAL',
          duplicatePolicy: 'NOT_CHECKED', checkType: null,
        }],
      },
    } as never, adminContext(administrator.cookie))
    expect(unknownIdentifier).toMatchObject({
      success: false, message: 'The cycle contains an unknown identifier rule.',
    })
    const cases: Array<[any, string]> = [
      [{ ...base, cycleCode: 'bad' }, 'Cycle code must contain 3–32 uppercase letters, numbers, or hyphens.'],
      [{ ...base, displayName: ' ' }, 'Enter a cycle display name.'],
      [{ ...base, cycleYear: 1999 }, 'Enter a valid policy year.'],
      [{ ...base, closesAt: base.opensAt }, 'The closing time must be later than the opening time.'],
      [{ ...base, policy: { ...testPolicy(), reasons: [...testPolicy().reasons as any[], (testPolicy().reasons as any[])[0]] } }, 'Cycle policy entries must be unique.'],
      [{ ...base, policy: { ...testPolicy(), requiredAssessmentTypes: ['UTILIZATION', 'UTILIZATION'] } }, 'Cycle policy entries must be unique.'],
      
      [{ ...base, policy: { ...testPolicy(), reasons: Array.from({ length: 51 }, (_, index) => ({ context: 'REVISION', code: `R_${index}`, label: 'Reason' })) } }, 'A cycle may contain at most 50 reason categories.'],
      [{ ...base, policy: { ...testPolicy(), reasons: [{ context: 'REVISION', code: 'x', label: 'Reason' }] } }, 'One or more reason categories are invalid.'],
      [{ ...base, policy: { ...testPolicy(), reasons: [{ context: 'REVISION', code: 'VALID', label: ' ' }] } }, 'One or more reason categories are invalid.'],
      [{ ...base, policy: { ...testPolicy(), reasons: [{ context: 'REVISION', code: 'VALID', label: 'Reason', applicantMessageTemplate: 'x'.repeat(501) }] } }, 'One or more reason categories are invalid.'],
      [{ ...base, policy: { ...testPolicy(), minimumApplicantAge: -1 } }, 'Minimum age must be a non-negative whole number.'],
      [{ ...base, policy: { ...testPolicy(), maximumApplicantAge: -1 } }, 'Maximum age must be a non-negative whole number.'],
      [{ ...base, policy: { ...testPolicy(), minimumApplicantAge: 60, maximumApplicantAge: 18 } }, 'Maximum age cannot be lower than minimum age.'],
      [{ ...base, policy: { ...testPolicy(), categoryAMaximumMonths: -1 } }, 'Category A month limit must be a non-negative whole number.'],
      [{ ...base, policy: { ...testPolicy(), expansionWaitMonths: 0 } }, 'Expansion waiting time must be a positive whole number of months.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingAmountPaise: '1' } }, 'An unresolved funding ceiling cannot contain an amount or scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingScope: 'APPLICATION' } }, 'An unresolved funding ceiling cannot contain an amount or scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingState: 'RESOLVED' } }, 'A resolved funding ceiling requires a positive amount and scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '0', fundingCeilingScope: 'APPLICATION' } }, 'A resolved funding ceiling requires a positive amount and scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '1', fundingCeilingScope: null } }, 'A resolved funding ceiling requires a positive amount and scope.'],
    ]
    for (const [input, message] of cases) {
      const result = await create(input)
      expect(result.errors, message).toBeUndefined()
      expect(result.data.admin.programmeCycle.create, message).toMatchObject({ success: false, message })
    }

    /*
     * A form with questions but no reporting role bound, refused **at
     * authoring** rather than at open.
     *
     * The admin queue and the decision's money bound both read through roles,
     * so an open cycle in this state leaves them nothing to read — and this
     * used to be caught only when the cycle was opened. In the meantime
     * `resolveFormTemplate` returned `null` for it, so the officer's own
     * editor could not show the form back either, and the schema's claim that
     * null means the rows were hand-edited was not true.
     *
     * `openingProblem` still checks, as the second layer against exactly the
     * hand editing that claim is about.
     */
    const unbound = await create({
      ...base,
      cycleCode: `SEP-ROLE-${crypto.randomUUID().slice(0, 5).toUpperCase()}`,
      policy: {
        ...testPolicy(),
        formTemplate: defaultTemplate((template) => ({
          ...template,
          fields: template.fields.map((each) => ({ ...each, role: null })),
        })),
      },
    })
    expect(unbound.data.admin.programmeCycle.create).toMatchObject({
      success: false,
      // Names the missing role, not "the form is invalid". The first of the
      // two roles in declaration order is what the check reports.
      message: 'This cycle has no question the programme can read as APPLICANT_DATE_OF_BIRTH.',
    })

    const missingCollections = [
      {
        policy: { ...testPolicy(), requiredAssessmentTypes: [] },
        message: 'Define the assessment requirements before opening the cycle.',
      },
      {
        policy: { ...testPolicy(), reasons: [] },
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
    const administrator = await signIn(['ADMIN'])
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
    const administrator = await signIn(['ADMIN'])
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
      db: activeDatabase(), loaders: createLoaders(activeDatabase()), env,
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
    /*
     * Both shapes the driver returns. A statement with `.returning()` gives
     * rows; one without gives a command result carrying `rowCount`, and the
     * second used to be asserted as D1's `{ meta: { changes } }` — a shape
     * nothing produces, so the case that mattered was never really covered.
     */
    expect(changedExactlyOne([{ id: 'one' }])).toBe(true)
    expect(changedExactlyOne([])).toBe(false)
    expect(changedExactlyOne([{ id: 'one' }, { id: 'two' }])).toBe(false)
    expect(changedExactlyOne({ rowCount: 1 })).toBe(true)
    expect(changedExactlyOne({ rowCount: 0 })).toBe(false)
    expect(changedExactlyOne({ rowCount: 2 })).toBe(false)
    // A statement that reports no count at all is not evidence of a change.
    expect(changedExactlyOne({ rowCount: null })).toBe(false)
    /*
     * The shape the driver really throws: Drizzle's wrapper, whose own message
     * is the SQL it tried, with the database's error underneath. The previous
     * version of this threw `new Error('UNIQUE constraint failed')` — SQLite's
     * words, which no layer produces any more — so it passed while the thing
     * it named had stopped working.
     */
    const wrapped = (code: string) =>
      Object.assign(new Error('Failed query: insert into "seb_programme_cycle"'), {
        cause: Object.assign(new Error('duplicate key value'), { code }),
      })
    await expect(constraintSafe(async () => { throw wrapped('23505') }))
      .resolves.toBeNull()
    await expect(constraintSafe(async () => { throw wrapped('23503') }))
      .resolves.toBeNull()
    // Class 08 is connection failure. Swallowing it would report a lost
    // database as an ordinary refusal, and the caller would retry forever.
    await expect(constraintSafe(async () => { throw wrapped('08006') }))
      .rejects.toThrow('Failed query')
    await expect(constraintSafe(async () => {
      throw new Error('network unavailable')
    })).rejects.toThrow('network unavailable')
    // The word alone is not evidence: a table named for uniqueness fails here
    // for some other reason and must still be reported as that reason.
    await expect(constraintSafe(async () => {
      throw new Error('relation "unique_reference_seed" does not exist')
    })).rejects.toThrow('does not exist')
    await expect(constraintSafe(async () => 'ok')).resolves.toBe('ok')
    const requestHeaders = new Headers({
      'CF-Ray': 'ray-1', 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'vitest',
    })
    const context = {
      db: activeDatabase(), loaders: createLoaders(activeDatabase()), env, requestHeaders,
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
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const { applicationId, pins } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id, { scan: 'PENDING' },
    )
    const { submissionDocumentId, versionId } = pins.DPR!
    const db = activeDatabase()
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
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const blockedReview = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success message } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, expectedStatusVersion: 3,
      outcome: 'ADVANCE_TO_BANK',
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

  it('says why an advancement carrying a reason is refused', async () => {
    /*
     * `seb_desk_review_reason_check` has always refused this: an advancement
     * carries no reason and no applicant message, because there is nothing to
     * explain. Nothing above the database said so, so the officer was told
     * "The record changed. Reload and try again." — advice that cannot work,
     * about a record that had not changed.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedStatusVersion: 2,
    } }, administrator.cookie)

    const advance = (extra: Record<string, unknown>) => graphql<any>(
      `mutation($input: CompleteDeskReviewInput!) {
        admin { intake { completeDeskReview(input: $input) { success message } } }
      }`,
      { input: {
        conflictAcknowledged: true,
        applicationId: submitted.applicationId, expectedStatusVersion: 3,
        outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
        checks: deskCheckTypes.map((checkType) => ({
          checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
        })),
        identifiers: passingIdentifiers(),
        revisions: [],
        ...extra,
      } },
      administrator.cookie,
    )

    const carried = 'Advancement to the bank carries no reason and no message to the applicant.'
    expect((await advance({ applicantMessage: 'Off to the bank.' }))
      .data.admin.intake.completeDeskReview)
      .toMatchObject({ success: false, message: carried })
    expect((await advance({ reasonCategoryId: await reasonId(cycle.id, 'REVISION') }))
      .data.admin.intake.completeDeskReview)
      .toMatchObject({ success: false, message: carried })

    // And the ordinary advancement still goes through, so the new refusal is
    // not simply refusing everything.
    expect((await advance({})).data.admin.intake.completeDeskReview)
      .toMatchObject({ success: true })
  })

  it('retains cancelled revisions and replaced bank referrals', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const first = await submittedApplication(administrator.cookie, administrator.userId, cycle.id)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: first.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const revisionReason = await reasonId(cycle.id, 'REVISION')
    const requested = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success message response { application { status statusVersion } revisions { id stageKey } } } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId: first.applicationId, expectedStatusVersion: 3,
      outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReason,
      applicantMessage: 'Please correct the financial section.',
      checks: deskCheckTypes.map((checkType) => ({
        checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
      })),
      identifiers: passingIdentifiers(),
      revisions: [{
        stageKey: 'FINANCIAL', reasonCategoryId: revisionReason,
        note: 'Correct the requested-funding details.',
      }],
    } }, administrator.cookie)
    expect(requested.errors, JSON.stringify(requested.errors)).toBeUndefined()
    const completed = requested.data.admin.intake.completeDeskReview
    expect(completed.success, completed.message).toBe(true)
    const revisionWorkspace = completed.response
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
    /*
     * Withdrawing a correction request leaves the application exactly as it
     * was, so without an audit row it left no trace of the officer at all.
     */
    expect(await auditActionsFor(first.applicationId)).toContain('SEB.REVISION_CANCELLED')
    const staleRevisionCancellation = await graphql<any>(`mutation($input: CancelRevisionInput!) {
      admin { intake { cancelRevision(input: $input) { success message } } }
    }`, { input: {
      applicationId: first.applicationId, revisionRequestId: revisionWorkspace.revisions[0].id,
      expectedStatusVersion: 4, reason: 'Repeat a stale cancellation.',
    } }, administrator.cookie)
    expect(staleRevisionCancellation.data.admin.intake.cancelRevision.success).toBe(false)

    const second = await submittedApplication(administrator.cookie, administrator.userId, cycle.id)
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: second.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const advanced = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { response { reviews { id } application { statusVersion } } } } }
    }`, { input: {
      conflictAcknowledged: true,
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
      availableLoanAmountPaise: null, applicantSummary: 'Negative feedback still reaches the decision.',
      internalNote: null, revisions: [],
    } }, administrator.cookie)
    expect(bank.data.admin.decision.recordBankOutcome.response.application.statusVersion).toBe(7)
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
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(administrator.cookie, administrator.userId, cycle.id)
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
        oldest: queue(input: { first: 1, cycleId: $cycle, status: SUBMITTED, phaseNumber: 1, applicationType: INITIAL, sector: FOOD_PROCESSING, category: CATEGORY_B, referenceNumber: $reference, order: OLDEST_WAITING }) { response { nodes { id } pageInfo { endCursor hasNextPage } } }
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

    const later = await submittedApplication(administrator.cookie, administrator.userId, cycle.id)
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
    /*
     * A draft and an application that never existed are refused identically,
     * so probing ids cannot reveal which drafts exist.
     *
     * Submitted applications are deliberately not hidden from each other. Any
     * staff member can list every one of them in the queue, so answering
     * differently for a real one conceals nothing — and the scan message is
     * the true reason that request failed.
     */
    const downloadQuery = `query($id: ID!) { admin { intake {
      documentDownloadUrl(applicationId: $id, submissionDocumentId: "missing") { success message }
    } } }`
    /*
     * A draft and an application that never existed are refused identically,
     * so probing ids cannot reveal which drafts exist. Made by putting a known
     * application back into DRAFT for the assertion rather than starting a
     * second one, which the fixture's cycle refuses for unrelated reasons.
     */
    await env.DB.prepare("UPDATE seb_application SET status = 'DRAFT' WHERE id = ?")
      .bind(submitted.applicationId).run()
    for (const applicationId of [submitted.applicationId, 'missing', crypto.randomUUID()]) {
      const refused = await graphql<any>(downloadQuery, { id: applicationId },
        administrator.cookie)
      expect(refused.data.admin.intake.documentDownloadUrl, String(applicationId))
        .toMatchObject({ success: false, message: 'The application was not found.' })
    }
    await env.DB.prepare("UPDATE seb_application SET status = 'SUBMITTED' WHERE id = ?")
      .bind(submitted.applicationId).run()

    // And a submitted one is refused for the true reason instead.
    const scanRefusal = await graphql<any>(downloadQuery,
      { id: submitted.applicationId }, administrator.cookie)
    expect(scanRefusal.data.admin.intake.documentDownloadUrl).toMatchObject({
      success: false,
      message: 'The submitted document has not passed malware scanning.',
    })
    const missingReview = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId: 'missing', expectedStatusVersion: 1,
      outcome: 'ADVANCE_TO_BANK', checks: [], identifiers: [], reasonCategoryId: null,
      applicantMessage: null, revisions: [],
    } }, administrator.cookie)
    expect(missingReview.data.admin.intake.completeDeskReview.success).toBe(false)
    const unsafeDownload = await graphql<any>(`query($id: ID!) { admin { intake {
      documentDownloadUrl(applicationId: $id, submissionDocumentId: "missing") { success message }
    } } }`, { id: submitted.applicationId }, administrator.cookie)
    expect(unsafeDownload.data.admin.intake.documentDownloadUrl.message)
      .toBe('The submitted document has not passed malware scanning.')
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
      { checks, outcome: 'ADVANCE_TO_BANK', revisions: [{ stageKey: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Change.' }] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: null, applicantMessage: 'Safe.', revisions: [] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: null, revisions: [{
        stageKey: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Clarify funding.',
      }] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'First.' },
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Second.' },
      ] },
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: ' ' },
      ] },
      { checks, outcome: 'REJECT', reasonCategoryId: rejectionReason, applicantMessage: 'Safe.', revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReasonPlaceholder, note: 'Change.' },
      ] },
      /*
       * A stage this cycle's form does not have.
       *
       * This path had its own copy of the revision rules and that copy was
       * missing the membership check — so the review landed, the application
       * moved to `REVISION_REQUIRED` with a scope nothing intersects, and the
       * applicant could neither save nor resubmit. They were told the
       * application had changed, on every attempt, for ever. The decision and
       * bank paths refused it all along; only the desk review did not.
       */
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions: [
        { stageKey: 'NO_SUCH_STAGE', reasonCategoryId: revisionReasonPlaceholder, note: 'Fix it.' },
      ] },
      // And more than the six an outcome may carry.
      { checks, outcome: 'REQUEST_REVISION', reasonCategoryId: revisionReasonPlaceholder, applicantMessage: 'Safe.', revisions:
        ['ENTERPRISE', 'APPLICANT_PROFILE', 'FINANCIAL', 'PRIOR_FUNDING', 'DOCUMENTS', 'DECLARATION', 'ENTERPRISE']
          .map((stageKey, index) => ({
            stageKey: index === 6 ? 'ENTERPRISE' : stageKey,
            reasonCategoryId: revisionReasonPlaceholder,
            note: `Change ${index}.`,
          })) },
    ]
    for (const candidate of reviewCases) {
      const result = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
        admin { intake { completeDeskReview(input: $input) { success message } } }
      }`, { input: {
      conflictAcknowledged: true,
        applicationId: submitted.applicationId, expectedStatusVersion: 3,
        reasonCategoryId: null, applicantMessage: null,
        identifiers: passingIdentifiers(), ...candidate,
      } }, administrator.cookie)
      expect(result.data.admin.intake.completeDeskReview.success).toBe(false)
    }
    const staleReview = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId: submitted.applicationId, expectedStatusVersion: 99,
      outcome: 'REJECT', checks, reasonCategoryId: rejectionReason,
      applicantMessage: 'Safe.', revisions: [], identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(staleReview.data.admin.intake.completeDeskReview.success).toBe(false)
    const rejected = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { response { application { status assignedToUserId } } } } }
    }`, { input: {
      conflictAcknowledged: true,
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

    const expansion = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    await env.DB.prepare(`UPDATE seb_application SET application_type = 'EXPANSION',
      phase_number = 2 WHERE id = ?`).bind(expansion.applicationId).run()
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: { applicationId: expansion.applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    const uncheckedExpansion = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success message } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId: expansion.applicationId, expectedStatusVersion: 3,
      outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
      checks, revisions: [], identifiers: passingIdentifiers(),
    } }, administrator.cookie)
    expect(uncheckedExpansion.data.admin.intake.completeDeskReview.message)
      .toBe('Expansion evidence must be checked for an expansion application.')
  })

  it('returns safe envelopes for malformed or stale bank, TTM, award, release, and recovery actions', async () => {
    const administrator = await signIn(['ADMIN'])
    const calls = [
      'query { admin { funding { byApplication(applicationId: "missing") { success message } } } }',
      'query { admin { funding { recoveryById(recoveryCaseId: "missing") { success message } } } }',
      'mutation { admin { decision { referToBank(input: { applicationId: "x", submissionId: "x", deskReviewId: "x", expectedStatusVersion: 0, bankName: " ", referralReference: " ", referralDate: "2026-01-01", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { decision { referToBank(input: { applicationId: "x", submissionId: "x", deskReviewId: "x", expectedStatusVersion: 1, bankName: "Bank", referralReference: "R", referralDate: "2026-01-01", applicantMessage: "Safe" }) { success message } } } }',
      'mutation { admin { decision { recordBankOutcome(input: { applicationId: "x", referralId: "x", expectedStatusVersion: 0, expectedReferralVersion: 0, outcome: RECOMMENDED, decisionReference: " ", decisionDate: "2026-01-01", availableLoanAmountPaise: "0", applicantSummary: " ", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { recordBankOutcome(input: { applicationId: "x", referralId: "x", expectedStatusVersion: 1, expectedReferralVersion: 1, outcome: RECOMMENDED, decisionReference: "R", decisionDate: "2026-01-01", applicantSummary: "Safe", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { cancelBankReferral(input: { applicationId: "x", referralId: "x", expectedReferralVersion: 0, reasonCategoryId: "x", reason: " ", applicantMessage: " " }) { success message } } } }',
      'mutation { admin { decision { correctBankOutcome(input: { applicationId: "x", referralId: "x", supersedesOutcomeId: "x", expectedStatusVersion: 0, outcome: RECOMMENDED, decisionReference: " ", decisionDate: "2026-01-01", applicantSummary: " ", correctionReasonCategoryId: "x", correctionReason: " ", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { recordDecision(input: { applicationId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "R", decisionDate: "2026-01-01", approvedAmountPaise: "1", applicantMessage: "Safe", revisions: [] }) { success message } } } }',
      'mutation { admin { decision { correctDecision(input: { applicationId: "x", supersedesDecisionId: "x", expectedStatusVersion: 1, outcome: APPROVED, decisionReference: "R", decisionDate: "2026-01-01", approvedAmountPaise: "1", correctionReasonCategoryId: "x", correctionReason: "Reason", applicantMessage: "Safe", revisions: [] }) { success message } } } }',
      'mutation { admin { funding { createAward(input: { applicationId: "x", decisionId: "x", expectedStatusVersion: 0, sanctionOrderNumber: " ", sanctionDate: "2026-01-01" }) { success message } } } }',
      'mutation { admin { funding { createAward(input: { applicationId: "x", decisionId: "x", expectedStatusVersion: 1, sanctionOrderNumber: "ORDER", sanctionDate: "2026-01-01" }) { success message } } } }',
      'mutation { admin { funding { changeAward(input: { awardId: "x", applicationId: "x", expectedVersion: 0, expectedStatusVersion: 0, status: ACTIVE, sanctionedAmountPaise: "0", reasonCategoryId: "x", reason: " " }) { success message } } } }',
      'mutation { admin { funding { recordRelease(input: { awardId: "x", applicationId: "x", expectedLedgerVersion: 0, amountPaise: "0", occurredAt: "2030-01-01T00:00:00Z", externalReference: " ", approvalReference: " ", approvalDate: "2026-01-01", bankAccountVerifiedAt: "2030-01-01T00:00:00Z", performanceAgreementReference: " ", performanceAgreementExecutedAt: "2030-01-01T00:00:00Z", physicalVerificationRequired: false, applicantMessage: " " }) { success message } } } }',
      'mutation { admin { funding { recordRelease(input: { awardId: "x", applicationId: "x", expectedLedgerVersion: 0, amountPaise: "1", occurredAt: "2030-01-01T00:00:00Z", externalReference: "R", approvalReference: "A", approvalDate: "2026-01-01", bankAccountVerifiedAt: "2030-01-01T00:00:00Z", performanceAgreementReference: "P", performanceAgreementExecutedAt: "2030-01-01T00:00:00Z", physicalVerificationRequired: true, applicantMessage: "Safe" }) { success message } } } }',
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

  it('runs an application through desk review, bank, TTM, award, release, assessment, and recovery', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const applicationId = submitted.applicationId
    let submissionId = submitted.submissionId
    const db = activeDatabase()
    /*
     * The latest, explicitly ordered, and the next version counted from it.
     * This read had no `ORDER BY` and the write assumed version 2 — true only
     * while the fixture hand-wrote a single version. Reaching submitted the
     * way an applicant does costs versions, so both had to stop guessing.
     */
    const [firstSnapshot] = await db.select().from(sebApplicationVersion).where(
      eq(sebApplicationVersion.applicationId, applicationId),
    ).orderBy(desc(sebApplicationVersion.version)).limit(1)
    if (!firstSnapshot) throw new Error('first submission snapshot missing')
    const resubmissionVersion = firstSnapshot.version + 1
    submissionId = crypto.randomUUID()
    const evidencePinId = crypto.randomUUID()
    const resubmittedAt = new Date()
    const secondVersionId = crypto.randomUUID()
    await batch(db, (tx) => [
      tx.insert(sebApplicationVersion).values({
        ...firstSnapshot,
        id: secondVersionId,
        version: resubmissionVersion,
        changeType: 'RESUBMISSION',
        createdAt: resubmittedAt,
      }),
      /*
       * The answers come with it. They are rows on the version now, not
       * columns of it, so spreading the first snapshot copies the pins and the
       * expansion facts and nothing the applicant actually wrote — and the
       * workspace this test then reads would show an empty form.
       */
      tx.insert(sebApplicationVersionAnswer).select(sql`
        SELECT gen_random_uuid()::text, ${secondVersionId}, programme_cycle_id,
               programme_cycle_version, field_key, entry_index, value_ordinal,
               value_text, ${resubmittedAt}
          FROM seb_application_version_answer
         WHERE application_version_id = ${firstSnapshot.id}`),
      tx.insert(sebApplicationSubmission).values({
        id: submissionId,
        applicationId,
        submissionNumber: 2,
        applicationVersion: resubmissionVersion,
        submittedByUserId: administrator.userId,
        submittedAt: resubmittedAt,
      }),
      tx.update(sebApplication)
        .set({ currentVersion: resubmissionVersion, updatedAt: resubmittedAt })
        .where(eq(sebApplication.id, applicationId)),
    ])
    /*
     * The resubmission pins the evidence the applicant already uploaded.
     *
     * A second `DPR` document is what the schema refuses — evidence is one
     * document per question per application, versioned in place. What changes
     * between submissions is which version each one pinned, and that is the
     * only row written here.
     */
    await env.DB.prepare(`INSERT INTO seb_application_submission_document (
      id, application_id, submission_id, document_id, document_version,
      field_key, created_at
    ) VALUES (?, ?, ?, ?, 1, 'DPR', ?)`).bind(
      evidencePinId, applicationId, submissionId, submitted.pins.DPR!.documentId,
      resubmittedAt.getTime(),
    ).run()
    /*
     * The head's status version, read rather than counted.
     *
     * Every act below quotes the version it expects, and a chain of literals
     * running from 2 into the twenties has to be renumbered end to end
     * whenever a step is added or removed — which is how a valid act starts
     * being refused as stale, several lines from where it reads as a null.
     * The refusals below keep their literals, because quoting a wrong version
     * is exactly what they are testing.
     */
    const liveStatusVersion = async (): Promise<number> => (await env.DB.prepare(
      `SELECT status_version AS "statusVersion" FROM seb_application WHERE id = ?`,
    ).bind(applicationId).first<{ statusVersion: number }>())!.statusVersion

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

    /*
     * Annotating does not require having worked the file.
     *
     * It used to: the note's write predicate carried the assignment, so a case
     * sitting in the shared queue could not be annotated at all. A note is an
     * insert rather than a transition — there is no lost update to lose — so
     * its remaining guards are the ones that matter: the application exists,
     * is not deleted, and is not a draft.
     */
    const unassignedNote = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success message } } }
    }`, { input: {
      applicationId, note: 'Written while the case sits in the shared queue.',
    } }, administrator.cookie)
    expect(unassignedNote.data.admin.intake.addInternalNote.success).toBe(true)

    /*
     * What still refuses a note: a draft. Removing the assignment removed the
     * "only the holder may annotate" rule, not the "an unsubmitted draft is
     * invisible to the office" one, and that distinction is the whole point of
     * which terms were dropped.
     */
    await env.DB.prepare("UPDATE seb_application SET status = 'DRAFT' WHERE id = ?")
      .bind(applicationId).run()
    const draftNote = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success } } }
    }`, { input: {
      applicationId, note: 'A draft has never reached the office.',
    } }, administrator.cookie)
    expect(draftNote.data.admin.intake.addInternalNote.success).toBe(false)
    await env.DB.prepare("UPDATE seb_application SET status = 'SUBMITTED' WHERE id = ?")
      .bind(applicationId).run()
    const reviewStart = await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { response { status statusVersion } } } }
    }`, { input: { applicationId, expectedStatusVersion: 2 } }, administrator.cookie)
    expect(reviewStart.data.admin.intake.startDeskReview.response.status).toBe('DESK_REVIEW')
    const review = await graphql<any>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success response { reviews { id } application { status statusVersion } } } } }
    }`, { input: {
      conflictAcknowledged: true,
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
      applicationId, submissionId, deskReviewId: reviewId,
      expectedStatusVersion: await liveStatusVersion(),
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
        { stageKey: 'FINANCIAL', reasonCategoryId: bankRevisionReason, note: 'First.' },
        { stageKey: 'FINANCIAL', reasonCategoryId: bankRevisionReason, note: 'Second.' },
      ] },
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: 'missing', note: 'Correction.' },
      ] },
      { outcome: 'RECOMMENDED', revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: bankRevisionReason, note: 'Unexpected.' },
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
        stageKey: 'FINANCIAL', reasonCategoryId: bankRevisionReason,
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
        { stageKey: 'DOCUMENTS', reasonCategoryId: bankRevisionReason, note: 'First.' },
        { stageKey: 'DOCUMENTS', reasonCategoryId: bankRevisionReason, note: 'Second.' },
      ] },
      { outcome: 'MORE_INFORMATION_REQUIRED', revisions: [
        { stageKey: 'DOCUMENTS', reasonCategoryId: 'missing', note: 'Correction.' },
      ] },
      { outcome: 'RECOMMENDED', revisions: [
        { stageKey: 'DOCUMENTS', reasonCategoryId: bankRevisionReason, note: 'Unexpected.' },
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
      expectedStatusVersion: await liveStatusVersion(), outcome: 'MORE_INFORMATION_REQUIRED',
      decisionReference: `BANK-CORR-${applicationId}`, decisionDate: '2026-06-11',
      availableLoanAmountPaise: null, applicantSummary: 'Bank requested corrected supporting evidence.',
      internalNote: 'Signed correction received offline.',
      correctionReasonCategoryId: correctionReason, correctionReason: 'Correct signed outcome received.',
      revisions: [{
        stageKey: 'DOCUMENTS', reasonCategoryId: bankRevisionReason,
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
      expectedStatusVersion: await liveStatusVersion(), outcome: 'RECOMMENDED',
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

    /*
     * Straight from the bank's appraisal to the decision.
     *
     * Everything between — scheduling a sitting, putting the application on an
     * agenda, opening the sitting — went with the committee. What the agenda
     * used to carry, the decision now pins itself: which submission and which
     * bank outcome were in front of the decider.
     */
    const ttmRejectionReason = await reasonId(cycle.id, 'REJECTION')
    const revisionReason = await reasonId(cycle.id, 'REVISION')
    const malformedDecision = await graphql<any>(`mutation($input: DecisionInput!) {
      admin { decision { recordDecision(input: $input) { success message } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, expectedStatusVersion: 0,
      outcome: 'APPROVED', decisionReference: ' ', decisionDate: '2026-06-15',
      approvedAmountPaise: '1', applicantConditions: null, reasonCategoryId: null,
      applicantMessage: ' ', revisions: [],
    } }, administrator.cookie)
    expect(malformedDecision.data.admin.decision.recordDecision.message)
      .toBe('Enter valid decision details.')
    const invalidDecisionCases = [
      // One paise more than the fixture's request, read from the fixture so it
      // stays "more" when the fixture changes.
      { outcome: 'APPROVED', approvedAmountPaise: String(completeAnswers().SEED_FUND_REQUESTED_PAISE as number + 1), reasonCategoryId: null, revisions: [] },
      { outcome: 'REJECTED', approvedAmountPaise: '1', reasonCategoryId: ttmRejectionReason, revisions: [] },
      /*
       * An approval carrying a next action used to sit here. `nextAction` went
       * with `DEFERRED` — it meant "hold this over to the next sitting" — so
       * the case has no subject any more and is simply a valid approval.
       */
      { outcome: 'REJECTED', approvedAmountPaise: null, reasonCategoryId: null, revisions: [] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: ttmRejectionReason, revisions: [] },
      { outcome: 'REVISION_REQUIRED', approvedAmountPaise: null, reasonCategoryId: revisionReason, revisions: [] },
      { outcome: 'REVISION_REQUIRED', approvedAmountPaise: null, reasonCategoryId: revisionReason, revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReason, note: 'First.' },
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReason, note: 'Second.' },
      ] },
      { outcome: 'REVISION_REQUIRED', approvedAmountPaise: null, reasonCategoryId: revisionReason, revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReason, note: ' ' },
      ] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: null, revisions: [
        { stageKey: 'FINANCIAL', reasonCategoryId: revisionReason, note: 'Unexpected.' },
      ] },
    ]
    for (const [index, candidate] of invalidDecisionCases.entries()) {
      const invalid = await graphql<any>(`mutation($input: DecisionInput!) {
        admin { decision { recordDecision(input: $input) { success message } } }
      }`, { input: {
      conflictAcknowledged: true,
        applicationId, expectedStatusVersion: 8,
        decisionReference: `INVALID-${index}-${applicationId}`, decisionDate: '2026-06-15',
        applicantConditions: null, applicantMessage: 'Safe explanation.', ...candidate,
      } }, administrator.cookie)
      expect(invalid.data.admin.decision.recordDecision.success).toBe(false)
    }
    const decision = await graphql<any>(`mutation($input: DecisionInput!) {
      admin { decision { recordDecision(input: $input) { success message response { decisions { id } application { status statusVersion } } } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, expectedStatusVersion: await liveStatusVersion(),
      outcome: 'REVISION_REQUIRED', decisionReference: `TTM-DEC-${applicationId}`,
      decisionDate: '2026-06-15', approvedAmountPaise: null,
      applicantConditions: null, reasonCategoryId: revisionReason,
      applicantMessage: 'TTM initially requested a financial correction.',
      revisions: [{
        stageKey: 'FINANCIAL', reasonCategoryId: revisionReason,
        note: 'Clarify the requested amount.',
      }],
    } }, administrator.cookie)
    expect(decision.errors, JSON.stringify(decision.errors)).toBeUndefined()
    const recorded = decision.data.admin.decision.recordDecision
    expect(recorded.success, recorded.message).toBe(true)
    expect(recorded.response.application.status).toBe('REVISION_REQUIRED')
    const initialDecisionId = decision.data.admin.decision.recordDecision.response.decisions[0].id as string
    const staleInitialDecision = await graphql<any>(`mutation($input: DecisionInput!) {
      admin { decision { recordDecision(input: $input) { success } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, expectedStatusVersion: 8,
      outcome: 'REJECTED', decisionReference: `STALE-DEC-${applicationId}`,
      decisionDate: '2026-06-15', approvedAmountPaise: null,
      applicantConditions: null, reasonCategoryId: ttmRejectionReason,
      applicantMessage: 'This stale decision must lose.', revisions: [],
    } }, administrator.cookie)
    expect(staleInitialDecision.data.admin.decision.recordDecision.success).toBe(false)
    const decisionCorrectionReason = await reasonId(cycle.id, 'DECISION_CORRECTION')
    const invalidDecisionCorrections = [
      { outcome: 'REJECTED', reasonCategoryId: null, revisions: [] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: ttmRejectionReason, revisions: [] },
      { outcome: 'REVISION_REQUIRED', reasonCategoryId: revisionReason, revisions: [] },
      { outcome: 'REVISION_REQUIRED', reasonCategoryId: revisionReason, revisions: [
        { stageKey: 'DOCUMENTS', reasonCategoryId: 'missing', note: 'Correction.' },
      ] },
      { outcome: 'APPROVED', approvedAmountPaise: '900000', reasonCategoryId: null, revisions: [
        { stageKey: 'DOCUMENTS', reasonCategoryId: revisionReason, note: 'Unexpected.' },
      ] },
      // A correction that does not say why. The superseded decision is kept
      // forever, so the record of what was wrong with it is not optional.
      { outcome: 'REJECTED', reasonCategoryId: ttmRejectionReason, revisions: [],
        correctionReason: '   ' },
    ]
    for (const [index, candidate] of invalidDecisionCorrections.entries()) {
      const invalid = await graphql<any>(`mutation($input: CorrectDecisionInput!) {
        admin { decision { correctDecision(input: $input) { success } } }
      }`, { input: {
        // Disclosed, so each candidate below is refused for the reason it names
        // rather than for the self-review guard it would otherwise trip first.
        conflictAcknowledged: true,
        applicationId, supersedesDecisionId: initialDecisionId,
        expectedStatusVersion: 9, decisionReference: `INVALID-TTM-CORR-${index}`,
        decisionDate: '2026-06-16', approvedAmountPaise: null, applicantConditions: null,
        correctionReasonCategoryId: decisionCorrectionReason, correctionReason: 'Correction.',
        applicantMessage: 'Safe explanation.', ...candidate,
      } }, administrator.cookie)
      expect(invalid.data.admin.decision.correctDecision.success).toBe(false)
    }
    /*
     * A correction is its own act on the file, and this officer is the
     * applicant. Superseding a decision without disclosing is refused exactly
     * as recording one is — otherwise the disclosure could be sidestepped by
     * recording a decision and immediately correcting it.
     */
    const undisclosedCorrection = await graphql<{
      admin: { decision: { correctDecision: { success: boolean; message: string | null } } }
    }>(`mutation($input: CorrectDecisionInput!) {
      admin { decision { correctDecision(input: $input) { success message } } }
    }`, { input: {
      applicationId, supersedesDecisionId: initialDecisionId,
      expectedStatusVersion: 9, outcome: 'REJECTED',
      decisionReference: `TTM-UNDISCLOSED-${applicationId}`, decisionDate: '2026-06-16',
      approvedAmountPaise: null, applicantConditions: null,
      reasonCategoryId: ttmRejectionReason, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'The initial revision direction was incorrect.',
      applicantMessage: 'TTM rejected the application.', revisions: [],
    } }, administrator.cookie)
    expect(undisclosedCorrection.data?.admin.decision.correctDecision).toMatchObject({
      success: false,
      message: 'Acknowledge that you are acting on your own application.',
    })

    const rejectedDecision = await graphql<any>(`mutation($input: CorrectDecisionInput!) {
      admin { decision { correctDecision(input: $input) { success message response { decisions { id } application { status statusVersion assignmentVersion } } } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, supersedesDecisionId: initialDecisionId,
      expectedStatusVersion: await liveStatusVersion(), outcome: 'REJECTED',
      decisionReference: `TTM-REJECT-${applicationId}`, decisionDate: '2026-06-16',
      approvedAmountPaise: null, applicantConditions: null,
      reasonCategoryId: ttmRejectionReason, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'The initial revision direction was incorrect.',
      applicantMessage: 'TTM rejected the application.', revisions: [],
    } }, administrator.cookie)
    const corrected = rejectedDecision.data.admin.decision.correctDecision
    expect(corrected.success, corrected.message).toBe(true)
    const rejectedWorkspace = corrected.response
    expect(rejectedWorkspace.application).toMatchObject({
      status: 'REJECTED', statusVersion: 10, assignmentVersion: 2,
    })
    const rejectedDecisionId = rejectedWorkspace.decisions[1].id as string
    const revisionDecision = await graphql<any>(`mutation($input: CorrectDecisionInput!) {
      admin { decision { correctDecision(input: $input) { success message response { decisions { id approvedAmountPaise } application { statusVersion } } } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, supersedesDecisionId: rejectedDecisionId,
      expectedStatusVersion: await liveStatusVersion(), outcome: 'REVISION_REQUIRED',
      decisionReference: `TTM-CORR-${applicationId}`, decisionDate: '2026-06-17',
      approvedAmountPaise: null, applicantConditions: null,
      reasonCategoryId: revisionReason, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Replace the mistaken rejection with a revision request.',
      applicantMessage: 'TTM requires one document correction.',
      revisions: [{
        stageKey: 'DOCUMENTS', reasonCategoryId: revisionReason,
        note: 'Replace the unclear supporting document.',
      }],
    } }, administrator.cookie)
    const revised = revisionDecision.data.admin.decision.correctDecision
    expect(revised.success, revised.message).toBe(true)
    const revisionDecisionWorkspace = revised.response
    const revisionDecisionId = revisionDecisionWorkspace.decisions[2].id as string
    const correctedDecision = await graphql<any>(`mutation($input: CorrectDecisionInput!) {
      admin { decision { correctDecision(input: $input) { success message response { decisions { id approvedAmountPaise } application { statusVersion } } } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, supersedesDecisionId: revisionDecisionId,
      expectedStatusVersion: await liveStatusVersion(), outcome: 'APPROVED',
      decisionReference: `DEC-APPROVE-${applicationId}`, decisionDate: '2026-06-19',
      approvedAmountPaise: '900000', applicantConditions: 'Use funds only for approved assets.',
      reasonCategoryId: null, correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Final verification completed.',
      applicantMessage: 'TTM approved the corrected application.', revisions: [],
    } }, administrator.cookie)
    const approved = correctedDecision.data.admin.decision.correctDecision
    if (!approved.success) {
      console.log('DBG head', JSON.stringify((await env.DB.prepare(
        `SELECT status, status_version AS "sv" FROM seb_application WHERE id = ?`,
      ).bind(applicationId).first())))
      console.log('DBG decisions', JSON.stringify((await env.DB.prepare(
        `SELECT id, decision_number AS "n", outcome, created_at AS "at"
           FROM seb_programme_decision WHERE application_id = ? ORDER BY created_at`,
      ).bind(applicationId).all()).results))
      console.log('DBG supersedes', revisionDecisionId)
      console.log('DBG answers', JSON.stringify((await env.DB.prepare(
        `SELECT a.value_text FROM seb_application_version_answer a
           JOIN seb_application v ON v.current_version = (
             SELECT version FROM seb_application_version WHERE id = a.application_version_id)
          WHERE v.id = ? AND a.field_key = 'SEED_FUND_REQUESTED_PAISE'`,
      ).bind(applicationId).all()).results))
    }
    expect(approved.success, approved.message).toBe(true)
    const correctedDecisionWorkspace = approved.response
    /*
     * The fourth decision on this application: the first, then a rejection, a
     * revision, and this approval — each superseding the last and each kept.
     * Counted from the list rather than indexed by a literal, so a step added
     * above moves it rather than silently pointing at somebody else's row.
     */
    const decisionId = correctedDecisionWorkspace
      .decisions[correctedDecisionWorkspace.decisions.length - 1].id as string
    expect(correctedDecisionWorkspace.decisions).toHaveLength(4)
    const staleDecisionCorrection = await graphql<any>(`mutation($input: CorrectDecisionInput!) {
      admin { decision { correctDecision(input: $input) { success } } }
    }`, { input: {
      conflictAcknowledged: true,
      applicationId, supersedesDecisionId: revisionDecisionId,
      expectedStatusVersion: 11, outcome: 'APPROVED',
      decisionReference: `STALE-APPROVAL-${applicationId}`, decisionDate: '2026-06-19',
      approvedAmountPaise: '900000', applicantConditions: null, reasonCategoryId: null,
      correctionReasonCategoryId: decisionCorrectionReason,
      correctionReason: 'Attempt stale correction.',
      applicantMessage: 'This stale correction must lose.', revisions: [],
    } }, administrator.cookie)
    expect(staleDecisionCorrection.data.admin.decision.correctDecision.success).toBe(false)
    const award = await graphql<any>(`mutation($input: CreateAwardInput!) {
      admin { funding { createAward(input: $input) { response { award { id ledgerVersion } } } } }
    }`, { input: {
      applicationId, decisionId, expectedStatusVersion: await liveStatusVersion(),
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
      awardId: awardHead.id, applicationId, expectedVersion: 1, expectedStatusVersion: 13,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence.',
      reasonCategoryId: amendmentReason, reason: 'No values changed.',
    } }, administrator.cookie)
    expect(noOpAmendment.data.admin.funding.changeAward.success).toBe(false)
    const rejectedAmendment = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { success message } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 1, expectedStatusVersion: 13,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: wrongAmendmentReason, reason: 'Wrong category.',
    } }, administrator.cookie)
    expect(rejectedAmendment.data.admin.funding.changeAward.message)
      .toBe('Select an approved award-change reason.')
    const amended = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { response { award { status currentVersion applicantConditions } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 1, expectedStatusVersion: 13,
      status: 'ACTIVE', sanctionedAmountPaise: '900000',
      applicantConditions: 'Submit utilization evidence for every release.',
      reasonCategoryId: amendmentReason, reason: 'Clarify evidence timing.',
    } }, administrator.cookie)
    expect(amended.data.admin.funding.changeAward.response.award.currentVersion).toBe(2)
    const suspensionReason = await reasonId(cycle.id, 'AWARD_SUSPENSION')
    const suspended = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { response { award { status currentVersion } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 2, expectedStatusVersion: 13,
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
      awardId: awardHead.id, applicationId, expectedVersion: 2, expectedStatusVersion: 13,
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
      approvalReference: 'BLOCKED', approvalDate: '2026-06-21',
      bankAccountVerifiedAt: new Date().toISOString(), performanceAgreementReference: 'BLOCKED',
      performanceAgreementExecutedAt: new Date().toISOString(),
      physicalVerificationRequired: false, physicalVerificationReference: null,
      physicalVerificationCompletedAt: null, applicantMessage: 'Should not release.',
    } }, administrator.cookie)
    expect(blockedRelease.data.admin.funding.recordRelease.success).toBe(false)
    const resumed = await graphql<any>(`mutation($input: ChangeAwardInput!) {
      admin { funding { changeAward(input: $input) { response { award { status currentVersion } } } } }
    }`, { input: {
      awardId: awardHead.id, applicationId, expectedVersion: 3, expectedStatusVersion: 13,
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
      externalReference: `PAY-${applicationId}`, approvalReference: `TTM-REL-${applicationId}`,
      approvalDate: '2026-06-25', bankAccountVerifiedAt: new Date().toISOString(),
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
      approvalReference: `TTM-REL-SECOND-${applicationId}`, approvalDate: '2026-07-01',
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
      expectedStatusVersion: 14, status: 'CANCELLED', sanctionedAmountPaise: '900000',
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
      expectedStatusVersion: 15, status: 'CLOSED', sanctionedAmountPaise: '900000',
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
      expectedStatusVersion: 15, status: 'CLOSED', sanctionedAmountPaise: '900000',
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
        snapshots { version programmeCycleVersion }
        documents { id submissionId fieldKey documentVersion originalFilename contentType sizeBytes }
        submissionChanges { fromSubmissionNumber toSubmissionNumber stageKeys }
        assignments { eventType assignmentVersion }
        reviewChecks { checkType result }
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
    /*
     * The resubmission's pin, naming the document the applicant uploaded
     * before the first submission. The file details are the fixture's, because
     * the evidence itself is not re-uploaded on a resubmission — only pinned
     * again.
     */
    expect(workspace.documents).toContainEqual(expect.objectContaining({
      id: evidencePinId, submissionId, fieldKey: 'DPR', documentVersion: 1,
      originalFilename: 'DPR.pdf', contentType: 'application/pdf', sizeBytes: 10,
    }))
    /*
     * Empty, and that is the assertion: the resubmission copied the first
     * submission's answers unchanged, so nothing differs between them. A
     * comparison that reported a changed stage here would be reporting a
     * difference the applicant did not make.
     */
    expect(workspace.submissionChanges).toEqual([{
      fromSubmissionNumber: 1, toSubmissionNumber: 2, stageKeys: [],
    }])
    expect(workspace.assignments.length).toBeGreaterThan(0)
    expect(workspace.reviewChecks).toHaveLength(deskCheckTypes.length)
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
    const otherApplicant = await signIn(['APPLICANT'])
    const foreignRead = await graphql<any>(`query($id: ID!) {
      seb { application { funding(applicationId: $id) { success message response { award { sanctionOrderNumber } } } } }
    }`, { id: applicationId }, otherApplicant.cookie)
    expect(foreignRead.data.seb.application.funding).toEqual({
      success: false, message: 'The application was not found.', response: null,
    })
  })

  it('gives administrators a named queue per stage with matching counts', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const first = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const second = await submittedApplication(
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
    const beforeReviewStart = await stateOf(first.applicationId)
    const started = await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success message } } }
    }`, { input: {
      applicationId: first.applicationId,
      expectedStatusVersion: beforeReviewStart.statusVersion,
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
    const otherCycle = await openCycle(administrator.cookie)
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

    // A draft has never been formally submitted, so it belongs to no queue:
    // reviewers must not be able to reach unsubmitted work.
    const draftEnterprise = await graphql<any>(`mutation($input: EnterpriseProfileInput!) {
      seb { enterprise { create(input: $input) { response { id } } } }
    }`, { input: {
      name: 'Unsubmitted Draft Enterprise', establishmentDate: '2026-01-01',
      registrationType: 'SOLE_PROPRIETORSHIP', registrationNumber: null, gstin: null,
      businessSector: 'FOOD_PROCESSING', otherBusinessSector: null,
      businessBlockOrVillage: 'Khumulwng', businessDistrict: 'WEST_TRIPURA',
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
    // Reached for below only to prove it is absent from every count.
    expect(draftId).toBeTruthy()
    const withDraft = await graphql<any>(summaryQuery, { cycleId: cycle.id },
      administrator.cookie)
    expect(countFor(withDraft, 'NEW_SUBMISSIONS')).toBe(0)
    expect(countFor(withDraft, 'DESK_REVIEW')).toBe(1)

    const applicantOnly = await signIn(['APPLICANT'])
    const refused = await graphql<any>(summaryQuery, { cycleId: null }, applicantOnly.cookie)
    expect(refused.data.admin.intake.queues).toMatchObject({
      success: false, message: 'You do not have permission to do that.',
    })
  })

  it('reports a sanctioned application that has no award yet', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
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
  it('never lets a search reach past the filters beside it', async () => {
    /*
     * The search matches two columns, and two columns mean an `OR`. An `OR`
     * without parentheses binds looser than every `AND` around it, so the
     * predicate collapses to "(everything else AND the first column) OR the
     * second column" — and a row matching the second is returned whatever its
     * status, whatever its cycle, deleted or not.
     *
     * The office would see unsubmitted drafts, which the download path goes out
     * of its way to keep invisible, and soft-deleted applications, in a list
     * whose count claims to describe the filters.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    /*
     * Searched by the **enterprise name**, which is the second of the two
     * columns the search spans. The first sits inside the AND group and is
     * therefore safe; it is the second that escapes it, so a test using the
     * reference number would pass while the leak was wide open.
     */
    const [row] = await env.DB.prepare(
      `SELECT e.current_name AS name FROM seb_application a
       JOIN seb_enterprise e ON e.id = a.enterprise_id WHERE a.id = ?`,
    ).bind(submitted.applicationId).raw<[string]>()
    const enterpriseName = row?.[0] ?? ''
    expect(enterpriseName).not.toBe('')

    // Soft-delete it. Nothing may bring it back into the queue.
    await env.DB.prepare('UPDATE seb_application SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), submitted.applicationId).run()

    const found = await graphql<any>(`query($input: AdminIntakeQueueInput) {
      admin { intake { queue(input: $input) { response {
        nodes { id } pageInfo { totalCount }
      } } } }
    }`, { input: { first: 50, search: enterpriseName } }, administrator.cookie)
    const page = found.data.admin.intake.queue.response
    expect(page.nodes.map((node: { id: string }) => node.id))
      .not.toContain(submitted.applicationId)
    expect(page.pageInfo.totalCount, 'the count must describe the same rows')
      .toBe(page.nodes.length)
  })


  it('finds an application by the start of its reference or enterprise name', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
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

    /*
     * Or the enterprise name, because that is the other thing on the paper.
     * Read back rather than written as a literal: the fixture makes the name
     * unique per application so the enterprise cap and the per-owner name
     * uniqueness do not refuse the second one, and a literal here would be a
     * test that passes only while it happens to agree with the fixture.
     */
    const enterpriseName = (await env.DB.prepare(
      `SELECT current_name AS "currentName" FROM seb_enterprise WHERE id = ?`,
    ).bind(submitted.enterpriseId).first<{ currentName: string }>())!.currentName
    const byName = await search(enterpriseName.slice(0, 12).toLowerCase())
    expect(byName?.nodes.map((node) => node.id)).toContain(submitted.applicationId)

    // Prefix only, and a miss is empty rather than everything.
    expect((await search('zzzz'))?.nodes).toEqual([])
    expect((await search('zzzz'))?.pageInfo.totalCount).toBe(0)
  })

  it('narrows the cycle list by status, year and code, and refuses a nonsense year', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
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

describe('what reaches the activity history', () => {
  it('records a recovery case cancelled in error', async () => {
    /*
     * Cancelling is the one recovery act that leaves no ledger entry behind, so
     * it is the one where the audit row is the *only* trace. A case opened
     * against the wrong award and quietly cancelled would otherwise be
     * indistinguishable from one that never existed.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const caseId = await recoverableCase(administrator, cycle)

    const cancelled = await graphql<any>(`mutation($input: CloseRecoveryInput!) {
      admin { funding { cancelRecovery(input: $input) { success message } } }
    }`, { input: {
      recoveryCaseId: caseId, expectedVersion: 1,
      reason: 'Opened against the wrong award.',
    } }, administrator.cookie)
    expect(cancelled.data.admin.funding.cancelRecovery.success, JSON.stringify(cancelled))
      .toBe(true)
    expect(await auditActionsFor(caseId)).toContain('SEB.RECOVERY_CANCELLED')
  })

  it('records every recovery action, including a waiver of public money', async () => {
    /*
     * A recovery waiver is public money being written off — the single most
     * sensitive administrative act in the programme. It must be reviewable.
     *
     * The action names below are already declared in `auditActions`; nothing
     * was writing them, so the trail said a recovery case had simply never
     * existed.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const caseId = await recoverableCase(administrator, cycle)

    expect(await auditActionsFor(caseId)).toContain('SEB.RECOVERY_OPENED')

    const demand = await graphql<any>(`mutation($input: RecoveryEntryInput!) {
      admin { funding { recordRecoveryEntry(input: $input) { success message } } }
    }`, { input: {
      recoveryCaseId: caseId, expectedLedgerVersion: 0,
      entryType: 'DEMAND', component: 'PENAL_INTEREST', relatedEntryId: null,
      amountPaise: '10000', externalReference: `REC-D-${caseId}`,
      occurredAt: new Date().toISOString(), reasonCategoryId: null,
      applicantMessage: 'Interest demanded.',
    } }, administrator.cookie)
    expect(demand.data.admin.funding.recordRecoveryEntry.success).toBe(true)

    // The waiver itself.
    const waiver = await graphql<any>(`mutation($input: RecoveryEntryInput!) {
      admin { funding { recordRecoveryEntry(input: $input) { success message } } }
    }`, { input: {
      recoveryCaseId: caseId, expectedLedgerVersion: 1,
      entryType: 'WAIVER', component: 'PENAL_INTEREST', relatedEntryId: null,
      amountPaise: '10000', externalReference: `REC-W-${caseId}`,
      occurredAt: new Date().toISOString(),
      reasonCategoryId: await reasonId(cycle.id, 'RECOVERY_WAIVER'),
      applicantMessage: 'Interest waived.',
    } }, administrator.cookie)
    expect(waiver.data.admin.funding.recordRecoveryEntry.success, JSON.stringify(waiver)).toBe(true)

    const afterEntries = await auditActionsFor(caseId)
    expect(afterEntries.filter((a) => a === 'SEB.RECOVERY_ENTRY_RECORDED')).toHaveLength(2)

    const closed = await graphql<any>(`mutation($input: CloseRecoveryInput!) {
      admin { funding { closeRecovery(input: $input) { success message } } }
    }`, { input: {
      recoveryCaseId: caseId, expectedVersion: 1, reason: 'Balance settled.',
    } }, administrator.cookie)
    expect(closed.data.admin.funding.closeRecovery.success, JSON.stringify(closed)).toBe(true)
    expect(await auditActionsFor(caseId)).toContain('SEB.RECOVERY_CLOSED')
  })
})

describe('what a reviewer read off the documents', () => {
  /**
   * Takes a fresh application to the point a desk review can be completed, and
   * returns a function that completes it with whatever identifiers are given.
   */
  const readyToReview = async (
    options: {
      /** Reuse a cycle, so two applications can share one set of rules. */
      cycle?: { id: string }
      identifierRules?: unknown[]
    } = {},
  ) => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = options.cycle ?? await openCycle(
      administrator.cookie,
      options.identifierRules ? { identifierRules: options.identifierRules } : undefined,
    )
    const submitted = await submittedApplication(
      administrator.cookie,
      administrator.userId,
      cycle.id,
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
            // This fixture's officer owns the application, so the self-review
            // has to be disclosed before anything else is asserted.
            conflictAcknowledged: true,
          },
        },
        administrator.cookie,
      ).then((result) => result.data.admin.intake.completeDeskReview)

    return { administrator, cycle, applicationId: submitted.applicationId, review }
  }


  it('collects only what its cycle asks for', async () => {
    /*
     * The two settings are independent, and a cycle that says nothing about a
     * kind is not the same as one that says OFF.
     *
     * OFF means somebody decided this programme does not collect that number,
     * so a value sent anyway is refused rather than quietly dropped — dropping
     * it would leave the reviewer believing they had recorded something.
     * Silence means the cycle predates these rules, and refusing there would
     * have broken every open cycle on the day this shipped.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie, {
      identifierRules: [
        // Wanted, but never demanded and never compared.
        { kind: 'ST_CERTIFICATE', requirement: 'OPTIONAL',
          duplicatePolicy: 'NOT_CHECKED', checkType: null },
        // Deliberately not collected by this programme.
        { kind: 'BANK_ACCOUNT', requirement: 'OFF',
          duplicatePolicy: 'NOT_CHECKED', checkType: null },
      ],
    })
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    await graphql<any>(`mutation($input: StartDeskReviewInput!) {
      admin { intake { startDeskReview(input: $input) { success } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedStatusVersion: 2,
    } }, administrator.cookie)

    const complete = (identifiers: unknown[]) => graphql<{
      admin: { intake: { completeDeskReview: { success: boolean; message: string | null } } }
    }>(`mutation($input: CompleteDeskReviewInput!) {
      admin { intake { completeDeskReview(input: $input) { success message } } }
    }`, { input: {
      applicationId: submitted.applicationId, expectedStatusVersion: 3,
      outcome: 'ADVANCE_TO_BANK', reasonCategoryId: null, applicantMessage: null,
      checks: deskCheckTypes.map((checkType) => ({
        checkType, result: checkType === 'EXPANSION_EVIDENCE' ? 'NOT_APPLICABLE' : 'PASS',
      })), revisions: [], identifiers, conflictAcknowledged: true,
    } }, administrator.cookie)

    // A kind this cycle switched off, sent anyway.
    const offered = await complete([
      { kind: 'BANK_ACCOUNT', value: '123456789012', branchCode: 'SBIN0001234' },
    ])
    expect(offered.data?.admin.intake.completeDeskReview).toMatchObject({
      success: false,
      message: 'This programme cycle does not collect the bank account number and branch code.',
    })

    // Nothing is demanded, because nothing here is REQUIRED_ON_PASS — even
    // though every check passed.
    expect((await complete([])).data?.admin.intake.completeDeskReview.success).toBe(true)
  })

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
        `SELECT matched_reason AS reason, comparable_value AS value, last_four AS "lastFour"
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

  it('compares only the kinds its cycle marks for comparison', async () => {
    /*
     * The two settings are independent, and this is the half that is easy to
     * get backwards: an identifier can be *demanded* without being *compared*.
     *
     * A bank account shared by a family is a real thing, and a programme that
     * decided a repeat is not disqualifying must be able to say so. If
     * `duplicate_policy` were quietly ignored, the collision would still be
     * raised and the setting would be decoration.
     */
    const first = await readyToReview({
      identifierRules: [
        { kind: 'IDENTITY_DOCUMENT', requirement: 'REQUIRED_ON_PASS',
          duplicatePolicy: 'NOT_CHECKED', checkType: 'IDENTITY_KYC' },
      ],
    })
    const shared = { kind: 'IDENTITY_DOCUMENT', value: '770000002222' }
    expect((await first.review([shared])).success).toBe(true)

    // The same number, the same cycle, a different application. Recorded
    // without a word, because this cycle asked for it not to be compared.
    const second = await readyToReview({ cycle: first.cycle })
    const repeated = await second.review([shared])
    expect(repeated.success).toBe(true)
    expect(repeated.message).toBeNull()

    // Both are on the record. Not comparing is not the same as not storing.
    const [{ count }] = (await env.DB.prepare(
      `SELECT count(*)::int AS count FROM seb_desk_review_identifier
       WHERE kind = 'IDENTITY_DOCUMENT' AND last_four = '2222'`,
    ).all()).results as { count: number }[]
    expect(count).toBe(2)
  })

  it('treats one account number at two branches as two accounts', async () => {
    /*
     * A bank account is two fields, and only the pair identifies it. Comparing
     * the account number alone would collide every 50010000001 in Tripura;
     * comparing the branch alone would collide everybody who banks at the same
     * branch. Both are the kind of false match that teaches reviewers to click
     * through the warning.
     */
    const first = await readyToReview()
    expect((await first.review([
      { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-990001' },
      { kind: 'IDENTITY_DOCUMENT', value: '990000001111' },
      { kind: 'BANK_ACCOUNT', value: '50010000999', branchCode: 'SBIN0001111' },
    ])).success).toBe(true)

    const second = await readyToReview()
    const otherBranch = await second.review([
      { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-990002' },
      { kind: 'IDENTITY_DOCUMENT', value: '990000002222' },
      // Same digits, different bank. A different account.
      { kind: 'BANK_ACCOUNT', value: '50010000999', branchCode: 'SBIN0002222' },
    ])
    expect(otherBranch.success).toBe(true)

    // And the pair really does still collide when both halves agree.
    const third = await readyToReview()
    const sameAccount = await third.review([
      { kind: 'ST_CERTIFICATE', value: 'TR-ST-2026-990003' },
      { kind: 'IDENTITY_DOCUMENT', value: '990000003333' },
      { kind: 'BANK_ACCOUNT', value: '50010000999', branchCode: 'SBIN0001111' },
    ])
    expect(sameAccount.success).toBe(false)
    expect(sameAccount.message).toContain('bank account number and branch code')
  })

  it('refuses identifier rules that repeat a kind or name no real check', async () => {
    /*
     * A unique index and a CHECK enforce both of these in SQL, and that is what
     * makes the outcome correct. These assertions are about the *message*: a
     * constraint violation surfaces as "the record changed", which tells
     * somebody editing a cycle nothing about which row is wrong.
     */
    const administrator = await signIn(['SUPER_ADMIN'])

    const repeated = await cycleRefusedFor(administrator.cookie, {
      identifierRules: [
        { kind: 'ST_CERTIFICATE', requirement: 'OPTIONAL',
          duplicatePolicy: 'NOT_CHECKED', checkType: null },
        { kind: 'ST_CERTIFICATE', requirement: 'OFF',
          duplicatePolicy: 'NOT_CHECKED', checkType: null },
      ],
    })
    expect(repeated).toBe('Cycle policy entries must be unique.')

    // Demanded on a passing check, but never says which check.
    const noCheck = await cycleRefusedFor(administrator.cookie, {
      identifierRules: [
        { kind: 'ST_CERTIFICATE', requirement: 'REQUIRED_ON_PASS',
          duplicatePolicy: 'CHECKED', checkType: null },
      ],
    })
    expect(noCheck).toContain('must name that check')

    // Names a check, but is not the requirement that has a moment to apply at.
    const strayCheck = await cycleRefusedFor(administrator.cookie, {
      identifierRules: [
        { kind: 'ST_CERTIFICATE', requirement: 'OPTIONAL',
          duplicatePolicy: 'CHECKED', checkType: 'ST_ELIGIBILITY' },
      ],
    })
    expect(strayCheck).toContain('no other may name one')
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

describe('the approval and sanction notification emails', () => {
  /*
   * The road to a decision — desk review, bank, TTM — is proven at length in
   * the lifecycle test above. These fixtures move the head straight to the
   * status each mutation requires, because what is under test here is only
   * what the mutation sends afterwards.
   */
  const awaitingDecision = async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const applicant = await signIn(['APPLICANT'])
    const cycle = await openCycle(officer.cookie)
    const submitted = await submittedApplication(
      applicant.cookie, applicant.userId, cycle.id,
    )
    await env.DB.prepare(
      "UPDATE seb_application SET status = 'AWAITING_DECISION' WHERE id = ?",
    ).bind(submitted.applicationId).run()
    return { officer, applicant, submitted }
  }

  type DevEmail = {
    to: string
    subject: string
    text: string
    attachments?: { filename: string; bytes: number; content?: unknown }[]
  }

  /** Runs one act with the console watched, and returns the mail it printed. */
  const mailedBy = async <T>(act: () => Promise<T>): Promise<{ result: T; mails: DevEmail[] }> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const result = await act()
    const mails = log.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('DEV_EMAIL '))
      .map((line) => JSON.parse(line.slice('DEV_EMAIL '.length)) as DevEmail)
    log.mockRestore()
    return { result, mails }
  }

  const APPROVE = (applicationId: string, expectedStatusVersion: number) =>
    `mutation { admin { decision { recordDecision(input: {
      applicationId: "${applicationId}", expectedStatusVersion: ${expectedStatusVersion},
      outcome: APPROVED, decisionReference: "TTM/APPROVE/1", decisionDate: "2026-06-19",
      approvedAmountPaise: "900000",
      applicantMessage: "TTM approved the application.", revisions: []
    }) { success message response { decisions { id } } } } } }`

  const SANCTION = (applicationId: string, decisionId: string, expectedStatusVersion: number) =>
    `mutation { admin { funding { createAward(input: {
      applicationId: "${applicationId}", decisionId: "${decisionId}",
      expectedStatusVersion: ${expectedStatusVersion},
      sanctionOrderNumber: "SANCTION-ORDER-77", sanctionDate: "2026-06-20"
    }) { success message response { award { id } } } } } }`

  it('mails the applicant on approval, with the application attached', async () => {
    const { officer, applicant, submitted } = await awaitingDecision()
    const { result, mails } = await mailedBy(() => graphql<any>(
      APPROVE(submitted.applicationId, submitted.statusVersion), {}, officer.cookie,
    ))
    const decided = result.data.admin.decision.recordDecision
    expect(decided.success, decided.message).toBe(true)

    const mail = mails.find(
      (each) => each.subject === 'Your Mission SEP application has been approved',
    )
    expect(mail).toBeDefined()
    expect(mail?.to).toBe(`${applicant.userId}@example.test`)
    // The message the officer wrote for the applicant is the message sent.
    expect(mail?.text).toContain('TTM approved the application.')
    expect(mail?.attachments).toHaveLength(1)
    const attachment = mail!.attachments![0]!
    expect(attachment.filename).toMatch(/^application-SEP-\d{4}-[0-9A-HJKMNP-TV-Z]{8}\.pdf$/u)
    expect(attachment.bytes).toBeGreaterThan(0)
    expect(attachment).not.toHaveProperty('content')
  })

  it('mails the applicant when funding is sanctioned, naming the order', async () => {
    const { officer, applicant, submitted } = await awaitingDecision()
    const approved = await graphql<any>(
      APPROVE(submitted.applicationId, submitted.statusVersion), {}, officer.cookie,
    )
    expect(approved.data.admin.decision.recordDecision.success).toBe(true)
    const decisionId = approved.data.admin.decision.recordDecision.response.decisions[0].id as string

    const { result, mails } = await mailedBy(() => graphql<any>(
      SANCTION(submitted.applicationId, decisionId, submitted.statusVersion + 1),
      {}, officer.cookie,
    ))
    const sanctioned = result.data.admin.funding.createAward
    expect(sanctioned.success, sanctioned.message).toBe(true)

    const mail = mails.find(
      (each) => each.subject === 'Your Mission SEP funding has been sanctioned',
    )
    expect(mail).toBeDefined()
    expect(mail?.to).toBe(`${applicant.userId}@example.test`)
    // The order number is what the applicant will be asked for at the bank.
    expect(mail?.text).toContain('SANCTION-ORDER-77')
    expect(mail?.attachments).toHaveLength(1)
    expect(mail!.attachments![0]!.bytes).toBeGreaterThan(0)
  })

  const undelivered = async <T>(act: () => Promise<T>): Promise<T> => {
    // The console transport is the wire in a test environment, so making it
    // throw is a real delivery failure rather than a mocked one.
    const failing = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('the transport is down')
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      return await act()
    } finally {
      failing.mockRestore()
      errorLog.mockRestore()
    }
  }

  const failures = async (action: string, entityId: string) =>
    (await env.DB.prepare(
      `SELECT count(*)::int AS count FROM core_audit_event
        WHERE action = ? AND outcome = 'FAILURE' AND entity_id = ?`,
    ).bind(action, entityId).first<{ count: number }>())?.count

  it('still records the approval when the mail fails, and audits the failure', async () => {
    const { officer, submitted } = await awaitingDecision()
    const approved = await undelivered(() => graphql<any>(
      APPROVE(submitted.applicationId, submitted.statusVersion), {}, officer.cookie,
    ))
    // The decision stands: a mail failure must not undo or hide it.
    expect(approved.data.admin.decision.recordDecision.success).toBe(true)
    expect(await failures(
      auditActions.approvalNotificationFailed, submitted.applicationId,
    )).toBe(1)
  })

  it('still creates the award when the mail fails, and audits the failure', async () => {
    const { officer, submitted } = await awaitingDecision()
    const approved = await graphql<any>(
      APPROVE(submitted.applicationId, submitted.statusVersion), {}, officer.cookie,
    )
    const decisionId = approved.data.admin.decision.recordDecision.response.decisions[0].id as string
    const sanctioned = await undelivered(() => graphql<any>(
      SANCTION(submitted.applicationId, decisionId, submitted.statusVersion + 1),
      {}, officer.cookie,
    ))
    expect(sanctioned.data.admin.funding.createAward.success).toBe(true)
    expect(await failures(
      auditActions.sanctionNotificationFailed, submitted.applicationId,
    )).toBe(1)
  })
})

describe('the analytic queue filters', () => {
  const QUEUE = `query($input: AdminIntakeQueueInput) {
    admin { intake { queue(input: $input) {
      success message
      response { nodes { id } pageInfo { totalCount } }
    } } }
  }`

  const idsFor = async (cookie: string, input: Record<string, unknown>) => {
    const body = await graphql<any>(QUEUE, { input: { first: 50, ...input } }, cookie)
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    const page = body.data.admin.intake.queue
    expect(page.success, page.message ?? '').toBe(true)
    return new Set<string>(page.response.nodes.map((node: { id: string }) => node.id))
  }

  it('narrows by every multi-value dimension, superseding the single filters', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycleOne = await openCycle(administrator.cookie)
    const cycleTwo = await openCycle(administrator.cookie)
    const established = await submittedProfile({
      cycleId: cycleOne.id,
      enterprise: {
        establishmentDate: '2020-01-01',
        businessSector: 'INFORMATION_TECHNOLOGY',
        businessDistrict: 'DHALAI',
        registrationType: 'LLP',
        registrationNumber: `LLP-${crypto.randomUUID().slice(0, 8)}`,
      },
      requestedPaise: 5_000_000,
    })
    const young = await submittedProfile({
      cycleId: cycleOne.id,
      enterprise: { businessSector: 'FOOD_PROCESSING', businessDistrict: 'WEST_TRIPURA' },
      requestedPaise: 10_000_000,
    })
    const otherCycle = await submittedProfile({
      cycleId: cycleTwo.id,
      enterprise: { businessSector: 'FOOD_PROCESSING', businessDistrict: 'GOMATI' },
      requestedPaise: 20_000_000,
    })

    expect(await idsFor(administrator.cookie, { categories: ['CATEGORY_A'] }))
      .toEqual(new Set([established.applicationId]))
    // The plural supersedes the single, so a client migrating filter by filter
    // cannot have the two intersected behind its back.
    expect(await idsFor(administrator.cookie, {
      category: 'CATEGORY_B', categories: ['CATEGORY_A'],
    })).toEqual(new Set([established.applicationId]))
    expect(await idsFor(administrator.cookie, {
      sector: 'INFORMATION_TECHNOLOGY', sectors: ['FOOD_PROCESSING'],
    })).toEqual(new Set([young.applicationId, otherCycle.applicationId]))
    expect(await idsFor(administrator.cookie, { districts: ['DHALAI', 'GOMATI'] }))
      .toEqual(new Set([established.applicationId, otherCycle.applicationId]))
    expect(await idsFor(administrator.cookie, { registrationTypes: ['LLP'] }))
      .toEqual(new Set([established.applicationId]))
    expect(await idsFor(administrator.cookie, {
      cycleId: cycleOne.id, cycleIds: [cycleTwo.id],
    })).toEqual(new Set([otherCycle.applicationId]))
    expect(await idsFor(administrator.cookie, { statuses: ['SUBMITTED', 'DESK_REVIEW'] }))
      .toEqual(new Set([
        established.applicationId, young.applicationId, otherCycle.applicationId,
      ]))
    expect(await idsFor(administrator.cookie, { statuses: ['DESK_REVIEW'] }))
      .toEqual(new Set())
    // An empty list is no filter at all, not a filter matching nothing.
    expect((await idsFor(administrator.cookie, { categories: [] })).size).toBe(3)
  })

  it('bounds the requested amount inclusively and the decision date by its range', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const smaller = await submittedProfile({
      cycleId: cycle.id, requestedPaise: 5_000_000,
    })
    const larger = await submittedProfile({
      cycleId: cycle.id, requestedPaise: 10_000_000,
    })

    // Inclusive at both ends: a bound equal to the answer still matches it.
    expect(await idsFor(administrator.cookie, { requestedMinPaise: 10_000_000 }))
      .toEqual(new Set([larger.applicationId]))
    expect(await idsFor(administrator.cookie, { requestedMaxPaise: 5_000_000 }))
      .toEqual(new Set([smaller.applicationId]))
    expect(await idsFor(administrator.cookie, {
      requestedMinPaise: 5_000_000, requestedMaxPaise: 10_000_000,
    })).toEqual(new Set([smaller.applicationId, larger.applicationId]))
    expect(await idsFor(administrator.cookie, {
      requestedMinPaise: 5_000_001, requestedMaxPaise: 9_999_999,
    })).toEqual(new Set())

    /*
     * A corrupt answer must narrow to nothing rather than fail the whole
     * queue: the regex guard keeps the cast off non-numeric rows.
     */
    await env.DB.prepare(`UPDATE seb_application_version_answer
      SET value_text = 'not-a-number' WHERE field_key = 'SEED_FUND_REQUESTED_PAISE'
      AND application_version_id IN (
        SELECT id FROM seb_application_version WHERE application_id = ?
      )`).bind(smaller.applicationId).run()
    expect(await idsFor(administrator.cookie, { requestedMinPaise: 1 }))
      .toEqual(new Set([larger.applicationId]))

    await seededDecision({
      applicationId: larger.applicationId,
      submissionId: larger.submissionId,
      recordedByUserId: administrator.userId,
      decidedAt: new Date(),
    })
    expect(await idsFor(administrator.cookie, {
      decidedFrom: new Date(Date.now() - 60_000).toISOString(),
      decidedTo: new Date(Date.now() + 60_000).toISOString(),
    })).toEqual(new Set([larger.applicationId]))
    expect(await idsFor(administrator.cookie, { decidedFrom: '2030-01-01T00:00:00Z' }))
      .toEqual(new Set())
    expect(await idsFor(administrator.cookie, { decidedTo: '2000-01-01T00:00:00Z' }))
      .toEqual(new Set())

    // The refusals, so an impossible range is named rather than answered empty.
    for (const [input, message] of [
      [{ requestedMinPaise: 200, requestedMaxPaise: 100 },
        'The requested amount range is invalid.'],
      [{ decidedFrom: '2026-02-01T00:00:00Z', decidedTo: '2026-01-01T00:00:00Z' },
        'The decision date range is invalid.'],
    ] as const) {
      const refused = await graphql<any>(QUEUE, { input }, administrator.cookie)
      expect(refused.data.admin.intake.queue, JSON.stringify(input))
        .toMatchObject({ success: false, message })
    }
  })
})
