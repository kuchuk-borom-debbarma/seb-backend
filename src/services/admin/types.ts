import type { deskReviewIdentifierKinds } from '../../db/schema'
import type { Envelope } from '../envelope'
import type { AppBindings } from '../../bindings'
import type { Loaders } from '../../loaders'

// Re-exported because the operation contexts below name it.
export type { Loaders } from '../../loaders'
import type { Database } from '../../db'
import type { IdentifierKind } from './identifiers'
export type { IdentifierKind } from './identifiers'
import type {
  awardAssessmentTypes,
  bankOutcomes,
  deskReviewChecks,
  deskReviewCheckResults,
  deskReviewOutcomes,
  documentTypes,
  fundingCeilingScopes,
  fundingCeilingStates,
  programmeDocumentConditions,
  programmeJurisdictions,
  programmeReasonContexts,
  recoveryComponents,
  ttmDecisionOutcomes,
} from '../../db/schema'

/**
 * The named work queues staff actually operate from.
 *
 * Most map to a single application status, but two do not, which is why this is
 * its own vocabulary rather than a reuse of `ApplicationStatus`: a first
 * submission and an answer to a revision request are both `SUBMITTED` and need
 * completely different handling, so they are separated by submission number.
 */
export const intakeQueueKeys = [
  'NEW_SUBMISSIONS',
  'DESK_REVIEW',
  'REVISION_RESPONSES',
  'PARTNER_BANK_EVALUATION',
  'TTM_REVIEW',
  'APPROVED',
  'REJECTED',
  'SANCTIONED',
  'DISBURSED',
] as const
export type IntakeQueueKey = (typeof intakeQueueKeys)[number]

export type AdminOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type AdminResult<T> = Envelope<T>

export type DocumentType = (typeof documentTypes)[number]
export type ProgrammeDocumentCondition = (typeof programmeDocumentConditions)[number]
export type ProgrammeReasonContext = (typeof programmeReasonContexts)[number]
export type ProgrammeJurisdiction = (typeof programmeJurisdictions)[number]
export type FundingCeilingState = (typeof fundingCeilingStates)[number]
export type FundingCeilingScope = (typeof fundingCeilingScopes)[number]
export type AssessmentType = (typeof awardAssessmentTypes)[number]
export type DeskReviewCheckType = (typeof deskReviewChecks)[number]
export type DeskReviewCheckResult = (typeof deskReviewCheckResults)[number]
export type DeskReviewOutcome = (typeof deskReviewOutcomes)[number]
export type BankOutcome = (typeof bankOutcomes)[number]
export type TtmDecisionOutcome = (typeof ttmDecisionOutcomes)[number]
export type RecoveryComponent = (typeof recoveryComponents)[number]

export type ProgrammeCycleDocumentRuleInput = {
  documentType: DocumentType
  condition: ProgrammeDocumentCondition
}

export type ProgrammeCycleReasonInput = {
  context: ProgrammeReasonContext
  code: string
  label: string
  applicantMessageTemplate?: string | null
}

export type ProgrammeCyclePolicyInput = {
  minimumApplicantAge: number | null
  maximumApplicantAge: number | null
  categoryAMaximumMonths: number | null
  expansionWaitMonths: number | null
  majorityOwnershipRequired: boolean | null
  jurisdiction: ProgrammeJurisdiction | null
  fundingCeilingState: FundingCeilingState | null
  fundingCeilingAmountPaise: number | null
  fundingCeilingScope: FundingCeilingScope | null
  requiredAssessmentTypes: AssessmentType[]
  documentRules: ProgrammeCycleDocumentRuleInput[]
  /** Absent means the cycle collects nothing and compares nothing. */
  identifierRules?: ProgrammeCycleIdentifierRuleInput[]
  reasons: ProgrammeCycleReasonInput[]
}

export type ProgrammeCycleInput = {
  cycleCode: string
  displayName: string
  cycleYear: number
  policyReference?: string | null
  applicantGuidance?: string | null
  partnerBankGuidance?: string | null
  opensAt?: Date | null
  closesAt?: Date | null
  policy: ProgrammeCyclePolicyInput
}

export type DeskReviewCheckInput = {
  checkType: DeskReviewCheckType
  result: DeskReviewCheckResult
  internalNote?: string | null
}

/**
 * One number read off a document, as the reviewer typed it.
 *
 * `branchCode` belongs only to a bank account, where the account number alone
 * does not identify a destination. `matchedReason` is supplied on the second
 * attempt, once the reviewer has been told the value already exists elsewhere.
 */
export type DeskReviewIdentifierInput = {
  kind: IdentifierKind
  value: string
  branchCode?: string | null
  matchedReason?: string | null
}

export type RevisionRequestInput = {
  section: 'ENTERPRISE' | 'APPLICANT_PROFILE' | 'FINANCIAL' | 'PRIOR_FUNDING' | 'DOCUMENTS' | 'DECLARATION'
  reasonCategoryId: string
  note: string
}

export type { PageInfo } from '../application/types'


/**
 * One frozen rule about an identifier a reviewer transcribes.
 *
 * `requirement` and `duplicatePolicy` are independent on purpose: a value can
 * be worth recording without being worth refusing on, and worth comparing
 * without being demanded.
 */
export type ProgrammeCycleIdentifierRuleInput = {
  kind: (typeof deskReviewIdentifierKinds)[number]
  requirement: 'REQUIRED_ON_PASS' | 'OPTIONAL' | 'OFF'
  duplicatePolicy: 'CHECKED' | 'NOT_CHECKED'
  checkType?: string | null
}

export type IdentifierRule = {
  kind: (typeof deskReviewIdentifierKinds)[number]
  requirement: 'REQUIRED_ON_PASS' | 'OPTIONAL' | 'OFF'
  duplicatePolicy: 'CHECKED' | 'NOT_CHECKED'
  /** The check this is evidence for. Null unless it is required on a pass. */
  checkType: string | null
}
