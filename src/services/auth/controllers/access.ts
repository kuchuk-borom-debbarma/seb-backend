/**
 * Administrative role management.
 *
 * A super administrator provisions and demotes administrators here. Every
 * mutation requires a fresh password confirmation, and every authorization term
 * is repeated inside the guarded write, because scrypt runs outside D1 and takes
 * long enough for the caller's own authority to change while it runs.
 *
 * Friendly refusals are decided by controller reads so an operator learns which
 * rule stopped them; the write predicates in `queries/access.ts` are what decide
 * concurrent attempts. The two are deliberately redundant.
 */
import { z } from 'zod'
import { auditActions } from '../../../db/schema'
import { verifyPassword } from '../crypto'
import {
  findActorPasswordHash,
  findManagedUserByEmail,
  findManagedGrant,
  findManagedUserById,
  grantRoleWrite,
  isManageableRole,
  revokeRoleWrite,
  usableSuperAdminExistsExcluding,
  type ManageableRole,
} from '../queries/access'
import {
  auditEvent,
  AUTH_REQUIRED_MESSAGE,
  failure,
  normalizeEmail,
  normalizeReason,
  success,
} from '../support'
import type { AuthOperationContext, AuthResult, ManagedUser } from '../types'
import { authenticatedSuperAdministrator } from './auth'

const REASON_MAXIMUM_LENGTH = 500
const INVALID_REASON_MESSAGE =
  `Give a reason of 1 to ${REASON_MAXIMUM_LENGTH} characters for this role change.`
const INVALID_PASSWORD_MESSAGE = 'Your password is incorrect.'
const USER_NOT_FOUND_MESSAGE = 'No user was found.'
const GRANT_NOT_ACTIVE_MESSAGE = 'That role grant is not active.'
const LAST_SUPER_ADMIN_MESSAGE =
  'At least one super administrator must remain. Grant the role to someone else first.'
const SELF_DEMOTION_MESSAGE =
  'You cannot revoke your own super administrator access. Another super administrator must do it.'
// Returned when a guarded write finds the world changed underneath a request
// that passed every controller check.
const CHANGED_MESSAGE = 'Access changed while this request ran. Reload and try again.'

const emailSchema = z.email()
const identifierSchema = z.uuid()

/**
/**
 * Confirms the caller's own password and normalizes their stated reason.
 *
 * Takes an already-authorized actor rather than resolving one, because
 * authorization has to happen before a mutation reads anything about its
 * subject. Answering "no user was found" or "that role is already active" to a
 * caller whose authority has not been established yet would turn this namespace
 * into an oracle for which user IDs are real and which of them are
 * administrators — exactly what exact-match-only lookup exists to prevent.
 *
 * What remains here is ordered by cost: the pure reason check first, then the
 * single credential read and memory-hard scrypt verification last.
 */
const confirmRoleChange = async (
  context: AuthOperationContext,
  actorUserId: string,
  input: { reason: string; currentPassword: string },
): Promise<
  | { ok: true; actorUserId: string; reason: string }
  | { ok: false; message: string }
> => {
  const reason = normalizeReason(input.reason, REASON_MAXIMUM_LENGTH)
  if (!reason) return { ok: false, message: INVALID_REASON_MESSAGE }

  const passwordHash = await findActorPasswordHash(context.db, actorUserId)
  if (!await verifyPassword(passwordHash, input.currentPassword)) {
    return { ok: false, message: INVALID_PASSWORD_MESSAGE }
  }
  return { ok: true, actorUserId, reason }
}

/**
 * Re-reads the subject after a successful write so one response carries both the
 * new active roles and the updated history. The write it follows only reports
 * success after changing a row on this identity, so the read cannot come back
 * empty.
 */
const reloadSubject = async (
  context: AuthOperationContext,
  userId: string,
): Promise<ManagedUser> =>
  (await findManagedUserById(context.db, userId))!

/** Exact-match lookup only. Listing or prefix search would enumerate accounts. */
export const managedUserByEmail = async (
  input: { email: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedUser>> => {
  if (!await authenticatedSuperAdministrator(context)) return failure(AUTH_REQUIRED_MESSAGE)
  const email = normalizeEmail(input.email)
  if (!emailSchema.safeParse(email).success) return failure('Enter a valid email address.')
  const user = await findManagedUserByEmail(context.db, email)
  return user ? success(user) : failure(USER_NOT_FOUND_MESSAGE)
}

export const managedUserById = async (
  input: { id: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedUser>> => {
  if (!await authenticatedSuperAdministrator(context)) return failure(AUTH_REQUIRED_MESSAGE)
  if (!identifierSchema.safeParse(input.id).success) return failure(USER_NOT_FOUND_MESSAGE)
  const user = await findManagedUserById(context.db, input.id)
  return user ? success(user) : failure(USER_NOT_FOUND_MESSAGE)
}

/**
 * Grants `ADMIN` or `SUPER_ADMIN`, retaining the reason in grant history.
 *
 * A role that was granted and later revoked is granted again as a new row
 * rather than by reopening the old one, so the history of who held what and
 * when stays complete.
 */
export const grantRole = async (
  input: { userId: string; role: ManageableRole; reason: string; currentPassword: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedUser>> => {
  // Authority first. Nothing below this line may describe the subject to a
  // caller who has not proved they are a super administrator.
  const actor = await authenticatedSuperAdministrator(context)
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  if (!identifierSchema.safeParse(input.userId).success) {
    return failure(USER_NOT_FOUND_MESSAGE)
  }
  const subject = await findManagedUserById(context.db, input.userId)
  if (!subject || subject.deleted) return failure(USER_NOT_FOUND_MESSAGE)
  if (!subject.emailVerified) {
    return failure('That user has not verified their email address yet.')
  }
  if (subject.roles.includes(input.role)) {
    return failure('That role is already active for this user.')
  }

  const authorized = await confirmRoleChange(context, actor.user.id, input)
  if (!authorized.ok) return failure(authorized.message)

  const now = new Date()
  const grantId = crypto.randomUUID()
  const granted = await grantRoleWrite(context.db, {
    actorUserId: authorized.actorUserId,
    grant: {
      id: grantId,
      userId: subject.id,
      role: input.role,
      grantedByUserId: authorized.actorUserId,
      grantReason: authorized.reason,
      grantedAt: now,
      revokedByUserId: null,
      revokedAt: null,
      revocationReason: null,
    },
    // Metadata names the subject and role only. The reason text is retained on
    // the grant row itself and is not copied into audit history, and the
    // subject's email never appears here.
    auditEvent: auditEvent(context, {
      action: auditActions.roleGranted,
      entityType: 'CORE_USER_ROLE_GRANT',
      entityId: grantId,
      actorUserId: authorized.actorUserId,
      metadata: { subjectUserId: subject.id, role: input.role },
      createdAt: now,
    }),
  })
  if (!granted) return failure(CHANGED_MESSAGE)
  return success(await reloadSubject(context, subject.id))
}

/**
 * Revokes one administrative grant, identified by the exact grant it closes.
 *
 * Targeting a grant ID rather than a user/role pair is the opposite of what the
 * first-super-admin bootstrap does, and deliberately so. Bootstrap had to
 * survive a grant being re-created underneath it; here a stale identifier means
 * the operator is acting on a row that no longer exists and should be told so.
 *
 * Sessions are intentionally untouched. Roles are joined live on every request,
 * so the demoted person's next administrative call is refused immediately, and
 * if this was their last role the existing deactivation paths destroy their
 * sessions. Deleting sessions here would additionally sign out someone who
 * merely lost one of several roles.
 */
export const revokeRole = async (
  input: { grantId: string; reason: string; currentPassword: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedUser>> => {
  const actor = await authenticatedSuperAdministrator(context)
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  if (!identifierSchema.safeParse(input.grantId).success) {
    return failure(GRANT_NOT_ACTIVE_MESSAGE)
  }

  const found = await findManagedGrant(context.db, input.grantId)
  if (!found) return failure(GRANT_NOT_ACTIVE_MESSAGE)
  const { subject, grant } = found
  if (grant.revokedAt !== null) return failure(GRANT_NOT_ACTIVE_MESSAGE)
  if (!isManageableRole(grant.role)) {
    return failure('Only administrative roles can be revoked here.')
  }
  if (grant.role === 'SUPER_ADMIN') {
    // Order matters. The last holder revoking their own grant is refused for
    // the stronger reason of the two, which is also the one that says what to
    // do about it: grant the role to somebody else first.
    if (!await usableSuperAdminExistsExcluding(context.db, input.grantId)) {
      return failure(LAST_SUPER_ADMIN_MESSAGE)
    }
    if (subject.id === actor.user.id) return failure(SELF_DEMOTION_MESSAGE)
  }

  const authorized = await confirmRoleChange(context, actor.user.id, input)
  if (!authorized.ok) return failure(authorized.message)

  const now = new Date()
  const revoked = await revokeRoleWrite(context.db, {
    actorUserId: authorized.actorUserId,
    grantId: input.grantId,
    reason: authorized.reason,
    now,
    auditEvent: auditEvent(context, {
      action: auditActions.roleRevoked,
      entityType: 'CORE_USER_ROLE_GRANT',
      entityId: input.grantId,
      actorUserId: authorized.actorUserId,
      metadata: { subjectUserId: subject.id, role: grant.role },
      createdAt: now,
    }),
  })
  if (!revoked) return failure(CHANGED_MESSAGE)
  return success(await reloadSubject(context, subject.id))
}
