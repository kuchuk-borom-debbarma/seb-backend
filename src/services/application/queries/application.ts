/**
 * Drizzle persistence for application heads, immutable snapshots, submissions,
 * revision requests, and applicant-visible timeline events.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebApplicationDocument,
  sebApplicationDocumentVersion,
  sebApplicationEvent,
  sebApplicationQualifyingAward,
  sebApplicationQualifyingAwardVersion,
  sebApplicationSubmission,
  sebApplicationVersion,
  sebDisbursement,
  sebEnterprise,
  sebEnterpriseVersion,
  sebFundingAward,
  sebFundingCase,
  sebProgrammeCycle,
  sebRevisionRequest,
} from '../../../db/schema'
import { encodeCursor } from '../pagination'
import {
  d1ChangedExactlyOne,
  requireInvariant,
  sqlDateMilliseconds,
  sqlNullable,
  type AuditRecord,
} from '../support'
import type {
  Application,
  ApplicationDraftInput,
  ApplicationDocument,
  ApplicationSection,
  ApplicationSnapshot,
  ApplicationStatus,
  ApplicationSummary,
  ApplicationType,
  Connection,
  DocumentType,
  ExpansionClaim,
  ExpansionEligibility,
  ProgrammeCycle,
  TimelineEvent,
} from '../types'
import {
  addUtcCalendarMonths,
  fullUtcCalendarMonths,
  requiredDocumentTypesForSnapshot,
} from '../validation'

export type ApplicationHeadRecord = typeof sebApplication.$inferSelect
export type ApplicationVersionRecord = typeof sebApplicationVersion.$inferSelect
export type ProgrammeCycleRecord = typeof sebProgrammeCycle.$inferSelect
type ApplicationMutationHead = Pick<
  ApplicationHeadRecord,
  | 'id'
  | 'fundingCaseId'
  | 'programmeCycleId'
  | 'applicationType'
  | 'phaseNumber'
  | 'currentVersion'
  | 'statusVersion'
  | 'status'
  | 'referenceNumber'
  | 'firstSubmittedAt'
>

/**
 * One definition of an open policy window for reads and guarded writes.
 * Missing bounds mean unbounded; a closing instant is exclusive, matching the
 * applicant-visible cycle query and avoiding a one-millisecond ambiguity.
 */
const programmeCycleOpenAt = (now: Date): SQL => sql`
  ${sebProgrammeCycle.status} = 'OPEN'
  AND ${sebProgrammeCycle.deletedAt} IS NULL
  AND (${sebProgrammeCycle.opensAt} IS NULL
    OR ${sebProgrammeCycle.opensAt} <= ${now.getTime()})
  AND (${sebProgrammeCycle.closesAt} IS NULL
    OR ${sebProgrammeCycle.closesAt} > ${now.getTime()})
`

const snapshotFromRecord = (record: ApplicationVersionRecord): ApplicationSnapshot => ({
  version: record.version,
  programmeCycleVersion: record.programmeCycleVersion,
  applicationType: record.applicationType,
  phaseNumber: record.phaseNumber,
  changeType: record.changeType,
  createdAt: record.createdAt,
  declarationAcceptedAt: record.declarationAcceptedAt,
  enterprise: {
    businessName: record.businessName,
    establishmentDate: record.establishmentDate,
    registrationType: record.registrationType,
    registrationNumber: record.registrationNumber,
    gstin: record.gstin,
    businessSector: record.businessSector,
    otherBusinessSector: record.otherBusinessSector,
    applicationCategory: record.applicationCategory,
    majorityOwnershipConfirmed: record.majorityOwnershipConfirmed,
  },
  applicantProfile: {
    primaryApplicantName: record.primaryApplicantName,
    designation: record.designation,
    dateOfBirth: record.dateOfBirth,
    gender: record.gender,
    businessBlockOrVillage: record.businessBlockOrVillage,
    businessDistrict: record.businessDistrict,
    businessPinCode: record.businessPinCode,
    contactNumber: record.contactNumber,
    contactEmail: record.contactEmail,
  },
  financial: {
    totalProjectCostPaise: record.totalProjectCostPaise,
    seedFundRequestedPaise: record.seedFundRequestedPaise,
    bankLoanProposedPaise: record.bankLoanProposedPaise,
    promoterContributionPaise: record.promoterContributionPaise,
  },
  priorFunding: {
    receivedGovernmentFunding: record.receivedGovernmentFunding,
    governmentSchemeName: record.governmentSchemeName,
    governmentFundingAmountPaise: record.governmentFundingAmountPaise,
    governmentFundingSanctionYear: record.governmentFundingSanctionYear,
    hasExistingBankCredit: record.hasExistingBankCredit,
    existingBankName: record.existingBankName,
    existingCreditAmountPaise: record.existingCreditAmountPaise,
    existingCreditStatus: record.existingCreditStatus,
  },
  documents: { nocRequired: record.nocRequired },
  declaration: {
    relationshipType: record.relationshipType,
    relatedPersonName: record.relatedPersonName,
    declarationAccepted: record.declarationAccepted,
    declarationPlace: record.declarationPlace,
  },
  priorSanctionOrderNumber: record.priorSanctionOrderNumber,
  priorSanctionDate: record.priorSanctionDate,
  priorNetDisbursedAmountPaise: record.priorNetDisbursedAmountPaise,
  continuousOperationMonths: record.continuousOperationMonths,
})

const applicationBase = (head: ApplicationHeadRecord) => ({
  id: head.id,
  enterpriseId: head.enterpriseId,
  fundingCaseId: head.fundingCaseId,
  programmeCycleId: head.programmeCycleId,
  applicationType: head.applicationType,
  phaseNumber: head.phaseNumber,
  referenceNumber: head.referenceNumber,
  currentVersion: head.currentVersion,
  status: head.status,
  statusVersion: head.statusVersion,
  firstSubmittedAt: head.firstSubmittedAt,
  createdAt: head.createdAt,
  updatedAt: head.updatedAt,
  deletedAt: head.deletedAt,
})

export const findOwnedApplicationHead = async (
  db: Database,
  userId: string,
  applicationId: string,
  includeDeleted = false,
): Promise<ApplicationHeadRecord | null> => {
  const [head] = await db
    .select()
    .from(sebApplication)
    .where(
      and(
        eq(sebApplication.id, applicationId),
        eq(sebApplication.applicantUserId, userId),
        includeDeleted ? undefined : isNull(sebApplication.deletedAt),
      ),
    )
    .limit(1)
  return head ?? null
}

export const findApplicationVersion = async (
  db: Database,
  applicationId: string,
  version: number,
): Promise<ApplicationVersionRecord | null> => {
  const [record] = await db
    .select()
    .from(sebApplicationVersion)
    .where(
      and(
        eq(sebApplicationVersion.applicationId, applicationId),
        eq(sebApplicationVersion.version, version),
      ),
    )
    .limit(1)
  return sqlNullable(record)
}

export const findLatestSubmittedVersion = async (
  db: Database,
  applicationId: string,
): Promise<ApplicationVersionRecord | null> => {
  const [record] = await db
    .select({ version: sebApplicationVersion })
    .from(sebApplicationSubmission)
    .innerJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplicationSubmission.applicationId),
        eq(sebApplicationVersion.version, sebApplicationSubmission.applicationVersion),
      ),
    )
    .where(eq(sebApplicationSubmission.applicationId, applicationId))
    .orderBy(desc(sebApplicationSubmission.submissionNumber))
    .limit(1)
  return sqlNullable(record && record.version)
}

export const listActiveDocumentTypes = async (
  db: Database,
  applicationId: string,
): Promise<Set<DocumentType>> => {
  const rows = await db
    .select({ documentType: sebApplicationDocument.documentType })
    .from(sebApplicationDocument)
    .where(
      and(
        eq(sebApplicationDocument.applicationId, applicationId),
        isNull(sebApplicationDocument.deletedAt),
      ),
    )
  return new Set(rows.map((row) => row.documentType))
}

const listDocuments = async (
  db: Database,
  applicationId: string,
): Promise<ApplicationDocument[]> => {
  const rows = await db
    .select({ head: sebApplicationDocument, version: sebApplicationDocumentVersion })
    .from(sebApplicationDocument)
    .innerJoin(
      sebApplicationDocumentVersion,
      and(
        eq(sebApplicationDocumentVersion.documentId, sebApplicationDocument.id),
        eq(sebApplicationDocumentVersion.version, sebApplicationDocument.currentVersion),
      ),
    )
    .where(eq(sebApplicationDocument.applicationId, applicationId))
    .orderBy(asc(sebApplicationDocument.documentType))
  return rows.map(({ head, version }) => ({
    id: head.id,
    documentType: head.documentType,
    currentVersion: head.currentVersion,
    originalFilename: version.originalFilename,
    contentType: version.contentType,
    sizeBytes: version.sizeBytes,
    createdAt: head.createdAt,
    deletedAt: head.deletedAt,
  }))
}

export const listOpenRevisionSections = async (
  db: Database,
  applicationId: string,
): Promise<Set<ApplicationSection>> => {
  const rows = await db
    .select({ section: sebRevisionRequest.section })
    .from(sebRevisionRequest)
    .where(
      and(
        eq(sebRevisionRequest.applicationId, applicationId),
        isNull(sebRevisionRequest.resolvedAt),
        isNull(sebRevisionRequest.cancelledAt),
      ),
    )
  return new Set(rows.map((row) => row.section))
}

const listRevisionRequests = async (db: Database, applicationId: string) =>
  db
    .select({
      id: sebRevisionRequest.id,
      section: sebRevisionRequest.section,
      note: sebRevisionRequest.note,
      requestedAt: sebRevisionRequest.requestedAt,
      resolvedAt: sebRevisionRequest.resolvedAt,
      cancelledAt: sebRevisionRequest.cancelledAt,
    })
    .from(sebRevisionRequest)
    .where(eq(sebRevisionRequest.applicationId, applicationId))
    .orderBy(asc(sebRevisionRequest.requestedAt))

export const loadOwnedApplication = async (
  db: Database,
  userId: string,
  applicationId: string,
  includeDeleted = false,
): Promise<Application | null> => {
  const head = await findOwnedApplicationHead(db, userId, applicationId, includeDeleted)
  if (!head) return null
  const [version, documents, revisionRequests] = await Promise.all([
    findApplicationVersion(db, applicationId, head.currentVersion),
    listDocuments(db, applicationId),
    listRevisionRequests(db, applicationId),
  ])
  return {
    ...applicationBase(head),
    snapshot: snapshotFromRecord(requireInvariant(version, 'Application current version is missing.')),
    documents,
    revisionRequests,
  }
}

export const listOwnedApplications = async (
  db: Database,
  input: {
    userId: string
    first: number
    cursor: { timestamp: Date; id: string } | null
    enterpriseId?: string | null
    status?: ApplicationStatus | null
    includeDeleted: boolean
  },
): Promise<Connection<ApplicationSummary>> => {
  const cursorPredicate = input.cursor
    ? or(
        gt(sebApplication.updatedAt, input.cursor.timestamp),
        and(
          eq(sebApplication.updatedAt, input.cursor.timestamp),
          gt(sebApplication.id, input.cursor.id),
        ),
      )
    : undefined
  const rows = await db
    .select({
      head: sebApplication,
      businessName: sebApplicationVersion.businessName,
      cycleCode: sebProgrammeCycle.cycleCode,
      cycleYear: sebProgrammeCycle.cycleYear,
    })
    .from(sebApplication)
    .innerJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplication.currentVersion),
      ),
    )
    .innerJoin(sebProgrammeCycle, eq(sebProgrammeCycle.id, sebApplication.programmeCycleId))
    .where(
      and(
        eq(sebApplication.applicantUserId, input.userId),
        input.enterpriseId ? eq(sebApplication.enterpriseId, input.enterpriseId) : undefined,
        input.status ? eq(sebApplication.status, input.status) : undefined,
        input.includeDeleted ? undefined : isNull(sebApplication.deletedAt),
        cursorPredicate,
      ),
    )
    .orderBy(asc(sebApplication.updatedAt), asc(sebApplication.id))
    .limit(input.first + 1)
  const hasNextPage = rows.length > input.first
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)?.head
  return {
    nodes: selected.map((row) => ({
      ...applicationBase(row.head),
      businessName: row.businessName,
      cycleCode: row.cycleCode,
      cycleYear: row.cycleYear,
    })),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor(last.updatedAt, last.id) : null,
    },
  }
}

export const listAvailableProgrammeCycles = async (
  db: Database,
  now: Date,
): Promise<ProgrammeCycle[]> => {
  const rows = await db
    .select()
    .from(sebProgrammeCycle)
    .where(programmeCycleOpenAt(now))
    .orderBy(asc(sebProgrammeCycle.opensAt), asc(sebProgrammeCycle.cycleCode))
  return rows.map((row) => ({
    id: row.id,
    cycleCode: row.cycleCode,
    cycleYear: row.cycleYear,
    policyReference: row.policyReference,
    currentVersion: row.currentVersion,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
  }))
}

export const findOpenProgrammeCycle = async (
  db: Database,
  cycleId: string,
  now: Date,
): Promise<ProgrammeCycleRecord | null> => {
  const [cycle] = await db
    .select()
    .from(sebProgrammeCycle)
    .where(
      and(
        eq(sebProgrammeCycle.id, cycleId),
        programmeCycleOpenAt(now),
      ),
    )
    .limit(1)
  return cycle ?? null
}

export const findEnterpriseApplicationSource = async (
  db: Database,
  userId: string,
  enterpriseId: string,
) => {
  const [row] = await db
    .select({
      enterprise: sebEnterprise,
      version: sebEnterpriseVersion,
      fundingCase: sebFundingCase,
    })
    .from(sebEnterprise)
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .innerJoin(sebFundingCase, eq(sebFundingCase.enterpriseId, sebEnterprise.id))
    .where(
      and(
        eq(sebEnterprise.id, enterpriseId),
        eq(sebEnterprise.portalOwnerUserId, userId),
        isNull(sebEnterprise.deletedAt),
        isNull(sebFundingCase.deletedAt),
        eq(sebFundingCase.status, 'OPEN'),
      ),
    )
    .limit(1)
  return row ?? null
}

type EligibleAward = {
  awardId: string
  priorApplicationId: string
  priorPhaseNumber: number
  sanctionOrderNumber: string
  sanctionDate: string
  firstReleaseAt: Date
  netDisbursedPaise: number
}

type AwardCandidate = {
  awardId: string
  applicationId: string
  phaseNumber: number
  sanctionOrderNumber: string
  sanctionDate: string
}

/** Derives retained money and the first still-effective release for one award. */
const eligibleAwardFromCandidate = async (
  db: Database,
  award: AwardCandidate,
): Promise<EligibleAward | null> => {
  const entries = await db
    .select()
    .from(sebDisbursement)
    .where(eq(sebDisbursement.fundingAwardId, award.awardId))
    .orderBy(asc(sebDisbursement.occurredAt), asc(sebDisbursement.sequenceNumber))
  const releases = entries.filter((entry) => entry.entryType === 'RELEASE')
  const reversalByRelease = new Map<string, number>()
  for (const entry of entries) {
    if (entry.entryType === 'REVERSAL' && entry.relatedDisbursementId) {
      reversalByRelease.set(
        entry.relatedDisbursementId,
        (reversalByRelease.get(entry.relatedDisbursementId) ?? 0) + entry.amountPaise,
      )
    }
  }
  const retainedAmount = (release: (typeof releases)[number]) =>
    release.amountPaise - (reversalByRelease.get(release.id) ?? 0)
  const firstRelease = releases.find((release) => retainedAmount(release) > 0)
  if (!firstRelease) return null
  const netDisbursedPaise = releases.reduce(
    (total, release) => total + retainedAmount(release),
    0,
  )
  if (netDisbursedPaise <= 0) return null
  return {
    awardId: award.awardId,
    priorApplicationId: award.applicationId,
    priorPhaseNumber: award.phaseNumber,
    sanctionOrderNumber: award.sanctionOrderNumber,
    sanctionDate: award.sanctionDate,
    firstReleaseAt: firstRelease.occurredAt,
    netDisbursedPaise,
  }
}

const eligibleAwardForCase = async (
  db: Database,
  fundingCaseId: string,
): Promise<EligibleAward | null> => {
  const awards = await db
    .select({
      awardId: sebFundingAward.id,
      applicationId: sebFundingAward.applicationId,
      phaseNumber: sebApplication.phaseNumber,
      sanctionOrderNumber: sebFundingAward.sanctionOrderNumber,
      sanctionDate: sebFundingAward.sanctionDate,
    })
    .from(sebFundingAward)
    .innerJoin(sebApplication, eq(sebApplication.id, sebFundingAward.applicationId))
    .where(
      and(
        eq(sebFundingAward.fundingCaseId, fundingCaseId),
        eq(sebFundingAward.status, 'ACTIVE'),
        isNull(sebFundingAward.deletedAt),
      ),
    )
    .orderBy(desc(sebApplication.phaseNumber))
  for (const award of awards) {
    const eligible = await eligibleAwardFromCandidate(db, award)
    if (eligible) return eligible
  }
  return null
}

const hasCompetingPhase = async (
  db: Database,
  fundingCaseId: string,
  phaseNumber: number,
  excludeApplicationId?: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: sebApplication.id })
    .from(sebApplication)
    .where(
      and(
        eq(sebApplication.fundingCaseId, fundingCaseId),
        eq(sebApplication.phaseNumber, phaseNumber),
        ne(sebApplication.status, 'REJECTED'),
        excludeApplicationId ? ne(sebApplication.id, excludeApplicationId) : undefined,
        isNull(sebApplication.deletedAt),
      ),
    )
    .limit(1)
  return row !== undefined
}

export const evaluateExpansionEligibility = async (
  db: Database,
  fundingCaseId: string,
  now: Date,
  excludeApplicationId?: string,
): Promise<{ result: ExpansionEligibility; award: EligibleAward | null }> => {
  const award = await eligibleAwardForCase(db, fundingCaseId)
  if (!award) {
    return {
      award: null,
      result: {
        eligible: false,
        nextPhaseNumber: null,
        qualifyingAwardId: null,
        eligibleAt: null,
        reasons: ['NO_QUALIFYING_AWARD_OR_RELEASE'],
      },
    }
  }
  const nextPhaseNumber = award.priorPhaseNumber + 1
  const eligibleAt = addUtcCalendarMonths(award.firstReleaseAt, 12)
  const reasons: string[] = []
  if (now.getTime() < eligibleAt.getTime()) reasons.push('TWELVE_MONTH_WAIT_NOT_COMPLETE')
  if (await hasCompetingPhase(db, fundingCaseId, nextPhaseNumber, excludeApplicationId)) {
    reasons.push('COMPETING_PHASE_APPLICATION')
  }
  return {
    award,
    result: {
      eligible: reasons.length === 0,
      nextPhaseNumber,
      qualifyingAwardId: award.awardId,
      eligibleAt,
      reasons,
    },
  }
}

export const expansionClaimFromAward = (
  award: EligibleAward,
  now: Date,
): ExpansionClaim => ({
  priorSanctionOrderNumber: award.sanctionOrderNumber,
  priorSanctionDate: award.sanctionDate,
  priorNetDisbursedAmountPaise: award.netDisbursedPaise,
  continuousOperationMonths: fullUtcCalendarMonths(award.firstReleaseAt, now),
})

export const findExpansionAwardForApplication = async (
  db: Database,
  applicationId: string,
): Promise<EligibleAward | null> => {
  const [linkedAward] = await db
    .select({
      awardId: sebFundingAward.id,
      applicationId: sebFundingAward.applicationId,
      phaseNumber: sebApplication.phaseNumber,
      sanctionOrderNumber: sebFundingAward.sanctionOrderNumber,
      sanctionDate: sebFundingAward.sanctionDate,
    })
    .from(sebApplicationQualifyingAward)
    .innerJoin(
      sebFundingAward,
      and(
        eq(sebFundingAward.id, sebApplicationQualifyingAward.currentFundingAwardId),
        eq(sebFundingAward.fundingCaseId, sebApplicationQualifyingAward.fundingCaseId),
        eq(sebFundingAward.status, 'ACTIVE'),
        isNull(sebFundingAward.deletedAt),
      ),
    )
    .innerJoin(sebApplication, eq(sebApplication.id, sebFundingAward.applicationId))
    .where(
      and(
        eq(sebApplicationQualifyingAward.applicationId, applicationId),
        eq(sebApplicationQualifyingAward.status, 'ACTIVE'),
        isNotNull(sebApplicationQualifyingAward.currentFundingAwardId),
      ),
    )
    .limit(1)
  return linkedAward ? eligibleAwardFromCandidate(db, linkedAward) : null
}

const versionValues = (input: {
  id?: string
  applicationId: string
  version: number
  programmeCycleId: string
  programmeCycleVersion: number
  applicationType: ApplicationType
  phaseNumber: number
  changeType: 'INITIAL' | 'SAVE' | 'REVISION' | 'SUBMISSION' | 'RESUBMISSION'
  changedByUserId: string
  createdAt: Date
  draft: ApplicationDraftInput
  expansionClaim: ExpansionClaim
  declarationAcceptedAt: Date | null
}): typeof sebApplicationVersion.$inferInsert => ({
  id: input.id ?? crypto.randomUUID(),
  applicationId: input.applicationId,
  version: input.version,
  programmeCycleId: input.programmeCycleId,
  programmeCycleVersion: input.programmeCycleVersion,
  applicationType: input.applicationType,
  phaseNumber: input.phaseNumber,
  changeType: input.changeType,
  changeReason: null,
  changedByUserId: input.changedByUserId,
  createdAt: input.createdAt,
  ...input.draft.enterprise,
  ...input.draft.applicantProfile,
  ...input.draft.financial,
  ...input.draft.priorFunding,
  ...input.expansionClaim,
  nocRequired: input.draft.documents.nocRequired,
  ...input.draft.declaration,
  declarationAcceptedAt: input.declarationAcceptedAt,
})

const insertVersionWhere = (
  db: Database,
  value: typeof sebApplicationVersion.$inferInsert,
  predicate: SQL,
) => db.insert(sebApplicationVersion).select(sql`
  SELECT ${value.id}, ${value.applicationId}, ${value.version},
    ${value.programmeCycleId}, ${value.programmeCycleVersion},
    ${value.applicationType}, ${value.phaseNumber}, ${value.changeType},
    ${sqlNullable(value.changeReason)}, ${value.changedByUserId},
    ${(value.createdAt as Date).getTime()}, ${sqlNullable(value.businessName)},
    ${sqlNullable(value.establishmentDate)}, ${sqlNullable(value.registrationType)},
    ${sqlNullable(value.registrationNumber)}, ${sqlNullable(value.gstin)},
    ${sqlNullable(value.businessSector)}, ${sqlNullable(value.otherBusinessSector)},
    ${sqlNullable(value.applicationCategory)}, ${sqlNullable(value.majorityOwnershipConfirmed)},
    ${sqlNullable(value.primaryApplicantName)}, ${sqlNullable(value.designation)},
    ${sqlNullable(value.dateOfBirth)}, ${sqlNullable(value.gender)},
    ${sqlNullable(value.businessBlockOrVillage)}, ${sqlNullable(value.businessDistrict)},
    ${sqlNullable(value.businessPinCode)}, ${sqlNullable(value.contactNumber)},
    ${sqlNullable(value.contactEmail)}, ${sqlNullable(value.totalProjectCostPaise)},
    ${sqlNullable(value.seedFundRequestedPaise)}, ${sqlNullable(value.bankLoanProposedPaise)},
    ${sqlNullable(value.promoterContributionPaise)}, ${sqlNullable(value.receivedGovernmentFunding)},
    ${sqlNullable(value.governmentSchemeName)}, ${sqlNullable(value.governmentFundingAmountPaise)},
    ${sqlNullable(value.governmentFundingSanctionYear)}, ${sqlNullable(value.hasExistingBankCredit)},
    ${sqlNullable(value.existingBankName)}, ${sqlNullable(value.existingCreditAmountPaise)},
    ${sqlNullable(value.existingCreditStatus)}, ${sqlNullable(value.priorSanctionOrderNumber)},
    ${sqlNullable(value.priorSanctionDate)}, ${sqlNullable(value.priorNetDisbursedAmountPaise)},
    ${sqlNullable(value.continuousOperationMonths)}, ${sqlNullable(value.nocRequired)},
    ${sqlNullable(value.relationshipType)}, ${sqlNullable(value.relatedPersonName)},
    ${sqlNullable(value.declarationAccepted)},
    ${sqlDateMilliseconds(value.declarationAcceptedAt as Date | null | undefined)},
    ${sqlNullable(value.declarationPlace)}
  FROM ${sebApplication}
  WHERE ${predicate}
`)

const eventValues = (input: {
  id?: string
  applicationId: string
  eventType: string
  actorUserId: string
  applicationVersion?: number | null
  submissionId?: string | null
  fromStatus?: ApplicationStatus | null
  toStatus?: ApplicationStatus | null
  message?: string | null
  createdAt: Date
}): typeof sebApplicationEvent.$inferInsert => ({
  id: input.id ?? crypto.randomUUID(),
  applicationId: input.applicationId,
  eventType: input.eventType,
  actorUserId: input.actorUserId,
  applicationVersion: sqlNullable(input.applicationVersion),
  submissionId: sqlNullable(input.submissionId),
  revisionRequestId: null,
  fromStatus: sqlNullable(input.fromStatus),
  toStatus: sqlNullable(input.toStatus),
  section: null,
  message: sqlNullable(input.message),
  metadataJson: null,
  createdAt: input.createdAt,
})

/**
 * Revalidates the authoritative award and ledger inside a draft/save batch.
 * Friendly controller checks explain failures; this predicate prevents an
 * award suspension, reversal, or competing phase from racing the final write.
 */
const expansionEvidenceStillCurrent = (input: {
  head: ApplicationMutationHead
  qualifyingAwardId?: string | null
  qualifyingReleaseAt?: Date | null
  expansionClaim: ExpansionClaim
  now: Date
}): SQL | undefined => {
  if (input.head.applicationType === 'INITIAL') return undefined
  const cutoff = addUtcCalendarMonths(input.now, -12)
  return sql`EXISTS (
    SELECT 1
    FROM ${sebApplicationQualifyingAward} AS qualifying_link
    INNER JOIN ${sebFundingAward} AS qualifying_award
      ON qualifying_award.id = qualifying_link.current_funding_award_id
      AND qualifying_award.funding_case_id = qualifying_link.funding_case_id
    INNER JOIN ${sebApplication} AS prior_application
      ON prior_application.id = qualifying_award.application_id
    WHERE qualifying_link.application_id = ${input.head.id}
      AND qualifying_link.funding_case_id = ${input.head.fundingCaseId}
      AND qualifying_link.status = 'ACTIVE'
      AND qualifying_link.current_funding_award_id = ${sqlNullable(input.qualifyingAwardId)}
      AND qualifying_award.status = 'ACTIVE'
      AND qualifying_award.deleted_at IS NULL
      AND qualifying_award.sanction_order_number = ${input.expansionClaim.priorSanctionOrderNumber}
      AND qualifying_award.sanction_date = ${input.expansionClaim.priorSanctionDate}
      AND prior_application.funding_case_id = ${input.head.fundingCaseId}
      AND prior_application.phase_number = ${input.head.phaseNumber - 1}
      AND (
        SELECT COALESCE(SUM(
          CASE WHEN ledger.entry_type = 'RELEASE'
            THEN ledger.amount_paise ELSE -ledger.amount_paise END
        ), 0)
        FROM ${sebDisbursement} AS ledger
        WHERE ledger.funding_award_id = qualifying_award.id
      ) = ${sqlNullable(input.expansionClaim.priorNetDisbursedAmountPaise)}
      AND (
        SELECT MIN(release.occurred_at)
        FROM ${sebDisbursement} AS release
        WHERE release.funding_award_id = qualifying_award.id
          AND release.entry_type = 'RELEASE'
          AND release.amount_paise - COALESCE((
            SELECT SUM(reversal.amount_paise)
            FROM ${sebDisbursement} AS reversal
            WHERE reversal.related_disbursement_id = release.id
              AND reversal.entry_type = 'REVERSAL'
          ), 0) > 0
      ) = ${sqlDateMilliseconds(input.qualifyingReleaseAt)}
      AND EXISTS (
        SELECT 1 FROM ${sebDisbursement} AS release
        WHERE release.funding_award_id = qualifying_award.id
          AND release.entry_type = 'RELEASE'
          AND release.occurred_at <= ${cutoff.getTime()}
          AND release.amount_paise - COALESCE((
            SELECT SUM(reversal.amount_paise)
            FROM ${sebDisbursement} AS reversal
            WHERE reversal.related_disbursement_id = release.id
              AND reversal.entry_type = 'REVERSAL'
          ), 0) > 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${sebApplication} AS competing_application
        WHERE competing_application.funding_case_id = ${input.head.fundingCaseId}
          AND competing_application.phase_number = ${input.head.phaseNumber}
          AND competing_application.id <> ${input.head.id}
          AND competing_application.status <> 'REJECTED'
          AND competing_application.deleted_at IS NULL
      )
  )`
}

/** Pins the exact unresolved revision-section set read by the controller. */
const revisionScopeStillCurrent = (input: {
  head: ApplicationMutationHead
  revisionSections?: ApplicationSection[]
}): SQL | undefined => {
  if (input.head.status !== 'REVISION_REQUIRED') return undefined
  const sections = input.revisionSections ?? []
  const openRevision = (section: ApplicationSection) => sql`EXISTS (
    SELECT 1 FROM ${sebRevisionRequest}
    WHERE ${sebRevisionRequest.applicationId} = ${input.head.id}
      AND ${sebRevisionRequest.section} = ${section}
      AND ${sebRevisionRequest.resolvedAt} IS NULL
      AND ${sebRevisionRequest.cancelledAt} IS NULL
  )`
  return and(
    // An empty scope is never a valid revision save or resubmission.
    sql`${sections.length} > 0`,
    sql`(
      SELECT COUNT(DISTINCT ${sebRevisionRequest.section})
      FROM ${sebRevisionRequest}
      WHERE ${sebRevisionRequest.applicationId} = ${input.head.id}
        AND ${sebRevisionRequest.resolvedAt} IS NULL
        AND ${sebRevisionRequest.cancelledAt} IS NULL
    ) = ${sections.length}`,
    ...sections.map(openRevision),
  )
}

export const insertApplicationAggregate = async (
  db: Database,
  input: {
    applicationId: string
    applicantUserId: string
    enterpriseId: string
    fundingCaseId: string
    programmeCycleId: string
    programmeCycleVersion: number
    applicationType: ApplicationType
    phaseNumber: number
    draft: ApplicationDraftInput
    expansionClaim: ExpansionClaim
    qualifyingAwardId?: string | null
    qualifyingReleaseAt?: Date | null
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const versionId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const eligibleReleaseCutoff = addUtcCalendarMonths(input.now, -12)

  // A rejected expansion does not permanently consume its earlier award. When
  // the applicant retries in a later cycle, the old current link is cancelled
  // in the same batch that creates the new draft and link. Capturing its version
  // here gives the batch an optimistic predicate against concurrent retries.
  const [replacedLink] = input.qualifyingAwardId
    ? await db
        .select({
          id: sebApplicationQualifyingAward.id,
          currentVersion: sebApplicationQualifyingAward.currentVersion,
        })
        .from(sebApplicationQualifyingAward)
        .innerJoin(
          sebApplication,
          eq(sebApplication.id, sebApplicationQualifyingAward.applicationId),
        )
        .where(
          and(
            eq(sebApplicationQualifyingAward.fundingCaseId, input.fundingCaseId),
            eq(sebApplicationQualifyingAward.currentFundingAwardId, input.qualifyingAwardId),
            eq(sebApplicationQualifyingAward.status, 'ACTIVE'),
            eq(sebApplication.phaseNumber, input.phaseNumber),
            eq(sebApplication.status, 'REJECTED'),
            isNull(sebApplication.deletedAt),
          ),
        )
        .orderBy(desc(sebApplication.updatedAt))
        .limit(1)
    : []
  const replacedLinkGuard = replacedLink
    ? sql`AND EXISTS (
        SELECT 1 FROM ${sebApplicationQualifyingAward}
        WHERE ${sebApplicationQualifyingAward.id} = ${replacedLink.id}
          AND ${sebApplicationQualifyingAward.currentVersion} = ${replacedLink.currentVersion}
          AND ${sebApplicationQualifyingAward.status} = 'ACTIVE'
          AND ${sebApplicationQualifyingAward.currentFundingAwardId} = ${input.qualifyingAwardId}
      )`
    : sql``
  // Do not settle for checking that the award is broadly eligible. Pin every
  // award and ledger fact copied into version 1 so a concurrent ledger change
  // cannot create a draft containing a stale eligibility snapshot.
  const awardEligibilityGuard = input.qualifyingAwardId
    ? sql`AND EXISTS (
        SELECT 1
        FROM ${sebFundingAward}
        INNER JOIN ${sebApplication} AS prior_application
          ON prior_application.id = ${sebFundingAward.applicationId}
        WHERE ${sebFundingAward.id} = ${input.qualifyingAwardId}
          AND ${sebFundingAward.fundingCaseId} = ${input.fundingCaseId}
          AND ${sebFundingAward.status} = 'ACTIVE'
          AND ${sebFundingAward.deletedAt} IS NULL
          AND ${sebFundingAward.sanctionOrderNumber} = ${input.expansionClaim.priorSanctionOrderNumber}
          AND ${sebFundingAward.sanctionDate} = ${input.expansionClaim.priorSanctionDate}
          AND prior_application.funding_case_id = ${input.fundingCaseId}
          AND prior_application.phase_number = ${input.phaseNumber - 1}
          AND (
            SELECT COALESCE(SUM(
              CASE WHEN ledger.entry_type = 'RELEASE'
                THEN ledger.amount_paise ELSE -ledger.amount_paise END
            ), 0)
            FROM ${sebDisbursement} AS ledger
            WHERE ledger.funding_award_id = ${input.qualifyingAwardId}
          ) = ${input.expansionClaim.priorNetDisbursedAmountPaise}
          AND ${input.expansionClaim.priorNetDisbursedAmountPaise} > 0
          AND (
            SELECT MIN(release.occurred_at)
            FROM ${sebDisbursement} AS release
            WHERE release.funding_award_id = ${input.qualifyingAwardId}
              AND release.entry_type = 'RELEASE'
              AND release.amount_paise - COALESCE((
                SELECT SUM(reversal.amount_paise)
                FROM ${sebDisbursement} AS reversal
                WHERE reversal.related_disbursement_id = release.id
                  AND reversal.entry_type = 'REVERSAL'
              ), 0) > 0
          ) = ${sqlDateMilliseconds(input.qualifyingReleaseAt)}
          AND EXISTS (
            SELECT 1 FROM ${sebDisbursement} AS release
            WHERE release.funding_award_id = ${input.qualifyingAwardId}
              AND release.entry_type = 'RELEASE'
              AND release.occurred_at <= ${eligibleReleaseCutoff.getTime()}
              AND release.amount_paise - COALESCE((
                SELECT SUM(reversal.amount_paise)
                FROM ${sebDisbursement} AS reversal
                WHERE reversal.related_disbursement_id = release.id
                  AND reversal.entry_type = 'REVERSAL'
              ), 0) > 0
          )
      )`
    : sql``
  const insertHead = db
    .insert(sebApplication)
    .select(sql`
      SELECT ${input.applicationId}, ${input.applicantUserId}, ${input.enterpriseId},
        ${input.fundingCaseId}, ${input.programmeCycleId}, ${input.applicationType},
        ${input.phaseNumber}, NULL, 1, ${input.now.getTime()}, ${input.now.getTime()},
        NULL, NULL, NULL, 'DRAFT', 1, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sebApplication}
        WHERE ${sebApplication.fundingCaseId} = ${input.fundingCaseId}
          AND ${sebApplication.phaseNumber} = ${input.phaseNumber}
          AND ${sebApplication.status} <> 'REJECTED'
          AND ${sebApplication.deletedAt} IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM ${sebEnterprise}
        INNER JOIN ${sebFundingCase}
          ON ${sebFundingCase.id} = ${input.fundingCaseId}
          AND ${sebFundingCase.enterpriseId} = ${sebEnterprise.id}
        INNER JOIN ${sebProgrammeCycle}
          ON ${sebProgrammeCycle.id} = ${input.programmeCycleId}
        WHERE ${sebEnterprise.id} = ${input.enterpriseId}
          AND ${sebEnterprise.portalOwnerUserId} = ${input.applicantUserId}
          AND ${sebEnterprise.deletedAt} IS NULL
          AND ${sebFundingCase.status} = 'OPEN'
          AND ${sebFundingCase.deletedAt} IS NULL
          AND ${sebProgrammeCycle.currentVersion} = ${input.programmeCycleVersion}
          AND ${programmeCycleOpenAt(input.now)}
      )
      ${awardEligibilityGuard}
      ${replacedLinkGuard}
    `)
    .returning({ id: sebApplication.id })
  const insertVersion = db.insert(sebApplicationVersion).select(sql`
    SELECT ${versionId}, ${input.applicationId}, 1, ${input.programmeCycleId},
      ${input.programmeCycleVersion}, ${input.applicationType}, ${input.phaseNumber},
      'INITIAL', NULL, ${input.applicantUserId}, ${input.now.getTime()},
      ${input.draft.enterprise.businessName}, ${input.draft.enterprise.establishmentDate},
      ${input.draft.enterprise.registrationType}, ${input.draft.enterprise.registrationNumber},
      ${input.draft.enterprise.gstin}, ${input.draft.enterprise.businessSector},
      ${input.draft.enterprise.otherBusinessSector}, ${input.draft.enterprise.applicationCategory},
      ${input.draft.enterprise.majorityOwnershipConfirmed},
      ${input.draft.applicantProfile.primaryApplicantName}, ${input.draft.applicantProfile.designation},
      ${input.draft.applicantProfile.dateOfBirth}, ${input.draft.applicantProfile.gender},
      ${input.draft.applicantProfile.businessBlockOrVillage},
      ${input.draft.applicantProfile.businessDistrict}, ${input.draft.applicantProfile.businessPinCode},
      ${input.draft.applicantProfile.contactNumber}, ${input.draft.applicantProfile.contactEmail},
      ${input.draft.financial.totalProjectCostPaise}, ${input.draft.financial.seedFundRequestedPaise},
      ${input.draft.financial.bankLoanProposedPaise}, ${input.draft.financial.promoterContributionPaise},
      ${input.draft.priorFunding.receivedGovernmentFunding},
      ${input.draft.priorFunding.governmentSchemeName},
      ${input.draft.priorFunding.governmentFundingAmountPaise},
      ${input.draft.priorFunding.governmentFundingSanctionYear},
      ${input.draft.priorFunding.hasExistingBankCredit}, ${input.draft.priorFunding.existingBankName},
      ${input.draft.priorFunding.existingCreditAmountPaise},
      ${input.draft.priorFunding.existingCreditStatus},
      ${input.expansionClaim.priorSanctionOrderNumber},
      ${input.expansionClaim.priorSanctionDate},
      ${input.expansionClaim.priorNetDisbursedAmountPaise},
      ${input.expansionClaim.continuousOperationMonths},
      ${input.draft.documents.nocRequired}, ${input.draft.declaration.relationshipType},
      ${input.draft.declaration.relatedPersonName}, ${input.draft.declaration.declarationAccepted},
      NULL, ${input.draft.declaration.declarationPlace}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const insertEvent = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventId}, ${input.applicationId}, 'APPLICATION_STARTED',
      ${input.applicantUserId}, 1, NULL, NULL, NULL, 'DRAFT', NULL,
      'Application draft started.', NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const insertAudit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
    )
  `)
  const statements = [insertHead, insertVersion] as const
  if (input.qualifyingAwardId) {
    const linkId = crypto.randomUUID()
    const cancelReplacedLink = replacedLink
      ? db
          .update(sebApplicationQualifyingAward)
          .set({
            currentFundingAwardId: null,
            status: 'CANCELLED',
            currentVersion: replacedLink.currentVersion + 1,
            updatedAt: input.now,
            cancelledAt: input.now,
            cancelledByUserId: input.applicantUserId,
            cancellationReason: 'REJECTED_APPLICATION_REPLACED',
          })
          .where(
            and(
              eq(sebApplicationQualifyingAward.id, replacedLink.id),
              eq(sebApplicationQualifyingAward.currentVersion, replacedLink.currentVersion),
              eq(sebApplicationQualifyingAward.status, 'ACTIVE'),
              sql`EXISTS (
                SELECT 1 FROM ${sebApplication}
                WHERE ${sebApplication.id} = ${input.applicationId}
              )`,
            ),
          )
      : null
    const insertReplacedLinkVersion = replacedLink
      ? db.insert(sebApplicationQualifyingAwardVersion).select(sql`
          SELECT ${crypto.randomUUID()}, ${replacedLink.id}, ${input.fundingCaseId},
            ${replacedLink.currentVersion + 1}, ${input.qualifyingAwardId},
            'CANCELLED', 'CANCELLED', 'REJECTED_APPLICATION_REPLACED',
            ${input.applicantUserId}, ${input.now.getTime()}
          WHERE EXISTS (
            SELECT 1 FROM ${sebApplicationQualifyingAward}
            WHERE ${sebApplicationQualifyingAward.id} = ${replacedLink.id}
              AND ${sebApplicationQualifyingAward.currentVersion} = ${replacedLink.currentVersion + 1}
              AND ${sebApplicationQualifyingAward.status} = 'CANCELLED'
          )
        `)
      : null
    const insertLink = db.insert(sebApplicationQualifyingAward).select(sql`
      SELECT ${linkId}, ${input.applicationId}, ${input.fundingCaseId},
        ${input.qualifyingAwardId}, 'ACTIVE', 1, ${input.applicantUserId},
        ${input.now.getTime()}, ${input.now.getTime()}, NULL, NULL, NULL
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplication} WHERE ${sebApplication.id} = ${input.applicationId}
      )
    `)
    const insertLinkVersion = db.insert(sebApplicationQualifyingAwardVersion).select(sql`
      SELECT ${crypto.randomUUID()}, ${linkId}, ${input.fundingCaseId}, 1,
        ${input.qualifyingAwardId}, 'ACTIVE', 'LINKED', NULL,
        ${input.applicantUserId}, ${input.now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM ${sebApplicationQualifyingAward}
        WHERE ${sebApplicationQualifyingAward.id} = ${linkId}
      )
    `)
    const linkStatements = cancelReplacedLink && insertReplacedLinkVersion
      ? [cancelReplacedLink, insertReplacedLinkVersion, insertLink, insertLinkVersion] as const
      : [insertLink, insertLinkVersion] as const
    const [headResult] = await db.batch([
      ...statements,
      ...linkStatements,
      insertEvent,
      insertAudit,
    ])
    return headResult.length === 1
  }
  const [headResult] = await db.batch([...statements, insertEvent, insertAudit])
  return headResult.length === 1
}

export const saveApplicationSnapshot = async (
  db: Database,
  input: {
    head: ApplicationMutationHead
    userId: string
    draft: ApplicationDraftInput
    expansionClaim: ExpansionClaim
    qualifyingAwardId?: string | null
    qualifyingReleaseAt?: Date | null
    revisionSections?: ApplicationSection[]
    programmeCycleVersion: number
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const nextVersion = input.head.currentVersion + 1
  const changeType = input.head.status === 'REVISION_REQUIRED' ? 'REVISION' : 'SAVE'
  const updateHead = db
    .update(sebApplication)
    .set({ currentVersion: nextVersion, updatedAt: input.now })
    .where(
      and(
        eq(sebApplication.id, input.head.id),
        eq(sebApplication.applicantUserId, input.userId),
        eq(sebApplication.currentVersion, input.head.currentVersion),
        eq(sebApplication.statusVersion, input.head.statusVersion),
        eq(sebApplication.status, input.head.status),
        inArray(sebApplication.status, ['DRAFT', 'REVISION_REQUIRED']),
        isNull(sebApplication.deletedAt),
        expansionEvidenceStillCurrent(input),
        revisionScopeStillCurrent(input),
      ),
    )
  const insertVersion = insertVersionWhere(
    db,
    versionValues({
      applicationId: input.head.id,
      version: nextVersion,
      programmeCycleId: input.head.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationType: input.head.applicationType,
      phaseNumber: input.head.phaseNumber,
      changeType,
      changedByUserId: input.userId,
      createdAt: input.now,
      draft: input.draft,
      expansionClaim: input.expansionClaim,
      declarationAcceptedAt: null,
    }),
    sql`${sebApplication.id} = ${input.head.id}
      AND ${sebApplication.currentVersion} = ${nextVersion}
      AND ${sebApplication.updatedAt} = ${input.now.getTime()}`,
  )
  // D1 batches are transactional, but a plain VALUES insert cannot see whether
  // the guarded update won. The caller prechecked the exact head and the unique
  // version key rolls the entire batch back if a concurrent writer won.
  const eventValue = eventValues({
    applicationId: input.head.id,
    eventType: 'APPLICATION_SAVED',
    actorUserId: input.userId,
    applicationVersion: nextVersion,
    message: 'Application draft saved.',
    createdAt: input.now,
  })
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventValue.id}, ${eventValue.applicationId}, ${eventValue.eventType},
      ${eventValue.actorUserId}, ${eventValue.applicationVersion}, NULL, NULL,
      NULL, NULL, NULL, ${eventValue.message}, NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.currentVersion} = ${nextVersion}
        AND ${sebApplication.updatedAt} = ${input.now.getTime()}
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.currentVersion} = ${nextVersion}
        AND ${sebApplication.updatedAt} = ${input.now.getTime()}
    )
  `)
  const [updated] = await db.batch([
    updateHead,
    insertVersion,
    event,
    audit,
  ])
  return d1ChangedExactlyOne(updated)
}

export const setApplicationDeleted = async (
  db: Database,
  input: {
    head: ApplicationHeadRecord
    userId: string
    deleted: boolean
    reason: string | null
    restoreAwardId?: string | null
    restoreAwardNetDisbursedPaise?: number | null
    restoreAwardFirstReleaseAt?: Date | null
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const [link] = await db
    .select()
    .from(sebApplicationQualifyingAward)
    .where(eq(sebApplicationQualifyingAward.applicationId, input.head.id))
    .limit(1)
  const statePredicate = input.deleted
    ? isNull(sebApplication.deletedAt)
    : isNotNull(sebApplication.deletedAt)
  // Restoring any phase must re-establish the aggregate invariants that were
  // released by deletion. This applies to INITIAL as well as EXPANSION drafts:
  // the parent enterprise/case must still be active and no replacement attempt
  // for the same phase may have become current while this draft was deleted.
  const restoreRootEligibilityPredicate = !input.deleted
    ? sql`EXISTS (
        SELECT 1
        FROM ${sebEnterprise}
        INNER JOIN ${sebFundingCase}
          ON ${sebFundingCase.id} = ${input.head.fundingCaseId}
          AND ${sebFundingCase.enterpriseId} = ${sebEnterprise.id}
        WHERE ${sebEnterprise.id} = ${input.head.enterpriseId}
          AND ${sebEnterprise.portalOwnerUserId} = ${input.userId}
          AND ${sebEnterprise.deletedAt} IS NULL
          AND ${sebFundingCase.status} = 'OPEN'
          AND ${sebFundingCase.deletedAt} IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${sebApplication} AS competing_application
        WHERE competing_application.funding_case_id = ${input.head.fundingCaseId}
          AND competing_application.phase_number = ${input.head.phaseNumber}
          AND competing_application.id <> ${input.head.id}
          AND competing_application.status <> 'REJECTED'
          AND competing_application.deleted_at IS NULL
      )`
    : undefined
  const linkStatePredicate = input.head.applicationType === 'EXPANSION'
    ? link && (input.deleted ? link.currentFundingAwardId : input.restoreAwardId)
      ? sql`EXISTS (
          SELECT 1 FROM ${sebApplicationQualifyingAward}
          WHERE ${sebApplicationQualifyingAward.id} = ${link.id}
            AND ${sebApplicationQualifyingAward.currentVersion} = ${link.currentVersion}
            AND ${sebApplicationQualifyingAward.status} = ${input.deleted ? 'ACTIVE' : 'CANCELLED'}
            AND ${input.deleted
              ? sql`${sebApplicationQualifyingAward.currentFundingAwardId} IS NOT NULL`
              : sql`${sebApplicationQualifyingAward.currentFundingAwardId} IS NULL`}
        )`
      : sql`0 = 1`
    : undefined
  // Expansion restoration reclaims a released qualification. Matching the
  // exact net and first retained release closes the race between the friendly
  // eligibility read and this batch, including same-total ledger replacements.
  const restoreEligibilityPredicate =
    !input.deleted && input.head.applicationType === 'EXPANSION' && input.restoreAwardId
      ? sql`EXISTS (
          SELECT 1
          FROM ${sebFundingAward}
          INNER JOIN ${sebApplication} AS prior_application
            ON prior_application.id = ${sebFundingAward.applicationId}
          WHERE ${sebFundingAward.id} = ${input.restoreAwardId}
            AND ${sebFundingAward.fundingCaseId} = ${input.head.fundingCaseId}
            AND ${sebFundingAward.status} = 'ACTIVE'
            AND ${sebFundingAward.deletedAt} IS NULL
            AND prior_application.phase_number = ${input.head.phaseNumber - 1}
            AND (
              SELECT COALESCE(SUM(
                CASE WHEN ledger.entry_type = 'RELEASE'
                  THEN ledger.amount_paise ELSE -ledger.amount_paise END
              ), 0)
              FROM ${sebDisbursement} AS ledger
              WHERE ledger.funding_award_id = ${input.restoreAwardId}
            ) = ${sqlNullable(input.restoreAwardNetDisbursedPaise)}
            AND ${sqlNullable(input.restoreAwardNetDisbursedPaise)} > 0
            AND (
              SELECT MIN(release.occurred_at)
              FROM ${sebDisbursement} AS release
              WHERE release.funding_award_id = ${input.restoreAwardId}
                AND release.entry_type = 'RELEASE'
                AND release.amount_paise - COALESCE((
                  SELECT SUM(reversal.amount_paise)
                  FROM ${sebDisbursement} AS reversal
                  WHERE reversal.related_disbursement_id = release.id
                    AND reversal.entry_type = 'REVERSAL'
                ), 0) > 0
            ) = ${sqlDateMilliseconds(input.restoreAwardFirstReleaseAt)}
            AND EXISTS (
              SELECT 1 FROM ${sebDisbursement} AS release
              WHERE release.funding_award_id = ${input.restoreAwardId}
                AND release.entry_type = 'RELEASE'
                AND release.occurred_at <= ${addUtcCalendarMonths(input.now, -12).getTime()}
                AND release.amount_paise - COALESCE((
                  SELECT SUM(reversal.amount_paise)
                  FROM ${sebDisbursement} AS reversal
                  WHERE reversal.related_disbursement_id = release.id
                    AND reversal.entry_type = 'REVERSAL'
                ), 0) > 0
            )
            AND NOT EXISTS (
              SELECT 1 FROM ${sebApplication} AS competing_application
              WHERE competing_application.funding_case_id = ${input.head.fundingCaseId}
                AND competing_application.phase_number = ${input.head.phaseNumber}
                AND competing_application.id <> ${input.head.id}
                AND competing_application.status <> 'REJECTED'
                AND competing_application.deleted_at IS NULL
            )
        )`
      : undefined
  // This append-only audit row is the transition's unique claim. All writes in
  // the same D1 batch require its exact ID, which is stronger than correlating
  // them through `updated_at`: independent requests may legitimately share the
  // same millisecond timestamp.
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplication}
      WHERE ${sebApplication.id} = ${input.head.id}
        AND ${sebApplication.applicantUserId} = ${input.userId}
        AND ${sebApplication.currentVersion} = ${input.head.currentVersion}
        AND ${sebApplication.statusVersion} = ${input.head.statusVersion}
        AND ${sebApplication.status} = 'DRAFT'
        AND ${statePredicate}
        AND ${restoreRootEligibilityPredicate ?? sql`1 = 1`}
        AND ${linkStatePredicate ?? sql`1 = 1`}
        AND ${restoreEligibilityPredicate ?? sql`1 = 1`}
    )
  `)
  const updateHead = db
    .update(sebApplication)
    .set(
      input.deleted
        ? {
            deletedAt: input.now,
            deletedByUserId: input.userId,
            deleteReason: input.reason,
            updatedAt: input.now,
          }
        : {
            deletedAt: null,
            deletedByUserId: null,
            deleteReason: null,
            updatedAt: input.now,
          },
    )
    .where(
      and(
        eq(sebApplication.id, input.head.id),
        eq(sebApplication.applicantUserId, input.userId),
        eq(sebApplication.currentVersion, input.head.currentVersion),
        eq(sebApplication.statusVersion, input.head.statusVersion),
        eq(sebApplication.status, 'DRAFT'),
        statePredicate,
        restoreRootEligibilityPredicate,
        linkStatePredicate,
        restoreEligibilityPredicate,
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const nextLinkVersion = link ? link.currentVersion + 1 : null
  const linkAwardId = input.deleted ? link?.currentFundingAwardId : input.restoreAwardId
  const updateLink = link && linkAwardId && nextLinkVersion
    ? db
        .update(sebApplicationQualifyingAward)
        .set(
          input.deleted
            ? {
                status: 'CANCELLED',
                currentFundingAwardId: null,
                currentVersion: nextLinkVersion,
                updatedAt: input.now,
                cancelledAt: input.now,
                cancelledByUserId: input.userId,
                cancellationReason: 'APPLICATION_DRAFT_DELETED',
              }
            : {
                status: 'ACTIVE',
                currentFundingAwardId: input.restoreAwardId,
                currentVersion: nextLinkVersion,
                updatedAt: input.now,
                cancelledAt: null,
                cancelledByUserId: null,
                cancellationReason: null,
              },
        )
        .where(
          and(
            eq(sebApplicationQualifyingAward.id, link.id),
            eq(sebApplicationQualifyingAward.currentVersion, link.currentVersion),
            eq(
              sebApplicationQualifyingAward.status,
              input.deleted ? 'ACTIVE' : 'CANCELLED',
            ),
            sql`EXISTS (
              SELECT 1 FROM ${coreAuditEvent}
              WHERE ${coreAuditEvent.id} = ${input.audit.id}
            )`,
          ),
        )
    : null
  const insertLinkVersion = link && linkAwardId && nextLinkVersion
    ? db.insert(sebApplicationQualifyingAwardVersion).select(sql`
        SELECT ${crypto.randomUUID()}, ${link.id}, ${input.head.fundingCaseId},
          ${nextLinkVersion}, ${linkAwardId},
          ${input.deleted ? 'CANCELLED' : 'ACTIVE'},
          ${input.deleted ? 'CANCELLED' : 'CORRECTED'},
          ${input.deleted ? 'APPLICATION_DRAFT_DELETED' : 'APPLICATION_DRAFT_RESTORED'},
          ${input.userId}, ${input.now.getTime()}
        WHERE EXISTS (
          SELECT 1 FROM ${sebApplicationQualifyingAward}
          WHERE ${sebApplicationQualifyingAward.id} = ${link.id}
            AND ${sebApplicationQualifyingAward.currentVersion} = ${nextLinkVersion}
        )
      `)
    : null
  const eventId = crypto.randomUUID()
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${eventId}, ${input.head.id},
      ${input.deleted ? 'APPLICATION_DELETED' : 'APPLICATION_RESTORED'},
      ${input.userId}, ${input.head.currentVersion}, NULL, NULL, 'DRAFT', 'DRAFT',
      NULL, ${input.deleted ? 'Application draft removed.' : 'Application draft restored.'},
      NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${coreAuditEvent}
      WHERE ${coreAuditEvent.id} = ${input.audit.id}
    )
  `)
  const statements = updateLink && insertLinkVersion
    ? [audit, updateHead, updateLink, insertLinkVersion, event] as const
    : [audit, updateHead, event] as const
  const [updated] = await db.batch(statements)
  return d1ChangedExactlyOne(updated)
}

export const submitApplicationSnapshot = async (
  db: Database,
  input: {
    head: ApplicationMutationHead
    currentVersion: ApplicationVersionRecord
    userId: string
    draft: ApplicationDraftInput
    expansionClaim: ExpansionClaim
    qualifyingAwardId?: string | null
    qualifyingReleaseAt?: Date | null
    revisionSections?: ApplicationSection[]
    programmeCycleVersion: number
    referenceNumber: string
    resubmission: boolean
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const nextVersion = input.head.currentVersion + 1
  const nextStatusVersion = input.head.statusVersion + 1
  let submissionNumber = 1
  if (input.resubmission) {
    const [nextSubmission] = await db
      .select({ value: sql<number>`COALESCE(MAX(${sebApplicationSubmission.submissionNumber}), 0) + 1` })
      .from(sebApplicationSubmission)
      .where(eq(sebApplicationSubmission.applicationId, input.head.id))
    submissionNumber = requireInvariant(
      nextSubmission,
      'Submission sequence query returned no row.',
    ).value
  }
  const submissionId = crypto.randomUUID()
  const cycleStillOpen = input.resubmission
    ? undefined
    : sql`EXISTS (
        SELECT 1 FROM ${sebProgrammeCycle}
        WHERE ${sebProgrammeCycle.id} = ${input.head.programmeCycleId}
          AND ${programmeCycleOpenAt(input.now)}
      )`
  const requiredDocumentsStillExist = and(
    ...requiredDocumentTypesForSnapshot(input.draft).map((documentType) => sql`EXISTS (
      SELECT 1 FROM ${sebApplicationDocument}
      WHERE ${sebApplicationDocument.applicationId} = ${input.head.id}
        AND ${sebApplicationDocument.documentType} = ${documentType}
        AND ${sebApplicationDocument.deletedAt} IS NULL
    )`),
  )
  const updateHead = db
    .update(sebApplication)
    .set({
      currentVersion: nextVersion,
      status: 'SUBMITTED',
      statusVersion: nextStatusVersion,
      referenceNumber: input.head.referenceNumber ?? input.referenceNumber,
      firstSubmittedAt: input.head.firstSubmittedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebApplication.id, input.head.id),
        eq(sebApplication.applicantUserId, input.userId),
        eq(sebApplication.currentVersion, input.head.currentVersion),
        eq(sebApplication.statusVersion, input.head.statusVersion),
        eq(
          sebApplication.status,
          input.resubmission ? 'REVISION_REQUIRED' : 'DRAFT',
        ),
        isNull(sebApplication.deletedAt),
        cycleStillOpen,
        requiredDocumentsStillExist,
        expansionEvidenceStillCurrent(input),
        revisionScopeStillCurrent(input),
      ),
    )
  const formalVersion = insertVersionWhere(
    db,
    versionValues({
      applicationId: input.head.id,
      version: nextVersion,
      programmeCycleId: input.head.programmeCycleId,
      programmeCycleVersion: input.programmeCycleVersion,
      applicationType: input.head.applicationType,
      phaseNumber: input.head.phaseNumber,
      changeType: input.resubmission ? 'RESUBMISSION' : 'SUBMISSION',
      changedByUserId: input.userId,
      createdAt: input.now,
      draft: input.draft,
      expansionClaim: input.expansionClaim,
      declarationAcceptedAt: input.now,
    }),
    sql`${sebApplication.id} = ${input.head.id}
      AND ${sebApplication.currentVersion} = ${nextVersion}
      AND ${sebApplication.statusVersion} = ${nextStatusVersion}
      AND ${sebApplication.updatedAt} = ${input.now.getTime()}`,
  )
  const submission = db.insert(sebApplicationSubmission).select(sql`
    SELECT ${submissionId}, ${input.head.id}, ${submissionNumber}, ${nextVersion},
      ${input.userId}, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationVersion}
      WHERE ${sebApplicationVersion.applicationId} = ${input.head.id}
        AND ${sebApplicationVersion.version} = ${nextVersion}
    )
  `)
  const resolveRevisions = db
    .update(sebRevisionRequest)
    .set({ resolvedBySubmissionId: submissionId, resolvedAt: input.now })
    .where(
      and(
        eq(sebRevisionRequest.applicationId, input.head.id),
        isNull(sebRevisionRequest.resolvedAt),
        isNull(sebRevisionRequest.cancelledAt),
        sql`EXISTS (
          SELECT 1 FROM ${sebApplicationSubmission}
          WHERE ${sebApplicationSubmission.id} = ${submissionId}
        )`,
      ),
    )
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.head.id},
      ${input.resubmission ? 'APPLICATION_RESUBMITTED' : 'APPLICATION_SUBMITTED'},
      ${input.userId}, ${nextVersion}, ${submissionId}, NULL,
      ${input.resubmission ? 'REVISION_REQUIRED' : 'DRAFT'}, 'SUBMITTED', NULL,
      ${input.resubmission ? 'Application resubmitted.' : 'Application submitted.'},
      NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationSubmission}
      WHERE ${sebApplicationSubmission.id} = ${submissionId}
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationSubmission}
      WHERE ${sebApplicationSubmission.id} = ${submissionId}
    )
  `)
  const statements = input.resubmission
    ? [updateHead, formalVersion, submission, resolveRevisions, event, audit] as const
    : [updateHead, formalVersion, submission, event, audit] as const
  const [updated] = await db.batch(statements)
  return d1ChangedExactlyOne(updated)
}

export const listApplicationTimeline = async (
  db: Database,
  input: {
    applicationId: string
    first: number
    cursor: { timestamp: Date; id: string } | null
  },
): Promise<Connection<TimelineEvent>> => {
  const cursorPredicate = input.cursor
    ? or(
        gt(sebApplicationEvent.createdAt, input.cursor.timestamp),
        and(
          eq(sebApplicationEvent.createdAt, input.cursor.timestamp),
          gt(sebApplicationEvent.id, input.cursor.id),
        ),
      )
    : undefined
  const rows = await db
    .select()
    .from(sebApplicationEvent)
    .where(and(eq(sebApplicationEvent.applicationId, input.applicationId), cursorPredicate))
    .orderBy(asc(sebApplicationEvent.createdAt), asc(sebApplicationEvent.id))
    .limit(input.first + 1)
  const hasNextPage = rows.length > input.first
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)
  return {
    nodes: selected.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      section: row.section,
      message: row.message,
      createdAt: row.createdAt,
    })),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    },
  }
}

export const snapshotRecordToPublic = snapshotFromRecord
