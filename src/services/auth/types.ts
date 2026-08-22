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

/** Public identity payload. Roles are the live grants, never a fixed literal. */
export type AuthUser = {
  id: string
  email: string
  emailVerified: boolean
  roles: UserRole[]
  createdAt: Date
}

export type AuthSession = {
  id: string
  createdAt: Date
  updatedAt: Date
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
  current: boolean
}

export type AuthResponse = {
  user: AuthUser
  session: AuthSession
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

/** Administrative guards accept ADMIN directly or SUPER_ADMIN by implication. */
export type AuthenticatedAdministratorRequest = AuthenticatedUserRequest

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
