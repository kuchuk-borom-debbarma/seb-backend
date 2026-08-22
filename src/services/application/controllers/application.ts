/** Applicant application, validation, expansion, and submission use cases. */
import { auditActions, applicationStatuses } from '../../../db/schema'
import { decodeCursor, pageSize } from '../pagination'
import {
  evaluateExpansionEligibility,
  expansionClaimFromAward,
  findApplicationVersion,
  findEnterpriseApplicationSource,
  findExpansionAwardForApplication,
  findLatestSubmittedVersion,
  findOpenProgrammeCycle,
  findOwnedApplicationHead,
  insertApplicationAggregate,
  listActiveDocumentTypes,
  listApplicationTimeline,
  listAvailableProgrammeCycles,
  listOpenRevisionSections,
  listOwnedApplications,
  loadOwnedApplication,
  saveApplicationSnapshot,
  setApplicationDeleted,
  snapshotRecordToPublic,
  submitApplicationSnapshot,
} from '../queries/application'
import {
  AUTH_REQUIRED_MESSAGE,
  auditRecord,
  completeGuardedOperation,
  currentApplicant,
  failure,
  firstValidationIssueMessage,
  requireInvariant,
  runConstraintRetry,
  runConstraintSafe,
  success,
} from '../support'
import type {
  Application,
  ApplicationDraftInput,
  ApplicationOperationContext,
  ApplicationSection,
  ApplicationStatus,
  ApplicationSummary,
  Connection,
  ExpansionClaim,
  ExpansionEligibility,
  ProgrammeCycle,
  SebResult,
  TimelineEvent,
  ValidationReport,
} from '../types'
import { normalizeDraftInput, validateSubmissionSnapshot } from '../validation'

const EMPTY_EXPANSION_CLAIM: ExpansionClaim = {
  priorSanctionOrderNumber: null,
  priorSanctionDate: null,
  priorNetDisbursedAmountPaise: null,
  continuousOperationMonths: null,
}

const currentDraft = (application: Application): ApplicationDraftInput => ({
  enterprise: application.snapshot.enterprise,
  applicantProfile: application.snapshot.applicantProfile,
  financial: application.snapshot.financial,
  priorFunding: application.snapshot.priorFunding,
  documents: application.snapshot.documents,
  declaration: application.snapshot.declaration,
})

const sourceDraft = (
  source: NonNullable<Awaited<ReturnType<typeof findEnterpriseApplicationSource>>>,
  applicantEmail: string,
): ApplicationDraftInput => {
  return {
    enterprise: {
      businessName: source.version.name,
      establishmentDate: source.version.establishmentDate,
      registrationType: source.version.registrationType,
      registrationNumber: source.version.registrationNumber,
      gstin: source.version.gstin,
      businessSector: source.version.businessSector,
      otherBusinessSector: source.version.otherBusinessSector,
      applicationCategory: null,
      majorityOwnershipConfirmed: null,
    },
    applicantProfile: {
      primaryApplicantName: null,
      designation: null,
      dateOfBirth: null,
      gender: null,
      businessBlockOrVillage: source.version.businessBlockOrVillage,
      businessDistrict: source.version.businessDistrict,
      businessPinCode: source.version.businessPinCode,
      contactNumber: source.version.contactNumber,
      contactEmail: source.version.contactEmail ?? applicantEmail,
    },
    financial: {
      totalProjectCostPaise: null,
      seedFundRequestedPaise: null,
      bankLoanProposedPaise: null,
      promoterContributionPaise: null,
    },
    priorFunding: {
      receivedGovernmentFunding: null,
      governmentSchemeName: null,
      governmentFundingAmountPaise: null,
      governmentFundingSanctionYear: null,
      hasExistingBankCredit: null,
      existingBankName: null,
      existingCreditAmountPaise: null,
      existingCreditStatus: null,
    },
    documents: { nocRequired: null },
    declaration: {
      relationshipType: null,
      relatedPersonName: null,
      declarationAccepted: null,
      declarationPlace: null,
    },
  }
}

const validExpectedVersions = (expectedVersion: number, expectedStatusVersion: number) =>
  Number.isInteger(expectedVersion) &&
  expectedVersion >= 1 &&
  Number.isInteger(expectedStatusVersion) &&
  expectedStatusVersion >= 1

export const availableProgrammeCycles = async (
  context: ApplicationOperationContext,
): Promise<SebResult<{ cycles: ProgrammeCycle[] }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  return success({ cycles: await listAvailableProgrammeCycles(context.db, new Date()) })
}

export const myApplications = async (
  input: {
    first?: number | null
    after?: string | null
    enterpriseId?: string | null
    status?: ApplicationStatus | null
    includeDeleted?: boolean | null
  },
  context: ApplicationOperationContext,
): Promise<SebResult<Connection<ApplicationSummary>>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const first = pageSize(input.first)
  const cursor = decodeCursor(input.after)
  if (first === null || cursor === 'INVALID') return failure('Invalid pagination input.')
  if (input.status && !applicationStatuses.includes(input.status)) {
    return failure('Select a valid application status.')
  }
  return success(
    await listOwnedApplications(context.db, {
      userId: applicant.id,
      first,
      cursor,
      enterpriseId: input.enterpriseId,
      status: input.status,
      includeDeleted: input.includeDeleted === true,
    }),
  )
}

export const applicationById = async (
  id: string,
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const application = await loadOwnedApplication(context.db, applicant.id, id, true)
  return application ? success(application) : failure('The application was not found.')
}

export const expansionEligibility = async (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<ExpansionEligibility>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const now = new Date()
  const [source, cycle] = await Promise.all([
    findEnterpriseApplicationSource(context.db, applicant.id, input.enterpriseId),
    findOpenProgrammeCycle(context.db, input.programmeCycleId, now),
  ])
  if (!source) return failure('The enterprise was not found or its funding case is not open.')
  if (!cycle) return failure('The programme cycle is not open.')
  const evaluated = await evaluateExpansionEligibility(context.db, source.fundingCase.id, now)
  return success(evaluated.result)
}

const startApplication = async (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
  expansion: boolean,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const now = new Date()
  const [source, cycle] = await Promise.all([
    findEnterpriseApplicationSource(context.db, applicant.id, input.enterpriseId),
    findOpenProgrammeCycle(context.db, input.programmeCycleId, now),
  ])
  if (!source) return failure('The enterprise was not found or its funding case is not open.')
  if (!cycle) return failure('The programme cycle is not open.')

  let phaseNumber = 1
  let qualifyingAwardId: string | null = null
  let qualifyingReleaseAt: Date | null = null
  let expansionClaim = EMPTY_EXPANSION_CLAIM
  if (expansion) {
    const evaluated = await evaluateExpansionEligibility(context.db, source.fundingCase.id, now)
    if (!evaluated.result.eligible || !evaluated.award || !evaluated.result.nextPhaseNumber) {
      return failure('The enterprise is not currently eligible for an expansion application.')
    }
    phaseNumber = evaluated.result.nextPhaseNumber
    qualifyingAwardId = evaluated.award.awardId
    qualifyingReleaseAt = evaluated.award.firstReleaseAt
    expansionClaim = expansionClaimFromAward(evaluated.award, now)
  }

  const applicationId = crypto.randomUUID()
  const inserted = await runConstraintSafe(() =>
    insertApplicationAggregate(context.db, {
      applicationId,
      applicantUserId: applicant.id,
      enterpriseId: source.enterprise.id,
      fundingCaseId: source.fundingCase.id,
      programmeCycleId: cycle.id,
      programmeCycleVersion: cycle.currentVersion,
      applicationType: expansion ? 'EXPANSION' : 'INITIAL',
      phaseNumber,
      draft: sourceDraft(source, applicant.email),
      expansionClaim,
      qualifyingAwardId,
      qualifyingReleaseAt,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: auditActions.applicationStarted,
        entityType: 'SEB_APPLICATION',
        entityId: applicationId,
        metadata: { type: expansion ? 'EXPANSION' : 'INITIAL', phaseNumber },
        now,
      }),
    }),
  )
  if (!inserted) return failure('Another application already exists for this phase.')
  return success(requireInvariant(
    await loadOwnedApplication(context.db, applicant.id, applicationId),
    'Created application could not be read.',
  ))
}

export const startInitialApplication = (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => startApplication(input, context, false)

export const startExpansionApplication = (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => startApplication(input, context, true)

type EditableApplicationSection = Exclude<ApplicationSection, 'EXPANSION'>

const sectionKeys: Record<EditableApplicationSection, keyof ApplicationDraftInput> = {
  ENTERPRISE: 'enterprise',
  APPLICANT_PROFILE: 'applicantProfile',
  FINANCIAL: 'financial',
  PRIOR_FUNDING: 'priorFunding',
  DOCUMENTS: 'documents',
  DECLARATION: 'declaration',
}

const sectionValue = (
  draft: ApplicationDraftInput,
  section: EditableApplicationSection,
): unknown => draft[sectionKeys[section]]

const revisionChangesAreAllowed = async (
  context: ApplicationOperationContext,
  applicationId: string,
  draft: ApplicationDraftInput,
): Promise<Set<ApplicationSection> | null> => {
  const [submitted, openSections] = await Promise.all([
    findLatestSubmittedVersion(context.db, applicationId),
    listOpenRevisionSections(context.db, applicationId),
  ])
  if (!submitted || openSections.size === 0) return null
  const submittedDraft = currentDraft({ snapshot: snapshotRecordToPublic(submitted) } as Application)
  const sections: EditableApplicationSection[] = [
    'ENTERPRISE',
    'APPLICANT_PROFILE',
    'FINANCIAL',
    'PRIOR_FUNDING',
    'DOCUMENTS',
    'DECLARATION',
  ]
  return sections.every(
    (section) =>
      openSections.has(section) ||
      JSON.stringify(sectionValue(draft, section)) ===
        JSON.stringify(sectionValue(submittedDraft, section)),
  ) ? openSections : null
}

const expansionEvidenceForHead = async (
  context: ApplicationOperationContext,
  application: Application,
  now: Date,
): Promise<{
  claim: ExpansionClaim
  qualifyingAwardId: string | null
  qualifyingReleaseAt: Date | null
} | null> => {
  if (application.applicationType === 'INITIAL') {
    return {
      claim: EMPTY_EXPANSION_CLAIM,
      qualifyingAwardId: null,
      qualifyingReleaseAt: null,
    }
  }
  const award = await findExpansionAwardForApplication(context.db, application.id)
  return award
    ? {
        claim: expansionClaimFromAward(award, now),
        qualifyingAwardId: award.awardId,
        qualifyingReleaseAt: award.firstReleaseAt,
      }
    : null
}

export const saveApplicationDraft = async (
  input: {
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    draft: ApplicationDraftInput
  },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!validExpectedVersions(input.expectedVersion, input.expectedStatusVersion)) {
    return failure('Expected versions must be positive integers.')
  }
  const application = await loadOwnedApplication(context.db, applicant.id, input.applicationId)
  if (!application) return failure('The application was not found.')
  if (
    application.currentVersion !== input.expectedVersion ||
    application.statusVersion !== input.expectedStatusVersion
  ) return failure('The application changed. Refresh it and try again.')
  if (application.status !== 'DRAFT' && application.status !== 'REVISION_REQUIRED') {
    return failure('The application cannot be edited in its current status.')
  }
  const normalized = normalizeDraftInput(input.draft)
  if (!normalized.value || normalized.issues.length > 0) {
    return failure(firstValidationIssueMessage(
      normalized.issues,
      'The draft contains invalid values.',
    ))
  }
  const draft = normalized.value
  const revisionSections = application.status === 'REVISION_REQUIRED'
    ? await revisionChangesAreAllowed(context, application.id, draft)
    : undefined
  if (application.status === 'REVISION_REQUIRED' && !revisionSections) {
    return failure('Only sections requested for revision may be changed.')
  }
  if (JSON.stringify(currentDraft(application)) === JSON.stringify(draft)) {
    return success(application)
  }
  const now = new Date()
  const expansionEvidence = await expansionEvidenceForHead(context, application, now)
  if (!expansionEvidence) return failure('The qualifying award is no longer valid.')
  const currentVersionRecord = await findApplicationVersion(
    context.db,
    application.id,
    application.currentVersion,
  )
  const readableVersion = requireInvariant(currentVersionRecord, 'Application version is missing.')
  const saved = await runConstraintSafe(() => saveApplicationSnapshot(context.db, {
    head: application,
    userId: applicant.id,
    draft,
    expansionClaim: expansionEvidence.claim,
    qualifyingAwardId: expansionEvidence.qualifyingAwardId,
    qualifyingReleaseAt: expansionEvidence.qualifyingReleaseAt,
    revisionSections: revisionSections ? [...revisionSections] : undefined,
    programmeCycleVersion: readableVersion.programmeCycleVersion,
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: auditActions.applicationSaved,
      entityType: 'SEB_APPLICATION',
      entityId: application.id,
      now,
    }),
  }))
  return completeGuardedOperation(
    saved,
    'The application changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, applicant.id, application.id),
    'Saved application could not be read.',
  )
}

export const validateApplication = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<ValidationReport>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const application = await loadOwnedApplication(context.db, applicant.id, applicationId)
  if (!application) return failure('The application was not found.')
  const documentTypes = await listActiveDocumentTypes(context.db, applicationId)
  return success(validateSubmissionSnapshot(application.snapshot, documentTypes, new Date()))
}

const changeApplicationDeletion = async (
  input: {
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    reason?: string | null
  },
  context: ApplicationOperationContext,
  deleted: boolean,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!validExpectedVersions(input.expectedVersion, input.expectedStatusVersion)) {
    return failure('Expected versions must be positive integers.')
  }
  const head = await findOwnedApplicationHead(context.db, applicant.id, input.applicationId, true)
  if (!head) return failure('The application was not found.')
  if (
    head.currentVersion !== input.expectedVersion ||
    head.statusVersion !== input.expectedStatusVersion ||
    head.status !== 'DRAFT'
  ) return failure('Only an unchanged draft can be removed or restored.')
  let restoreAwardId: string | null = null
  let restoreAwardNetDisbursedPaise: number | null = null
  let restoreAwardFirstReleaseAt: Date | null = null
  if (!deleted && head.applicationType === 'EXPANSION') {
    const evaluated = await evaluateExpansionEligibility(
      context.db,
      head.fundingCaseId,
      new Date(),
      head.id,
    )
    if (!evaluated.result.eligible || !evaluated.award) {
      return failure('The expansion draft is no longer eligible for restoration.')
    }
    restoreAwardId = evaluated.award.awardId
    restoreAwardNetDisbursedPaise = evaluated.award.netDisbursedPaise
    restoreAwardFirstReleaseAt = evaluated.award.firstReleaseAt
  }
  const now = new Date()
  const changed = await runConstraintSafe(() => setApplicationDeleted(context.db, {
      head,
      userId: applicant.id,
      deleted,
      reason: deleted ? (input.reason?.trim() || 'REMOVED_BY_APPLICANT') : null,
      restoreAwardId,
      restoreAwardNetDisbursedPaise,
      restoreAwardFirstReleaseAt,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: deleted ? auditActions.applicationDeleted : auditActions.applicationRestored,
        entityType: 'SEB_APPLICATION',
        entityId: head.id,
        now,
      }),
    }))
  return completeGuardedOperation(
    changed,
    'The application state changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, applicant.id, head.id, true),
    'Changed application could not be read.',
  )
}

export const softDeleteApplicationDraft = (
  input: {
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    reason?: string | null
  },
  context: ApplicationOperationContext,
) => changeApplicationDeletion(input, context, true)

export const restoreApplicationDraft = (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
) => changeApplicationDeletion(input, context, false)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const createReferenceNumber = (cycleYear: number): string => {
  const random = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ''
  for (const byte of random) suffix += CROCKFORD[byte % CROCKFORD.length]
  return `SEP-${cycleYear}-${suffix}`
}

const submit = async (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
  resubmission: boolean,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!validExpectedVersions(input.expectedVersion, input.expectedStatusVersion)) {
    return failure('Expected versions must be positive integers.')
  }
  const application = await loadOwnedApplication(context.db, applicant.id, input.applicationId)
  if (!application) return failure('The application was not found.')
  if (
    application.currentVersion !== input.expectedVersion ||
    application.statusVersion !== input.expectedStatusVersion ||
    application.status !== (resubmission ? 'REVISION_REQUIRED' : 'DRAFT')
  ) return failure('The application changed or cannot be submitted in its current status.')
  const now = new Date()
  const cycle = resubmission
    ? null
    : await findOpenProgrammeCycle(context.db, application.programmeCycleId, now)
  if (!resubmission && !cycle) return failure('The programme cycle is no longer open.')
  const revisionSections = resubmission
    ? await listOpenRevisionSections(context.db, application.id)
    : undefined
  if (resubmission && revisionSections?.size === 0) {
    return failure('There are no open revision requests to resolve.')
  }
  const expansionEvidence = await expansionEvidenceForHead(context, application, now)
  if (!expansionEvidence) return failure('The expansion application is no longer eligible.')
  if (application.applicationType === 'EXPANSION') {
    const evaluated = await evaluateExpansionEligibility(
      context.db,
      application.fundingCaseId,
      now,
      application.id,
    )
    if (!evaluated.result.eligible) return failure('The expansion application is no longer eligible.')
  }
  const normalizedDraft = normalizeDraftInput(currentDraft(application))
  if (!normalizedDraft.value || normalizedDraft.issues.length > 0) {
    return failure('The application contains invalid values. Run validation for details.')
  }
  const draft = normalizedDraft.value
  const formalSnapshot = {
    ...application.snapshot,
    ...expansionEvidence.claim,
    enterprise: draft.enterprise,
    applicantProfile: draft.applicantProfile,
    financial: draft.financial,
    priorFunding: draft.priorFunding,
    documents: draft.documents,
    declaration: draft.declaration,
  }
  const report = validateSubmissionSnapshot(
    formalSnapshot,
    await listActiveDocumentTypes(context.db, application.id),
    now,
  )
  if (!report.valid) return failure('The application is incomplete. Run validation for details.')
  const currentVersionRecord = await findApplicationVersion(
    context.db,
    application.id,
    application.currentVersion,
  )
  const readableVersion = requireInvariant(currentVersionRecord, 'Application version is missing.')

  const submitted = await runConstraintRetry(() => submitApplicationSnapshot(context.db, {
    head: application,
    currentVersion: readableVersion,
    userId: applicant.id,
    draft,
    expansionClaim: expansionEvidence.claim,
    qualifyingAwardId: expansionEvidence.qualifyingAwardId,
    qualifyingReleaseAt: expansionEvidence.qualifyingReleaseAt,
    revisionSections: revisionSections ? [...revisionSections] : undefined,
    programmeCycleVersion: readableVersion.programmeCycleVersion,
    referenceNumber: createReferenceNumber(cycle?.cycleYear ?? new Date().getUTCFullYear()),
    resubmission,
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: resubmission
        ? auditActions.applicationResubmitted
        : auditActions.applicationSubmitted,
      entityType: 'SEB_APPLICATION',
      entityId: application.id,
      now,
    }),
  }), 3)
  return completeGuardedOperation(
    submitted === true,
    'The application changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, applicant.id, application.id),
    'Submitted application could not be read.',
  )
}

export const submitApplication = (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
) => submit(input, context, false)

export const resubmitApplication = (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
) => submit(input, context, true)

export const applicationTimeline = async (
  input: { applicationId: string; first?: number | null; after?: string | null },
  context: ApplicationOperationContext,
): Promise<SebResult<Connection<TimelineEvent>>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!(await findOwnedApplicationHead(context.db, applicant.id, input.applicationId, true))) {
    return failure('The application was not found.')
  }
  const first = pageSize(input.first)
  const cursor = decodeCursor(input.after)
  if (first === null || cursor === 'INVALID') return failure('Invalid pagination input.')
  return success(
    await listApplicationTimeline(context.db, {
      applicationId: input.applicationId,
      first,
      cursor,
    }),
  )
}
