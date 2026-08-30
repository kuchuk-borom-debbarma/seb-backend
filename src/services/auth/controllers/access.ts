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
import { sendNotification } from '../../external-notification'
import { verifyPassword } from '../crypto'
import {
  INVITE_TTL_MS,
  openInvite,
  requireInviteSecret,
  sealInvite,
} from '../invite'
import { createAuditEvent } from '../queries/auth'
import {
  acceptRoleInviteWrite,
  findActorPasswordHash,
  findManagedUserByEmail,
  findManagedGrant,
  findManagedUserById,
  grantRoleWrite,
  isRevocableGrant,
  revokeRoleWrite,
  usableSuperAdminExistsExcluding,
} from '../queries/access'
import { findRoleById, findRoleByKey, type ManagedRole } from '../queries/roles'
import { permissionKey } from '../permissions'
import {
  auditEvent,
  AUTH_REQUIRED_MESSAGE,
  normalizeEmail,
  normalizeReason,
} from '../support'
import { failure, success } from '../../envelope'
import type { AuthOperationContext, AuthResult, ManagedUser } from '../types'
import { authenticatedSuperAdministrator, authenticatedWithPermission } from './auth'

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
 * Resolves a role key to what should be written into a grant.
 *
 * The API names an authority by one key whether it is decided in code or
 * composed, so a caller never has to know which kind it is asking for — but the
 * grant table keeps them in different columns, and this is the one place that
 * translation happens.
 *
 * `APPLICANT` is refused. It is created only by verified signup and nothing can
 * grant it back, so accepting it here would let one later revocation strip
 * somebody permanently.
 */
const grantTargetFor = async (
  context: AuthOperationContext,
  roleKey: string,
): Promise<{ role: string | null; roleId: string | null } | null> => {
  if (roleKey === 'SUPER_ADMIN') return { role: 'SUPER_ADMIN', roleId: null }
  if (roleKey === 'APPLICANT') return null
  const role = await findRoleByKey(context.db, roleKey)
  return role ? { role: null, roleId: role.id } : null
}

const UNKNOWN_ROLE_MESSAGE = 'No such role.'

/**
 * Grants an authority directly, retaining the reason in grant history.
 *
 * A role that was granted and later revoked is granted again as a new row
 * rather than by reopening the old one, so the history of who held what and
 * when stays complete.
 */
export const grantRole = async (
  input: { userId: string; roleKey: string; reason: string; currentPassword: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedUser>> => {
  // Authority first. Nothing below this line may describe the subject to a
  // caller who has not proved they are a super administrator.
  const actor = await authenticatedSuperAdministrator(context)
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  if (!identifierSchema.safeParse(input.userId).success) {
    return failure(USER_NOT_FOUND_MESSAGE)
  }
  const target = await grantTargetFor(context, input.roleKey)
  if (!target) return failure(UNKNOWN_ROLE_MESSAGE)
  const subject = await findManagedUserById(context.db, input.userId)
  if (!subject || subject.deleted) return failure(USER_NOT_FOUND_MESSAGE)
  if (!subject.emailVerified) {
    return failure('That user has not verified their email address yet.')
  }
  if (subject.roles.includes(input.roleKey)) {
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
      role: target.role,
      roleId: target.roleId,
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
      metadata: { subjectUserId: subject.id, role: input.roleKey },
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
  if (!isRevocableGrant(grant)) {
    /*
     * `APPLICANT` is the only thing this refuses. Nothing can grant it back, so
     * closing one here would strip somebody permanently with no recovery path.
     */
    return failure('Applicant access cannot be revoked here.')
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

/**
 * Where the invitation link points.
 *
 * At the client, not at this Worker, and the reason matters: a link that acted
 * on `GET` would be spent by whatever opened it first, and mail providers open
 * links — Gmail, Outlook and most scanners prefetch them to check for malware.
 * The invitation would be consumed before the person ever saw it, and the audit
 * row would record an acceptance nobody performed. So the link is a page, with
 * a button that calls the mutation.
 *
 * The token rides in the fragment, which browsers never send to a server and
 * which therefore stays out of access logs and `Referer` headers.
 */
const invitePortalUrl = (context: AuthOperationContext, token: string): string => {
  const base = context.env.PORTAL_BASE_URL?.trim() || new URL(context.requestUrl).origin
  return `${base.replace(/\/+$/u, '')}/invite#${token}`
}

/**
 * Whether an issuer may offer this role: is it a subset of what they hold?
 *
 * Without a ceiling, "an administrator may invite" is a privilege escalation —
 * somebody could invite a second account to more than they hold and obtain
 * through it exactly the authority they are directly forbidden.
 *
 * This used to be a hand-written table of role names, and with composed roles
 * that table cannot be written at all: the roles are not known when the code
 * is. So the rule generalizes to what it always meant, and reads the actual
 * permission sets. A super administrator holds the wildcard, so every role is a
 * subset and they may offer any of them.
 *
 * Nobody is ever invited to super administrator. That stays bootstrap or a
 * direct grant by somebody who already is one, and it is not a composed role,
 * so no role reachable here can carry it.
 */
const withinIssuersAuthority = (
  actor: { superAdministrator: boolean; permissions: readonly { resource: string; action: string }[] },
  role: ManagedRole,
): boolean => {
  if (actor.superAdministrator) return true
  const held = new Set(actor.permissions.map((p) => permissionKey(p.resource, p.action)))
  return role.permissions.every((p) => held.has(permissionKey(p.resource, p.action)))
}

/** Said to anyone whose link does not open, whatever the reason. */
const INVITE_UNUSABLE_MESSAGE =
  'This invitation is not usable. Ask for a new one.'

/**
 * Invites somebody to a staff role they must accept themselves.
 *
 * The link is emailed and never returned to the issuer. An issuer who could
 * read it could forward it, and the invitee's mailbox is supposed to be the
 * factor that makes possession meaningful.
 */
export const inviteRole = async (
  input: { userId: string; roleKey: string; reason: string },
  context: AuthOperationContext,
): Promise<AuthResult<{ email: string; role: string; expiresAt: Date }>> => {
  // Authority first. Nothing below may describe the subject to a caller who
  // has not proved they may invite at all.
  const actor = await authenticatedWithPermission(context, 'role', 'invite')
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  const role = await findRoleByKey(context.db, input.roleKey)
  /*
   * One refusal for an unknown role and one beyond the caller's authority. The
   * two are distinguishable only to somebody who may already read the role
   * list, and telling everybody else which keys are real is an enumeration
   * this namespace deliberately does not offer.
   */
  if (!role || !withinIssuersAuthority(actor, role)) {
    return failure('You cannot invite somebody to that role.')
  }
  if (!identifierSchema.safeParse(input.userId).success) {
    return failure(USER_NOT_FOUND_MESSAGE)
  }
  const reason = normalizeReason(input.reason, REASON_MAXIMUM_LENGTH)
  if (!reason) return failure(INVALID_REASON_MESSAGE)

  const subject = await findManagedUserById(context.db, input.userId)
  if (!subject || subject.deleted) return failure(USER_NOT_FOUND_MESSAGE)
  if (!subject.emailVerified) {
    return failure('That user has not verified their email address yet.')
  }
  if (subject.roles.includes(role.key)) {
    return failure('That role is already active for this user.')
  }
  // Accepting swaps an applicant grant for the staff role, so somebody who no
  // longer holds one has nothing to swap. Refusing here rather than sending a
  // link that could never work.
  if (!subject.roles.includes('APPLICANT')) {
    return failure('That user is not an applicant, so this invitation cannot apply.')
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS)
  const token = await sealInvite(requireInviteSecret(context.env.ROLE_INVITE_SECRET), {
    version: 2,
    userId: subject.id,
    email: subject.email,
    roleId: role.id,
    /*
     * The version the issuer approved. The ceiling above is checked now, and a
     * role can be edited in the forty-eight hours before this is accepted —
     * without this term, somebody could offer a role they may legitimately
     * offer and then add authority to it.
     */
    roleVersion: role.version,
    issuerId: actor.user.id,
    issuedAt: now.getTime(),
    expiresAt: expiresAt.getTime(),
    nonce: crypto.randomUUID(),
  })

  await createAuditEvent(
    context.db,
    auditEvent(context, {
      action: auditActions.roleInviteIssued,
      entityType: 'CORE_USER',
      entityId: subject.id,
      actorUserId: actor.user.id,
      // The token is never recorded. An audit row that carried it would be a
      // second copy of a live credential, readable by anybody who may read
      // audits.
      metadata: { role: role.key, reason, expiresAt: expiresAt.toISOString() },
    }),
  )

  try {
    await sendNotification(
      {
        to: subject.email,
        subject: `You have been invited to the Mission SEP office`,
        body: [
          `You have been invited to join the Mission SEP programme office as a`,
          `${role.name}.`,
          ``,
          `Open this link to accept. It expires in 48 hours:`,
          `${invitePortalUrl(context, token)}`,
          ``,
          `If you were not expecting this, ignore it and nothing will change.`,
        ].join('\n'),
      },
      context.env,
    )
  } catch {
    // Deliberately not logging the error: a transport failure can carry the
    // request it was making, and that request contains the invitation link.
    return failure('The invitation could not be sent. Try again.')
  }

  return success({ email: subject.email, role: role.key, expiresAt })
}

/**
 * Accepts an invitation, exchanging the applicant grant for the staff role.
 *
 * **Takes no session.** Possession of the link is the credential, which is the
 * decision this flow was built around: the link goes to an address only that
 * person can read. Everything protecting it is below — the seal is
 * authenticated so it cannot be edited, it expires, it is void if the address
 * changed since it was sent, and it only applies while its precondition holds,
 * which is what makes a stateless invitation single-use.
 */
export const acceptRoleInvite = async (
  input: { token: string },
  context: AuthOperationContext,
): Promise<AuthResult<{ role: string }>> => {
  const now = new Date()
  const invite = await openInvite(
    requireInviteSecret(context.env.ROLE_INVITE_SECRET),
    input.token,
    now,
  )
  /*
   * One refusal for every failure — wrong key, altered bytes, expired, absent.
   * Distinguishing them would let somebody probe which tokens are valid.
   *
   * Recorded, though, because a run of refusals is exactly what a super
   * administrator would want to see: it is somebody trying tokens. The actor is
   * null, as it is for every unauthenticated act — possession of the token is
   * the credential here, and a refused token identifies nobody.
   */
  if (!invite) {
    await createAuditEvent(
      context.db,
      auditEvent(context, {
        action: auditActions.roleInviteRefused,
        entityType: 'CORE_USER',
        outcome: 'FAILURE',
      }),
    )
    return failure(INVITE_UNUSABLE_MESSAGE)
  }

  const subject = await findManagedUserById(context.db, invite.userId)
  /*
   * The role is re-read rather than trusted from the seal, and its version has
   * to still match. An invitation names what the issuer approved; a role edited
   * since — or retired — is no longer that thing, and honouring it would let
   * somebody offer a weak role and then strengthen it before it was accepted.
   */
  const role = await findRoleById(context.db, invite.roleId)
  if (
    !subject ||
    subject.deleted ||
    !subject.emailVerified ||
    !role ||
    role.version !== invite.roleVersion ||
    // The address the invitation was sent to is no longer the account's, so
    // whoever holds the link is no longer necessarily the account holder.
    subject.email !== invite.email
  ) {
    await createAuditEvent(
      context.db,
      auditEvent(context, {
        action: auditActions.roleInviteRefused,
        entityType: 'CORE_USER',
        entityId: subject?.id ?? null,
        outcome: 'FAILURE',
      }),
    )
    return failure(INVITE_UNUSABLE_MESSAGE)
  }

  const grantedAt = new Date()
  const accepted = await acceptRoleInviteWrite(context.db, {
    userId: subject.id,
    grant: {
      id: crypto.randomUUID(),
      userId: subject.id,
      role: null,
      roleId: role.id,
      grantedByUserId: invite.issuerId,
      grantReason: 'ROLE_INVITE_ACCEPTED',
      grantedAt,
      revokedByUserId: null,
      revokedAt: null,
      revocationReason: null,
    },
    auditEvent: auditEvent(context, {
      action: auditActions.roleInviteAccepted,
      entityType: 'CORE_USER',
      entityId: subject.id,
      // The subject acts on their own account here; the issuer is recorded as
      // the grant's authority rather than as this event's actor.
      actorUserId: subject.id,
      metadata: { role: role.key, issuerId: invite.issuerId },
    }),
  })
  // Already spent, or the account stopped being an applicant in between. Both
  // are the same answer to whoever is holding the link.
  if (!accepted) return failure(INVITE_UNUSABLE_MESSAGE)

  return success({ role: role.key }, `You are now a ${role.name}.`)
}
