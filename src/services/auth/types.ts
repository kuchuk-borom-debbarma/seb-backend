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
import type { Authority, Permission } from './permissions'

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

/** Public identity payload. Authority is the live grants, never a fixed literal. */
export type AuthUser = {
  id: string
  email: string
  emailVerified: boolean
  /** What they call themselves. Null until they have said. */
  displayName: string | null
  /** Every authority held now, by name — the two decided in code, then composed roles. */
  roles: string[]
  /** Derived from those, never stored. What a screen may offer. */
  permissions: Permission[]
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

/**
 * Internal session identity, with the authority this request carries.
 *
 * Everything below `user` is read live on each request rather than copied into
 * the session, so revoking a grant, retiring a role or editing what a role may
 * do takes effect on the caller's very next action.
 */
export type AuthenticatedUserRequest = Authority & {
  user: {
    id: string
    email: string
    emailVerifiedAt: Date | null
    displayName: string | null
    createdAt: Date
    updatedAt: Date
  }
  /** Every authority held, by name. For display and refusals, never for a guard. */
  roles: string[]
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

/** Staff guards return this only after confirming the permission asked for. */
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
  /**
   * What was granted, by name: one of the two decided in code, or a composed
   * role's key.
   *
   * Read from the grant's own row rather than joined live, so a grant stays
   * readable after the role it named has been retired — history that could not
   * be rendered would not be history.
   */
  role: string
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
  roles: string[]
  grants: ManagedRoleGrant[]
}

export type StartApplicantSignupResponse = {
  challengeToken: string
  expiresAt: Date
}

/**
 * Public response for starting a password reset or an email change.
 *
 * Identical whether or not a challenge was actually recorded — that is the
 * whole point, and `expiresAt` is computed rather than read for the same
 * reason.
 */
export type StartAccountChallengeResponse = {
  challengeToken: string
  expiresAt: Date
}

/** Public response for the curl-only, one-time bootstrap operation. */
export type FirstSuperAdminBootstrapResponse = {
  userId: string
  roles: string[]
}

export type AuthResult<T> = Envelope<T>
