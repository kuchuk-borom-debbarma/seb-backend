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
import type { UserRole } from '../../db/schema'
import type { Capability } from './capabilities'

export type { AppBindings } from '../../bindings'

/**
 * Authentication services are stateless. Every operation receives its database,
 * request metadata, environment, and response-header sink explicitly.
 */
export type AuthOperationContext = {
  db: Database
  /** Per-request batched lookups. Never shared between requests. */
  loaders: Loaders
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
  /** Derived from `roles`, never stored. What a screen may offer. */
  capabilities: Capability[]
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

/**
 * One entry in a person's retained role history.
 *
 * Written out rather than inferred from the table so adding a column cannot
 * silently widen the administrative response. Revocation closes a grant instead
 * of deleting it, so a closed grant keeps its actor, time, and reason.
 */
export type ManagedRoleGrant = {
  id: string
  role: UserRole
  grantReason: string
  grantedAt: Date
  // Null identifies a trusted system transition such as verified signup or the
  // one-time first-super-admin bootstrap, never an anonymous portal user.
  grantedByUserId: string | null
  revokedByUserId: string | null
  revokedAt: Date | null
  revocationReason: string | null
}

/** Administrative view of one identity, its active roles, and its full history. */
export type ManagedUser = {
  id: string
  email: string
  emailVerified: boolean
  deleted: boolean
  createdAt: Date
  roles: UserRole[]
  grants: ManagedRoleGrant[]
}

export type StartApplicantSignupResponse = {
  challengeToken: string
  expiresAt: Date
}

/** Public response for the curl-only, one-time bootstrap operation. */
export type FirstSuperAdminBootstrapResponse = {
  userId: string
  roles: UserRole[]
}

export type AuthResult<T> = Envelope<T>
