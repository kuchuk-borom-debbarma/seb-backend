import { env } from 'cloudflare:test'
import { buildSchema, parse, validate } from 'graphql'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../src/db'
import { singleAuthMutationRule, singleSebMutationRule } from '../src/graphql/validation'
import { decodeCursor, encodeCursor, pageSize } from '../src/services/application/pagination'
import type {
  ApplicationOperationContext,
  ApplicationSnapshot,
  EnterpriseProfileInput,
} from '../src/services/application/types'
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  createDocumentObjectKey,
  createDownloadAuthorization,
  createUploadAuthorization,
  sanitizeFilename,
  validSha256Base64,
  verifyUploadedObject,
} from '../src/services/application/uploads'
import {
  addUtcCalendarMonths,
  fullUtcCalendarMonths,
  normalizeDraftInput,
  normalizeEnterpriseProfile,
  parseDateOnly,
  validateSubmissionSnapshot,
} from '../src/services/application/validation'

const completeSnapshot = (): ApplicationSnapshot => ({
  version: 1,
  programmeCycleVersion: 1,
  applicationType: 'INITIAL',
  phaseNumber: 1,
  changeType: 'SAVE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  declarationAcceptedAt: null,
  enterprise: {
    businessName: 'Example Foods',
    establishmentDate: '2026-01-15',
    registrationType: 'UDYAM',
    registrationNumber: 'UDYAM-1',
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
    totalProjectCostPaise: 50_000_000,
    seedFundRequestedPaise: 10_000_000,
    bankLoanProposedPaise: 0,
    promoterContributionPaise: 1_000_000,
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
  priorSanctionOrderNumber: null,
  priorSanctionDate: null,
  priorNetDisbursedAmountPaise: null,
  continuousOperationMonths: null,
})

const allEvidence = new Set([
  'IDENTITY_AGE_PROOF',
  'ST_CERTIFICATE',
  'ADDRESS_PROOF',
  'BUSINESS_REGISTRATION',
  'DPR',
  'BANK_DETAILS',
] as const)

const signingContext = (): ApplicationOperationContext => ({
  db: createDatabase(env.DB),
  env,
  requestHeaders: new Headers(),
  requestUrl: 'https://api.example.test/graphql',
  responseHeaders: new Headers(),
})

const digest = async (bytes: Uint8Array) => {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const value = await crypto.subtle.digest('SHA-256', input)
  return {
    buffer: value,
    base64: btoa(String.fromCharCode(...new Uint8Array(value))),
  }
}

describe('application pure business rules', () => {
  it('parses real date-only values and uses calendar month boundaries', () => {
    expect(parseDateOnly('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(parseDateOnly('2023-02-29')).toBeNull()
    expect(parseDateOnly('2024/02/29')).toBeNull()
    expect(addUtcCalendarMonths(new Date('2024-02-29T12:30:00Z'), 12).toISOString())
      .toBe('2025-02-28T12:30:00.000Z')
    expect(fullUtcCalendarMonths(
      new Date('2024-02-29T12:30:00Z'),
      new Date('2025-02-28T12:29:59Z'),
    )).toBe(11)
    expect(fullUtcCalendarMonths(
      new Date('2024-02-29T12:30:00Z'),
      new Date('2025-02-28T12:30:00Z'),
    )).toBe(12)
  })

  it('normalizes a complete replacement draft and reports malformed fields', () => {
    const draft = completeSnapshot()
    draft.enterprise.businessName = '  Example   Foods  '
    draft.enterprise.registrationNumber = 'udyam-1'
    draft.applicantProfile.contactEmail = '  RINA@EXAMPLE.TEST '
    draft.applicantProfile.contactNumber = '+91 (98765) 43210'
    const normalized = normalizeDraftInput(draft)
    expect(normalized.value?.enterprise).toMatchObject({
      businessName: 'Example Foods',
      registrationNumber: 'UDYAM-1',
    })
    expect(normalized.value?.applicantProfile).toMatchObject({
      contactEmail: 'rina@example.test',
      contactNumber: '+919876543210',
    })

    const nullableContacts = completeSnapshot()
    nullableContacts.applicantProfile.contactEmail = null
    nullableContacts.applicantProfile.contactNumber = null
    expect(normalizeDraftInput(nullableContacts).value?.applicantProfile).toMatchObject({
      contactEmail: null,
      contactNumber: null,
    })

    const incomplete = structuredClone(draft) as unknown as Record<string, unknown>
    delete incomplete.financial
    expect(normalizeDraftInput(incomplete as never).issues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_SECTION', field: 'financial' }),
    )

    const malformed = completeSnapshot()
    malformed.enterprise.gstin = 'bad'
    malformed.enterprise.establishmentDate = '2023-02-29'
    malformed.applicantProfile.dateOfBirth = '2023-02-29'
    malformed.applicantProfile.contactEmail = 'bad'
    malformed.applicantProfile.contactNumber = '123'
    malformed.applicantProfile.businessPinCode = '12'
    malformed.financial.totalProjectCostPaise = -1
    malformed.priorFunding.governmentFundingAmountPaise = -1
    malformed.priorFunding.governmentFundingSanctionYear = 12
    expect(normalizeDraftInput(malformed).issues.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'INVALID_GSTIN',
        'INVALID_DATE',
        'INVALID_EMAIL',
        'INVALID_PHONE',
        'INVALID_PIN',
        'INVALID_MONEY',
        'INVALID_YEAR',
      ]),
    )
  })

  it('requires every nullable snapshot key and rejects invalid enum, flag, and length values', () => {
    for (const [section, key, expectedSection] of [
      ['enterprise', 'businessName', 'ENTERPRISE'],
      ['applicantProfile', 'designation', 'APPLICANT_PROFILE'],
      ['priorFunding', 'existingBankName', 'PRIOR_FUNDING'],
      ['documents', 'nocRequired', 'DOCUMENTS'],
      ['declaration', 'declarationPlace', 'DECLARATION'],
    ] as const) {
      const draft = completeSnapshot() as unknown as Record<string, Record<string, unknown>>
      delete draft[section][key]
      expect(normalizeDraftInput(draft as never).issues).toContainEqual(
        expect.objectContaining({ section: expectedSection, field: key, code: 'MISSING_SNAPSHOT_FIELD' }),
      )
    }

    const draft = completeSnapshot()
    draft.enterprise.registrationType = 'INVALID' as never
    draft.enterprise.businessSector = 'INVALID' as never
    draft.enterprise.applicationCategory = 'INVALID' as never
    draft.applicantProfile.designation = 'INVALID' as never
    draft.applicantProfile.gender = 'INVALID' as never
    draft.priorFunding.existingCreditStatus = 'INVALID' as never
    draft.declaration.relationshipType = 'INVALID' as never
    draft.documents.nocRequired = 'yes' as never
    draft.enterprise.businessName = 'x'.repeat(201)
    expect(normalizeDraftInput(draft).issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(['INVALID_ENUM', 'INVALID_BOOLEAN', 'TOO_LONG']),
    )
  })

  it('normalizes enterprise profiles and rejects inconsistent conditional values', () => {
    const profile: EnterpriseProfileInput = {
      name: '  Example   Foods ',
      establishmentDate: '2026-01-15',
      registrationType: 'UDYAM',
      registrationNumber: 'udyam-1',
      gstin: null,
      businessSector: 'FOOD_PROCESSING',
      otherBusinessSector: null,
      businessBlockOrVillage: ' Khumulwng ',
      businessDistrict: ' West Tripura ',
      businessPinCode: '799045',
      contactNumber: '+91 (98765) 43210',
      contactEmail: ' OWNER@EXAMPLE.TEST ',
    }
    expect(normalizeEnterpriseProfile(profile).value).toMatchObject({
      name: 'Example Foods',
      registrationNumber: 'UDYAM-1',
      contactEmail: 'owner@example.test',
    })
    expect(normalizeEnterpriseProfile({
      ...profile,
      contactEmail: null,
      contactNumber: null,
    }).value).toMatchObject({ contactEmail: null, contactNumber: null })
    expect(normalizeEnterpriseProfile({ ...profile, name: ' ' }).message).toMatch(/2 to 200/u)
    expect(normalizeEnterpriseProfile({ ...profile, registrationType: 'NONE' }).message)
      .toMatch(/Registration details/u)
    expect(normalizeEnterpriseProfile({
      ...profile,
      businessSector: 'OTHER',
      otherBusinessSector: null,
    }).message).toMatch(/other business sector/u)
    expect(normalizeEnterpriseProfile({ ...profile, contactEmail: 'bad' }).message)
      .toMatch(/email/u)
    expect(normalizeEnterpriseProfile({ ...profile, establishmentDate: '2023-02-29' }).message)
      .toMatch(/real establishment date/u)
    expect(normalizeEnterpriseProfile({ ...profile, gstin: 'bad' }).message).toMatch(/GSTIN/u)
    expect(normalizeEnterpriseProfile({ ...profile, businessPinCode: '1' }).message).toMatch(/PIN/u)
    expect(normalizeEnterpriseProfile({ ...profile, contactNumber: '1' }).message).toMatch(/phone/u)
    expect(normalizeEnterpriseProfile({
      ...profile,
      registrationNumber: 'x'.repeat(201),
    }).message).toMatch(/at most 200/u)
    expect(normalizeEnterpriseProfile({
      ...profile,
      registrationType: 'INVALID' as never,
    }).message).toMatch(/registration type/u)
    expect(normalizeEnterpriseProfile({
      ...profile,
      businessSector: 'INVALID' as never,
    }).message).toMatch(/business sector/u)
  })

  it('accepts a complete form without imposing a financing sum or seed ceiling', () => {
    const snapshot = completeSnapshot()
    snapshot.financial.seedFundRequestedPaise = Number.MAX_SAFE_INTEGER
    const report = validateSubmissionSnapshot(snapshot, allEvidence, new Date('2026-08-22T23:00:00Z'))
    expect(report).toEqual({ valid: true, issues: [] })
  })

  it('applies a resolved application ceiling and every normalized cycle document condition', () => {
    const snapshot = completeSnapshot()
    snapshot.enterprise.gstin = '16ABCDE1234F1Z5'
    snapshot.documents.nocRequired = true
    const policy = {
      minimumApplicantAge: 18, maximumApplicantAge: 60,
      categoryAMaximumMonths: 24, majorityOwnershipRequired: true,
      fundingCeilingState: 'RESOLVED' as const,
      fundingCeilingAmountPaise: 9_000_000,
      fundingCeilingScope: 'APPLICATION' as const,
      documentRules: [
        { documentType: 'IDENTITY_AGE_PROOF' as const, condition: 'ALWAYS' as const },
        { documentType: 'BUSINESS_REGISTRATION' as const, condition: 'WHEN_REGISTERED' as const },
        { documentType: 'GST_REGISTRATION' as const, condition: 'WHEN_GSTIN_PRESENT' as const },
        { documentType: 'NOC' as const, condition: 'WHEN_NOC_REQUIRED' as const },
        { documentType: 'DPR' as const, condition: 'OPTIONAL' as const },
      ],
    }
    const report = validateSubmissionSnapshot(snapshot, new Set(), new Date('2026-08-22Z'), policy)
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FUNDING_CEILING_EXCEEDED' }),
      expect.objectContaining({ field: 'IDENTITY_AGE_PROOF', code: 'DOCUMENT_REQUIRED' }),
      expect.objectContaining({ field: 'BUSINESS_REGISTRATION', code: 'DOCUMENT_REQUIRED' }),
      expect.objectContaining({ field: 'GST_REGISTRATION', code: 'DOCUMENT_REQUIRED' }),
      expect.objectContaining({ field: 'NOC', code: 'DOCUMENT_REQUIRED' }),
    ]))
    expect(report.issues).not.toContainEqual(expect.objectContaining({ field: 'DPR' }))

    const conditionalFalse = completeSnapshot()
    conditionalFalse.enterprise.registrationType = 'NONE'
    conditionalFalse.enterprise.registrationNumber = null
    conditionalFalse.documents.nocRequired = false
    conditionalFalse.financial.seedFundRequestedPaise = 1
    const falseReport = validateSubmissionSnapshot(
      conditionalFalse,
      new Set(['IDENTITY_AGE_PROOF']),
      new Date('2026-08-22Z'),
      { ...policy, fundingCeilingScope: 'PHASE' },
    )
    expect(falseReport.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FUNDING_CEILING_EXCEEDED' }),
      expect.objectContaining({ field: 'BUSINESS_REGISTRATION' }),
      expect.objectContaining({ field: 'GST_REGISTRATION' }),
      expect.objectContaining({ field: 'NOC' }),
    ]))
  })

  it('applies age, category, conditional-data, declaration, and document rules', () => {
    const snapshot = completeSnapshot()
    snapshot.enterprise.applicationCategory = 'CATEGORY_B'
    snapshot.enterprise.establishmentDate = '2024-08-22'
    snapshot.enterprise.businessSector = 'OTHER'
    snapshot.enterprise.otherBusinessSector = null
    snapshot.enterprise.majorityOwnershipConfirmed = false
    snapshot.applicantProfile.dateOfBirth = '2008-08-23'
    snapshot.priorFunding.receivedGovernmentFunding = true
    snapshot.priorFunding.governmentFundingAmountPaise = 1
    snapshot.priorFunding.governmentFundingSanctionYear = 2025
    snapshot.priorFunding.hasExistingBankCredit = true
    snapshot.priorFunding.existingCreditAmountPaise = 1
    snapshot.documents.nocRequired = true
    snapshot.declaration.declarationAccepted = false
    const report = validateSubmissionSnapshot(snapshot, new Set(), new Date('2026-08-22T23:00:00Z'))
    expect(report.valid).toBe(false)
    expect(report.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'CATEGORY_MISMATCH',
      'MUST_CONFIRM',
      'AGE_INELIGIBLE',
      'REQUIRED',
      'MUST_ACCEPT',
      'DOCUMENT_REQUIRED',
    ]))
    expect(report.issues.filter((item) => item.code === 'DOCUMENT_REQUIRED')).toHaveLength(7)

    const missingConditionalAmounts = completeSnapshot()
    missingConditionalAmounts.priorFunding.receivedGovernmentFunding = true
    missingConditionalAmounts.priorFunding.hasExistingBankCredit = true
    const conditionalReport = validateSubmissionSnapshot(
      missingConditionalAmounts,
      allEvidence,
      new Date('2026-08-22T23:00:00Z'),
    )
    expect(conditionalReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'governmentFundingAmountPaise', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'existingCreditAmountPaise', code: 'REQUIRED' }),
    ]))
  })

  it('rejects contradictory conditional answers and validates proposed/category-B forms', () => {
    const contradictory = completeSnapshot()
    contradictory.enterprise.registrationType = 'NONE'
    contradictory.enterprise.registrationNumber = 'SHOULD-BE-CLEAR'
    contradictory.priorFunding.governmentSchemeName = 'Old Scheme'
    contradictory.priorFunding.existingBankName = 'Old Bank'
    const report = validateSubmissionSnapshot(contradictory, allEvidence, new Date('2026-08-22Z'))
    expect(report.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'MUST_BE_EMPTY',
      'CONDITIONAL_FIELDS',
    ]))

    const categoryB = completeSnapshot()
    categoryB.enterprise.applicationCategory = 'CATEGORY_B'
    categoryB.enterprise.establishmentDate = null
    categoryB.applicantProfile.dateOfBirth = null
    categoryB.financial.totalProjectCostPaise = 0
    categoryB.financial.seedFundRequestedPaise = 0
    expect(validateSubmissionSnapshot(categoryB, allEvidence, new Date('2026-08-22Z')).issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'establishmentDate', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'dateOfBirth', code: 'REQUIRED' }),
        expect.objectContaining({ field: 'totalProjectCostPaise', code: 'MUST_BE_POSITIVE' }),
        expect.objectContaining({ field: 'seedFundRequestedPaise', code: 'MUST_BE_POSITIVE' }),
      ]))

    const future = completeSnapshot()
    future.enterprise.establishmentDate = '2027-01-01'
    expect(validateSubmissionSnapshot(future, allEvidence, new Date('2026-08-22Z')).issues)
      .toContainEqual(expect.objectContaining({ code: 'FUTURE_DATE' }))

    const categoryAOverAge = completeSnapshot()
    categoryAOverAge.enterprise.establishmentDate = '2020-01-01'
    expect(validateSubmissionSnapshot(
      categoryAOverAge,
      allEvidence,
      new Date('2026-08-22Z'),
    ).issues).toContainEqual(expect.objectContaining({
      field: 'applicationCategory',
      code: 'CATEGORY_MISMATCH',
      message: expect.stringContaining('Category A'),
    }))

    const missingRegistrationAndGstEvidence = completeSnapshot()
    missingRegistrationAndGstEvidence.enterprise.registrationNumber = null
    missingRegistrationAndGstEvidence.enterprise.gstin = '16ABCDE1234F1Z5'
    const conditionalEvidence = validateSubmissionSnapshot(
      missingRegistrationAndGstEvidence,
      allEvidence,
      new Date('2026-08-22T00:00:00Z'),
    ).issues
    expect(conditionalEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'registrationNumber', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'GST_REGISTRATION', code: 'DOCUMENT_REQUIRED' }),
    ]))
  })

  it('treats the full 24-month anniversary day as Category A', () => {
    const snapshot = completeSnapshot()
    snapshot.enterprise.establishmentDate = '2024-08-22'
    expect(validateSubmissionSnapshot(
      snapshot,
      allEvidence,
      new Date('2026-08-22T23:59:59Z'),
    ).issues).not.toContainEqual(expect.objectContaining({ code: 'CATEGORY_MISMATCH' }))
  })
})

describe('application cursors and private upload helpers', () => {
  it('enforces pagination bounds and round-trips opaque cursors', () => {
    expect(pageSize(undefined)).toBe(20)
    expect(pageSize(1)).toBe(1)
    expect(pageSize(100)).toBe(100)
    expect(pageSize(0)).toBeNull()
    expect(pageSize(101)).toBeNull()
    const date = new Date('2026-08-22T10:20:30Z')
    expect(decodeCursor(encodeCursor(date, 'public-id'))).toEqual({ timestamp: date, id: 'public-id' })
    expect(decodeCursor('not-base64')).toBe('INVALID')
    expect(decodeCursor(btoa(JSON.stringify([Date.now()])))).toBe('INVALID')
    expect(decodeCursor(btoa(JSON.stringify([8_640_000_000_000_001, 'id'])))).toBe('INVALID')
  })

  it('counts custom SEB mutations safely even for incomplete fragment documents', () => {
    const schema = buildSchema(`type Query { ok: Boolean } type Mutation { seb: Boolean }`)
    const missingFragment = validate(
      schema,
      parse('mutation { seb ...Missing }'),
      [singleSebMutationRule],
    )
    expect(missingFragment).toEqual([])
    const missingSelectionSet = validate(
      schema,
      parse('mutation { seb }'),
      [singleSebMutationRule],
    )
    expect(missingSelectionSet).toEqual([])
  })

  it('does not count GraphQL __typename meta-fields as business mutations', () => {
    const schema = buildSchema(`
      type Query { ok: Boolean }
      type Mutation { auth: AuthMutation!, seb: SebMutation! }
      type AuthMutation { signOut: Boolean }
      type SebMutation { enterprise: EnterpriseMutation! }
      type EnterpriseMutation { restore: Boolean }
    `)
    expect(validate(
      schema,
      parse('mutation { auth { __typename signOut } }'),
      [singleAuthMutationRule],
    )).toEqual([])
    expect(validate(
      schema,
      parse('mutation { seb { __typename enterprise { __typename restore } } }'),
      [singleSebMutationRule],
    )).toEqual([])
    // The one-action rule also runs on otherwise invalid documents; the normal
    // GraphQL validation rules are responsible for the missing selection set.
    expect(validate(
      schema,
      parse('mutation { seb { enterprise } }'),
      [singleSebMutationRule],
    )).toEqual([])
  })

  it('sanitizes filenames and creates opaque, application-bound object keys', () => {
    expect(sanitizeFilename(' ../a\\b\u0000.pdf ')).toBe('.._a_b.pdf')
    expect(sanitizeFilename(' ')).toBeNull()
    expect(sanitizeFilename('a'.repeat(256))).toBeNull()
    expect(validSha256Base64('A'.repeat(43) + '=')).toBe(true)
    expect(validSha256Base64('bad')).toBe(false)
    const key = createDocumentObjectKey('application-id', 'DPR')
    expect(key).toMatch(/^applications\/application-id\/documents\/DPR\/[0-9a-f-]+$/u)
  })

  it('signs private upload and attachment-only download authorizations', async () => {
    const context = signingContext()
    const checksum = 'A'.repeat(43) + '='
    const upload = await createUploadAuthorization(context, {
      objectKey: 'applications/a/documents/DPR/object',
      originalFilename: 'DPR “final”.pdf',
      contentType: ALLOWED_DOCUMENT_CONTENT_TYPES[0],
      sizeBytes: 1234,
      checksumSha256: checksum,
      expiresAt: new Date('2026-08-22T10:10:00Z'),
    })
    expect(upload.uploadUrl).toContain('X-Amz-Signature=')
    expect(upload.requiredHeaders).toEqual(expect.arrayContaining([
      { name: 'If-None-Match', value: '*' },
      { name: 'Content-Length', value: '1234' },
      { name: 'x-amz-checksum-sha256', value: checksum },
    ]))
    expect(new URL(upload.uploadUrl).searchParams.get('X-Amz-SignedHeaders'))
      .toContain('content-length')
    expect(upload.requiredHeaders.find((item) => item.name === 'Content-Disposition')?.value)
      .not.toContain('“')
    const download = await createDownloadAuthorization(
      context,
      'applications/a/documents/DPR/object',
      'project-report.pdf',
      new Date('2026-08-22T10:00:00Z'),
    )
    expect(download.downloadUrl).toContain('X-Amz-Signature=')
    expect(new URL(download.downloadUrl).searchParams.get('response-content-disposition'))
      .toBe('attachment; filename="project-report.pdf"')
    expect(download.expiresAt.toISOString()).toBe('2026-08-22T10:05:00.000Z')
    const missingConfiguration = signingContext()
    missingConfiguration.env = { ...env, R2_ACCESS_KEY_ID: undefined } as never
    await expect(createUploadAuthorization(missingConfiguration, {
      objectKey: 'object',
      originalFilename: 'file.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: checksum,
      expiresAt: new Date(),
    })).rejects.toThrow('R2 signing configuration is required.')
  })

  it('verifies size, MIME, checksum, and magic bytes against private R2', async () => {
    const key = `unit/${crypto.randomUUID()}`
    const bytes = new TextEncoder().encode('%PDF-valid')
    const checksum = await digest(bytes)
    await env.STORAGE.put(key, bytes, {
      httpMetadata: { contentType: 'application/pdf' },
      sha256: checksum.buffer,
    })
    expect(await verifyUploadedObject(env.STORAGE, {
      objectKey: key,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: checksum.base64,
    })).toEqual({ valid: true })
    expect((await verifyUploadedObject(env.STORAGE, {
      objectKey: 'missing',
      contentType: 'application/pdf',
      sizeBytes: 1,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
    expect((await verifyUploadedObject(env.STORAGE, {
      objectKey: key,
      contentType: 'application/pdf',
      sizeBytes: MAX_DOCUMENT_BYTES,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
    expect((await verifyUploadedObject(env.STORAGE, {
      objectKey: key,
      contentType: 'image/png',
      sizeBytes: bytes.length,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
    expect((await verifyUploadedObject(env.STORAGE, {
      objectKey: key,
      contentType: 'application/pdf',
      sizeBytes: bytes.length,
      checksumSha256: 'B'.repeat(43) + '=',
    })).valid).toBe(false)

    const fakePdfKey = `unit/${crypto.randomUUID()}`
    const fakeBytes = new TextEncoder().encode('not-a-pdf')
    const fakeChecksum = await digest(fakeBytes)
    await env.STORAGE.put(fakePdfKey, fakeBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      sha256: fakeChecksum.buffer,
    })
    expect((await verifyUploadedObject(env.STORAGE, {
      objectKey: fakePdfKey,
      contentType: 'application/pdf',
      sizeBytes: fakeBytes.length,
      checksumSha256: fakeChecksum.base64,
    })).valid).toBe(false)

    for (const [contentType, fileBytes] of [
      ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0x01])],
      ['image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ] as const) {
      const imageKey = `unit/${crypto.randomUUID()}`
      const imageChecksum = await digest(fileBytes)
      await env.STORAGE.put(imageKey, fileBytes, {
        httpMetadata: { contentType },
        sha256: imageChecksum.buffer,
      })
      expect(await verifyUploadedObject(env.STORAGE, {
        objectKey: imageKey,
        contentType,
        sizeBytes: fileBytes.length,
        checksumSha256: imageChecksum.base64,
      })).toEqual({ valid: true })
    }

    const uninspectableBucket = {
      head: async () => ({
        size: 1,
        httpMetadata: { contentType: 'application/pdf' },
        checksums: { sha256: checksum.buffer },
      }),
      get: async () => null,
    } as unknown as R2Bucket
    expect((await verifyUploadedObject(uninspectableBucket, {
      objectKey: 'object',
      contentType: 'application/pdf',
      sizeBytes: 1,
      checksumSha256: checksum.base64,
    })).valid).toBe(false)
  })
})
