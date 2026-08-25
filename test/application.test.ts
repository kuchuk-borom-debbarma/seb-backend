import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/db'
import { createLoaders } from '../src/loaders'
import { auditActions } from '../src/db/schema'
import {
  cleanupExpiredDocumentUploads,
  finalizeDocumentUpload,
  issueDocumentUpload,
  myApplications,
  softDeleteApplicationDocument,
} from '../src/services/application'
import {
  findApplicationVersion,
  findEnterpriseApplicationSource,
  evaluateExpansionEligibility,
  expansionClaimFromAward,
  findExpansionAwardForApplication,
  findLatestSubmittedVersion,
  findOwnedApplicationHead,
  insertApplicationAggregate,
  listApplicationTimeline,
  loadOwnedApplication,
  saveApplicationSnapshot,
  setApplicationDeleted,
  submitApplicationSnapshot,
} from '../src/services/application/queries/application'
import {
  finalizeUploadIntent,
  findOwnedUploadIntent,
  insertUploadIntent,
  setDocumentDeleted,
} from '../src/services/application/queries/document'
import { setEnterpriseDeleted } from '../src/services/application/queries/enterprise'
import { auditRecord } from '../src/services/application/support'
import { MAX_DOCUMENT_BYTES } from '../src/services/application/uploads'
import { requiredDocumentTypesForSnapshot } from '../src/services/application/validation'
import type {
  ApplicationDraftInput,
  EnterpriseProfileInput,
} from '../src/services/application/types'
import { sessionTokenDigest } from '../src/services/auth/crypto'

type GraphQLResponse<T> = { data?: T; errors?: Array<{ message: string }> }

const graphql = async <T>(
  query: string,
  variables: Record<string, unknown> = {},
  cookie?: string,
): Promise<GraphQLResponse<T>> => {
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
  return response.json() as Promise<GraphQLResponse<T>>
}

const applicantSession = async () => {
  const userId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = Date.now()
  const digest = await sessionTokenDigest(env.AUTH_SECRET, token)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_user (
        id, email, password_hash, email_verified_at, row_version, created_at, updated_at
      ) VALUES (?, ?, 'unused', ?, 1, ?, ?)`,
    ).bind(userId, `${userId}@example.test`, now, now, now),
    env.DB.prepare(
      `INSERT INTO core_user_role_grant (
        id, user_id, role, grant_reason, granted_at
      ) VALUES (?, ?, 'APPLICANT', 'TEST_FIXTURE', ?)`,
    ).bind(crypto.randomUUID(), userId, now),
    env.DB.prepare(
      `INSERT INTO core_session (
        id, user_id, token_digest, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, digest, now + 86_400_000, now, now),
  ])
  return { userId, cookie: `seb_session=${token}` }
}

const directContext = (cookie: string) => ({
  db: createDatabase(env.DB), loaders: createLoaders(createDatabase(env.DB)),
  env,
  requestHeaders: new Headers({ cookie }),
  requestUrl: 'https://api.example.test/graphql',
  responseHeaders: new Headers(),
})

const insertOpenCycle = async (actorUserId: string) => {
  const id = crypto.randomUUID()
  const code = `SEP-${id}`
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle (
        id, cycle_code, display_name, cycle_year, status, current_version, opens_at, closes_at,
        created_at, updated_at
      ) VALUES (?, ?, 'Mission SEP Test Cycle', 2026, 'OPEN', 1, ?, ?, ?, ?)`,
    ).bind(id, code, now - 1_000, now + 86_400_000, now, now),
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle_version (
        id, programme_cycle_id, version, cycle_code, display_name, cycle_year, status,
        opens_at, closes_at, change_type, changed_by_user_id, created_at
      ) VALUES (?, ?, 1, ?, 'Mission SEP Test Cycle', 2026, 'OPEN', ?, ?, 'CREATED', ?, ?)`,
    ).bind(crypto.randomUUID(), id, code, now - 1_000, now + 86_400_000, actorUserId, now),
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle_reason (
        id, programme_cycle_id, programme_cycle_version, context, code, label, created_at
      ) VALUES (?, ?, 1, 'RELEASE_REVERSAL', 'TEST_REVERSAL', 'Test reversal', ?)`,
    ).bind(`reversal-${id}`, id, now),
  ])
  return id
}

const profile: EnterpriseProfileInput = {
  name: 'Example Tribal Foods',
  establishmentDate: '2026-01-15',
  registrationType: 'UDYAM',
  registrationNumber: 'UDYAM-TEST-1',
  gstin: null,
  businessSector: 'FOOD_PROCESSING',
  otherBusinessSector: null,
  businessBlockOrVillage: 'Khumulwng',
  businessDistrict: 'West Tripura',
  businessPinCode: '799045',
  contactNumber: '+919876543210',
  contactEmail: 'OWNER@EXAMPLE.TEST',
}

const createEnterprise = async (
  cookie: string,
  enterpriseProfile: EnterpriseProfileInput = profile,
) => {
  const response = await graphql<{
    seb: { enterprise: { create: { success: boolean; message: string | null; response: { id: string; currentVersion: number } | null } } }
  }>(
    `mutation Create($input: EnterpriseProfileInput!) {
      seb { enterprise { create(input: $input) {
        success message response { id currentVersion }
      } } }
    }`,
    { input: enterpriseProfile },
    cookie,
  )
  const result = response.data?.seb.enterprise.create
  if (!result?.success || !result.response) throw new Error(result?.message ?? 'create failed')
  return result.response
}

const startInitial = async (cookie: string, enterpriseId: string, programmeCycleId: string) => {
  const response = await graphql<{
    seb: { application: { startInitial: { success: boolean; message: string | null; response: { id: string; currentVersion: number; statusVersion: number; snapshot: { enterprise: { businessName: string } } } | null } } }
  }>(
    `mutation Start($input: StartApplicationInput!) {
      seb { application { startInitial(input: $input) {
        success message response {
          id currentVersion statusVersion snapshot { enterprise { businessName } }
        }
      } } }
    }`,
    { input: { enterpriseId, programmeCycleId } },
    cookie,
  )
  const result = response.data?.seb.application.startInitial
  if (!result?.success || !result.response) throw new Error(result?.message ?? 'start failed')
  return result.response
}

const completeDraft = {
  enterprise: {
    businessName: 'Example Tribal Foods',
    establishmentDate: '2026-01-15',
    registrationType: 'UDYAM',
    registrationNumber: 'UDYAM-TEST-1',
    gstin: null,
    businessSector: 'FOOD_PROCESSING',
    otherBusinessSector: null,
    applicationCategory: 'CATEGORY_A',
    majorityOwnershipConfirmed: true,
  },
  applicantProfile: {
    primaryApplicantName: 'Rina Debbarma',
    designation: 'PROPRIETOR',
    dateOfBirth: '1995-02-10',
    gender: 'FEMALE',
    businessBlockOrVillage: 'Khumulwng',
    businessDistrict: 'West Tripura',
    businessPinCode: '799045',
    contactNumber: '+919876543210',
    contactEmail: 'rina@example.test',
  },
  financial: {
    totalProjectCostPaise: '50000000',
    seedFundRequestedPaise: '10000000',
    bankLoanProposedPaise: '0',
    promoterContributionPaise: '1000000',
  },
  priorFunding: {
    receivedGovernmentFunding: false,
    governmentSchemeName: null,
    governmentFundingAmountPaise: null,
    governmentFundingSanctionYear: null,
    hasExistingBankCredit: false,
    existingBankName: null,
    existingCreditAmountPaise: null,
    existingCreditStatus: null,
  },
  documents: { nocRequired: false },
  declaration: {
    relationshipType: 'DAUGHTER_OF',
    relatedPersonName: 'Maya Debbarma',
    declarationAccepted: true,
    declarationPlace: 'Agartala',
  },
}

/** The GraphQL money scalar accepts strings, while persistence uses exact numbers. */
const persistenceDraft = (): ApplicationDraftInput => {
  const draft = structuredClone(completeDraft) as unknown as ApplicationDraftInput
  draft.financial = {
    totalProjectCostPaise: 50_000_000,
    seedFundRequestedPaise: 10_000_000,
    bankLoanProposedPaise: 0,
    promoterContributionPaise: 1_000_000,
  }
  return draft
}

const saveCompleteDraft = async (
  cookie: string,
  applicationId: string,
  expectedVersion = 1,
  expectedStatusVersion = 1,
) => {
  const response = await graphql<{
    seb: { application: { saveDraft: { success: boolean; message: string | null; response: { currentVersion: number; statusVersion: number } | null } } }
  }>(
    `mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) {
        success message response { currentVersion statusVersion }
      } } }
    }`,
    {
      input: {
        applicationId,
        expectedVersion,
        expectedStatusVersion,
        draft: completeDraft,
      },
    },
    cookie,
  )
  const result = response.data?.seb.application.saveDraft
  if (!result?.success || !result.response) throw new Error(result?.message ?? 'save failed')
  return result.response
}

const insertRequiredEvidence = async (applicationId: string, userId: string) => {
  const now = Date.now()
  const types = [
    'IDENTITY_AGE_PROOF',
    'ST_CERTIFICATE',
    'ADDRESS_PROOF',
    'BUSINESS_REGISTRATION',
    'DPR',
    'BANK_DETAILS',
  ]
  for (const type of types) {
    const documentId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_application_document (
          id, application_id, document_type, current_version, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(documentId, applicationId, type, now, now),
      env.DB.prepare(
        `INSERT INTO seb_application_document_version (
          id, document_id, version, operation, r2_object_key, original_filename,
          content_type, size_bytes, checksum, uploaded_by_user_id, created_at
        ) VALUES (?, ?, 1, 'UPLOAD', ?, ?, 'application/pdf', 10, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        documentId,
        `test/${crypto.randomUUID()}`,
        `${type}.pdf`,
        'A'.repeat(43) + '=',
        userId,
        now,
      ),
    ])
  }
}

const insertActiveAward = async (
  userId: string,
  applicationId: string,
  releaseAt: number,
) => {
  const [{ fundingCaseId }] = await env.DB.prepare(
    'SELECT funding_case_id AS fundingCaseId FROM seb_application WHERE id = ?',
  ).bind(applicationId).all<{ fundingCaseId: string }>().then((result) => result.results)
  if (!fundingCaseId) throw new Error('funding case missing')
  const awardId = crypto.randomUUID()
  const order = `ORDER-${awardId}`
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE seb_application SET status = 'SANCTIONED', status_version = 2,
        updated_at = ? WHERE id = ?`,
    ).bind(now, applicationId),
    env.DB.prepare(
      `INSERT INTO seb_funding_award (
        id, funding_case_id, application_id, sanction_order_number, sanction_date,
        sanctioned_amount_paise, status, current_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '2025-01-01', 50000000, 'ACTIVE', 1, ?, ?)`,
    ).bind(awardId, fundingCaseId, applicationId, order, now, now),
    env.DB.prepare(
      `INSERT INTO seb_funding_award_version (
        id, funding_award_id, version, sanction_order_number, sanction_date,
        sanctioned_amount_paise, status, change_type, changed_by_user_id, created_at
      ) VALUES (?, ?, 1, ?, '2025-01-01', 50000000, 'ACTIVE', 'CREATED', ?, ?)`,
    ).bind(crypto.randomUUID(), awardId, order, userId, now),
    env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, amount_paise,
        occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
        bank_account_verified_at, performance_agreement_reference,
        performance_agreement_executed_at, physical_verification_required,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 1, 'RELEASE', 10000000, ?, ?, 'TTM-TEST', '2025-01-01',
        ?, 'AGREEMENT-TEST', ?, 0, 'Test release.', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      awardId,
      releaseAt,
      `RELEASE-${awardId}`,
      now,
      now,
      userId,
      now,
    ),
  ])
  return { awardId, fundingCaseId }
}

describe('applicant application business service', () => {
  it('requires authentication for every enterprise, application, and document operation', async () => {
    const operations: Array<[string, Record<string, unknown>?]> = [
      ['query { seb { enterprise { mine { success } } } }'],
      ['query { seb { enterprise { byId(id: "missing") { success } } } }'],
      [`mutation Create($input: EnterpriseProfileInput!) {
        seb { enterprise { create(input: $input) { success } } }
      }`, { input: profile }],
      [`mutation Update($input: UpdateEnterpriseInput!) {
        seb { enterprise { update(input: $input) { success } } }
      }`, { input: { id: 'missing', expectedVersion: 1, profile } }],
      ['mutation { seb { enterprise { softDelete(input: { id: "missing", expectedVersion: 1 }) { success } } } }'],
      ['mutation { seb { enterprise { restore(id: "missing", expectedVersion: 1) { success } } } }'],
      ['query { seb { application { availableProgrammeCycles { success } } } }'],
      ['query { seb { application { myProgrammeCycles { success } } } }'],
      ['query { seb { application { statusGuide { success } } } }'],
      ['query { seb { application { funding(applicationId: "missing") { success } } } }'],
      ['query { seb { application { draftChanges(applicationId: "missing") { success } } } }'],
      ['query { seb { application { mine { success } } } }'],
      ['query { seb { application { byId(id: "missing") { success } } } }'],
      ['query { seb { application { validate(applicationId: "missing") { success } } } }'],
      ['query { seb { application { expansionEligibility(enterpriseId: "missing", programmeCycleId: "missing") { success } } } }'],
      ['query { seb { application { timeline(applicationId: "missing") { success } } } }'],
      ['query { seb { application { documentDownloadUrl(documentId: "missing") { success } } } }'],
      ['mutation { seb { application { startInitial(input: { enterpriseId: "missing", programmeCycleId: "missing" }) { success } } } }'],
      ['mutation { seb { application { startExpansion(input: { enterpriseId: "missing", programmeCycleId: "missing" }) { success } } } }'],
      [`mutation Save($input: SaveApplicationDraftInput!) {
        seb { application { saveDraft(input: $input) { success } } }
      }`, { input: {
        applicationId: 'missing',
        expectedVersion: 1,
        expectedStatusVersion: 1,
        draft: completeDraft,
      } }],
      ['mutation { seb { application { softDeleteDraft(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success } } } }'],
      ['mutation { seb { application { restoreDraft(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success } } } }'],
      ['mutation { seb { application { submit(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success } } } }'],
      ['mutation { seb { application { resubmit(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success } } } }'],
      [`mutation Issue($input: IssueDocumentUploadInput!) {
        seb { application { issueDocumentUpload(input: $input) { success } } }
      }`, { input: {
        applicationId: 'missing',
        documentType: 'DPR',
        expectedDocumentVersion: 0,
        originalFilename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        checksumSha256: 'A'.repeat(43) + '=',
      } }],
      ['mutation { seb { application { finalizeDocumentUpload(uploadId: "missing") { success } } } }'],
      ['mutation { seb { application { softDeleteDocument(input: { applicationId: "missing", documentId: "missing", expectedVersion: 1 }) { success } } } }'],
      ['mutation { seb { application { restoreDocument(input: { applicationId: "missing", documentId: "missing", expectedVersion: 1 }) { success } } } }'],
    ]
    for (const [query, variables = {}] of operations) {
      const response = await graphql<Record<string, unknown>>(query, variables)
      expect(response.errors, query).toBeUndefined()
      expect(JSON.stringify(response.data), query).toContain('"success":false')
    }
  })

  it('rejects multiple SEB actions before either resolver executes', async () => {
    const response = await graphql<unknown>(`mutation {
      seb {
        enterprise {
          restore(id: "missing", expectedVersion: 1) { success }
          softDelete(input: { id: "missing", expectedVersion: 1 }) { success }
        }
      }
    }`)
    expect(response.data).toBeUndefined()
    expect(response.errors?.map((error) => error.message)).toContain(
      'Only one action may be selected beneath mutation.seb.',
    )

    const fragments = await graphql<unknown>(`mutation {
      seb {
        __typename
        ...EnterpriseAction
        ... on SebMutation {
          application { finalizeDocumentUpload(uploadId: "missing") { success } }
        }
      }
    }
    fragment EnterpriseAction on SebMutation {
      enterprise { restore(id: "missing", expectedVersion: 1) { success } }
    }`)
    expect(fragments.data).toBeUndefined()
    expect(fragments.errors?.map((error) => error.message)).toContain(
      'Only one action may be selected beneath mutation.seb.',
    )

    const recursive = await graphql<unknown>(`mutation {
      seb { ...RecursiveSeb }
    }
    fragment RecursiveSeb on SebMutation {
      ...RecursiveSeb
      enterprise { restore(id: "missing", expectedVersion: 1) { success } }
    }`)
    expect(recursive.errors?.length).toBeGreaterThan(0)
  })

  it('requires an applicant session and never exposes another owner’s enterprise', async () => {
    const first = await applicantSession()
    const second = await applicantSession()
    const enterprise = await createEnterprise(first.cookie)
    const cycleId = await insertOpenCycle(first.userId)
    await startInitial(first.cookie, enterprise.id, cycleId)
    const signedOut = await graphql<{ seb: { enterprise: { byId: { success: boolean } } } }>(
      `query { seb { enterprise { byId(id: "${enterprise.id}") { success } } } }`,
    )
    expect(signedOut.data?.seb.enterprise.byId.success).toBe(false)
    const other = await graphql<{ seb: { enterprise: { byId: { success: boolean; response: unknown } } } }>(
      `query { seb { enterprise { byId(id: "${enterprise.id}") { success response { id } } } } }`,
      {},
      second.cookie,
    )
    expect(other.data?.seb.enterprise.byId).toEqual({ success: false, response: null })
    const deleteOther = await graphql<{
      seb: { enterprise: { softDelete: { success: boolean; message: string | null; response: unknown } } }
    }>(`mutation { seb { enterprise { softDelete(input: {
      id: "${enterprise.id}", expectedVersion: 1
    }) { success message response { id } } } } }`, {}, second.cookie)
    const deleteMissing = await graphql<{
      seb: { enterprise: { softDelete: { success: boolean; message: string | null; response: unknown } } }
    }>(`mutation { seb { enterprise { softDelete(input: {
      id: "missing", expectedVersion: 1
    }) { success message response { id } } } } }`, {}, second.cookie)
    expect(deleteOther.data?.seb.enterprise.softDelete)
      .toEqual(deleteMissing.data?.seb.enterprise.softDelete)
    const emptyLists = await graphql<{
      seb: {
        enterprise: { mine: { response: { pageInfo: { endCursor: string | null } } } }
        application: { mine: { response: { pageInfo: { endCursor: string | null } } } }
      }
    }>(`query { seb {
      enterprise { mine { response { pageInfo { endCursor } } } }
      application { mine { response { pageInfo { endCursor } } } }
    } }`, {}, second.cookie)
    expect(emptyLists.data?.seb.enterprise.mine.response.pageInfo.endCursor).toBeNull()
    expect(emptyLists.data?.seb.application.mine.response.pageInfo.endCursor).toBeNull()
  })

  it('returns safe failures for missing IDs, stale versions, invalid pages, and blocked lifecycle changes', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const operations = [
      'query { seb { enterprise { mine(first: 0) { success response { nodes { id } } } } } }',
      'query { seb { enterprise { byId(id: "missing") { success response { id } } } } }',
      `mutation Update($profile: EnterpriseProfileInput!) { seb { enterprise {
        update(input: { id: "${enterprise.id}", expectedVersion: 0, profile: $profile }) {
          success response { id }
        }
      } } }`,
      'mutation { seb { enterprise { softDelete(input: { id: "missing", expectedVersion: 1 }) { success response { id } } } } }',
      'query { seb { application { mine(first: 101) { success response { nodes { id } } } } } }',
      'query { seb { application { byId(id: "missing") { success response { id } } } } }',
      'query { seb { application { validate(applicationId: "missing") { success response { valid } } } } }',
      'query { seb { application { expansionEligibility(enterpriseId: "missing", programmeCycleId: "missing") { success response { eligible } } } } }',
      'mutation { seb { application { startInitial(input: { enterpriseId: "missing", programmeCycleId: "missing" }) { success response { id } } } } }',
      'mutation { seb { application { softDeleteDraft(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success response { id } } } } }',
      'mutation { seb { application { restoreDraft(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success response { id } } } } }',
      'mutation { seb { application { submit(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success response { id } } } } }',
      'mutation { seb { application { resubmit(input: { applicationId: "missing", expectedVersion: 1, expectedStatusVersion: 1 }) { success response { id } } } } }',
      'query { seb { application { timeline(applicationId: "missing") { success response { nodes { id } } } } } }',
      'query { seb { application { documentDownloadUrl(documentId: "missing") { success response { downloadUrl } } } } }',
      'mutation { seb { application { finalizeDocumentUpload(uploadId: "missing") { success response { documentId } } } } }',
      `mutation { seb { application { softDeleteDocument(input: {
        applicationId: "${application.id}", documentId: "missing", expectedVersion: 1
      }) { success response { value } } } } }`,
    ]
    for (const query of operations) {
      const variables = query.includes('$profile') ? { profile } : {}
      const response = await graphql<Record<string, unknown>>(query, variables, applicant.cookie)
      expect(response.errors, query).toBeUndefined()
      expect(JSON.stringify(response.data), query).toContain('"success":false')
    }

    const blockedEnterprise = await graphql<{
      seb: { enterprise: { softDelete: { success: boolean; response: unknown } } }
    }>(`mutation { seb { enterprise { softDelete(input: {
      id: "${enterprise.id}", expectedVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(blockedEnterprise.data?.seb.enterprise.softDelete).toEqual({ success: false, response: null })

    const duplicate = await graphql<{
      seb: { application: { startInitial: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { startInitial(input: {
      enterpriseId: "${enterprise.id}", programmeCycleId: "${cycleId}"
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(duplicate.data?.seb.application.startInitial).toEqual({ success: false, response: null })

    const incomplete = await graphql<{
      seb: { application: { submit: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { submit(input: {
      applicationId: "${application.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(incomplete.data?.seb.application.submit).toEqual({ success: false, response: null })

    await env.DB.prepare(
      `UPDATE seb_programme_cycle SET status = 'CLOSED', closes_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(Date.now() - 1, Date.now(), cycleId).run()
    const submitAfterCycleClose = await graphql<{
      seb: { application: { submit: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { submit(input: {
      applicationId: "${application.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(submitAfterCycleClose.data?.seb.application.submit)
      .toEqual({ success: false, response: null })

    const invalidCreate = await graphql<{
      seb: { enterprise: { create: { success: boolean; response: unknown } } }
    }>(`mutation Create($input: EnterpriseProfileInput!) {
      seb { enterprise { create(input: $input) { success response { id } } }
    } }`, { input: { ...profile, name: ' ' } }, applicant.cookie)
    expect(invalidCreate.data?.seb.enterprise.create).toEqual({ success: false, response: null })

    const invalidSave = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { id } } }
    } }`, { input: {
      applicationId: application.id,
      expectedVersion: 0,
      expectedStatusVersion: 1,
      draft: completeDraft,
    } }, applicant.cookie)
    expect(invalidSave.data?.seb.application.saveDraft).toEqual({ success: false, response: null })

    const missingSave = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { id } } }
    } }`, { input: {
      applicationId: 'missing',
      expectedVersion: 1,
      expectedStatusVersion: 1,
      draft: completeDraft,
    } }, applicant.cookie)
    expect(missingSave.data?.seb.application.saveDraft).toEqual({ success: false, response: null })

    for (const operation of ['softDeleteDraft', 'restoreDraft', 'submit'] as const) {
      const response = await graphql<Record<string, unknown>>(`mutation { seb { application {
        ${operation}(input: {
          applicationId: "${application.id}", expectedVersion: 0, expectedStatusVersion: 1
        }) { success response { id } }
      } } }`, {}, applicant.cookie)
      expect(JSON.stringify(response.data), operation).toContain('"success":false')
    }

    const invalidEnterpriseDelete = await graphql<Record<string, unknown>>(`mutation { seb {
      enterprise { softDelete(input: { id: "${enterprise.id}", expectedVersion: 0 }) {
        success response { id }
      } }
    } }`, {}, applicant.cookie)
    expect(JSON.stringify(invalidEnterpriseDelete.data)).toContain('"success":false')

    const malformedDraft = structuredClone(completeDraft)
    malformedDraft.applicantProfile.contactEmail = 'invalid-email'
    const malformedSave = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { id } } }
    } }`, { input: {
      applicationId: application.id,
      expectedVersion: 1,
      expectedStatusVersion: 1,
      draft: malformedDraft,
    } }, applicant.cookie)
    expect(malformedSave.data?.seb.application.saveDraft).toEqual({ success: false, response: null })

    const noAwardCycle = await insertOpenCycle(applicant.userId)
    const noAwardExpansion = await graphql<{
      seb: { application: { startExpansion: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { startExpansion(input: {
      enterpriseId: "${enterprise.id}", programmeCycleId: "${noAwardCycle}"
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(noAwardExpansion.data?.seb.application.startExpansion).toEqual({ success: false, response: null })

    const invalidTimeline = await graphql<{
      seb: { application: { timeline: { success: boolean; response: unknown } } }
    }>(`query { seb { application { timeline(applicationId: "${application.id}", first: 0) {
      success response { nodes { id } }
    } } } }`, {}, applicant.cookie)
    expect(invalidTimeline.data?.seb.application.timeline).toEqual({ success: false, response: null })

    const closedCycle = await insertOpenCycle(applicant.userId)
    await env.DB.prepare(
      `UPDATE seb_programme_cycle SET status = 'CLOSED', closes_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(Date.now() - 1, Date.now(), closedCycle).run()
    const freshEnterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Closed Cycle Enterprise',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const closedStart = await graphql<{
      seb: { application: { startInitial: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { startInitial(input: {
      enterpriseId: "${freshEnterprise.id}", programmeCycleId: "${closedCycle}"
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(closedStart.data?.seb.application.startInitial).toEqual({ success: false, response: null })
    const closedEligibility = await graphql<{
      seb: { application: { expansionEligibility: { success: boolean; response: unknown } } }
    }>(`query { seb { application { expansionEligibility(
      enterpriseId: "${freshEnterprise.id}", programmeCycleId: "${closedCycle}"
    ) { success response { eligible } } } } }`, {}, applicant.cookie)
    expect(closedEligibility.data?.seb.application.expansionEligibility)
      .toEqual({ success: false, response: null })

    expect(await myApplications(
      { status: 'NOT_A_STATUS' as never },
      directContext(applicant.cookie),
    )).toEqual({
      success: false,
      message: 'Select a valid application status.',
      response: null,
    })
    expect(await issueDocumentUpload({
      applicationId: application.id,
      documentType: 'NOT_A_DOCUMENT' as never,
      expectedDocumentVersion: 0,
      originalFilename: 'file.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    }, directContext(applicant.cookie))).toEqual({
      success: false,
      message: 'Select a valid document type.',
      response: null,
    })
    expect(await softDeleteApplicationDocument({
      applicationId: 'missing',
      documentId: 'missing',
      expectedVersion: 1,
    }, directContext(applicant.cookie))).toMatchObject({
      success: false,
      response: null,
      message: 'The application was not found.',
    })
    const db = createDatabase(env.DB)
    expect(await findApplicationVersion(db, 'missing', 1)).toBeNull()
    expect(await findLatestSubmittedVersion(db, 'missing')).toBeNull()
    expect((await listApplicationTimeline(db, {
      applicationId: 'missing',
      first: 1,
      cursor: null,
    })).pageInfo.endCursor).toBeNull()
    expect((await listApplicationTimeline(db, {
      applicationId: 'missing',
      first: 1,
      cursor: { timestamp: new Date(0), id: 'cursor-id' },
    })).nodes).toEqual([])

    const head = await findOwnedApplicationHead(db, applicant.userId, application.id)
    if (!head) throw new Error('application head missing')
    const now = new Date()
    expect(await setApplicationDeleted(db, {
      head: { ...head, applicationType: 'EXPANSION' },
      userId: applicant.userId,
      deleted: true,
      reason: 'GUARD_TEST',
      now,
      audit: auditRecord(directContext(applicant.cookie), {
        actorUserId: applicant.userId,
        action: auditActions.applicationDeleted,
        entityType: 'SEB_APPLICATION',
        entityId: application.id,
        now,
      }),
    })).toBe(false)
  })

  it('accepts a profile that omits optional fields instead of sending explicit nulls', async () => {
    const applicant = await applicantSession()

    // GraphQL drops absent nullable inputs rather than passing null, so every
    // optional field arrives here as undefined. Only name and registrationType
    // are non-null in the schema.
    const created = await graphql<{
      seb: {
        enterprise: {
          create: {
            success: boolean
            message: string | null
            response: {
              id: string
              businessSector: string | null
              establishmentDate: string | null
              contactEmail: string | null
            } | null
          }
        }
      }
    }>(
      `mutation Create($input: EnterpriseProfileInput!) {
        seb { enterprise { create(input: $input) {
          success message
          response { id businessSector establishmentDate contactEmail }
        } } }
      }`,
      { input: { name: 'Minimal Enterprise', registrationType: 'NONE' } },
      applicant.cookie,
    )

    expect(created.errors).toBeUndefined()
    expect(created.data?.seb.enterprise.create).toMatchObject({
      success: true,
      message: null,
      response: {
        businessSector: null,
        establishmentDate: null,
        contactEmail: null,
      },
    })

    // The same omission must survive an update, which normalizes the profile
    // through the identical path.
    const enterpriseId = created.data?.seb.enterprise.create.response?.id
    const updated = await graphql<{
      seb: {
        enterprise: {
          update: {
            success: boolean
            message: string | null
            response: { currentVersion: number; businessSector: string | null } | null
          }
        }
      }
    }>(
      `mutation Update($input: UpdateEnterpriseInput!) {
        seb { enterprise { update(input: $input) {
          success message response { currentVersion businessSector }
        } } }
      }`,
      {
        input: {
          id: enterpriseId,
          expectedVersion: 1,
          profile: { name: 'Minimal Enterprise Renamed', registrationType: 'NONE' },
        },
      },
      applicant.cookie,
    )
    expect(updated.errors).toBeUndefined()
    expect(updated.data?.seb.enterprise.update).toMatchObject({
      success: true,
      response: { currentVersion: 2, businessSector: null },
    })
  })

  it('creates and versions a canonical enterprise without changing an application snapshot', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    expect(application.snapshot.enterprise.businessName).toBe(profile.name)

    const updatedProfile = { ...profile, name: 'Renamed Tribal Foods' }
    const update = await graphql<{
      seb: { enterprise: { update: { success: boolean; response: { currentVersion: number; name: string } | null } } }
    }>(
      `mutation Update($input: UpdateEnterpriseInput!) {
        seb { enterprise { update(input: $input) { success response { currentVersion name } } } }
      }`,
      { input: { id: enterprise.id, expectedVersion: 1, profile: updatedProfile } },
      applicant.cookie,
    )
    expect(update.data?.seb.enterprise.update.response).toEqual({
      currentVersion: 2,
      name: updatedProfile.name,
    })
    const proposedUpdate = await graphql<{
      seb: { enterprise: { update: { response: { currentVersion: number; status: string } | null } } }
    }>(`mutation Update($input: UpdateEnterpriseInput!) {
      seb { enterprise { update(input: $input) { response { currentVersion status } } } }
    }`, { input: {
      id: enterprise.id,
      expectedVersion: 2,
      profile: { ...updatedProfile, establishmentDate: null },
    } }, applicant.cookie)
    expect(proposedUpdate.data?.seb.enterprise.update.response)
      .toEqual({ currentVersion: 3, status: 'PROPOSED' })
    const ownEnterprise = await graphql<{
      seb: { enterprise: { byId: { success: boolean; response: { id: string } | null } } }
    }>(`query { seb { enterprise { byId(id: "${enterprise.id}") {
      success response { id }
    } } } }`, {}, applicant.cookie)
    expect(ownEnterprise.data?.seb.enterprise.byId)
      .toEqual({ success: true, response: { id: enterprise.id } })

    const proposed = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Proposed Enterprise',
      establishmentDate: null,
      contactEmail: null,
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    expect(await env.DB.prepare(
      'SELECT status FROM seb_enterprise WHERE id = ?',
    ).bind(proposed.id).first()).toEqual({ status: 'PROPOSED' })
    const proposedApplication = await startInitial(applicant.cookie, proposed.id, cycleId)
    expect(proposedApplication.snapshot.enterprise.businessName).toBe('Proposed Enterprise')
    const read = await graphql<{
      seb: { application: { byId: { response: { snapshot: { enterprise: { businessName: string } } } } } }
    }>(
      `query { seb { application { byId(id: "${application.id}") {
        response { snapshot { enterprise { businessName } } }
      } } } }`,
      {},
      applicant.cookie,
    )
    expect(read.data?.seb.application.byId.response.snapshot.enterprise.businessName).toBe(profile.name)
  })

  it('rechecks lifecycle and document predicates inside atomic D1 writes', async () => {
    const applicant = await applicantSession()
    const db = createDatabase(env.DB)
    const context = directContext(applicant.cookie)

    // Simulate the cycle reaching its exclusive closing instant after the
    // controller read it but before the aggregate reaches its guarded batch.
    const staleCycleId = await insertOpenCycle(applicant.userId)
    const staleEnterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Cycle Race Enterprise',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const staleSource = await findEnterpriseApplicationSource(
      db,
      applicant.userId,
      staleEnterprise.id,
    )
    if (!staleSource) throw new Error('stale application source missing')
    const staleNow = new Date()
    await env.DB.prepare(
      'UPDATE seb_programme_cycle SET closes_at = ?, updated_at = ? WHERE id = ?',
    ).bind(staleNow.getTime(), staleNow.getTime(), staleCycleId).run()
    const staleApplicationId = crypto.randomUUID()
    expect(await insertApplicationAggregate(db, {
      applicationId: staleApplicationId,
      applicantUserId: applicant.userId,
      enterpriseId: staleSource.enterprise.id,
      fundingCaseId: staleSource.fundingCase.id,
      programmeCycleId: staleCycleId,
      programmeCycleVersion: 1,
      applicationType: 'INITIAL',
      phaseNumber: 1,
      draft: persistenceDraft(),
      expansionClaim: {
        priorSanctionOrderNumber: null,
        priorSanctionDate: null,
        priorNetDisbursedAmountPaise: null,
        continuousOperationMonths: null,
      },
      now: staleNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.applicationStarted,
        entityType: 'SEB_APPLICATION',
        entityId: staleApplicationId,
        now: staleNow,
      }),
    })).toBe(false)
    expect(await env.DB.prepare(
      'SELECT id FROM seb_application WHERE id = ?',
    ).bind(staleApplicationId).first()).toBeNull()

    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Document Race Enterprise',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const saved = await saveCompleteDraft(applicant.cookie, application.id)
    await insertRequiredEvidence(application.id, applicant.userId)
    const loaded = await loadOwnedApplication(db, applicant.userId, application.id)
    const currentVersion = await findApplicationVersion(db, application.id, saved.currentVersion)
    if (!loaded || !currentVersion) throw new Error('submission aggregate missing')

    // Removing evidence after validation must make the update-head predicate
    // fail, leaving every formal-submission row absent.
    const identityDocument = await env.DB.prepare(
      `SELECT id, current_version AS currentVersion FROM seb_application_document
       WHERE application_id = ? AND document_type = 'IDENTITY_AGE_PROOF'`,
    ).bind(application.id).first<{ id: string; currentVersion: number }>()
    if (!identityDocument) throw new Error('identity document missing')
    await env.DB.prepare(
      `UPDATE seb_application_document SET deleted_at = ?, deleted_by_user_id = ?
       WHERE id = ?`,
    ).bind(Date.now(), applicant.userId, identityDocument.id).run()
    const submitNow = new Date()
    expect(await submitApplicationSnapshot(db, {
      head: loaded,
      currentVersion,
      userId: applicant.userId,
      draft: persistenceDraft(),
      expansionClaim: {
        priorSanctionOrderNumber: null,
        priorSanctionDate: null,
        priorNetDisbursedAmountPaise: null,
        continuousOperationMonths: null,
      },
      programmeCycleVersion: currentVersion.programmeCycleVersion,
      referenceNumber: `SEP-2026-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      resubmission: false,
      // The real list, so the write repeats the check the validator made —
      // which is what this test is about.
      requiredDocumentTypes: requiredDocumentTypesForSnapshot(persistenceDraft()),
      now: submitNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.applicationSubmitted,
        entityType: 'SEB_APPLICATION',
        entityId: application.id,
        now: submitNow,
      }),
    })).toBe(false)
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM seb_application_submission WHERE application_id = ?',
    ).bind(application.id).first()).toEqual({ count: 0 })

    const issued = await issueDocumentUpload({
      applicationId: application.id,
      documentType: 'NOC',
      expectedDocumentVersion: 0,
      originalFilename: 'race-noc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    }, context)
    if (!issued.success || !issued.response) throw new Error('race upload intent missing')
    const intent = await findOwnedUploadIntent(db, applicant.userId, issued.response.uploadId)
    if (!intent) throw new Error('stored race upload intent missing')

    // Delay the status transition until the upload controller has completed
    // its friendly reads. The guarded insert must still reject the intent and
    // the controller must return a normal conflict envelope.
    const racingDb = createDatabase(env.DB)
    const originalBatch = racingDb.batch.bind(racingDb)
    racingDb.batch = (async (statements) => {
      await env.DB.prepare(
        `UPDATE seb_application SET status = 'SUBMITTED', status_version = status_version + 1,
         updated_at = ? WHERE id = ?`,
      ).bind(Date.now(), application.id).run()
      return originalBatch(statements)
    }) as typeof racingDb.batch
    const racedIssue = await issueDocumentUpload({
      applicationId: application.id,
      documentType: 'NOC',
      expectedDocumentVersion: 0,
      originalFilename: 'raced-noc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    }, { ...context, db: racingDb })
    expect(racedIssue).toEqual({
      success: false,
      message: 'The application or document changed. Refresh it and try again.',
      response: null,
    })
    const documentNow = new Date()
    const staleUploadId = crypto.randomUUID()
    expect(await insertUploadIntent(db, {
      id: staleUploadId,
      applicationId: application.id,
      applicantUserId: applicant.userId,
      documentType: 'NOC',
      expectedDocumentVersion: 0,
      objectKey: `applications/${application.id}/${staleUploadId}`,
      originalFilename: 'stale-noc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
      status: 'ISSUED',
      expiresAt: new Date(documentNow.getTime() + 600_000),
      finalizedDocumentVersionId: null,
      createdAt: documentNow,
      updatedAt: documentNow,
    }, auditRecord(context, {
      actorUserId: applicant.userId,
      action: auditActions.documentUploadIssued,
      entityType: 'SEB_DOCUMENT_UPLOAD_INTENT',
      entityId: staleUploadId,
      now: documentNow,
    }))).toBe(false)
    expect(await findOwnedUploadIntent(db, applicant.userId, staleUploadId)).toBeNull()
    expect(await finalizeUploadIntent(db, {
      intent,
      documentId: crypto.randomUUID(),
      documentVersionId: crypto.randomUUID(),
      nextVersion: 1,
      userId: applicant.userId,
      now: documentNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.documentFinalized,
        entityType: 'SEB_APPLICATION_DOCUMENT',
        entityId: crypto.randomUUID(),
        now: documentNow,
      }),
    })).toBe(false)
    expect(await setDocumentDeleted(db, {
      applicationId: application.id,
      documentId: identityDocument.id,
      expectedVersion: identityDocument.currentVersion,
      userId: applicant.userId,
      deleted: false,
      now: documentNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.documentRestored,
        entityType: 'SEB_APPLICATION_DOCUMENT',
        entityId: identityDocument.id,
        now: documentNow,
      }),
    })).toBe(false)
    expect(await setEnterpriseDeleted(db, {
      enterpriseId: enterprise.id,
      userId: applicant.userId,
      expectedVersion: 1,
      deleted: true,
      reason: 'RACE_GUARD_TEST',
      now: documentNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.enterpriseDeleted,
        entityType: 'SEB_ENTERPRISE',
        entityId: enterprise.id,
        now: documentNow,
      }),
    })).toBe(false)
  })

  it('does not let same-millisecond retries append duplicate lifecycle history', async () => {
    const applicant = await applicantSession()
    const db = createDatabase(env.DB)
    const context = directContext(applicant.cookie)
    const sameNow = new Date()

    const emptyEnterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Atomic Enterprise Transition',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const deleteEnterprise = () => setEnterpriseDeleted(db, {
      enterpriseId: emptyEnterprise.id,
      userId: applicant.userId,
      expectedVersion: 1,
      deleted: true,
      reason: 'NO_LONGER_NEEDED',
      now: sameNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.enterpriseDeleted,
        entityType: 'SEB_ENTERPRISE',
        entityId: emptyEnterprise.id,
        now: sameNow,
      }),
    })
    expect(await deleteEnterprise()).toBe(true)
    expect(await deleteEnterprise()).toBe(false)

    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Atomic Application Transition',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    await insertRequiredEvidence(application.id, applicant.userId)
    const document = await env.DB.prepare(
      `SELECT id, current_version AS currentVersion
       FROM seb_application_document
       WHERE application_id = ? AND document_type = 'ADDRESS_PROOF'`,
    ).bind(application.id).first<{ id: string; currentVersion: number }>()
    if (!document) throw new Error('atomic test document missing')
    const deleteDocument = () => setDocumentDeleted(db, {
      applicationId: application.id,
      documentId: document.id,
      expectedVersion: document.currentVersion,
      userId: applicant.userId,
      deleted: true,
      now: sameNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.documentDeleted,
        entityType: 'SEB_APPLICATION_DOCUMENT',
        entityId: document.id,
        now: sameNow,
      }),
    })
    expect(await deleteDocument()).toBe(true)
    expect(await deleteDocument()).toBe(false)

    const head = await findOwnedApplicationHead(db, applicant.userId, application.id)
    if (!head) throw new Error('atomic test application missing')
    const deleteApplication = () => setApplicationDeleted(db, {
      head,
      userId: applicant.userId,
      deleted: true,
      reason: 'NO_LONGER_NEEDED',
      now: sameNow,
      audit: auditRecord(context, {
        actorUserId: applicant.userId,
        action: auditActions.applicationDeleted,
        entityType: 'SEB_APPLICATION',
        entityId: application.id,
        now: sameNow,
      }),
    })
    expect(await deleteApplication()).toBe(true)
    expect(await deleteApplication()).toBe(false)

    const auditCounts = await env.DB.prepare(
      `SELECT entity_type AS entityType, COUNT(*) AS count
       FROM core_audit_event
       WHERE (entity_type = 'SEB_ENTERPRISE' AND entity_id = ? AND action = ?)
          OR (entity_type = 'SEB_APPLICATION_DOCUMENT' AND entity_id = ? AND action = ?)
          OR (entity_type = 'SEB_APPLICATION' AND entity_id = ? AND action = ?)
       GROUP BY entity_type
       ORDER BY entity_type`,
    ).bind(
      emptyEnterprise.id,
      auditActions.enterpriseDeleted,
      document.id,
      auditActions.documentDeleted,
      application.id,
      auditActions.applicationDeleted,
    ).all<{ entityType: string; count: number }>()
    expect(auditCounts.results).toEqual([
      { entityType: 'SEB_APPLICATION', count: 1 },
      { entityType: 'SEB_APPLICATION_DOCUMENT', count: 1 },
      { entityType: 'SEB_ENTERPRISE', count: 1 },
    ])
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM seb_application_event
       WHERE application_id = ? AND event_type IN ('DOCUMENT_DELETED', 'APPLICATION_DELETED')`,
    ).bind(application.id).first()).toEqual({ count: 2 })
  })

  it('rejects invalid, stale, and conflicting canonical enterprise updates', async () => {
    const applicant = await applicantSession()
    const first = await createEnterprise(applicant.cookie)
    const duplicateCreate = await graphql<{
      seb: { enterprise: { create: { success: boolean; response: unknown } } }
    }>(`mutation Create($input: EnterpriseProfileInput!) {
      seb { enterprise { create(input: $input) { success response { id } } }
    } }`, { input: { ...profile, name: 'Duplicate Registration' } }, applicant.cookie)
    expect(duplicateCreate.data?.seb.enterprise.create).toEqual({ success: false, response: null })
    const secondProfile = {
      ...profile,
      name: 'Second Enterprise',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    }
    const second = await createEnterprise(applicant.cookie, secondProfile)
    const update = async (input: Record<string, unknown>) => graphql<{
      seb: { enterprise: { update: { success: boolean; response: unknown } } }
    }>(`mutation Update($input: UpdateEnterpriseInput!) {
      seb { enterprise { update(input: $input) { success response { id } } }
    } }`, { input }, applicant.cookie)
    expect((await update({ id: second.id, expectedVersion: 1, profile: {
      ...secondProfile,
      registrationNumber: profile.registrationNumber,
    } })).data?.seb.enterprise.update).toEqual({ success: false, response: null })
    expect((await update({ id: first.id, expectedVersion: 2, profile })).data?.seb.enterprise.update)
      .toEqual({ success: false, response: null })
    expect((await update({ id: first.id, expectedVersion: 1, profile: {
      ...profile,
      name: ' ',
    } })).data?.seb.enterprise.update).toEqual({ success: false, response: null })
  })

  it('discovers open cycles and paginates/filter applicants’ own applications', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const secondEnterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Pagination Enterprise',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    await startInitial(applicant.cookie, secondEnterprise.id, cycleId)
    const cycles = await graphql<{
      seb: { application: { availableProgrammeCycles: { success: boolean; response: { cycles: Array<{ id: string }> } } } }
    }>(`query { seb { application { availableProgrammeCycles {
      success response { cycles { id } }
    } } } }`, {}, applicant.cookie)
    expect(cycles.data?.seb.application.availableProgrammeCycles.response.cycles)
      .toContainEqual({ id: cycleId })

    const mine = await graphql<{
      seb: { application: { mine: { success: boolean; response: { nodes: Array<{ id: string; status: string }>; pageInfo: { hasNextPage: boolean } } } } }
    }>(`query { seb { application { mine(
      first: 1, enterpriseId: "${enterprise.id}", status: DRAFT
    ) { success response { nodes { id status } pageInfo { hasNextPage } } } } } }`, {}, applicant.cookie)
    expect(mine.data?.seb.application.mine.response).toEqual({
      nodes: [{ id: application.id, status: 'DRAFT' }],
      pageInfo: { hasNextPage: false },
    })

    const firstPage = await graphql<{
      seb: {
        application: {
          mine: {
            response: {
              nodes: Array<{ id: string }>
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
            }
          }
        }
      }
    }>(`query { seb { application { mine(first: 1, includeDeleted: true) {
      response { nodes { id } pageInfo { hasNextPage endCursor } }
    } } } }`, {}, applicant.cookie)
    expect(firstPage.data?.seb.application.mine.response.pageInfo.hasNextPage).toBe(true)
    const cursor = firstPage.data?.seb.application.mine.response.pageInfo.endCursor
    if (!cursor) throw new Error('application cursor missing')
    const secondPage = await graphql<{
      seb: {
        application: {
          mine: {
            response: {
              nodes: Array<{ id: string }>
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
            }
          }
        }
      }
    }>(`query Mine($after: String!) { seb { application { mine(first: 1, after: $after) {
      response { nodes { id } pageInfo { hasNextPage endCursor } }
    } } } }`, { after: cursor }, applicant.cookie)
    expect(secondPage.data?.seb.application.mine.response).toMatchObject({
      nodes: [{ id: expect.any(String) }],
      pageInfo: { hasNextPage: false, endCursor: expect.any(String) },
    })
  })

  it('saves complete snapshots, reports missing evidence, and blocks stale saves', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const save = await graphql<{
      seb: { application: { saveDraft: { success: boolean; message: string | null; response: { currentVersion: number } | null } } }
    }>(
      `mutation Save($input: SaveApplicationDraftInput!) {
        seb { application { saveDraft(input: $input) {
          success message response { currentVersion }
        } } }
      }`,
      {
        input: {
          applicationId: application.id,
          expectedVersion: 1,
          expectedStatusVersion: 1,
          draft: completeDraft,
        },
      },
      applicant.cookie,
    )
    expect(save.data?.seb.application.saveDraft).toMatchObject({
      success: true,
      response: { currentVersion: 2 },
    })
    const noOp = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: { currentVersion: number } | null } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { currentVersion } } }
    } }`, { input: {
      applicationId: application.id,
      expectedVersion: 2,
      expectedStatusVersion: 1,
      draft: completeDraft,
    } }, applicant.cookie)
    expect(noOp.data?.seb.application.saveDraft.response).toEqual({ currentVersion: 2 })
    const stale = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(
      `mutation Save($input: SaveApplicationDraftInput!) {
        seb { application { saveDraft(input: $input) { success response { id } } }
      } }`,
      {
        input: {
          applicationId: application.id,
          expectedVersion: 1,
          expectedStatusVersion: 1,
          draft: completeDraft,
        },
      },
      applicant.cookie,
    )
    expect(stale.data?.seb.application.saveDraft).toEqual({ success: false, response: null })
    const validation = await graphql<{
      seb: { application: { validate: { success: boolean; response: { valid: boolean; issues: Array<{ code: string }> } } } }
    }>(
      `query { seb { application { validate(applicationId: "${application.id}") {
        success response { valid issues { code } }
      } } } }`,
      {},
      applicant.cookie,
    )
    expect(validation.data?.seb.application.validate.response.valid).toBe(false)
    expect(validation.data?.seb.application.validate.response.issues).toContainEqual({
      code: 'DOCUMENT_REQUIRED',
    })

    const removed = await graphql<{
      seb: { application: { softDeleteDraft: { success: boolean; response: { deletedAt: string | null } | null } } }
    }>(`mutation { seb { application { softDeleteDraft(input: {
      applicationId: "${application.id}", expectedVersion: 2, expectedStatusVersion: 1
    }) { success response { deletedAt } } } } }`, {}, applicant.cookie)
    expect(removed.data?.seb.application.softDeleteDraft.response?.deletedAt).not.toBeNull()
    const restored = await graphql<{
      seb: { application: { restoreDraft: { success: boolean; response: { deletedAt: string | null } | null } } }
    }>(`mutation { seb { application { restoreDraft(input: {
      applicationId: "${application.id}", expectedVersion: 2, expectedStatusVersion: 1
    }) { success response { deletedAt } } } } }`, {}, applicant.cookie)
    expect(restored.data?.seb.application.restoreDraft.response?.deletedAt).toBeNull()
  })

  it('lists, versions, soft-deletes, and restores only eligible enterprises', async () => {
    const applicant = await applicantSession()
    const first = await createEnterprise(applicant.cookie)
    await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Second Tribal Foods',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const mine = await graphql<{
      seb: { enterprise: { mine: { success: boolean; response: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } }
    }>(`query { seb { enterprise { mine(first: 1) {
      success response { nodes { id } pageInfo { hasNextPage endCursor } }
    } } } }`, {}, applicant.cookie)
    expect(mine.data?.seb.enterprise.mine.response).toMatchObject({
      nodes: [{ id: expect.any(String) }],
      pageInfo: { hasNextPage: true, endCursor: expect.any(String) },
    })
    const enterpriseCursor = mine.data?.seb.enterprise.mine.response.pageInfo.endCursor
    if (!enterpriseCursor) throw new Error('enterprise cursor missing')
    const secondPage = await graphql<{
      seb: { enterprise: { mine: { response: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } }
    }>(`query Mine($after: String!) { seb { enterprise { mine(first: 1, after: $after) {
      response { nodes { id } pageInfo { hasNextPage endCursor } }
    } } } }`, { after: enterpriseCursor }, applicant.cookie)
    expect(secondPage.data?.seb.enterprise.mine.response).toMatchObject({
      nodes: [{ id: expect.any(String) }],
      pageInfo: { hasNextPage: false, endCursor: expect.any(String) },
    })

    const removed = await graphql<{
      seb: { enterprise: { softDelete: { success: boolean; response: { id: string; deletedAt: string | null } | null } } }
    }>(`mutation { seb { enterprise { softDelete(input: {
      id: "${first.id}", expectedVersion: 1, reason: "Duplicate draft enterprise"
    }) { success response { id deletedAt } } } } }`, {}, applicant.cookie)
    expect(removed.data?.seb.enterprise.softDelete.response?.deletedAt).not.toBeNull()

    const includingDeleted = await graphql<{
      seb: { enterprise: { mine: { response: { nodes: Array<{ id: string }> } } } }
    }>(`query { seb { enterprise { mine(includeDeleted: true) {
      response { nodes { id } }
    } } } }`, {}, applicant.cookie)
    expect(includingDeleted.data?.seb.enterprise.mine.response.nodes)
      .toContainEqual({ id: first.id })

    const restored = await graphql<{
      seb: { enterprise: { restore: { success: boolean; response: { id: string; deletedAt: string | null } | null } } }
    }>(`mutation { seb { enterprise { restore(id: "${first.id}", expectedVersion: 1) {
      success response { id deletedAt }
    } } } }`, {}, applicant.cookie)
    expect(restored.data?.seb.enterprise.restore.response).toEqual({ id: first.id, deletedAt: null })
  })

  it('refuses to restore an initial draft after its parent or phase slot changed', async () => {
    const applicant = await applicantSession()
    const firstCycleId = await insertOpenCycle(applicant.userId)
    const secondCycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Initial Restore Invariants',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const original = await startInitial(applicant.cookie, enterprise.id, firstCycleId)
    const deleteDraft = (applicationId: string) => graphql<{
      seb: { application: { softDeleteDraft: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { softDeleteDraft(input: {
      applicationId: "${applicationId}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    const restoreOriginal = () => graphql<{
      seb: { application: { restoreDraft: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { restoreDraft(input: {
      applicationId: "${original.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)

    expect((await deleteDraft(original.id)).data?.seb.application.softDeleteDraft.success)
      .toBe(true)
    const replacement = await startInitial(applicant.cookie, enterprise.id, secondCycleId)
    expect((await restoreOriginal()).data?.seb.application.restoreDraft)
      .toEqual({ success: false, response: null })

    expect((await deleteDraft(replacement.id)).data?.seb.application.softDeleteDraft.success)
      .toBe(true)
    const removedEnterprise = await graphql<{
      seb: { enterprise: { softDelete: { success: boolean; response: unknown } } }
    }>(`mutation { seb { enterprise { softDelete(input: {
      id: "${enterprise.id}", expectedVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(removedEnterprise.data?.seb.enterprise.softDelete.success).toBe(true)
    expect((await restoreOriginal()).data?.seb.application.restoreDraft)
      .toEqual({ success: false, response: null })
  })

  it('submits an immutable formal snapshot, generates a reference, and records history', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    // Null bounds are deliberately unbounded. The same predicate must be used
    // by cycle discovery, application start, and the final guarded submission.
    await env.DB.prepare(
      'UPDATE seb_programme_cycle SET opens_at = NULL, closes_at = NULL WHERE id = ?',
    ).bind(cycleId).run()
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const saved = await saveCompleteDraft(applicant.cookie, application.id)
    await insertRequiredEvidence(application.id, applicant.userId)
    const pendingUpload = await graphql<{
      seb: { application: { issueDocumentUpload: { response: { uploadId: string } | null } } }
    }>(`mutation Issue($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) { response { uploadId } } }
    } }`, { input: {
      applicationId: application.id,
      documentType: 'NOC',
      expectedDocumentVersion: 0,
      originalFilename: 'noc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    } }, applicant.cookie)
    const pendingUploadId = pendingUpload.data?.seb.application.issueDocumentUpload.response?.uploadId
    if (!pendingUploadId) throw new Error('pending upload missing')

    const [first, second] = await Promise.all([
      graphql<{
        seb: { application: { submit: { success: boolean; response: { status: string; referenceNumber: string; currentVersion: number } | null } } }
      }>(`mutation { seb { application { submit(input: {
        applicationId: "${application.id}", expectedVersion: ${saved.currentVersion}, expectedStatusVersion: 1
      }) { success response { status referenceNumber currentVersion } } } } }`, {}, applicant.cookie),
      graphql<{
        seb: { application: { submit: { success: boolean; response: unknown } } }
      }>(`mutation { seb { application { submit(input: {
        applicationId: "${application.id}", expectedVersion: ${saved.currentVersion}, expectedStatusVersion: 1
      }) { success response { id } } } } }`, {}, applicant.cookie),
    ])
    const results = [first.data?.seb.application.submit, second.data?.seb.application.submit]
    expect(results.filter((result) => result?.success)).toHaveLength(1)
    const successful = results.find((result) => result?.success)
    expect(successful?.response).toMatchObject({
      status: 'SUBMITTED',
      referenceNumber: expect.stringMatching(/^SEP-2026-[0-9A-HJKMNP-TV-Z]{8}$/u),
      currentVersion: 3,
    })

    const state = await env.DB.prepare(
      `SELECT a.status, v.change_type AS changeType,
        v.declaration_accepted_at AS acceptedAt,
        (SELECT COUNT(*) FROM seb_application_submission s WHERE s.application_id = a.id) AS submissions,
        (SELECT COUNT(*) FROM seb_application_event e WHERE e.application_id = a.id) AS events
       FROM seb_application a
       JOIN seb_application_version v
         ON v.application_id = a.id AND v.version = a.current_version
       WHERE a.id = ?`,
    ).bind(application.id).first<{
      status: string
      changeType: string
      acceptedAt: number | null
      submissions: number
      events: number
    }>()
    expect(state).toMatchObject({
      status: 'SUBMITTED',
      changeType: 'SUBMISSION',
      acceptedAt: expect.any(Number),
      submissions: 1,
      events: 3,
    })
    const sameTime = await env.DB.prepare(
      'SELECT created_at AS createdAt FROM seb_application_event WHERE application_id = ? LIMIT 1',
    ).bind(application.id).first<{ createdAt: number }>()
    if (!sameTime) throw new Error('application timeline event missing')
    await env.DB.prepare(`INSERT INTO seb_programme_cycle_event (
      id, programme_cycle_id, event_type, actor_user_id, message, created_at
    ) VALUES (?, ?, 'GUIDANCE_CHANGED', ?, 'Shared cycle guidance changed.', ?)`)
      .bind(crypto.randomUUID(), cycleId, applicant.userId, sameTime.createdAt).run()

    const postSubmissionOperations = [
      `mutation Save($input: SaveApplicationDraftInput!) {
        seb { application { saveDraft(input: $input) { success response { id } } }
      } }`,
      `mutation { seb { application { resubmit(input: {
        applicationId: "${application.id}", expectedVersion: 3, expectedStatusVersion: 2
      }) { success response { id } } } } }`,
      `mutation { seb { application { finalizeDocumentUpload(uploadId: "${pendingUploadId}") {
        success response { documentId }
      } } } }`,
    ]
    for (const query of postSubmissionOperations) {
      const variables = query.includes('$input') ? { input: {
        applicationId: application.id,
        expectedVersion: 3,
        expectedStatusVersion: 2,
        draft: completeDraft,
      } } : {}
      const response = await graphql<Record<string, unknown>>(query, variables, applicant.cookie)
      expect(JSON.stringify(response.data)).toContain('"success":false')
    }

    expect(await issueDocumentUpload({
      applicationId: application.id,
      documentType: 'NOC',
      expectedDocumentVersion: 0,
      originalFilename: 'late.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    }, directContext(applicant.cookie))).toMatchObject({
      success: false,
      response: null,
      message: expect.stringContaining('current status'),
    })

    const deleteSubmitted = await graphql<Record<string, unknown>>(`mutation { seb { application {
      softDeleteDraft(input: {
        applicationId: "${application.id}", expectedVersion: 3, expectedStatusVersion: 2
      }) { success response { id } }
    } } }`, {}, applicant.cookie)
    expect(JSON.stringify(deleteSubmitted.data)).toContain('"success":false')

    const document = await env.DB.prepare(
      'SELECT id FROM seb_application_document WHERE application_id = ? LIMIT 1',
    ).bind(application.id).first<{ id: string }>()
    if (!document) throw new Error('evidence document missing')
    for (const expectedVersion of [0, 2]) {
      const response = await graphql<{
        seb: { application: { softDeleteDocument: { success: boolean; response: unknown } } }
      }>(`mutation { seb { application { softDeleteDocument(input: {
        applicationId: "${application.id}", documentId: "${document.id}", expectedVersion: ${expectedVersion}
      }) { success response { value } } } } }`, {}, applicant.cookie)
      expect(response.data?.seb.application.softDeleteDocument)
        .toEqual({ success: false, response: null })
    }

    const timeline = await graphql<{
      seb: { application: { timeline: { success: boolean; response: { nodes: Array<{ id: string; eventType: string; createdAt: string }> } } } }
    }>(`query { seb { application { timeline(applicationId: "${application.id}") {
      success response { nodes { id eventType createdAt } }
    } } } }`, {}, applicant.cookie)
    expect(timeline.data?.seb.application.timeline.response.nodes.map((item) => item.eventType))
      .toEqual(expect.arrayContaining([
        'APPLICATION_STARTED', 'APPLICATION_SAVED', 'APPLICATION_SUBMITTED',
        'CYCLE_GUIDANCE_CHANGED',
      ]))
    const tied = timeline.data?.seb.application.timeline.response.nodes
      .filter((item) => Date.parse(item.createdAt) === sameTime.createdAt)
    expect(tied?.map((item) => item.id)).toEqual(
      tied?.map((item) => item.id).toSorted((left, right) => left.localeCompare(right)),
    )

    const recordedMetadata = JSON.stringify({
      audit: (await env.DB.prepare(
        `SELECT action, entity_type, entity_id, changes_json, metadata_json
         FROM core_audit_event WHERE entity_id IN (?, ?)`,
      ).bind(enterprise.id, application.id).all()).results,
      timeline: (await env.DB.prepare(
        `SELECT event_type, message, metadata_json
         FROM seb_application_event WHERE application_id = ?`,
      ).bind(application.id).all()).results,
    })
    for (const sensitive of [
      'Rina Debbarma',
      'rina@example.test',
      'Example Tribal Foods',
      '50000000',
      'IDENTITY_AGE_PROOF.pdf',
      'test/',
      'AAAA',
    ]) expect(recordedMetadata).not.toContain(sensitive)

    const malformedEnterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Malformed Snapshot Enterprise',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const malformedApplication = await startInitial(
      applicant.cookie,
      malformedEnterprise.id,
      cycleId,
    )
    await env.DB.prepare(
      `UPDATE seb_application_version SET contact_email = 'not-an-email'
       WHERE application_id = ? AND version = 1`,
    ).bind(malformedApplication.id).run()
    const malformedStoredDraft = await graphql<{
      seb: { application: { submit: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { submit(input: {
      applicationId: "${malformedApplication.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(malformedStoredDraft.data?.seb.application.submit)
      .toEqual({ success: false, response: null })
  })

  it('finalizes a verified private document and preserves immutable versions across deletion', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const bytes = new TextEncoder().encode('%PDF-document')
    const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
    const checksum = btoa(String.fromCharCode(...new Uint8Array(hash)))
    const issue = await graphql<{
      seb: { application: { issueDocumentUpload: { success: boolean; response: { uploadId: string; uploadUrl: string; requiredHeaders: Array<{ name: string; value: string }> } | null } } }
    }>(`mutation Issue($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) {
        success response { uploadId uploadUrl requiredHeaders { name value } }
      } } }
    }`, { input: {
      applicationId: application.id,
      documentType: 'DPR',
      expectedDocumentVersion: 0,
      originalFilename: 'project-report.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: checksum,
    } }, applicant.cookie)
    /*
     * The suite runs as a developer's machine does — no ENVIRONMENT — so the
     * bytes come to the Worker rather than to a bucket. Signing is asserted in
     * `application-unit.test.ts`, where the context says it is deployed.
     */
    expect(issue.data?.seb.application.issueDocumentUpload.response?.uploadUrl)
      .toContain('/internal/storage/uploads/')
    const uploadId = issue.data?.seb.application.issueDocumentUpload.response?.uploadId
    if (!uploadId) throw new Error('upload intent missing')
    const intent = await env.DB.prepare(
      'SELECT object_key AS objectKey FROM seb_document_upload_intent WHERE id = ?',
    ).bind(uploadId).first<{ objectKey: string }>()
    if (!intent) throw new Error('stored intent missing')

    /*
     * The upload itself, the way a browser performs it locally: a PUT to the
     * URL the authorization named. That is the whole point of the local
     * backend — no bucket, no credentials, and the bytes still arrive.
     */
    const uploadUrl = issue.data!.seb.application.issueDocumentUpload.response!.uploadUrl

    /*
     * The refusals first, against a genuinely issued authorization. Each is a
     * constraint the bucket would apply, re-applied here so a document cannot
     * behave one way locally and another once deployed.
     *
     * None of these consumes the authorization: a rejected attempt leaves it
     * usable, which is what lets the real upload below succeed.
     */
    const badPut = (init: RequestInit) => SELF.fetch(uploadUrl, { method: 'PUT', ...init })

    // A declared length that disagrees with the authorization, refused before
    // a single byte of the body is read.
    expect((await badPut({
      headers: { 'content-type': 'application/pdf', 'content-length': '999999' },
      body: bytes,
    })).status).toBe(400)

    // A body that disagrees with the authorization once measured.
    expect((await badPut({
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array([1, 2, 3]),
    })).status).toBe(400)

    // The right size, the wrong type.
    expect((await badPut({
      headers: { 'content-type': 'image/png' },
      body: bytes,
    })).status).toBe(400)

    /*
     * A streamed body carries no Content-Length, so the cheap check before
     * buffering has nothing to work with. The measurement after buffering is
     * what actually binds the size, and this is the path that proves it.
     */
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.length + 32).fill(37))
        controller.close()
      },
    })
    expect((await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: oversized,
      // @ts-expect-error duplex is required for a streaming body and is absent
      // from the DOM types the Worker build uses.
      duplex: 'half',
    })).status).toBe(400)

    // The right size and type, different bytes — so a different checksum.
    expect((await badPut({
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array(bytes.length).fill(65),
    })).status).toBe(400)

    const uploaded = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    })
    expect(uploaded.status).toBe(200)
    expect(await (await env.STORAGE.get(intent.objectKey))?.arrayBuffer())
      .toEqual(bytes.buffer)

    const finalized = await graphql<{
      seb: { application: { finalizeDocumentUpload: { success: boolean; response: { documentId: string; version: number } | null } } }
    }>(`mutation { seb { application { finalizeDocumentUpload(uploadId: "${uploadId}") {
      success response { documentId version }
    } } } }`, {}, applicant.cookie)
    expect(finalized.data?.seb.application.finalizeDocumentUpload).toMatchObject({
      success: true,
      response: { documentId: expect.any(String), version: 1 },
    })
    const documentId = finalized.data?.seb.application.finalizeDocumentUpload.response?.documentId
    if (!documentId) throw new Error('document missing')
    const invalidVersionDelete = await graphql<{
      seb: { application: { softDeleteDocument: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { softDeleteDocument(input: {
      applicationId: "${application.id}", documentId: "${documentId}", expectedVersion: 0
    }) { success response { value } } } } }`, {}, applicant.cookie)
    expect(invalidVersionDelete.data?.seb.application.softDeleteDocument)
      .toEqual({ success: false, response: null })
    const staleIssue = await graphql<{
      seb: { application: { issueDocumentUpload: { success: boolean; response: unknown } } }
    }>(`mutation Issue($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) { success response { uploadId } } }
    } }`, { input: {
      applicationId: application.id,
      documentType: 'DPR',
      expectedDocumentVersion: 0,
      originalFilename: 'replacement.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: checksum,
    } }, applicant.cookie)
    expect(staleIssue.data?.seb.application.issueDocumentUpload)
      .toEqual({ success: false, response: null })
    const download = await graphql<{
      seb: { application: { documentDownloadUrl: { success: boolean; response: { downloadUrl: string } | null } } }
    }>(`query { seb { application { documentDownloadUrl(documentId: "${documentId}") {
      success response { downloadUrl }
    } } } }`, {}, applicant.cookie)
    expect(download.data?.seb.application.documentDownloadUrl.response?.downloadUrl)
      .toContain('/internal/storage/objects?key=')

    for (const action of ['softDeleteDocument', 'restoreDocument']) {
      const changed = await graphql<{
        seb: { application: Record<string, { success: boolean; response: { value: boolean } | null }> }
      }>(`mutation { seb { application { ${action}(input: {
        applicationId: "${application.id}", documentId: "${documentId}", expectedVersion: 1
      }) { success response { value } } } } }`, {}, applicant.cookie)
      expect(changed.data?.seb.application[action]).toEqual({ success: true, response: { value: true } })
    }
    const replacementIssue = await graphql<{
      seb: { application: { issueDocumentUpload: { response: { uploadId: string } | null } } }
    }>(`mutation Issue($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) { response { uploadId } } } }
    }`, { input: {
      applicationId: application.id,
      documentType: 'DPR',
      expectedDocumentVersion: 1,
      originalFilename: 'replacement.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: checksum,
    } }, applicant.cookie)
    const replacementUploadId = replacementIssue.data?.seb.application.issueDocumentUpload.response?.uploadId
    if (!replacementUploadId) throw new Error('replacement intent missing')
    const replacementIntent = await env.DB.prepare(
      'SELECT object_key AS objectKey FROM seb_document_upload_intent WHERE id = ?',
    ).bind(replacementUploadId).first<{ objectKey: string }>()
    if (!replacementIntent) throw new Error('replacement intent row missing')
    await env.STORAGE.put(replacementIntent.objectKey, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      sha256: hash,
    })
    const replacementAttempts = await Promise.all([
      finalizeDocumentUpload(replacementUploadId, directContext(applicant.cookie)),
      finalizeDocumentUpload(replacementUploadId, directContext(applicant.cookie)),
    ])
    expect(replacementAttempts.filter((result) => result.success)).toHaveLength(1)
    expect(replacementAttempts.find((result) => result.success)?.response)
      .toEqual({ documentId, version: 2 })
    expect(await env.STORAGE.head(intent.objectKey)).not.toBeNull()
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM seb_application_document_version WHERE document_id = ?',
    ).bind(documentId).first<{ count: number }>()).toEqual({ count: 2 })
  })

  it('rejects unsafe upload authorizations and cleans expired or invalid objects', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const baseInput = {
      applicationId: application.id,
      documentType: 'DPR',
      expectedDocumentVersion: 0,
      originalFilename: 'report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    }
    for (const input of [
      { ...baseInput, expectedDocumentVersion: -1 },
      { ...baseInput, sizeBytes: 0 },
      { ...baseInput, sizeBytes: MAX_DOCUMENT_BYTES + 1 },
      { ...baseInput, contentType: 'text/html' },
      { ...baseInput, checksumSha256: 'not-a-checksum' },
      { ...baseInput, originalFilename: ' ' },
      // A name that describes something the file is not. This passes the type
      // check and would pass the signature check too, because the bytes really
      // are a PDF — the name is what lies.
      { ...baseInput, originalFilename: 'report.pdf.exe' },
      { ...baseInput, originalFilename: 'report' },
      { ...baseInput, applicationId: 'missing-application' },
    ]) {
      const response = await graphql<{
        seb: { application: { issueDocumentUpload: { success: boolean; response: unknown } } }
      }>(`mutation Issue($input: IssueDocumentUploadInput!) {
        seb { application { issueDocumentUpload(input: $input) { success response { uploadId } } } }
      }`, { input }, applicant.cookie)
      expect(response.data?.seb.application.issueDocumentUpload).toEqual({
        success: false,
        response: null,
      })
    }

    const issueOne = async () => {
      const response = await graphql<{
        seb: { application: { issueDocumentUpload: { success: boolean; response: { uploadId: string } | null } } }
      }>(`mutation Issue($input: IssueDocumentUploadInput!) {
        seb { application { issueDocumentUpload(input: $input) { success response { uploadId } } } }
      }`, { input: baseInput }, applicant.cookie)
      const uploadId = response.data?.seb.application.issueDocumentUpload.response?.uploadId
      if (!uploadId) throw new Error('upload intent missing')
      const intent = await env.DB.prepare(
        'SELECT object_key AS objectKey FROM seb_document_upload_intent WHERE id = ?',
      ).bind(uploadId).first<{ objectKey: string }>()
      if (!intent) throw new Error('intent missing')
      return { uploadId, objectKey: intent.objectKey }
    }

    const expired = await issueOne()
    await env.DB.prepare(
      'UPDATE seb_document_upload_intent SET expires_at = ? WHERE id = ?',
    ).bind(Date.now() - 1, expired.uploadId).run()
    await env.STORAGE.put(expired.objectKey, new TextEncoder().encode('%PDF-old'))
    const expiredResult = await graphql<{
      seb: { application: { finalizeDocumentUpload: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { finalizeDocumentUpload(uploadId: "${expired.uploadId}") {
      success response { documentId }
    } } } }`, {}, applicant.cookie)
    expect(expiredResult.data?.seb.application.finalizeDocumentUpload).toEqual({
      success: false,
      response: null,
    })
    expect(await env.STORAGE.head(expired.objectKey)).toBeNull()
    expect(await env.DB.prepare(
      'SELECT status FROM seb_document_upload_intent WHERE id = ?',
    ).bind(expired.uploadId).first()).toEqual({ status: 'EXPIRED' })

    const invalid = await issueOne()
    const invalidBytes = new TextEncoder().encode('not-a-pdf')
    const invalidHash = await crypto.subtle.digest('SHA-256', invalidBytes.buffer as ArrayBuffer)
    const invalidChecksum = btoa(String.fromCharCode(...new Uint8Array(invalidHash)))
    await env.DB.prepare(
      `UPDATE seb_document_upload_intent SET size_bytes = ?, checksum_sha256 = ? WHERE id = ?`,
    ).bind(invalidBytes.length, invalidChecksum, invalid.uploadId).run()
    await env.STORAGE.put(invalid.objectKey, invalidBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      sha256: invalidHash,
    })
    await graphql(`mutation { seb { application {
      finalizeDocumentUpload(uploadId: "${invalid.uploadId}") { success }
    } } }`, {}, applicant.cookie)
    expect(await env.STORAGE.head(invalid.objectKey)).toBeNull()
    expect(await env.DB.prepare(
      'SELECT status FROM seb_document_upload_intent WHERE id = ?',
    ).bind(invalid.uploadId).first()).toEqual({ status: 'REJECTED' })

    const pending = await issueOne()
    const cronExpired = await issueOne()
    await env.DB.prepare(
      `UPDATE seb_document_upload_intent
       SET status = 'CLEANUP_PENDING', cleanup_target_status = 'REJECTED'
       WHERE id = ?`,
    ).bind(pending.uploadId).run()
    await env.DB.prepare(
      'UPDATE seb_document_upload_intent SET expires_at = ? WHERE id = ?',
    ).bind(Date.now() - 1, cronExpired.uploadId).run()
    await env.STORAGE.put(pending.objectKey, new TextEncoder().encode('pending'))
    await env.STORAGE.put(cronExpired.objectKey, new TextEncoder().encode('expired'))
    await cleanupExpiredDocumentUploads({ db: createDatabase(env.DB), env }, new Date())
    expect(await env.STORAGE.head(pending.objectKey)).toBeNull()
    expect(await env.STORAGE.head(cronExpired.objectKey)).toBeNull()
    expect(await env.DB.prepare(
      'SELECT status FROM seb_document_upload_intent WHERE id = ?',
    ).bind(pending.uploadId).first()).toEqual({ status: 'REJECTED' })
    expect(await env.DB.prepare(
      'SELECT status FROM seb_document_upload_intent WHERE id = ?',
    ).bind(cronExpired.uploadId).first()).toEqual({ status: 'EXPIRED' })

    /*
     * The whole claimed batch is deleted in one call, and a failure leaves
     * every row retryable.
     *
     * A failure falls back to deleting them one at a time, and the reason is
     * that the alternative is permanent rather than temporary. The claim query
     * has no ordering, so every run picks up the same rows: one object the
     * bucket will never remove would hold up its companions for ever, and
     * every intent queued behind them with it.
     */
    const retryOne = await issueOne()
    const retryTwo = await issueOne()
    await env.DB.prepare(
      'UPDATE seb_document_upload_intent SET expires_at = ? WHERE id IN (?, ?)',
    ).bind(Date.now() - 1, retryOne.uploadId, retryTwo.uploadId).run()

    const deleteObject = vi.fn()
      .mockRejectedValueOnce(new Error('temporary R2 failure'))
      .mockResolvedValue(undefined)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = {
      db: createDatabase(env.DB), loaders: createLoaders(createDatabase(env.DB)),
      env: { STORAGE: { delete: deleteObject } as unknown as R2Bucket } as typeof env,
    }
    await cleanupExpiredDocumentUploads(failing, new Date())

    // One call for the batch, then one per object once that call failed.
    expect(deleteObject).toHaveBeenCalledTimes(3)
    expect((deleteObject.mock.calls[0]![0] as string[]).sort())
      .toEqual([retryOne.objectKey, retryTwo.objectKey].sort())
    expect(deleteObject.mock.calls.slice(1).map((call) => call[0] as string).sort())
      .toEqual([retryOne.objectKey, retryTwo.objectKey].sort())
    // Nothing was logged that names an object: a storage key is sensitive.
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain(retryOne.objectKey)
    errorLog.mockRestore()

    // Both objects went in the end, so both claims are closed in that same run.
    const settled = await env.DB.prepare(
      `SELECT status, cleanup_target_status AS cleanupTargetStatus
       FROM seb_document_upload_intent WHERE id IN (?, ?)`,
    ).bind(retryOne.uploadId, retryTwo.uploadId).all()
    expect(settled.results).toEqual([
      { status: 'EXPIRED', cleanupTargetStatus: null },
      { status: 'EXPIRED', cleanupTargetStatus: null },
    ])

    /*
     * The companion to the case above: an object that fails both the batch and
     * its own retry keeps its row claimable, so the work is not silently
     * marked done. Its companions are still finished — which is the whole
     * point of isolating it.
     */
    const poison = await issueOne()
    const healthy = await issueOne()
    await env.DB.prepare(
      'UPDATE seb_document_upload_intent SET expires_at = ? WHERE id IN (?, ?)',
    ).bind(Date.now() - 1, poison.uploadId, healthy.uploadId).run()

    const poisonDelete = vi.fn().mockImplementation(async (key: string | string[]) => {
      if (Array.isArray(key) || key === poison.objectKey) {
        throw new Error('this object can never be removed')
      }
    })
    const poisonLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await cleanupExpiredDocumentUploads({
      db: createDatabase(env.DB),
      env: { STORAGE: { delete: poisonDelete } as unknown as R2Bucket } as typeof env,
    } as typeof failing, new Date())
    poisonLog.mockRestore()

    const after = await env.DB.prepare(
      `SELECT id, status FROM seb_document_upload_intent WHERE id IN (?, ?)`,
    ).bind(poison.uploadId, healthy.uploadId).all<{ id: string; status: string }>()
    const byId = new Map(after.results.map((row) => [row.id, row.status]))
    expect(byId.get(healthy.uploadId), 'the healthy one finishes').toBe('EXPIRED')
    expect(byId.get(poison.uploadId), 'the poison one stays claimable')
      .toBe('CLEANUP_PENDING')

    /*
     * And a run where nothing at all can be removed closes nothing. Only the
     * poison row is still claimable now, so this is the every-object-fails
     * case — it must leave the row exactly as it found it rather than marking
     * work done that was never done.
     */
    const secondLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await cleanupExpiredDocumentUploads({
      db: createDatabase(env.DB),
      env: { STORAGE: { delete: poisonDelete } as unknown as R2Bucket } as typeof env,
    } as typeof failing, new Date())
    secondLog.mockRestore()
    const [stillOpen] = (await env.DB.prepare(
      'SELECT status FROM seb_document_upload_intent WHERE id = ?',
    ).bind(poison.uploadId).all<{ status: string }>()).results
    expect(stillOpen?.status).toBe('CLEANUP_PENDING')
  })

  it('restricts revision edits and permits a late resubmission that resolves every request', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const saved = await saveCompleteDraft(applicant.cookie, application.id)
    await insertRequiredEvidence(application.id, applicant.userId)
    const submitted = await graphql<{
      seb: { application: { submit: { success: boolean; response: { currentVersion: number; statusVersion: number } | null } } }
    }>(`mutation { seb { application { submit(input: {
      applicationId: "${application.id}", expectedVersion: ${saved.currentVersion}, expectedStatusVersion: 1
    }) { success response { currentVersion statusVersion } } } } }`, {}, applicant.cookie)
    expect(submitted.data?.seb.application.submit.response).toEqual({
      currentVersion: 3,
      statusVersion: 2,
    })
    const submission = await env.DB.prepare(
      'SELECT id FROM seb_application_submission WHERE application_id = ?',
    ).bind(application.id).first<{ id: string }>()
    if (!submission) throw new Error('submission missing')
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE seb_application SET status = 'REVISION_REQUIRED', status_version = 3,
          updated_at = ? WHERE id = ?`,
      ).bind(now, application.id),
      env.DB.prepare(
        `UPDATE seb_programme_cycle SET status = 'CLOSED', closes_at = ?,
          updated_at = ? WHERE id = ?`,
      ).bind(now - 1, now, cycleId),
    ])

    const noRequests = await graphql<{
      seb: { application: { resubmit: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { resubmit(input: {
      applicationId: "${application.id}", expectedVersion: 3, expectedStatusVersion: 3
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(noRequests.data?.seb.application.resubmit).toEqual({ success: false, response: null })
    const saveWithoutRequests = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { id } } }
    } }`, { input: {
      applicationId: application.id,
      expectedVersion: 3,
      expectedStatusVersion: 3,
      draft: completeDraft,
    } }, applicant.cookie)
    expect(saveWithoutRequests.data?.seb.application.saveDraft)
      .toEqual({ success: false, response: null })
    await env.DB.batch([
      env.DB.prepare(
      `INSERT INTO seb_revision_request (
        id, application_id, submission_id, section, note, requested_by_user_id, requested_at
      ) VALUES (?, ?, ?, 'FINANCIAL', 'Clarify the project cost.', ?, ?)`,
      ).bind(crypto.randomUUID(), application.id, submission.id, applicant.userId, now),
      env.DB.prepare(
        `INSERT INTO seb_revision_request (
          id, application_id, submission_id, section, note, requested_by_user_id, requested_at
        ) VALUES (?, ?, ?, 'APPLICANT_PROFILE', 'Confirm the profile.', ?, ?)`,
      ).bind(crypto.randomUUID(), application.id, submission.id, applicant.userId, now + 1),
      env.DB.prepare(
        `INSERT INTO seb_revision_request (
          id, application_id, submission_id, section, note, requested_by_user_id, requested_at
        ) VALUES (?, ?, ?, 'DOCUMENTS', 'Replace the DPR if needed.', ?, ?)`,
      ).bind(crypto.randomUUID(), application.id, submission.id, applicant.userId, now + 2),
    ])

    const revisionHead = await loadOwnedApplication(
      createDatabase(env.DB),
      applicant.userId,
      application.id,
    )
    if (!revisionHead) throw new Error('revision application missing')
    const revisionVersion = await findApplicationVersion(
      createDatabase(env.DB),
      application.id,
      revisionHead.currentVersion,
    )
    if (!revisionVersion) throw new Error('revision application version missing')
    const unscopedSaveAt = new Date()
    expect(await saveApplicationSnapshot(createDatabase(env.DB), {
      head: revisionHead,
      userId: applicant.userId,
      draft: persistenceDraft(),
      expansionClaim: {
        priorSanctionOrderNumber: null,
        priorSanctionDate: null,
        priorNetDisbursedAmountPaise: null,
        continuousOperationMonths: null,
      },
      programmeCycleVersion: revisionVersion.programmeCycleVersion,
      now: unscopedSaveAt,
      audit: auditRecord(directContext(applicant.cookie), {
        actorUserId: applicant.userId,
        action: auditActions.applicationSaved,
        entityType: 'SEB_APPLICATION',
        entityId: application.id,
        now: unscopedSaveAt,
      }),
    })).toBe(false)

    expect(await issueDocumentUpload({
      applicationId: application.id,
      documentType: 'NOC',
      expectedDocumentVersion: 0,
      originalFilename: 'revision-noc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    }, directContext(applicant.cookie))).toMatchObject({ success: true })

    const forbiddenDraft = structuredClone(completeDraft)
    forbiddenDraft.enterprise.businessName = 'Unauthorized name edit'
    const forbidden = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { id } } }
    } }`, { input: {
      applicationId: application.id,
      expectedVersion: 3,
      expectedStatusVersion: 3,
      draft: forbiddenDraft,
    } }, applicant.cookie)
    expect(forbidden.data?.seb.application.saveDraft).toEqual({ success: false, response: null })

    // While revision is required only the requested section is editable, and
    // the field says exactly what `saveDraft` accepted and refused above.
    const locked = await graphql<{
      seb: { application: { byId: { response: { editableSections: string[] } | null } } }
    }>(`query($id: ID!) { seb { application { byId(id: $id) {
      response { editableSections }
    } } } }`, { id: application.id }, applicant.cookie)
    // The three requested sections, in the fixed catalogue order rather than
    // the order the requests happened to be issued in.
    expect(locked.data?.seb.application.byId.response?.editableSections)
      .toEqual(['APPLICANT_PROFILE', 'FINANCIAL', 'DOCUMENTS'])

    const revisedDraft = structuredClone(completeDraft)
    revisedDraft.financial.totalProjectCostPaise = '51000000'
    const revised = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: { currentVersion: number } | null } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { currentVersion } } }
    } }`, { input: {
      applicationId: application.id,
      expectedVersion: 3,
      expectedStatusVersion: 3,
      draft: revisedDraft,
    } }, applicant.cookie)
    expect(revised.data?.seb.application.saveDraft.response).toEqual({ currentVersion: 4 })

    // Before resubmitting, the applicant can review exactly which sections
    // their answers change relative to the submission under revision. This is
    // the same comparison a reviewer sees in the administrative workspace.
    const changes = await graphql<{
      seb: { application: { draftChanges: { success: boolean; response: {
        sections: string[]
        comparedToSubmissionNumber: number
      } | null } } }
    }>(`query($id: ID!) { seb { application { draftChanges(applicationId: $id) {
      success response { sections comparedToSubmissionNumber }
    } } } }`, { id: application.id }, applicant.cookie)
    expect(changes.data?.seb.application.draftChanges.response).toEqual({
      sections: ['FINANCIAL'],
      comparedToSubmissionNumber: 1,
    })

    const resubmitted = await graphql<{
      seb: { application: { resubmit: { success: boolean; response: { currentVersion: number; statusVersion: number; status: string } | null } } }
    }>(`mutation { seb { application { resubmit(input: {
      applicationId: "${application.id}", expectedVersion: 4, expectedStatusVersion: 3
    }) { success response { currentVersion statusVersion status } } } } }`, {}, applicant.cookie)
    expect(resubmitted.data?.seb.application.resubmit.response).toEqual({
      currentVersion: 5,
      statusVersion: 4,
      status: 'SUBMITTED',
    })
    expect(await env.DB.prepare(
      `SELECT resolved_by_submission_id AS submissionId, resolved_at AS resolvedAt
       FROM seb_revision_request WHERE application_id = ?`,
    ).bind(application.id).first()).toMatchObject({
      submissionId: expect.any(String),
      resolvedAt: expect.any(Number),
    })

    // A revision response and a first submission are both SUBMITTED, and staff
    // handle them completely differently, so the named queues separate them by
    // submission number. Asserted here because this is the only place a real
    // second submission exists. Roles are joined live, so granting ADMIN makes
    // the applicant's existing session administrative on the next request.
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
       VALUES (?, ?, 'ADMIN', 'QUEUE_ASSERTION', ?)`,
    ).bind(crypto.randomUUID(), applicant.userId, Date.now()).run()

    const queues = await graphql<{
      admin: { intake: { queues: { response: { queues: Array<{ queue: string; count: number }> } } } }
    }>(`query { admin { intake { queues { response { queues { queue count } } } } } }`,
      {}, applicant.cookie)
    const countFor = (queue: string) => queues.data?.admin.intake.queues.response.queues
      .find((entry) => entry.queue === queue)?.count
    expect(countFor('REVISION_RESPONSES')).toBe(1)
    expect(countFor('NEW_SUBMISSIONS')).toBe(0)

    const revisionResponses = await graphql<{
      admin: { intake: { queue: { response: { nodes: Array<{ id: string; submissionNumber: number }> } } } }
    }>(`query { admin { intake { queue(input: { first: 10, queue: REVISION_RESPONSES }) {
      response { nodes { id submissionNumber } }
    } } } }`, {}, applicant.cookie)
    expect(revisionResponses.data?.admin.intake.queue.response.nodes).toEqual([
      { id: application.id, submissionNumber: 2 },
    ])

    const newSubmissions = await graphql<{
      admin: { intake: { queue: { response: { nodes: unknown[] } } } }
    }>(`query { admin { intake { queue(input: { first: 10, queue: NEW_SUBMISSIONS }) {
      response { nodes { id } }
    } } } }`, {}, applicant.cookie)
    expect(newSubmissions.data?.admin.intake.queue.response.nodes).toEqual([])
  })

  it('rejects an expansion start when its derived ledger evidence changes before the batch', async () => {
    const applicant = await applicantSession()
    const initialCycleId = await insertOpenCycle(applicant.userId)
    const expansionCycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      name: 'Atomic Expansion Evidence',
      registrationNumber: `UDYAM-${crypto.randomUUID()}`,
    })
    const initial = await startInitial(applicant.cookie, enterprise.id, initialCycleId)
    const oldReleaseAt = Date.now() - 370 * 86_400_000
    const { awardId, fundingCaseId } = await insertActiveAward(
      applicant.userId,
      initial.id,
      oldReleaseAt,
    )
    const secondReleaseId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, amount_paise,
        occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
        bank_account_verified_at, performance_agreement_reference,
        performance_agreement_executed_at, physical_verification_required,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 2, 'RELEASE', 100, ?, ?, 'TTM-TEST', '2025-01-01',
        ?, 'AGREEMENT-TEST', ?, 0, 'Test release.', ?, ?)`,
    ).bind(
      secondReleaseId,
      awardId,
      oldReleaseAt,
      `SECOND-${awardId}`,
      Date.now(),
      Date.now(),
      applicant.userId,
      Date.now(),
    ).run()

    const db = createDatabase(env.DB)
    const now = new Date()
    const [source, evaluated] = await Promise.all([
      findEnterpriseApplicationSource(db, applicant.userId, enterprise.id),
      evaluateExpansionEligibility(db, fundingCaseId, now),
    ])
    if (!source || !evaluated.award || !evaluated.result.nextPhaseNumber) {
      throw new Error('eligible expansion evidence missing')
    }
    const staleClaim = expansionClaimFromAward(evaluated.award, now)

    // Leave the original aged release positive while over-reversing another
    // release. A weak "some release is positive" predicate would still pass,
    // but the authoritative total is now zero and must invalidate the start.
    await env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
        amount_paise, occurred_at, external_reference, reason_category_id,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 3, 'REVERSAL', ?, 10000100, ?, ?,
        (SELECT id FROM seb_programme_cycle_reason WHERE context = 'RELEASE_REVERSAL' LIMIT 1),
        'Test reversal.', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      awardId,
      secondReleaseId,
      Date.now(),
      `OVER-REVERSAL-${awardId}`,
      applicant.userId,
      Date.now(),
    ).run()
    const candidateId = crypto.randomUUID()
    expect(await insertApplicationAggregate(db, {
      applicationId: candidateId,
      applicantUserId: applicant.userId,
      enterpriseId: source.enterprise.id,
      fundingCaseId,
      programmeCycleId: expansionCycleId,
      programmeCycleVersion: 1,
      applicationType: 'EXPANSION',
      phaseNumber: evaluated.result.nextPhaseNumber,
      draft: persistenceDraft(),
      expansionClaim: staleClaim,
      qualifyingAwardId: awardId,
      qualifyingReleaseAt: evaluated.award.firstReleaseAt,
      now,
      audit: auditRecord(directContext(applicant.cookie), {
        actorUserId: applicant.userId,
        action: auditActions.applicationStarted,
        entityType: 'SEB_APPLICATION',
        entityId: candidateId,
        now,
      }),
    })).toBe(false)
    expect(await env.DB.prepare(
      'SELECT id FROM seb_application WHERE id = ?',
    ).bind(candidateId).first()).toBeNull()
  })

  it('derives expansion eligibility and atomically releases/reclaims qualifying awards', async () => {
    const applicant = await applicantSession()
    const initialCycle = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const initial = await startInitial(applicant.cookie, enterprise.id, initialCycle)
    expect(await findExpansionAwardForApplication(createDatabase(env.DB), initial.id)).toBeNull()
    const beforeAward = await graphql<{
      seb: { application: { expansionEligibility: { response: {
        eligible: boolean
        reasons: Array<{ code: string; message: string; obligationId: string | null }>
      } } } }
    }>(`query { seb { application { expansionEligibility(
      enterpriseId: "${enterprise.id}", programmeCycleId: "${initialCycle}"
    ) { response { eligible reasons { code message obligationId } } } } } }`, {}, applicant.cookie)
    expect(beforeAward.data?.seb.application.expansionEligibility.response).toEqual({
      eligible: false,
      reasons: [{
        code: 'NO_QUALIFYING_AWARD',
        message: 'This enterprise has no sanctioned funding award to expand from.',
        obligationId: null,
      }],
    })
    const { awardId } = await insertActiveAward(
      applicant.userId,
      initial.id,
      Date.now() - 370 * 86_400_000,
    )
    const release = await env.DB.prepare(
      `SELECT id FROM seb_disbursement WHERE funding_award_id = ? AND entry_type = 'RELEASE'`,
    ).bind(awardId).first<{ id: string }>()
    if (!release) throw new Error('release missing')
    await env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
        amount_paise, occurred_at, external_reference, reason_category_id,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 2, 'REVERSAL', ?, 1000000, ?, ?,
        (SELECT id FROM seb_programme_cycle_reason WHERE context = 'RELEASE_REVERSAL' LIMIT 1),
        'Test reversal.', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      awardId,
      release.id,
      Date.now(),
      `REVERSAL-${awardId}`,
      applicant.userId,
      Date.now(),
    ).run()
    const expansionCycle = await insertOpenCycle(applicant.userId)
    const obligationId = crypto.randomUUID()
    const assessmentTime = Date.now()
    await env.DB.batch([
      ...(['UTILIZATION', 'PERFORMANCE', 'FINANCIAL_AUDIT'] as const).map((type) =>
        env.DB.prepare(`INSERT INTO seb_programme_cycle_assessment_rule (
          id, programme_cycle_id, programme_cycle_version, assessment_type,
          required_outcome, created_at
        ) VALUES (?, ?, 1, ?, 'PASSED', ?)`).bind(
          crypto.randomUUID(), expansionCycle, type, assessmentTime,
        )),
      env.DB.prepare(`INSERT INTO seb_utilization_obligation (
        id, funding_award_id, release_disbursement_id, due_at, created_at
      ) VALUES (?, ?, ?, ?, ?)`).bind(
        obligationId, awardId, release.id, assessmentTime, assessmentTime,
      ),
      env.DB.prepare(`INSERT INTO seb_award_assessment (
        id, funding_award_id, assessment_type, assessment_number, outcome,
        utilization_obligation_id, evidence_reference, applicant_summary,
        assessed_by_user_id, assessed_at, created_at
      ) VALUES (?, ?, 'UTILIZATION', 1, 'PASSED', ?, 'UC-TEST',
        'Utilization passed.', ?, ?, ?)`).bind(
        crypto.randomUUID(), awardId, obligationId, applicant.userId,
        assessmentTime, assessmentTime,
      ),
      ...(['PERFORMANCE', 'FINANCIAL_AUDIT'] as const).map((type) =>
        env.DB.prepare(`INSERT INTO seb_award_assessment (
          id, funding_award_id, assessment_type, assessment_number, outcome,
          evidence_reference, applicant_summary, assessed_by_user_id,
          assessed_at, created_at
        ) VALUES (?, ?, ?, 1, 'PASSED', ?, 'Assessment passed.', ?, ?, ?)`).bind(
          crypto.randomUUID(), awardId, type, `${type}-TEST`, applicant.userId,
          assessmentTime, assessmentTime,
        )),
    ])
    const eligibility = await graphql<{
      seb: { application: { expansionEligibility: { success: boolean; response: { eligible: boolean; nextPhaseNumber: number; qualifyingAwardId: string } } } }
    }>(`query { seb { application { expansionEligibility(
      enterpriseId: "${enterprise.id}", programmeCycleId: "${expansionCycle}"
    ) { success response { eligible nextPhaseNumber qualifyingAwardId } } } } }`, {}, applicant.cookie)
    expect(eligibility.data?.seb.application.expansionEligibility.response).toEqual({
      eligible: true,
      nextPhaseNumber: 2,
      qualifyingAwardId: awardId,
    })
    await env.DB.prepare(`INSERT INTO seb_award_assessment (
      id, funding_award_id, assessment_type, assessment_number, outcome,
      utilization_obligation_id, evidence_reference, applicant_summary,
      assessed_by_user_id, assessed_at, created_at
    ) VALUES (?, ?, 'UTILIZATION', 2, 'FAILED', ?, 'UC-REASSESS-FAILED',
      'Utilization reassessment failed.', ?, ?, ?)`).bind(
      crypto.randomUUID(), awardId, obligationId, applicant.userId,
      assessmentTime + 1, assessmentTime + 1,
    ).run()
    const failedUtilization = await graphql<{
      seb: { application: { expansionEligibility: { response: {
        eligible: boolean
        reasons: Array<{ code: string; message: string; obligationId: string | null }>
      } } } }
    }>(`query { seb { application { expansionEligibility(
      enterpriseId: "${enterprise.id}", programmeCycleId: "${expansionCycle}"
    ) { response { eligible reasons { code message obligationId } } } } } }`, {}, applicant.cookie)
    expect(failedUtilization.data?.seb.application.expansionEligibility.response).toEqual({
      eligible: false,
      // The obligation is named in its own field rather than concatenated into
      // the code, so a client can link the reason to the release it is about.
      reasons: [{
        code: 'UTILIZATION_NOT_PASSED',
        message: 'A utilization assessment for one of your releases has not passed yet.',
        obligationId,
      }],
    })
    await env.DB.prepare(`INSERT INTO seb_award_assessment (
      id, funding_award_id, assessment_type, assessment_number, outcome,
      utilization_obligation_id, evidence_reference, applicant_summary,
      assessed_by_user_id, assessed_at, created_at
    ) VALUES (?, ?, 'UTILIZATION', 3, 'PASSED', ?, 'UC-REASSESS-PASSED',
      'Utilization reassessment passed.', ?, ?, ?)`).bind(
      crypto.randomUUID(), awardId, obligationId, applicant.userId,
      assessmentTime + 2, assessmentTime + 2,
    ).run()

    const started = await graphql<{
      seb: { application: { startExpansion: { success: boolean; response: { id: string; applicationType: string; phaseNumber: number; currentVersion: number; statusVersion: number } | null } } }
    }>(`mutation { seb { application { startExpansion(input: {
      enterpriseId: "${enterprise.id}", programmeCycleId: "${expansionCycle}"
    }) { success response { id applicationType phaseNumber currentVersion statusVersion } } } } }`, {}, applicant.cookie)
    expect(started.data?.seb.application.startExpansion.response).toMatchObject({
      applicationType: 'EXPANSION',
      phaseNumber: 2,
    })
    const expansion = started.data?.seb.application.startExpansion.response
    if (!expansion) throw new Error('expansion missing')
    const competing = await graphql<{
      seb: { application: { expansionEligibility: { response: {
        eligible: boolean
        reasons: Array<{ code: string; message: string; obligationId: string | null }>
      } } } }
    }>(`query { seb { application { expansionEligibility(
      enterpriseId: "${enterprise.id}", programmeCycleId: "${expansionCycle}"
    ) { response { eligible reasons { code message obligationId } } } } } }`, {}, applicant.cookie)
    expect(competing.data?.seb.application.expansionEligibility.response).toEqual({
      eligible: false,
      reasons: [{
        code: 'COMPETING_PHASE_APPLICATION',
        message: 'Another application for this phase is already in progress.',
        obligationId: null,
      }],
    })

    const deleted = await graphql<{
      seb: { application: { softDeleteDraft: { success: boolean; response: { deletedAt: string | null } | null } } }
    }>(`mutation { seb { application { softDeleteDraft(input: {
      applicationId: "${expansion.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { deletedAt } } } } }`, {}, applicant.cookie)
    expect(deleted.data?.seb.application.softDeleteDraft.response?.deletedAt).not.toBeNull()
    expect(await env.DB.prepare(
      'SELECT status FROM seb_application_qualifying_award WHERE application_id = ?',
    ).bind(expansion.id).first()).toEqual({ status: 'CANCELLED' })

    await env.DB.prepare(
      `UPDATE seb_funding_award SET status = 'SUSPENDED', updated_at = ? WHERE id = ?`,
    ).bind(Date.now(), awardId).run()
    const ineligibleRestore = await graphql<{
      seb: { application: { restoreDraft: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { restoreDraft(input: {
      applicationId: "${expansion.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect(ineligibleRestore.data?.seb.application.restoreDraft)
      .toEqual({ success: false, response: null })
    await env.DB.prepare(
      `UPDATE seb_funding_award SET status = 'ACTIVE', updated_at = ? WHERE id = ?`,
    ).bind(Date.now(), awardId).run()

    const restored = await graphql<{
      seb: { application: { restoreDraft: { success: boolean; response: { deletedAt: string | null } | null } } }
    }>(`mutation { seb { application { restoreDraft(input: {
      applicationId: "${expansion.id}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { deletedAt } } } } }`, {}, applicant.cookie)
    expect(restored.data?.seb.application.restoreDraft.response?.deletedAt).toBeNull()
    expect(await env.DB.prepare(
      'SELECT status, current_funding_award_id AS awardId FROM seb_application_qualifying_award WHERE application_id = ?',
    ).bind(expansion.id).first()).toEqual({ status: 'ACTIVE', awardId })

    const savedExpansion = await saveCompleteDraft(applicant.cookie, expansion.id)
    await insertRequiredEvidence(expansion.id, applicant.userId)

    // An administrator may change the authoritative award after the applicant
    // passed the friendly eligibility read. The formal D1 write must repeat
    // that check rather than submitting a stale Phase-II snapshot.
    const staleExpansion = await loadOwnedApplication(
      createDatabase(env.DB),
      applicant.userId,
      expansion.id,
    )
    const staleExpansionVersion = await findApplicationVersion(
      createDatabase(env.DB),
      expansion.id,
      savedExpansion.currentVersion,
    )
    if (!staleExpansion || !staleExpansionVersion) {
      throw new Error('stale expansion submission aggregate missing')
    }
    await env.DB.prepare(
      `UPDATE seb_funding_award SET status = 'SUSPENDED', updated_at = ? WHERE id = ?`,
    ).bind(Date.now(), awardId).run()
    const staleSubmitAt = new Date()
    expect(await submitApplicationSnapshot(createDatabase(env.DB), {
      head: staleExpansion,
      currentVersion: staleExpansionVersion,
      userId: applicant.userId,
      draft: persistenceDraft(),
      expansionClaim: {
        priorSanctionOrderNumber: staleExpansion.snapshot.priorSanctionOrderNumber,
        priorSanctionDate: staleExpansion.snapshot.priorSanctionDate,
        priorNetDisbursedAmountPaise: staleExpansion.snapshot.priorNetDisbursedAmountPaise,
        continuousOperationMonths: staleExpansion.snapshot.continuousOperationMonths,
      },
      qualifyingAwardId: awardId,
      programmeCycleVersion: staleExpansionVersion.programmeCycleVersion,
      referenceNumber: `SEP-2026-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      resubmission: false,
      // The real list, so the write repeats the check the validator made —
      // which is what this test is about.
      requiredDocumentTypes: requiredDocumentTypesForSnapshot(persistenceDraft()),
      now: staleSubmitAt,
      audit: auditRecord(directContext(applicant.cookie), {
        actorUserId: applicant.userId,
        action: auditActions.applicationSubmitted,
        entityType: 'SEB_APPLICATION',
        entityId: expansion.id,
        now: staleSubmitAt,
      }),
    })).toBe(false)
    await env.DB.prepare(
      `UPDATE seb_funding_award SET status = 'ACTIVE', updated_at = ? WHERE id = ?`,
    ).bind(Date.now(), awardId).run()
    const submittedExpansion = await graphql<{
      seb: { application: { submit: { success: boolean; response: { status: string } | null } } }
    }>(`mutation { seb { application { submit(input: {
      applicationId: "${expansion.id}", expectedVersion: ${savedExpansion.currentVersion}, expectedStatusVersion: 1
    }) { success response { status } } } } }`, {}, applicant.cookie)
    expect(submittedExpansion.data?.seb.application.submit)
      .toEqual({ success: true, response: { status: 'SUBMITTED' } })

    // A rejected attempt can retry only in a later cycle. Creating the retry
    // cancels the old link and claims the same award for the replacement in one
    // guarded batch.
    await env.DB.prepare(
      `UPDATE seb_application SET status = 'REJECTED', status_version = status_version + 1,
        updated_at = ? WHERE id = ?`,
    ).bind(Date.now(), expansion.id).run()
    const retryCycle = await insertOpenCycle(applicant.userId)
    const retry = await graphql<{
      seb: { application: { startExpansion: { success: boolean; message: string | null; response: { id: string } | null } } }
    }>(`mutation { seb { application { startExpansion(input: {
      enterpriseId: "${enterprise.id}", programmeCycleId: "${retryCycle}"
    }) { success message response { id } } } } }`, {}, applicant.cookie)
    expect(retry.data?.seb.application.startExpansion).toMatchObject({
      success: true,
      response: { id: expect.any(String) },
    })
    const retryId = retry.data?.seb.application.startExpansion.response?.id
    expect(await env.DB.prepare(
      `SELECT application_id AS applicationId, status, current_funding_award_id AS awardId
       FROM seb_application_qualifying_award
       WHERE application_id IN (?, ?) ORDER BY application_id`,
    ).bind(expansion.id, retryId).all()).toMatchObject({
      results: expect.arrayContaining([
        { applicationId: expansion.id, status: 'CANCELLED', awardId: null },
        { applicationId: retryId, status: 'ACTIVE', awardId },
      ]),
    })

    if (!retryId) throw new Error('retry application missing')
    const transitionTime = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
          amount_paise, occurred_at, external_reference, reason_category_id,
          applicant_message, recorded_by_user_id, created_at
        ) VALUES (?, ?, 3, 'REVERSAL', ?, 9000000, ?, ?,
          (SELECT id FROM seb_programme_cycle_reason WHERE context = 'RELEASE_REVERSAL' LIMIT 1),
          'Test reversal.', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        awardId,
        release.id,
        transitionTime,
        `FINAL-REVERSAL-${awardId}`,
        applicant.userId,
        transitionTime,
      ),
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
          bank_account_verified_at, performance_agreement_reference,
          performance_agreement_executed_at, physical_verification_required,
          applicant_message, recorded_by_user_id, created_at
        ) VALUES (?, ?, 4, 'RELEASE', 1000000, ?, ?, 'TTM-TEST', '2025-01-01',
          ?, 'AGREEMENT-TEST', ?, 0, 'Test release.', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        awardId,
        transitionTime,
        `SECOND-RELEASE-${awardId}`,
        transitionTime,
        transitionTime,
        applicant.userId,
        transitionTime,
      ),
    ])
    const submitRetry = async () => graphql<{
      seb: { application: { submit: { success: boolean; response: unknown } } }
    }>(`mutation { seb { application { submit(input: {
      applicationId: "${retryId}", expectedVersion: 1, expectedStatusVersion: 1
    }) { success response { id } } } } }`, {}, applicant.cookie)
    expect((await submitRetry()).data?.seb.application.submit)
      .toEqual({ success: false, response: null })
    await env.DB.prepare(
      `UPDATE seb_funding_award SET status = 'SUSPENDED', updated_at = ? WHERE id = ?`,
    ).bind(Date.now(), awardId).run()
    expect((await submitRetry()).data?.seb.application.submit)
      .toEqual({ success: false, response: null })
    const saveWithoutAward = await graphql<{
      seb: { application: { saveDraft: { success: boolean; response: unknown } } }
    }>(`mutation Save($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success response { id } } }
    } }`, { input: {
      applicationId: retryId,
      expectedVersion: 1,
      expectedStatusVersion: 1,
      draft: completeDraft,
    } }, applicant.cookie)
    expect(saveWithoutAward.data?.seb.application.saveDraft)
      .toEqual({ success: false, response: null })
  })

  it('blocks expansion before the calendar anniversary and after effective releases are reversed', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const initial = await startInitial(applicant.cookie, enterprise.id, cycleId)
    const { awardId } = await insertActiveAward(applicant.userId, initial.id, Date.now())
    const eligibility = async () => graphql<{
      seb: { application: { expansionEligibility: { response: {
        eligible: boolean
        reasons: Array<{ code: string; message: string; obligationId: string | null }>
      } } } }
    }>(`query { seb { application { expansionEligibility(
      enterpriseId: "${enterprise.id}", programmeCycleId: "${cycleId}"
    ) { response { eligible reasons { code message obligationId } } } } } }`, {}, applicant.cookie)
    expect((await eligibility()).data?.seb.application.expansionEligibility.response)
      .toEqual({ eligible: false, reasons: [{
        code: 'TWELVE_MONTH_WAIT_NOT_COMPLETE',
        message:
          'Twelve months of operation since the first release have not been completed yet.',
        obligationId: null,
      }] })

    const release = await env.DB.prepare(
      `SELECT id FROM seb_disbursement WHERE funding_award_id = ? AND sequence_number = 1`,
    ).bind(awardId).first<{ id: string }>()
    if (!release) throw new Error('release missing')
    await env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
        amount_paise, occurred_at, external_reference, reason_category_id,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 2, 'REVERSAL', ?, 10000000, ?, ?,
        (SELECT id FROM seb_programme_cycle_reason WHERE context = 'RELEASE_REVERSAL' LIMIT 1),
        'Test reversal.', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      awardId,
      release.id,
      Date.now(),
      `FULL-REVERSAL-${awardId}`,
      applicant.userId,
      Date.now(),
    ).run()
    expect((await eligibility()).data?.seb.application.expansionEligibility.response)
      .toEqual({ eligible: false, reasons: [{
        code: 'NO_POSITIVE_RELEASE',
        message: 'No funds have been released and retained under the award yet.',
        obligationId: null,
      }] })

    const retainedReleaseId = crypto.randomUUID()
    const overReversedReleaseId = crypto.randomUUID()
    const ledgerTime = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
          bank_account_verified_at, performance_agreement_reference,
          performance_agreement_executed_at, physical_verification_required,
          applicant_message, recorded_by_user_id, created_at
        ) VALUES (?, ?, 3, 'RELEASE', 100, ?, ?, 'TTM-TEST', '2025-01-01',
          ?, 'AGREEMENT-TEST', ?, 0, 'Test release.', ?, ?)`,
      ).bind(
        retainedReleaseId,
        awardId,
        ledgerTime,
        `SMALL-RELEASE-${awardId}`,
        ledgerTime,
        ledgerTime,
        applicant.userId,
        ledgerTime,
      ),
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
          bank_account_verified_at, performance_agreement_reference,
          performance_agreement_executed_at, physical_verification_required,
          applicant_message, recorded_by_user_id, created_at
        ) VALUES (?, ?, 4, 'RELEASE', 100, ?, ?, 'TTM-TEST', '2025-01-01',
          ?, 'AGREEMENT-TEST', ?, 0, 'Test release.', ?, ?)`,
      ).bind(
        overReversedReleaseId,
        awardId,
        ledgerTime,
        `OVER-REVERSED-RELEASE-${awardId}`,
        ledgerTime,
        ledgerTime,
        applicant.userId,
        ledgerTime,
      ),
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
          amount_paise, occurred_at, external_reference, reason_category_id,
          applicant_message, recorded_by_user_id, created_at
        ) VALUES (?, ?, 5, 'REVERSAL', ?, 300, ?, ?,
          (SELECT id FROM seb_programme_cycle_reason WHERE context = 'RELEASE_REVERSAL' LIMIT 1),
          'Test reversal.', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        awardId,
        overReversedReleaseId,
        ledgerTime,
        `OVER-REVERSAL-${awardId}`,
        applicant.userId,
        ledgerTime,
      ),
    ])
    expect((await eligibility()).data?.seb.application.expansionEligibility.response)
      .toEqual({ eligible: false, reasons: [{
        code: 'NO_POSITIVE_RELEASE',
        message: 'No funds have been released and retained under the award yet.',
        obligationId: null,
      }] })

    // A later release restores a positive award-wide balance, while the
    // over-reversed release remains non-qualifying. Its own utilization
    // obligation must therefore be skipped rather than gate the application.
    const restoringReleaseId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, amount_paise,
        occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
        bank_account_verified_at, performance_agreement_reference,
        performance_agreement_executed_at, physical_verification_required,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 6, 'RELEASE', 300, ?, ?, 'TTM-RESTORE', '2025-01-01',
        ?, 'AGREEMENT-RESTORE', ?, 0, 'Restoring release.', ?, ?)`)
        .bind(
          restoringReleaseId, awardId, ledgerTime, `RESTORING-RELEASE-${awardId}`,
          ledgerTime, ledgerTime, applicant.userId, ledgerTime,
        ),
      env.DB.prepare(`INSERT INTO seb_utilization_obligation (
        id, funding_award_id, release_disbursement_id, due_at, created_at
      ) VALUES (?, ?, ?, ?, ?)`).bind(
        crypto.randomUUID(), awardId, overReversedReleaseId,
        ledgerTime + 180 * 86_400_000, ledgerTime,
      ),
      env.DB.prepare(`INSERT INTO seb_programme_cycle_assessment_rule (
        id, programme_cycle_id, programme_cycle_version, assessment_type,
        required_outcome, created_at
      ) VALUES (?, ?, 1, 'UTILIZATION', 'PASSED', ?)`)
        .bind(crypto.randomUUID(), cycleId, ledgerTime),
    ])
    expect((await eligibility()).data?.seb.application.expansionEligibility.response)
      .toEqual({ eligible: false, reasons: [{
        code: 'TWELVE_MONTH_WAIT_NOT_COMPLETE',
        message:
          'Twelve months of operation since the first release have not been completed yet.',
        obligationId: null,
      }] })
  })
  it('tells the applicant what is editable, what changed, and what each status means', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const started = await graphql<{
      seb: { application: { startInitial: { response: {
        id: string
        editableSections: string[]
      } | null } } }
    }>(`mutation($input: StartApplicationInput!) {
      seb { application { startInitial(input: $input) {
        response { id editableSections }
      } } }
    }`, { input: { enterpriseId: enterprise.id, programmeCycleId: cycleId } },
      applicant.cookie)
    const application = started.data?.seb.application.startInitial.response
    if (!application) throw new Error('Expected a started application.')

    // A draft is entirely open, which is exactly what `saveApplicationDraft`
    // allows for a DRAFT application.
    expect(application.editableSections).toEqual([
      'ENTERPRISE', 'APPLICANT_PROFILE', 'FINANCIAL', 'PRIOR_FUNDING',
      'EXPANSION', 'DOCUMENTS', 'DECLARATION',
    ])

    // Nothing has been submitted, so there is no baseline to compare against.
    const draftChangesQuery = `query($id: ID!) { seb { application {
      draftChanges(applicationId: $id) { success message response { sections } }
    } } }`
    type DraftChangesBody = {
      seb: { application: { draftChanges: { success: boolean; message: string | null } } }
    }
    // Another applicant's opaque application ID is indistinguishable from one
    // that never existed.
    const stranger = await applicantSession()
    const foreign = await graphql<DraftChangesBody>(draftChangesQuery,
      { id: application.id }, stranger.cookie)
    expect(foreign.data?.seb.application.draftChanges).toMatchObject({
      success: false, message: 'The application was not found.',
    })

    const noBaseline = await graphql<DraftChangesBody>(draftChangesQuery,
      { id: application.id }, applicant.cookie)
    expect(noBaseline.data?.seb.application.draftChanges).toMatchObject({
      success: false,
      message: 'This application has not been submitted yet, so there is nothing to compare.',
    })

    const guide = await graphql<{
      seb: { application: { statusGuide: { response: { statuses: Array<{
        status: string
        label: string
        explanation: string
        nextActor: string
        nextAction: string | null
      }> } } } }
    }>(`query { seb { application { statusGuide { response { statuses {
      status label explanation nextActor nextAction
    } } } } } }`, {}, applicant.cookie)
    const statuses = guide.data?.seb.application.statusGuide.response.statuses ?? []
    // Every status the workflow can produce is explained, in workflow order.
    expect(statuses.map((entry) => entry.status)).toEqual([
      'DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED',
      'PARTNER_BANK_EVALUATION', 'TTM_REVIEW', 'APPROVED', 'REJECTED',
      'SANCTIONED', 'DISBURSED', 'CANCELLED',
    ])
    expect(statuses.every((entry) => entry.label && entry.explanation)).toBe(true)
    expect(statuses.find((entry) => entry.status === 'DRAFT')).toMatchObject({
      nextActor: 'APPLICANT',
      nextAction: 'Complete every section and the required documents, then submit.',
    })
    expect(statuses.find((entry) => entry.status === 'DESK_REVIEW')).toMatchObject({
      nextActor: 'PROGRAMME_OFFICE', nextAction: null,
    })
    expect(statuses.find((entry) => entry.status === 'REJECTED')?.nextActor).toBe('NOBODY')
    // Staff do not commit to a completion date, so nothing here may imply one.
    const guideText = JSON.stringify(statuses)
    for (const timing of ['days', 'weeks', 'within', 'by ']) {
      expect(guideText.toLowerCase()).not.toContain(timing)
    }
  })

  it('lists the applicant own cycles including closed ones, separately from startable ones', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    await graphql(`mutation($input: StartApplicationInput!) {
      seb { application { startInitial(input: $input) { success } } }
    }`, { input: { enterpriseId: enterprise.id, programmeCycleId: cycleId } },
      applicant.cookie)

    const cycleQuery = `query { seb { application {
      availableProgrammeCycles { response { cycles {
        id cycleCode displayName status applicantGuidance opensAt closesAt
      } } }
      myProgrammeCycles { response { cycles { id status } } }
    } } }`
    type CycleBody = {
      seb: { application: {
        availableProgrammeCycles: { response: { cycles: Array<{
          id: string; displayName: string; status: string; applicantGuidance: string | null
        }> } }
        myProgrammeCycles: { response: { cycles: Array<{ id: string; status: string }> } }
      } }
    }
    const open = await graphql<CycleBody>(cycleQuery, {}, applicant.cookie)
    expect(open.data?.seb.application.availableProgrammeCycles.response.cycles)
      .toContainEqual(expect.objectContaining({
        id: cycleId,
        displayName: 'Mission SEP Test Cycle',
        status: 'OPEN',
      }))
    expect(open.data?.seb.application.myProgrammeCycles.response.cycles)
      .toEqual([{ id: cycleId, status: 'OPEN' }])

    // Once the cycle closes, the applicant keeps it as read-only history while
    // it disappears from the only list a "start application" action may use.
    await env.DB.prepare(
      `UPDATE seb_programme_cycle SET status = 'CLOSED', closes_at = ? WHERE id = ?`,
    ).bind(Date.now() - 1_000, cycleId).run()

    const closed = await graphql<CycleBody>(cycleQuery, {}, applicant.cookie)
    expect(closed.data?.seb.application.availableProgrammeCycles.response.cycles)
      .toEqual([])
    expect(closed.data?.seb.application.myProgrammeCycles.response.cycles)
      .toEqual([{ id: cycleId, status: 'CLOSED' }])

    // History is scoped to work the applicant can still see. Deleting their
    // only draft in the cycle removes the cycle too, rather than leaving a
    // read-only entry with nothing in it to open.
    await env.DB.prepare(
      `UPDATE seb_application SET deleted_at = ? WHERE programme_cycle_id = ?`,
    ).bind(Date.now(), cycleId).run()
    const withoutApplications = await graphql<CycleBody>(cycleQuery, {}, applicant.cookie)
    expect(withoutApplications.data?.seb.application.myProgrammeCycles.response.cycles)
      .toEqual([])

    // A cycle an administrator removed is gone from the applicant's history as
    // well, the same way every other applicant-facing cycle read treats it.
    await env.DB.prepare(
      `UPDATE seb_application SET deleted_at = NULL WHERE programme_cycle_id = ?`,
    ).bind(cycleId).run()
    await env.DB.prepare('UPDATE seb_programme_cycle SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), cycleId).run()
    const deletedCycle = await graphql<CycleBody>(cycleQuery, {}, applicant.cookie)
    expect(deletedCycle.data?.seb.application.myProgrammeCycles.response.cycles)
      .toEqual([])
  })

  it('names the applications that block an enterprise deletion', async () => {
    const applicant = await applicantSession()
    const cycleId = await insertOpenCycle(applicant.userId)
    const enterprise = await createEnterprise(applicant.cookie)
    const started = await graphql<{
      seb: { application: { startInitial: { response: { id: string } | null } } }
    }>(`mutation($input: StartApplicationInput!) {
      seb { application { startInitial(input: $input) { response { id } } } }
    }`, { input: { enterpriseId: enterprise.id, programmeCycleId: cycleId } },
      applicant.cookie)
    const applicationId = started.data?.seb.application.startInitial.response?.id
    if (!applicationId) throw new Error('Expected a started application.')

    const deleteQuery = `mutation($input: EnterpriseDeletionInput!) {
      seb { enterprise { softDelete(input: $input) {
        success message response { id } blockers {
          applicationId referenceNumber status hasAward
        }
      } } }
    }`
    type DeletionBody = {
      seb: { enterprise: { softDelete: {
        success: boolean
        message: string | null
        response: { id: string } | null
        blockers: Array<{
          applicationId: string
          referenceNumber: string | null
          status: string
          hasAward: boolean
        }>
      } } }
    }
    const blocked = await graphql<DeletionBody>(deleteQuery,
      { input: { id: enterprise.id, expectedVersion: enterprise.currentVersion } },
      applicant.cookie)
    expect(blocked.data?.seb.enterprise.softDelete).toEqual({
      success: false,
      message:
        'Delete all drafts first. Submitted applications and awards retain their enterprise.',
      response: null,
      // The exact application is named, so the applicant knows what to remove.
      blockers: [{
        applicationId,
        referenceNumber: null,
        status: 'DRAFT',
        hasAward: false,
      }],
    })

    // With the draft removed the enterprise deletes, and the field is present
    // and empty rather than absent.
    const removedDraft = await graphql<{
      seb: { application: { softDeleteDraft: { success: boolean; message: string | null } } }
    }>(`mutation($input: ApplicationDeletionInput!) {
      seb { application { softDeleteDraft(input: $input) { success message } } }
    }`, { input: {
      applicationId, expectedVersion: 1, expectedStatusVersion: 1, reason: 'No longer needed.',
    } }, applicant.cookie)
    expect(removedDraft.data?.seb.application.softDeleteDraft.success,
      JSON.stringify(removedDraft)).toBe(true)

    const deleted = await graphql<DeletionBody>(deleteQuery,
      { input: { id: enterprise.id, expectedVersion: enterprise.currentVersion } },
      applicant.cookie)
    expect(deleted.data?.seb.enterprise.softDelete).toMatchObject({
      success: true, blockers: [],
    })

    // Another applicant's enterprise reports nothing at all, so the richer
    // response cannot be used to probe somebody else's history.
    const stranger = await applicantSession()
    const probed = await graphql<DeletionBody>(deleteQuery,
      { input: { id: enterprise.id, expectedVersion: 1 } }, stranger.cookie)
    expect(probed.data?.seb.enterprise.softDelete).toMatchObject({
      success: false, blockers: [],
    })
  })

})

describe('searching and filtering the applicant lists', () => {
  it('narrows enterprises by name prefix, status and sector, and reports the total', async () => {
    const applicant = await applicantSession()
    for (const [index, name] of [
      'Khumulwng Food Works',
      'Khumulwng Handloom',
      'Agartala Textiles',
    ].entries()) {
      await createEnterprise(applicant.cookie, {
        ...profile,
        name,
        // The registration number is unique across the table.
        registrationNumber: `UDYAM-SEARCH-${index}`,
      })
    }

    const list = async (variables: Record<string, unknown>) => {
      const response = await graphql<{
        seb: {
          enterprise: {
            mine: {
              success: boolean
              message: string | null
              response: {
                nodes: { name: string }[]
                pageInfo: { totalCount: number; hasNextPage: boolean }
              } | null
            }
          }
        }
      }>(
        `query Mine($search: String, $status: EnterpriseStatus, $sector: BusinessSector, $first: Int) {
          seb { enterprise { mine(search: $search, status: $status, sector: $sector, first: $first) {
            success message response { nodes { name } pageInfo { totalCount hasNextPage } }
          } } }
        }`,
        variables,
        applicant.cookie,
      )
      return response.data?.seb.enterprise.mine
    }

    const all = await list({})
    expect(all?.response?.pageInfo.totalCount).toBe(3)

    // Prefix, and case-insensitive: somebody types what they remember, not what
    // was stored.
    const searched = await list({ search: 'khumulwng' })
    expect(searched?.response?.nodes.map((node) => node.name).sort()).toEqual([
      'Khumulwng Food Works',
      'Khumulwng Handloom',
    ])
    expect(searched?.response?.pageInfo.totalCount).toBe(2)

    // Prefix only. "Food" appears inside a name but not at the start of one.
    expect((await list({ search: 'Food' }))?.response?.nodes).toEqual([])

    // A GLOB metacharacter is a character, not a wildcard.
    expect((await list({ search: '*' }))?.response?.nodes).toEqual([])

    // Registration makes an enterprise ACTIVE, so the status filter narrows to
    // all of them or to none — both of which prove it reaches the column.
    expect((await list({ status: 'ACTIVE' }))?.response?.pageInfo.totalCount).toBe(3)
    expect((await list({ status: 'INACTIVE' }))?.response?.pageInfo.totalCount).toBe(0)

    // Sector lives on the version row, so this proves the filter reaches
    // through the join.
    expect((await list({ sector: 'FOOD_PROCESSING' }))?.response?.pageInfo.totalCount).toBe(3)
    expect((await list({ sector: 'TOURISM_AND_HOSPITALITY' }))?.response?.pageInfo.totalCount).toBe(
      0,
    )
  })

  it('narrows applications by cycle, type and reference prefix', async () => {
    const applicant = await applicantSession()
    const enterprise = await createEnterprise(applicant.cookie, {
      ...profile,
      registrationNumber: 'UDYAM-APPFILTER',
    })
    const cycleId = await insertOpenCycle(applicant.userId)
    const application = await startInitial(applicant.cookie, enterprise.id, cycleId)

    const list = async (variables: Record<string, unknown>) => {
      const response = await graphql<{
        seb: {
          application: {
            mine: {
              response: {
                nodes: { id: string }[]
                pageInfo: { totalCount: number }
              } | null
            }
          }
        }
      }>(
        `query Mine($programmeCycleId: ID, $applicationType: ApplicationType, $search: String) {
          seb { application { mine(
            programmeCycleId: $programmeCycleId
            applicationType: $applicationType
            search: $search
          ) { response { nodes { id } pageInfo { totalCount } } } } }
        }`,
        variables,
        applicant.cookie,
      )
      return response.data?.seb.application.mine.response
    }

    expect((await list({ programmeCycleId: cycleId }))?.nodes.map((node) => node.id))
      .toContain(application.id)
    expect((await list({ programmeCycleId: crypto.randomUUID() }))?.pageInfo.totalCount).toBe(0)

    expect((await list({ applicationType: 'INITIAL' }))?.nodes.map((node) => node.id))
      .toContain(application.id)
    expect((await list({ applicationType: 'EXPANSION' }))?.pageInfo.totalCount).toBe(0)

    // A draft has no reference number yet, so searching for one finds nothing —
    // which is the honest answer, not an empty filter falling through to all.
    expect((await list({ search: 'SEP-' }))?.pageInfo.totalCount).toBe(0)
  })

  it('counts the whole matching set, not the page', async () => {
    const applicant = await applicantSession()
    for (const index of [1, 2, 3]) {
      await createEnterprise(applicant.cookie, {
        ...profile,
        name: `Counted ${index}`,
        registrationNumber: `UDYAM-COUNT-${index}`,
      })
    }

    const response = await graphql<{
      seb: {
        enterprise: {
          mine: {
            response: {
              nodes: { name: string }[]
              pageInfo: { totalCount: number; hasNextPage: boolean }
            } | null
          }
        }
      }
    }>(
      `query { seb { enterprise { mine(first: 2, search: "Counted") {
        response { nodes { name } pageInfo { totalCount hasNextPage } }
      } } } }`,
      {},
      applicant.cookie,
    )
    const page = response.data?.seb.enterprise.mine.response
    // The point of the total: a page of two out of three matches.
    expect(page?.nodes).toHaveLength(2)
    expect(page?.pageInfo.hasNextPage).toBe(true)
    expect(page?.pageInfo.totalCount).toBe(3)
  })
})
