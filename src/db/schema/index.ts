import { coreAuditEvent } from './core/audit'
import { coreSession, coreSignupChallenge, coreUser } from './core/auth'
import {
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
} from './seb/application'
import { sebFundingCase, sebFundingCaseVersion } from './seb/case'
import {
  sebApplicationDocument,
  sebApplicationDocumentVersion,
  sebDocumentUploadIntent,
} from './seb/document'
import { sebEnterprise, sebEnterpriseVersion } from './seb/enterprise'
import {
  sebApplicationQualifyingAward,
  sebApplicationQualifyingAwardVersion,
  sebAwardAssessment,
  sebDisbursement,
  sebFundingAward,
  sebFundingAwardVersion,
} from './seb/funding'
import { sebProgrammeCycle, sebProgrammeCycleVersion } from './seb/programme'
import { sebApplicationEvent, sebRevisionRequest } from './seb/workflow'

export * from './core/audit'
export * from './core/auth'
export * from './seb/application'
export * from './seb/case'
export * from './seb/document'
export * from './seb/enterprise'
export * from './seb/funding'
export * from './seb/programme'
export * from './seb/workflow'

/** Complete schema passed to the request-scoped Drizzle D1 client. */
export const schema = {
  coreUser,
  coreSession,
  coreSignupChallenge,
  coreAuditEvent,
  sebEnterprise,
  sebEnterpriseVersion,
  sebProgrammeCycle,
  sebProgrammeCycleVersion,
  sebFundingCase,
  sebFundingCaseVersion,
  sebApplication,
  sebApplicationVersion,
  sebApplicationSubmission,
  sebApplicationDocument,
  sebApplicationDocumentVersion,
  sebDocumentUploadIntent,
  sebRevisionRequest,
  sebApplicationEvent,
  sebFundingAward,
  sebFundingAwardVersion,
  sebApplicationQualifyingAward,
  sebApplicationQualifyingAwardVersion,
  sebDisbursement,
  sebAwardAssessment,
}
