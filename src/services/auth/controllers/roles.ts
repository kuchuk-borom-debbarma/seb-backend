/**
 * Composing the roles the office runs on.
 *
 * Creating, editing and retiring a role is the super administrator's alone, and
 * deliberately not a catalogue permission. A role able to grant roles could
 * grant `SUPER_ADMIN` to its own holder, and a role able to *edit* roles could
 * write that authority onto itself — either way an administrator who can create
 * administrators is a super administrator by another name. Leaving the
 * authority out of the catalogue entirely means it cannot be written down, so
 * it cannot be handed out by mistake.
 *
 * Reading roles is a permission, because a screen that offers a role picker
 * needs one and offering a picker grants nothing.
 *
 * Friendly refusals are decided by controller reads so an operator learns which
 * rule stopped them; the write predicates in `queries/roles.ts` are what decide
 * concurrent attempts. The two are deliberately redundant.
 */
import { z } from 'zod'
import { auditReason } from '../../audit-vocabulary/fields'
import { auditActions, builtinRoles, legacyRoles } from '../../../db/schema'
import { failure, success } from '../../envelope'
import { constraintSafe } from '../../constraints'
import { normalizeRequiredText } from '../../text'
import { verifyPassword } from '../crypto'
import {
  actionDescriptions,
  catalogue,
  grants,
  isCataloguePermission,
  permissionKey,
  resourceDescriptions,
  resources,
  ownsEveryStage,
  withinAuthority,
  type Permission,
} from '../permissions'
import { findActorPasswordHash } from '../queries/access'
import {
  createRoleWrite,
  findRoleByKey,
  findRoleById,
  findRoles,
  retireRoleWrite,
  updateRoleWrite,
  type ManagedRole,
} from '../queries/roles'
import { auditEvent, AUTH_REQUIRED_MESSAGE } from '../support'
import type { AuthOperationContext, AuthResult } from '../types'
import { authenticatedSuperAdministrator, authenticatedWithPermission } from './auth'

const MAX_NAME_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 500

const identifierSchema = z.uuid()
const INVALID_PASSWORD_MESSAGE = 'Your password is incorrect.'
const ROLE_NOT_FOUND_MESSAGE = 'No such role.'
const STALE_MESSAGE = 'The role changed. Reload and try again.'
const KEY_TAKEN_MESSAGE = 'A role with that key already exists.'
const INVALID_KEY_MESSAGE =
  'A role key is 2 to 63 characters of A–Z, 0–9 and underscore, starting with a letter.'
const RESERVED_KEY_MESSAGE = 'That key is reserved.'

/*
 * Mirrors `core_role_key_check` and `core_role_key_reserved_check`. The schema
 * is the authority; this exists so the ordinary case is a sentence rather than
 * a caught constraint violation.
 *
 * Built from the schema's own tuples rather than retyped. A third hand-written
 * copy of the reserved words would go stale in the one direction that matters:
 * a key this forgot would reach the database, and the CHECK would refuse it as
 * an unhandled constraint violation instead of the sentence below.
 */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,62}$/u
const RESERVED_KEYS: ReadonlySet<string> = new Set([...builtinRoles, ...legacyRoles])

/** The catalogue, shaped for a role editor to render. */
export type PermissionCatalogue = {
  resources: {
    resource: string
    description: string
    actions: { action: string; description: string }[]
  }[]
}

/**
 * Everything a role may be given.
 *
 * Read this rather than hard-coding a list: it is the only complete statement
 * of what the server can enforce, and a picker offering anything absent from it
 * would be offering a permission nothing checks.
 */
export const permissionCatalogue = async (
  context: AuthOperationContext,
): Promise<AuthResult<PermissionCatalogue>> => {
  if (!await authenticatedWithPermission(context, 'role', 'read')) {
    return failure(AUTH_REQUIRED_MESSAGE)
  }
  return success({
    resources: resources.map((resource) => ({
      resource,
      description: resourceDescriptions[resource],
      actions: grants[resource].map((action) => ({
        action,
        description: actionDescriptions[action],
      })),
    })),
  })
}

/** Every live role, with what each may do. */
export const roles = async (
  context: AuthOperationContext,
): Promise<AuthResult<ManagedRole[]>> => {
  if (!await authenticatedWithPermission(context, 'role', 'read')) {
    return failure(AUTH_REQUIRED_MESSAGE)
  }
  return success(await findRoles(context.db))
}

/** One role, by the key the API speaks. */
export const roleByKey = async (
  input: { key: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedRole>> => {
  if (!await authenticatedWithPermission(context, 'role', 'read')) {
    return failure(AUTH_REQUIRED_MESSAGE)
  }
  const role = await findRoleByKey(context.db, input.key)
  return role ? success(role) : failure(ROLE_NOT_FOUND_MESSAGE)
}

/**
 * The roles the caller may offer somebody else.
 *
 * Computed here so no screen reimplements the ceiling. An issuer may invite
 * only to a role whose permissions are a subset of their own; a client that
 * decided that for itself would be a second copy of the rule that decides it,
 * and the two would drift.
 */
export const invitableRoles = async (
  context: AuthOperationContext,
): Promise<AuthResult<ManagedRole[]>> => {
  const actor = await authenticatedWithPermission(context, 'role', 'invite')
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  const all = await findRoles(context.db)
  /*
   * The same predicates `inviteRole` refuses by, so the list and the refusal
   * cannot disagree.
   *
   * A role holding nothing is left out for the reason `inviteRole` spells out:
   * the empty set is a subset of every authority, so the ceiling admits it, and
   * accepting spends an `APPLICANT` grant that nothing can give back. Offering
   * it would be offering to strand somebody.
   */
  return success(all.filter((role) =>
    role.permissions.length > 0
    && withinAuthority(actor, role.permissions)
    && ownsEveryStage(actor, role.ownedStages)))
}

/**
 * Validates a requested permission set against the catalogue.
 *
 * A pair the catalogue does not hold is refused rather than stored and ignored:
 * a role that silently dropped part of what an operator asked for would read as
 * granting it.
 */
const normalizePermissions = (
  requested: readonly { resource: string; action: string }[],
): Permission[] | null => {
  const wanted = new Set<string>()
  for (const { resource, action } of requested) {
    if (!isCataloguePermission(resource, action)) return null
    wanted.add(permissionKey(resource, action))
  }
  // Returned in catalogue order and deduplicated, so two roles built from the
  // same set store identically and compare equal.
  return catalogue
    .filter((pair) => wanted.has(permissionKey(pair.resource, pair.action)))
    .map((pair) => ({ ...pair }))
}

const normalizedFields = (input: { name: string; description: string }):
  | { name: string; description: string }
  | { message: string } => {
  const name = normalizeRequiredText(input.name, MAX_NAME_LENGTH)
  if (!name) return { message: `Give the role a name of 1 to ${MAX_NAME_LENGTH} characters.` }
  const description = normalizeRequiredText(input.description, MAX_DESCRIPTION_LENGTH)
  if (!description) {
    return {
      message:
        `Say what the role is for, in 1 to ${MAX_DESCRIPTION_LENGTH} characters. ` +
        'Whoever hands it out reads this.',
    }
  }
  return { name, description }
}

/**
 * Confirms the caller's own password before a change to what a role may do.
 *
 * Verified against the caller's account, never the subject's — this is a
 * step-up, not a second sign-in. Ordered after every cheap check, because
 * scrypt is real CPU and blocks the isolate.
 */
const confirmed = async (
  context: AuthOperationContext,
  actorUserId: string,
  currentPassword: string,
): Promise<boolean> =>
  // Hash first, then the password. Reversed, `verifyPassword` parses the
  // password as an encoded hash and throws rather than returning false — an
  // unhandled 500 where a refusal belongs.
  verifyPassword(await findActorPasswordHash(context.db, actorUserId), currentPassword)

/**
 * Creates a role with nothing on it yet.
 *
 * Naming a role and deciding what it may do are two acts, so a half-configured
 * role is never live: it starts able to do nothing, and no password is asked
 * for because nothing has been granted.
 */
export const createRole = async (
  input: { key: string; name: string; description: string },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedRole>> => {
  const actor = await authenticatedSuperAdministrator(context)
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  const key = input.key.trim().toUpperCase()
  if (!KEY_PATTERN.test(key)) return failure(INVALID_KEY_MESSAGE)
  if (RESERVED_KEYS.has(key)) return failure(RESERVED_KEY_MESSAGE)
  const fields = normalizedFields(input)
  if ('message' in fields) return failure(fields.message)
  if (await findRoleByKey(context.db, key)) return failure(KEY_TAKEN_MESSAGE)

  const now = new Date()
  const id = crypto.randomUUID()
  const created = await createRoleWrite(context.db, {
    role: {
      id,
      key,
      name: fields.name,
      description: fields.description,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdByUserId: actor.user.id,
    },
    actorUserId: actor.user.id,
    audit: auditEvent(context, {
      action: auditActions.roleCreated,
      entityType: 'CORE_ROLE',
      entityId: id,
      actorUserId: actor.user.id,
      payload: { roleKey: key, roleName: fields.name },
      createdAt: now,
    }),
  })
  // The unique key is the authority on a duplicate; the read above only makes
  // the ordinary case a sentence. A genuine dead heat lands here.
  if (!created) return failure(KEY_TAKEN_MESSAGE)
  return success((await findRoleById(context.db, id))!)
}

/**
 * Rewrites a role's name, purpose and whole permission set in one act.
 *
 * The set is replaced rather than added to and removed from, because a role is
 * live while it is being edited: every holder's next request is authorized
 * against whatever state a sequence of smaller writes had reached.
 *
 * A password is required here and not on creation, because this moves what
 * every holder may do the instant it lands.
 */
export const updateRole = async (
  input: {
    roleId: string
    expectedVersion: number
    name: string
    description: string
    permissions: readonly { resource: string; action: string }[]
    currentPassword: string
  },
  context: AuthOperationContext,
): Promise<AuthResult<ManagedRole>> => {
  const actor = await authenticatedSuperAdministrator(context)
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  if (!identifierSchema.safeParse(input.roleId).success) {
    return failure(ROLE_NOT_FOUND_MESSAGE)
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('That update request is not valid.')
  }
  const fields = normalizedFields(input)
  if ('message' in fields) return failure(fields.message)
  const permissions = normalizePermissions(input.permissions)
  if (permissions === null) {
    return failure('That permission is not one this server can enforce.')
  }
  const role = await findRoleById(context.db, input.roleId)
  if (!role) return failure(ROLE_NOT_FOUND_MESSAGE)

  if (!await confirmed(context, actor.user.id, input.currentPassword)) {
    return failure(INVALID_PASSWORD_MESSAGE)
  }

  const now = new Date()
  const updated = await constraintSafe(() => updateRoleWrite(context.db, {
    roleId: role.id,
    expectedVersion: input.expectedVersion,
    name: fields.name,
    description: fields.description,
    permissions,
    actorUserId: actor.user.id,
    now,
    // The payload names the role and the size of what it now holds. The pairs
    // themselves live on the role; copying them here would put a second,
    // diverging record of authority into retained history.
    audit: auditEvent(context, {
      action: auditActions.roleUpdated,
      entityType: 'CORE_ROLE',
      entityId: role.id,
      actorUserId: actor.user.id,
      payload: {
        roleKey: role.key,
        permissionCount: permissions.length,
        // The version this write creates, which is what the guard above checks.
        version: input.expectedVersion + 1,
      },
      createdAt: now,
    }),
  }))
  if (!updated) return failure(STALE_MESSAGE)
  return success((await findRoleById(context.db, role.id))!)
}

/**
 * Retires a role, closing every grant of it.
 *
 * Deliberately permitted whatever holds it — `queries/roles.ts` explains why a
 * "nobody holds it" precondition would be a predicate over rows the statement
 * does not write, and would lose. The holder count is reported beside the
 * control instead, so the decision is legible before it is made rather than a
 * refusal after.
 */
export const deleteRole = async (
  input: {
    roleId: string
    expectedVersion: number
    reason: string
    currentPassword: string
  },
  context: AuthOperationContext,
): Promise<AuthResult<{ key: string; grantsClosed: number }>> => {
  const actor = await authenticatedSuperAdministrator(context)
  if (!actor) return failure(AUTH_REQUIRED_MESSAGE)
  if (!identifierSchema.safeParse(input.roleId).success) {
    return failure(ROLE_NOT_FOUND_MESSAGE)
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('That request is not valid.')
  }
  const reason = normalizeRequiredText(input.reason, MAX_DESCRIPTION_LENGTH)
  if (!reason) return failure('Say why this role is being retired.')
  const role = await findRoleById(context.db, input.roleId)
  if (!role) return failure(ROLE_NOT_FOUND_MESSAGE)

  if (!await confirmed(context, actor.user.id, input.currentPassword)) {
    return failure(INVALID_PASSWORD_MESSAGE)
  }

  const now = new Date()
  /*
   * Wrapped like every other guarded write here. A constraint loss on the audit
   * insert or on a grant racing in is a lost race, and every lost race in this
   * service reads as `false` — reaching the caller as an unhandled failure is
   * the one outcome that is not a refusal.
   */
  const retired = await constraintSafe(() => retireRoleWrite(context.db, {
    roleId: role.id,
    expectedVersion: input.expectedVersion,
    actorUserId: actor.user.id,
    reason,
    now,
    /*
     * The audit row is built before the write and cannot carry the count the
     * write produced, so it names what was retired and leaves the number to the
     * response. A count read beforehand can disagree with what actually closed —
     * a grant may land or be revoked in between — and a wrong number in retained
     * history is worse than none.
     */
    audit: auditEvent(context, {
      action: auditActions.roleRetired,
      entityType: 'CORE_ROLE',
      entityId: role.id,
      actorUserId: actor.user.id,
      payload: { roleKey: role.key, reason: auditReason(reason) },
      createdAt: now,
    }),
  }))
  if (!retired) return failure(STALE_MESSAGE)
  // Reported from the statement that closed them, not from the read above.
  return success({ key: role.key, grantsClosed: retired.grantsClosed })
}
