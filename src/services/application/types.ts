import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
import type {
  applicationCategories,
  awardAssessmentOutcomes,
  awardAssessmentTypes,
  fundingAwardClosureDispositions,
  fundingAwardStatuses,
  applicationSections,
  applicationStatuses,
  applicationTypes,
  applicantDesignations,
  businessSectors,
  creditStatuses,
  documentTypes,
  enterpriseStatuses,
  genders,
  programmeCycleStatuses,
  registrationTypes,
  relationshipTypes,
} from '../../db/schema'

export type ApplicationOperationContext = {
  db: Database
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type SebResult<T> = {
  success: boolean
  message: string | null
  response: T | null
}

export type RegistrationType = (typeof registrationTypes)[number]
export type BusinessSector = (typeof businessSectors)[number]
export type EnterpriseStatus = (typeof enterpriseStatuses)[number]
export type ApplicationStatus = (typeof applicationStatuses)[number]
export type ApplicationType = (typeof applicationTypes)[number]
export type ApplicationCategory = (typeof applicationCategories)[number]
export type ApplicantDesignation = (typeof applicantDesignations)[number]
export type Gender = (typeof genders)[number]
export type CreditStatus = (typeof creditStatuses)[number]
export type RelationshipType = (typeof relationshipTypes)[number]
export type DocumentType = (typeof documentTypes)[number]
export type ApplicationSection = (typeof applicationSections)[number]
export type ProgrammeCycleStatus = (typeof programmeCycleStatuses)[number]
export type FundingAwardStatus = (typeof fundingAwardStatuses)[number]
export type FundingAwardClosureDisposition =
  (typeof fundingAwardClosureDispositions)[number]
export type AwardAssessmentType = (typeof awardAssessmentTypes)[number]
export type AwardAssessmentOutcome = (typeof awardAssessmentOutcomes)[number]

export type EnterpriseProfileInput = {
  name: string
  establishmentDate: string | null
  registrationType: RegistrationType
  registrationNumber: string | null
  gstin: string | null
  businessSector: BusinessSector | null
  otherBusinessSector: string | null
  businessBlockOrVillage: string | null
  businessDistrict: string | null
  businessPinCode: string | null
  contactNumber: string | null
  contactEmail: string | null
}

/**
 * The enterprise profile as it actually arrives from GraphQL.
 *
 * A nullable GraphQL input field that the client omits is absent from the
 * arguments object rather than present as `null`, so every optional field can
 * be `undefined` at this boundary. Normalization collapses both spellings to
 * `null` before any rule runs.
 */
export type SuppliedEnterpriseProfile =
  & Pick<EnterpriseProfileInput, 'name' | 'registrationType'>
  & Partial<Omit<EnterpriseProfileInput, 'name' | 'registrationType'>>

export type Enterprise = EnterpriseProfileInput & {
  id: string
  status: EnterpriseStatus
  currentVersion: number
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export type EnterpriseDetailsInput = {
  businessName: string | null
  establishmentDate: string | null
  registrationType: RegistrationType | null
  registrationNumber: string | null
  gstin: string | null
  businessSector: BusinessSector | null
  otherBusinessSector: string | null
  applicationCategory: ApplicationCategory | null
  majorityOwnershipConfirmed: boolean | null
}

export type ApplicantProfileInput = {
  primaryApplicantName: string | null
  designation: ApplicantDesignation | null
  dateOfBirth: string | null
  gender: Gender | null
  businessBlockOrVillage: string | null
  businessDistrict: string | null
  businessPinCode: string | null
  contactNumber: string | null
  contactEmail: string | null
}

export type FinancialInput = {
  totalProjectCostPaise: number | null
  seedFundRequestedPaise: number | null
  bankLoanProposedPaise: number | null
  promoterContributionPaise: number | null
}

export type PriorFundingInput = {
  receivedGovernmentFunding: boolean | null
  governmentSchemeName: string | null
  governmentFundingAmountPaise: number | null
  governmentFundingSanctionYear: number | null
  hasExistingBankCredit: boolean | null
  existingBankName: string | null
  existingCreditAmountPaise: number | null
  existingCreditStatus: CreditStatus | null
}

export type DocumentRequirementsInput = {
  nocRequired: boolean | null
}

export type DeclarationInput = {
  relationshipType: RelationshipType | null
  relatedPersonName: string | null
  declarationAccepted: boolean | null
  declarationPlace: string | null
}

/**
 * A draft save is a replacement snapshot rather than a JSON merge. GraphQL
 * requires each section object; controllers additionally verify every nullable
 * key is present so accidental omission cannot erase only part of a section.
 */
export type ApplicationDraftInput = {
  enterprise: EnterpriseDetailsInput
  applicantProfile: ApplicantProfileInput
  financial: FinancialInput
  priorFunding: PriorFundingInput
  documents: DocumentRequirementsInput
  declaration: DeclarationInput
}

export type ExpansionClaim = {
  priorSanctionOrderNumber: string | null
  priorSanctionDate: string | null
  priorNetDisbursedAmountPaise: number | null
  continuousOperationMonths: number | null
}

export type ApplicationSnapshot = ApplicationDraftInput &
  ExpansionClaim & {
    version: number
    programmeCycleVersion: number
    applicationType: ApplicationType
    phaseNumber: number
    changeType: string
    declarationAcceptedAt: Date | null
    createdAt: Date
  }

export type ApplicationDocument = {
  id: string
  documentType: DocumentType
  currentVersion: number
  originalFilename: string
  contentType: string
  sizeBytes: number
  createdAt: Date
  deletedAt: Date | null
}

export type RevisionRequest = {
  id: string
  section: ApplicationSection
  note: string
  requestedAt: Date
  resolvedAt: Date | null
  cancelledAt: Date | null
}

export type Application = {
  id: string
  enterpriseId: string
  fundingCaseId: string
  programmeCycleId: string
  applicationType: ApplicationType
  phaseNumber: number
  referenceNumber: string | null
  currentVersion: number
  status: ApplicationStatus
  statusVersion: number
  firstSubmittedAt: Date | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  snapshot: ApplicationSnapshot
  documents: ApplicationDocument[]
  revisionRequests: RevisionRequest[]
  /**
   * Sections the applicant may change right now.
   *
   * Every section while the application is a draft, only the sections named by
   * unresolved revision requests while revision is required, and none
   * otherwise. Anything outside this list is locked.
   */
  editableSections: ApplicationSection[]
}

// The list view is deliberately lighter than the detail view: editable
// sections need the application's revision requests, which a paginated list
// must not read per row.
export type ApplicationSummary = Omit<
  Application,
  'snapshot' | 'documents' | 'revisionRequests' | 'editableSections'
> & {
  businessName: string | null
  cycleCode: string
  cycleYear: number
}

export type ProgrammeCycle = {
  id: string
  cycleCode: string
  displayName: string
  cycleYear: number
  policyReference: string | null
  applicantGuidance: string | null
  /**
   * The cycle's own lifecycle state, which is not the same as whether an
   * application may start in it: a cycle can be OPEN but outside its
   * application window. The window is `opensAt`/`closesAt`.
   */
  status: ProgrammeCycleStatus
  currentVersion: number
  opensAt: Date | null
  closesAt: Date | null
}

/** One application that has to be dealt with before its enterprise can go. */
export type EnterpriseDeletionBlocker = {
  applicationId: string
  /** Null while the application has never been submitted. */
  referenceNumber: string | null
  status: ApplicationStatus
  hasAward: boolean
}

/**
 * Deletion carries an extra field so a refusal can name what blocked it.
 *
 * Always present and empty on every other outcome, so a client never has to
 * distinguish "not blocked" from "field absent".
 */
export type EnterpriseDeletionResult = SebResult<Enterprise> & {
  blockers: EnterpriseDeletionBlocker[]
}

/** Who the applicant is waiting on. NOBODY means the application has finished. */
export type NextActor = 'APPLICANT' | 'PROGRAMME_OFFICE' | 'NOBODY'

/**
 * One status explained in plain language.
 *
 * Deliberately carries no dates: a status says who holds the work, never when
 * they will finish it.
 */
export type ApplicationStatusGuideEntry = {
  status: ApplicationStatus
  label: string
  explanation: string
  nextActor: NextActor
  /** What the applicant can do now; null when nothing is theirs to do. */
  nextAction: string | null
}

export type ValidationIssue = {
  section: ApplicationSection
  field: string
  code: string
  message: string
}

export type ValidationReport = {
  valid: boolean
  issues: ValidationIssue[]
}

/**
 * One unmet expansion rule, stated separately so the applicant can see exactly
 * what remains outstanding rather than a single combined refusal.
 */
export type ExpansionReason = {
  code: ExpansionReasonCode
  message: string
  /**
   * The release obligation this reason is about, for utilization results.
   * Null for reasons that apply to the award as a whole.
   */
  obligationId: string | null
}

const expansionReasonCodes = [
  'NO_QUALIFYING_AWARD',
  'QUALIFYING_AWARD_NOT_ACTIVE',
  'NO_POSITIVE_RELEASE',
  'TWELVE_MONTH_WAIT_NOT_COMPLETE',
  'UTILIZATION_NOT_PASSED',
  'PERFORMANCE_NOT_PASSED',
  'FINANCIAL_AUDIT_NOT_PASSED',
  'COMPETING_PHASE_APPLICATION',
] as const
export type ExpansionReasonCode = (typeof expansionReasonCodes)[number]

export type ExpansionEligibility = {
  eligible: boolean
  nextPhaseNumber: number | null
  qualifyingAwardId: string | null
  /** The first calendar instant the twelve-month rule is satisfied. */
  eligibleAt: Date | null
  reasons: ExpansionReason[]
}

export type TimelineEvent = {
  id: string
  eventType: string
  fromStatus: ApplicationStatus | null
  toStatus: ApplicationStatus | null
  section: ApplicationSection | null
  message: string | null
  createdAt: Date
}

export type PageInfo = {
  endCursor: string | null
  hasNextPage: boolean
  /**
   * How many rows match the filters, not just this page.
   *
   * Keyset pagination cannot derive it — that is the price of not counting
   * offsets — so it is a second query with the same predicates. It is what lets
   * a screen say "1-20 of 143", and what tells "nothing matches these filters"
   * apart from "nothing here yet".
   */
  totalCount: number
}

export type Connection<T> = {
  nodes: T[]
  pageInfo: PageInfo
}

export type UploadAuthorization = {
  uploadId: string
  uploadUrl: string
  expiresAt: Date
  requiredHeaders: Array<{ name: string; value: string }>
}

export type DownloadAuthorization = {
  downloadUrl: string
  expiresAt: Date
}

/**
 * Applicant-visible view of an award and what it has actually paid out.
 *
 * Amounts are derived from the append-only ledger rather than stored, so they
 * cannot drift from the releases and reversals behind them.
 */
export type ApplicantAward = {
  sanctionOrderNumber: string
  sanctionDate: string
  sanctionedAmountPaise: number
  applicantConditions: string | null
  status: FundingAwardStatus
  closureDisposition: FundingAwardClosureDisposition | null
  grossReleasedPaise: number
  reversedPaise: number
  netReleasedPaise: number
  remainingPlannedPaise: number
}

/** One payment, with any correction folded into it rather than listed apart. */
export type ApplicantRelease = {
  sequenceNumber: number
  occurredAt: Date
  amountPaise: number
  paymentReference: string | null
  reversedAmountPaise: number
}

/** One post-award assessment result, without reviewer-only evidence or notes. */
export type ApplicantAssessment = {
  assessmentType: AwardAssessmentType
  assessmentNumber: number
  outcome: AwardAssessmentOutcome
  assessedAt: Date
  summary: string
  /**
   * True when this is the current result rather than a superseded one.
   *
   * Utilization is assessed per release, so more than one utilization
   * assessment can be current at the same time.
   */
  latest: boolean
}

export type ApplicantFunding = {
  award: ApplicantAward
  releases: ApplicantRelease[]
  assessments: ApplicantAssessment[]
}
