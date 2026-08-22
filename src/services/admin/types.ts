import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
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

export type AdminOperationContext = {
  db: Database
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type AdminResult<T> = {
  success: boolean
  message: string | null
  response: T | null
}

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

export type RevisionRequestInput = {
  section: 'ENTERPRISE' | 'APPLICANT_PROFILE' | 'FINANCIAL' | 'PRIOR_FUNDING' | 'DOCUMENTS' | 'DECLARATION'
  reasonCategoryId: string
  note: string
}

export type PageInfo = { endCursor: string | null; hasNextPage: boolean }

