import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'

export type { AppBindings } from '../../bindings'

/**
 * Authentication services are stateless. Every operation receives its database,
 * request metadata, environment, and response-header sink explicitly.
 */
export type AuthOperationContext = {
  db: Database
  env: AppBindings
  requestHeaders: Headers
  requestUrl: string
  responseHeaders: Headers
}

export type Applicant = {
  id: string
  email: string
  emailVerified: boolean
  role: 'APPLICANT'
  createdAt: Date
}

export type ApplicantSession = {
  id: string
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
  current: boolean
}

export type ApplicantAuthResponse = {
  applicant: Applicant
  session: ApplicantSession
}

export type StartApplicantSignupResponse = {
  challengeToken: string
  expiresAt: Date
}

export type AuthResult<T> = {
  // Expected failures stay inside this envelope instead of becoming GraphQL errors.
  success: boolean
  message: string | null
  response: T | null
}
