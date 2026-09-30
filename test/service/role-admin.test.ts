/**
 * Composing the roles the office runs on.
 *
 * Two properties carry this suite. The first is that only a super administrator
 * may compose a role at all — the authority is absent from the catalogue, so it
 * cannot be granted, and there is no pair to name here for that reason. The
 * second is that a role is *live while it is edited*: every holder's next
 * request is authorized against whatever the permission set has become, which
 * is why the set is replaced whole and guarded by a version.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { env } from '../support/worker'
import { everyPermission, graphql, permissionsOn, signIn } from '../support/api'
import { auditActions } from '../../src/db/schema'
import { auditEventRow } from '../../src/services/audit-event'
import {
  createRoleWrite,
  findRoleById,
  retireRoleWrite,
  updateRoleWrite,
} from '../../src/services/auth/queries/roles'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const PASSWORD = 'a-correct-horse-battery-staple'
const DENIED = 'Authentication is required.'
const STALE = 'The role changed. Reload and try again.'
const WRONG_PASSWORD = 'Your password is incorrect.'

const superAdministrator = () =>
  signIn({ roles: ['SUPER_ADMIN'], password: PASSWORD })

const createRole = (
  cookie: string,
  input: { key: string; name?: string; description?: string },
) => graphql<any>(`mutation($input: CreateRoleInput!) {
  access { createRole(input: $input) { success message response { id key version } } }
}`, { input: {
  name: 'Composed role',
  description: 'What this role is for.',
  ...input,
} }, cookie)

const roleByKey = (cookie: string, key: string) => graphql<any>(
  `query { access { role(key: "${key}") { success message response {
    id key name description version memberCount permissions { resource action }
  } } } }`, {}, cookie,
)

const updateRole = (
  cookie: string,
  input: {
    roleId: string
    expectedVersion: number
    permissions: readonly (readonly [string, string])[]
    name?: string
    description?: string
    currentPassword?: string
  },
) => graphql<any>(`mutation($input: UpdateRoleInput!) {
  access { updateRole(input: $input) { success message response { version permissions { resource action } } } }
}`, { input: {
  roleId: input.roleId,
  expectedVersion: input.expectedVersion,
  name: input.name ?? 'Composed role',
  description: input.description ?? 'What this role is for.',
  permissions: input.permissions.map(([resource, action]) => ({ resource, action })),
  currentPassword: input.currentPassword ?? PASSWORD,
} }, cookie)

const deleteRole = (
  cookie: string,
  input: { roleId: string; expectedVersion: number; currentPassword?: string },
) => graphql<any>(`mutation($input: DeleteRoleInput!) {
  access { deleteRole(input: $input) { success message response { key grantsClosed } } }
}`, { input: {
  roleId: input.roleId,
  expectedVersion: input.expectedVersion,
  reason: 'No longer needed by the office.',
  currentPassword: input.currentPassword ?? PASSWORD,
} }, cookie)

/** A role holding the pairs named, created and filled in through the API. */
const composed = async (
  cookie: string,
  key: string,
  permissions: readonly (readonly [string, string])[],
) => {
  const created = await createRole(cookie, { key })
  expect(created.data.access.createRole.success,
    created.data.access.createRole.message ?? '').toBe(true)
  const role = created.data.access.createRole.response
  if (permissions.length === 0) return role
  const updated = await updateRole(cookie, {
    roleId: role.id, expectedVersion: role.version, permissions,
  })
  expect(updated.data.access.updateRole.success,
    updated.data.access.updateRole.message ?? '').toBe(true)
  return { ...role, version: updated.data.access.updateRole.response.version }
}

describe('composing a role', () => {
  it('starts a new role able to do nothing at all', async () => {
    const operator = await superAdministrator()
    const created = await createRole(operator.cookie, { key: 'DESK_REVIEWER' })
    expect(created.data.access.createRole.success).toBe(true)

    /*
     * Naming a role and deciding what it may do are two acts. A role that
     * arrived holding something would mean a half-configured one is live, and
     * the window between the two writes is exactly when nobody is looking.
     */
    const read = await roleByKey(operator.cookie, 'DESK_REVIEWER')
    expect(read.data.access.role.response).toMatchObject({
      key: 'DESK_REVIEWER', version: 1, memberCount: 0, permissions: [],
    })
  })

  it('refuses a key the server decides for itself, and one already taken', async () => {
    const operator = await superAdministrator()
    for (const key of ['SUPER_ADMIN', 'APPLICANT', 'ADMIN', 'REVIEWER']) {
      const attempt = await createRole(operator.cookie, { key })
      expect(attempt.data.access.createRole, key).toMatchObject({
        success: false, message: 'That key is reserved.',
      })
    }
    expect((await createRole(operator.cookie, { key: 'DESK_REVIEWER' }))
      .data.access.createRole.success).toBe(true)
    expect((await createRole(operator.cookie, { key: 'DESK_REVIEWER' }))
      .data.access.createRole).toMatchObject({
        success: false, message: 'A role with that key already exists.',
      })
  })

  it('refuses a key that could never be one, and folds case rather than refusing it', async () => {
    const operator = await superAdministrator()
    for (const key of ['9LEADING_DIGIT', 'A', 'HAS SPACE', 'HAS:COLON', '']) {
      const attempt = await createRole(operator.cookie, { key })
      expect(attempt.data.access.createRole.success, key).toBe(false)
    }
    /*
     * Case is normalized rather than refused, so `desk_reviewer` and
     * `DESK_REVIEWER` are the same role rather than two that look identical
     * everywhere a key is displayed.
     */
    const folded = await createRole(operator.cookie, { key: 'desk_reviewer' })
    expect(folded.data.access.createRole.response.key).toBe('DESK_REVIEWER')
    expect((await createRole(operator.cookie, { key: 'DESK_REVIEWER' }))
      .data.access.createRole.success).toBe(false)
  })

  it('refuses a name or a purpose nobody wrote', async () => {
    const operator = await superAdministrator()
    expect((await createRole(operator.cookie, { key: 'A_ROLE', name: '   ' }))
      .data.access.createRole.success).toBe(false)
    expect((await createRole(operator.cookie, { key: 'A_ROLE', description: '  ' }))
      .data.access.createRole.success).toBe(false)
  })
})

describe('editing what a role may do', () => {
  it('replaces the whole set rather than adding to it', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [
      ['application', 'read'], ['application', 'note'],
    ])

    const narrowed = await updateRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version,
      permissions: [['application', 'read']],
    })
    /*
     * `note` is gone because it was not sent, not because it was removed. A
     * role is live while it is edited, so a sequence of smaller writes would
     * authorize its holders against each half-finished state in turn.
     */
    expect(narrowed.data.access.updateRole.response.permissions)
      .toEqual([{ resource: 'application', action: 'read' }])
  })

  it('refuses an edit against a version somebody else has moved', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [['application', 'read']])

    const stale = await updateRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version - 1,
      permissions: [['application', 'note']],
    })
    expect(stale.data.access.updateRole).toMatchObject({ success: false, message: STALE })

    // And the losing edit wrote nothing, rather than half of itself.
    const read = await roleByKey(operator.cookie, 'CASEWORKER')
    expect(read.data.access.role.response.permissions)
      .toEqual([{ resource: 'application', action: 'read' }])
  })

  it('lets only one of two simultaneous edits land', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [['application', 'read']])

    const both = await Promise.all([
      updateRole(operator.cookie, {
        roleId: role.id, expectedVersion: role.version,
        permissions: [['application', 'note']],
      }),
      updateRole(operator.cookie, {
        roleId: role.id, expectedVersion: role.version,
        permissions: [['stage', 'decide']],
      }),
    ])
    const landed = both.filter((one) => one.data.access.updateRole.success)
    expect(landed).toHaveLength(1)

    /*
     * And the set is one of the two asked for, never a mixture. The dependent
     * writes are guarded on the instant this update minted rather than on
     * `expectedVersion + 1`, which would also be true of an update that had
     * already happened.
     */
    const read = await roleByKey(operator.cookie, 'CASEWORKER')
    expect(read.data.access.role.response.permissions).toHaveLength(1)
  })

  it('refuses a pair this server cannot enforce', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    for (const pair of [
      ['audit', 'award'],        // a real resource, an act it does not offer
      ['nonsense', 'read'],      // no such resource
      ['application', 'fly'],    // no such action
      ['role', 'grant'],         // deliberately absent: it cannot be delegated
    ] as const) {
      const attempt = await updateRole(operator.cookie, {
        roleId: role.id, expectedVersion: role.version, permissions: [pair],
      })
      expect(attempt.data.access.updateRole, pair.join(':')).toMatchObject({
        success: false,
        message: 'That permission is not one this server can enforce.',
      })
    }
  })

  it('takes the operator\'s own password, and writes nothing without it', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    const attempt = await updateRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version,
      permissions: [['application', 'read']],
      currentPassword: 'not the right password',
    })
    expect(attempt.data.access.updateRole)
      .toMatchObject({ success: false, message: WRONG_PASSWORD })
    const read = await roleByKey(operator.cookie, 'CASEWORKER')
    expect(read.data.access.role.response.permissions).toEqual([])
  })

  it('takes effect on a holder\'s very next request', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [['announcement', 'read']])

    // Granted straight into the grant table: what is under test is the edit
    // reaching a live session, not how the grant got there.
    const holder = await signIn({})
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
       VALUES (?, ?, ?, 'ROLE_EDIT_TEST', ?)`,
    ).bind(crypto.randomUUID(), holder.userId, role.id, Date.now()).run()

    const board = () => graphql<any>(
      `query { admin { announcement { board { success message } } } }`, {}, holder.cookie,
    )
    expect((await board()).data.admin.announcement.board.success).toBe(true)

    await updateRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version, permissions: [],
    })
    // Authority is read live, so nothing had to sign them out for this to bite.
    expect((await board()).data.admin.announcement.board).toMatchObject({
      success: false, message: 'You do not have permission to do that.',
    })
  })
})

describe('retiring a role', () => {
  it('closes every grant of it and reports how many', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [['announcement', 'read']])
    const holder = await signIn({})
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
       VALUES (?, ?, ?, 'RETIRE_TEST', ?)`,
    ).bind(crypto.randomUUID(), holder.userId, role.id, Date.now()).run()

    const retired = await deleteRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version,
    })
    expect(retired.data.access.deleteRole).toMatchObject({
      success: true, response: { key: 'CASEWORKER', grantsClosed: 1 },
    })

    // Retired, not deleted: the grant survives as history, closed with a reason.
    const grant = await env.DB.prepare(
      `SELECT revoked_at, revocation_reason FROM core_user_role_grant
       WHERE user_id = ? AND role_id = ?`,
    ).bind(holder.userId, role.id).first<{ revocation_reason: string }>()
    expect(grant?.revocation_reason).toBe('ROLE_RETIRED')

    // And it is gone from the list a picker reads.
    expect((await roleByKey(operator.cookie, 'CASEWORKER')).data.access.role)
      .toMatchObject({ success: false, message: 'No such role.' })
  })

  it('is permitted whatever holds it, because the alternative cannot be guarded', async () => {
    /*
     * A "nobody holds it" precondition would be a predicate over rows the
     * statement does not write: one operator retires while another grants,
     * neither blocks, and both succeed. The holder count is reported beside the
     * control instead, so the cost is known before the decision rather than
     * after it.
     */
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    const holder = await signIn({})
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
       VALUES (?, ?, ?, 'RETIRE_TEST', ?)`,
    ).bind(crypto.randomUUID(), holder.userId, role.id, Date.now()).run()

    expect((await roleByKey(operator.cookie, 'CASEWORKER'))
      .data.access.role.response.memberCount).toBe(1)
    expect((await deleteRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version,
    })).data.access.deleteRole.success).toBe(true)
  })

  it('closes a grant that landed after the retirement instant was minted', async () => {
    /*
     * `now` is minted in the controller, before the batch opens, so another
     * operator's grant of this same role can commit in between — and under READ
     * COMMITTED the closing statement then sees a row granted *later* than the
     * instant it is writing. Stamping `now` on it produces a grant revoked
     * before it was granted, which the revocation CHECK refuses as a 23514 that
     * `constraintSafe` deliberately does not swallow: the operator would get an
     * unhandled failure and the role would stay live.
     */
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    const holder = await signIn({})
    const later = Date.now() + 60_000
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (id, user_id, role_id, grant_reason, granted_at)
       VALUES (?, ?, ?, 'RACED_IN', ?)`,
    ).bind(crypto.randomUUID(), holder.userId, role.id, later).run()

    expect((await deleteRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version,
    })).data.access.deleteRole.success).toBe(true)

    const grant = await env.DB.prepare(
      `SELECT revoked_at FROM core_user_role_grant WHERE role_id = ?`,
    ).bind(role.id).first<{ revoked_at: number }>()
    expect(grant?.revoked_at, 'the raced-in grant is closed, not left open').not.toBeNull()
  })

  it('refuses a stale version and a wrong password', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    expect((await deleteRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version + 5,
    })).data.access.deleteRole).toMatchObject({ success: false, message: STALE })
    expect((await deleteRole(operator.cookie, {
      roleId: role.id, expectedVersion: role.version, currentPassword: 'wrong',
    })).data.access.deleteRole).toMatchObject({ success: false, message: WRONG_PASSWORD })
  })
})

describe('who may compose a role at all', () => {
  it('is the super administrator alone, and nobody can be granted it', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])

    /*
     * Somebody holding every permission the catalogue offers still cannot
     * compose a role, because the authority is not in the catalogue to hold.
     * That is the whole reason it is absent: a role able to grant roles could
     * grant super administrator to its own holder.
     */
    const everything = await signIn({ permissions: everyPermission(), password: PASSWORD })
    expect((await createRole(everything.cookie, { key: 'ANOTHER_ROLE' }))
      .data.access.createRole).toMatchObject({ success: false, message: DENIED })
    expect((await updateRole(everything.cookie, {
      roleId: role.id, expectedVersion: role.version, permissions: [['application', 'read']],
    })).data.access.updateRole).toMatchObject({ success: false, message: DENIED })
    expect((await deleteRole(everything.cookie, {
      roleId: role.id, expectedVersion: role.version,
    })).data.access.deleteRole).toMatchObject({ success: false, message: DENIED })
  })

  it('lets anybody holding role.read see the roles and the catalogue', async () => {
    const operator = await superAdministrator()
    await composed(operator.cookie, 'CASEWORKER', [['application', 'read']])

    const reader = await signIn({ permissions: [['role', 'read']] })
    const listed = await graphql<any>(
      `query { access { roles { success response { key permissions { resource action } } } } }`,
      {}, reader.cookie,
    )
    expect(listed.data.access.roles.success).toBe(true)
    // The reader's own authority is a composed role too, so it is listed
    // beside the one under test.
    expect(listed.data.access.roles.response.map((one: any) => one.key))
      .toContain('CASEWORKER')

    const catalogue = await graphql<any>(
      `query { access { permissionCatalogue { success response { resources {
        resource description actions { action description }
      } } } } }`, {}, reader.cookie,
    )
    expect(catalogue.data.access.permissionCatalogue.success).toBe(true)
    expect(catalogue.data.access.permissionCatalogue.response.resources).toHaveLength(11)

    // And somebody without it sees neither.
    const outsider = await signIn({ permissions: permissionsOn('announcement') })
    expect((await graphql<any>(`query { access { roles { success message } } }`,
      {}, outsider.cookie)).data.access.roles)
      .toMatchObject({ success: false, message: DENIED })
  })

  it('offers an issuer only the roles within their own authority', async () => {
    const operator = await superAdministrator()
    await composed(operator.cookie, 'READS_ONLY', [['application', 'read']])
    await composed(operator.cookie, 'DECIDES', [['stage', 'decide']])

    const issuer = await signIn({
      permissions: [['role', 'invite'], ['role', 'read'], ['application', 'read']],
    })
    const offered = await graphql<any>(
      `query { access { invitableRoles { success response { key } } } }`, {}, issuer.cookie,
    )
    const keys: string[] = offered.data.access.invitableRoles.response
      .map((one: any) => one.key)
    // Within their authority, so offered; beyond it, so not.
    expect(keys).toContain('READS_ONLY')
    expect(keys).not.toContain('DECIDES')

    // A super administrator holds the wildcard, so every role is a subset.
    const all = await graphql<any>(
      `query { access { invitableRoles { success response { key } } } }`, {}, operator.cookie,
    )
    const allKeys: string[] = all.data.access.invitableRoles.response.map((one: any) => one.key)
    expect(allKeys).toEqual(expect.arrayContaining(['READS_ONLY', 'DECIDES']))
  })
})

describe("the actor's own authority, re-stated inside the write", () => {
  /*
   * These reach the query layer directly, because the race they cover cannot be
   * staged from outside it. The controller checks the caller is a super
   * administrator and then spends real time: `confirmed()` runs scrypt, which
   * is memory-hard by design. Another super administrator revoking that grant
   * during the hash lands between the check and the write, and no request the
   * suite can send occupies that window — driving these through GraphQL would
   * only re-test the controller's own read, which refuses first.
   *
   * Composing a role is reserved in code rather than by a catalogue pair, so
   * what the statement repeats is the grant itself, exactly as `grantRoleWrite`
   * and `revokeRoleWrite` do.
   */
  const auditFor = (actorUserId: string, entityId: string) =>
    auditEventRow({ requestHeaders: new Headers() }, {
      action: auditActions.roleUpdated,
      entityType: 'CORE_ROLE',
      entityId,
      actorUserId,
      payload: { roleKey: 'FIXTURE_ROLE', permissionCount: 0, version: 2 },
      createdAt: new Date(),
    })

  /** Closes every `SUPER_ADMIN` grant the person holds, as a peer would. */
  const stripSuperAdministrator = async (userId: string) => {
    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'DEMOTED'
        WHERE user_id = ? AND role = 'SUPER_ADMIN' AND revoked_at IS NULL`,
    ).bind(Date.now(), userId).run()
  }

  it('refuses to rewrite a role once the grant that permitted it is closed', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    await stripSuperAdministrator(operator.userId)

    const landed = await updateRoleWrite(activeDatabase(), {
      roleId: role.id,
      expectedVersion: role.version,
      name: 'Renamed by somebody demoted mid-request',
      description: 'What this role is for.',
      permissions: [{ resource: 'application', action: 'read' }],
      actorUserId: operator.userId,
      now: new Date(),
      audit: auditFor(operator.userId, role.id),
    })

    expect(landed, 'the write reports the loss rather than succeeding').toBe(false)
    const after = await findRoleById(activeDatabase(), role.id)
    expect(after?.name, 'the name is untouched').toBe('Composed role')
    expect(after?.permissions, 'and so is the permission set').toEqual([])
  })

  it('refuses to retire a role once the grant that permitted it is closed', async () => {
    const operator = await superAdministrator()
    const role = await composed(operator.cookie, 'CASEWORKER', [])
    await stripSuperAdministrator(operator.userId)

    const retired = await retireRoleWrite(activeDatabase(), {
      roleId: role.id,
      expectedVersion: role.version,
      actorUserId: operator.userId,
      reason: 'Retired by somebody demoted mid-request',
      now: new Date(),
      audit: auditFor(operator.userId, role.id),
    })

    expect(retired, 'nothing is retired and no grants are closed').toBeNull()
    expect(await findRoleById(activeDatabase(), role.id), 'the role is still live')
      .not.toBeNull()
  })

  it('refuses to create a role once the grant that permitted it is closed', async () => {
    const operator = await superAdministrator()
    await stripSuperAdministrator(operator.userId)
    const id = crypto.randomUUID()
    const now = new Date()

    const written = await createRoleWrite(activeDatabase(), {
      role: {
        id,
        key: 'COMPOSED_AFTER_DEMOTION',
        name: 'Composed after demotion',
        description: 'What this role is for.',
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        createdByUserId: operator.userId,
      },
      actorUserId: operator.userId,
      audit: auditFor(operator.userId, id),
    })

    expect(written, 'the insert selects no row, so nothing is written').toBe(false)
    expect(await findRoleById(activeDatabase(), id)).toBeNull()
  })
})
