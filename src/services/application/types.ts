import type { AppBindings } from '../../bindings'
import type { Envelope } from '../envelope'

/*
 * Re-exported so a caller naming one of the aliases below can name its shape
 * too. Without this the alias would resolve to a type nothing else can reach.
 */
export type { Envelope } from '../envelope'
import type { Loaders } from '../../loaders'

// Re-exported because the operation contexts below name it.
export type { Loaders } from '../../loaders'
import type { Database } from '../../db'
export type { AnswerMap } from './form/types'
import type { AnswerMap } from './form/types'

/*
 * `AnswerMap` alone, because `Application` and `ApplicationSnapshot` below both
 * name one — a caller holding either and unable to name its answers would have
 * a type it cannot take apart.
 *
 * The rest of the form's vocabulary is **not** re-exported here — import it
 * from `form/types`, or `form/codes` for an issue.
 *
 * It was, "so a caller naming an application can name its answers without
 * reaching past this module into the engine". That reads well and cannot be
 * done honestly: re-exporting the composites alone left a caller holding a
 * `ResolvedFormTemplate` with no way to name a `FormField` in it, and
 * re-exporting the parts as well made this module the second place the
 * vocabulary is declared. One door into the engine's types, and it is the
 * engine's own file.
 */
import type {
  awardAssessmentOutcomes,
  awardAssessmentTypes,
  fundingAwardClosureDispositions,
  fundingAwardStatuses,
  applicationStatuses,
  applicationTypes,
  businessSectors,
  enterpriseStatuses,
  programmeCycleStatuses,
  registrationTypes,
  tripuraDistricts,
} from '../../db/schema'

export type ApplicationOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type SebResult<T> = Envelope<T>

export type RegistrationType = (typeof registrationTypes)[number]
export type TripuraDistrict = (typeof tripuraDistricts)[number]
export type BusinessSector = (typeof businessSectors)[number]
export type EnterpriseStatus = (typeof enterpriseStatuses)[number]
export type ApplicationStatus = (typeof applicationStatuses)[number]
export type ApplicationType = (typeof applicationTypes)[number]
/*
 * Five closed sets stood here — category, designation, gender, credit status
 * and relationship — naming answers the *old fixed form* asked. What a cycle
 * asks, and which values it offers, is the cycle's decision now: each is a
 * `SINGLE_CHOICE` question whose values the template enumerates.
 *
 * `applicationCategories` survives in the schema because the category is
 * role-bound and read across many cycles at once, and `ApplicationCategory`
 * survives in the *SDL* for the same reason. The TypeScript alias had no
 * reader on either side of that.
 */
/**
 * The evidence slot a document fills, and the step of the form a question sits
 * in.
 *
 * Both were closed enums and are now template keys, because which documents a
 * cycle asks for and how it groups its questions are the cycle's decisions. A
 * key is validated against the template pinned to the application it belongs to
 * — the schema constrains its shape, and the form engine constrains its
 * membership.
 */
export type DocumentType = string
export type ApplicationSection = string
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
  businessDistrict: TripuraDistrict | null
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
  & Partial<Omit<EnterpriseProfileInput, 'name' | 'registrationType' | 'businessDistrict'>>
  /*
   * Wider than the stored profile on purpose: over the wire the district is
   * whatever string the client sent, and normalization is what narrows it to
   * the closed set — by value, not by trusting a type annotation.
   */
  & { businessDistrict?: string | null }

export type Enterprise = EnterpriseProfileInput & {
  id: string
  status: EnterpriseStatus
  currentVersion: number
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export type ExpansionClaim = {
  priorSanctionOrderNumber: string | null
  priorSanctionDate: string | null
  priorNetDisbursedAmountPaise: number | null
  continuousOperationMonths: number | null
}

/**
 * One stored version, without its answers.
 *
 * The answers live one row each and are read against the template this version
 * is pinned to, so a caller that wants them asks for them. Keeping them off
 * this type is what stops a list of applications loading a template and an
 * answer set per row by accident.
 */
export type ApplicationSnapshot = ExpansionClaim & {
  version: number
  /** What was answered at this version, against the form it is pinned to. */
  answers: AnswerMap
  programmeCycleVersion: number
  applicationType: ApplicationType
  phaseNumber: number
  changeType: string
  declarationAcceptedAt: Date | null
  /** Computed at submission; see the schema column. Null on drafts. */
  applicationCategory: 'CATEGORY_A' | 'CATEGORY_B' | null
  createdAt: Date
}

export type ApplicationDocument = {
  id: string
  /** The FILE field this evidence answers, from the pinned template. */
  fieldKey: DocumentType
  currentVersion: number
  originalFilename: string
  contentType: string
  sizeBytes: number
  createdAt: Date
  deletedAt: Date | null
}

export type RevisionRequest = {
  id: string
  /** The template stage a reviewer reopened; see `ApplicationSection`. */
  stageKey: ApplicationSection
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
  /**
   * Every answer on the current version, keyed by template field.
   *
   * Read against the template this version is pinned to, so a question the
   * cycle has since changed still reads as it was answered.
   */
  answers: AnswerMap
  documents: ApplicationDocument[]
  revisionRequests: RevisionRequest[]
  /**
   * Stages the applicant may change right now.
   *
   * Every stage the pinned template declares while the application is a draft,
   * only the stages named by unresolved revision requests while revision is
   * required, and none otherwise. Anything outside this list is locked.
   */
  editableStageKeys: ApplicationSection[]
}

// The list view is deliberately lighter than the detail view: editable stages
// need the application's revision requests, and the answers need its template,
// neither of which a paginated list may read per row.
export type ApplicationSummary = Omit<
  Application,
  'snapshot' | 'answers' | 'documents' | 'revisionRequests' | 'editableStageKeys'
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
  /**
   * The order or circular this cycle implements, as a downloadable PDF.
   * Null until the office publishes one *and* its malware scan is ACCEPTED —
   * an applicant is never shown a file nobody may download.
   */
  policyDocument: {
    version: number
    originalFilename: string
    sizeBytes: number
    uploadedAt: Date
  } | null
  applicantGuidance: string | null
  /**
   * The current rule version's Category A threshold, in months of trading.
   * The one policy scalar the applicant surface repeats, so the screens can
   * say which way an establishment date points before submission stamps the
   * category for real.
   */
  categoryAMaximumMonths: number | null
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
  stageKey: ApplicationSection | null
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
