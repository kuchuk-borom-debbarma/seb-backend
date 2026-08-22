import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
import type { UserRole } from '../../db/schema'

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

/** Internal session identity. Roles are loaded from active D1 grants per request. */
export type AuthenticatedUserRequest = {
  user: {
    id: string
    email: string
    emailVerifiedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }
  roles: UserRole[]
  session: {
    id: string
    userId: string
    expiresAt: Date
    createdAt: Date
    updatedAt: Date
    ipAddress: string | null
    userAgent: string | null
  }
}

/** Applicant guards return this only after confirming an active APPLICANT grant. */
export type AuthenticatedApplicantRequest = AuthenticatedUserRequest

export type StartApplicantSignupResponse = {
  challengeToken: string
  expiresAt: Date
}

/** Public response for the curl-only, one-time bootstrap operation. */
export type FirstSuperAdminBootstrapResponse = {
  userId: string
  roles: UserRole[]
}

export type AuthResult<T> = {
  // Expected failures stay inside this envelope instead of becoming GraphQL errors.
  success: boolean
  message: string | null
  response: T | null
}
