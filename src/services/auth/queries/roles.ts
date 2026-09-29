/**
 * Drizzle persistence for the roles a super administrator composes.
 *
 * Beside the other access queries for the reason that module gives: `core_user`,
 * `core_user_role_grant` and `core_session` are written from exactly one place,
 * and a role is now part of the same story.
 *
 * ## What retirement does, and what it deliberately does not
 *
 * Retiring a role does not check whether anybody holds it. That check would be
 * a predicate over rows the statement does not write, and `docs/rules/code.md`
 * records exactly how those lose: one operator retires while another grants,
 * neither blocks, each evaluates against a snapshot taken before the other
 * committed, and both succeed — leaving a live grant on a retired role.
 *
 * So retirement is always permitted, and it takes effect through the *read*
 * instead: every authority query joins `deleted_at IS NULL`, so a holder's
 * permissions drop on their very next request with no write to their grants and
 * nothing to contend on. The same statement closes the grants that exist at
 * that instant, which *is* a guard for those rows because it writes them.
 *
 * ## Every write here re-states the actor's own authority
 *
 * The controller checked it, and then spent real time: `confirmed()` runs
 * scrypt, which is memory-hard by design and takes long enough for another
 * super administrator to revoke the caller's grant while it runs. Composing a
 * role is reserved in code rather than by a catalogue pair, so there is no
 * permission term to repeat — what gets repeated is the grant itself, exactly
 * as `grantRoleWrite` and `revokeRoleWrite` already do.
 *
 * Without it the redundancy this service claims is one-sided: the version guard
 * decides *which* role state loses a race, and nothing decides whether the
 * person writing it is still allowed to.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { batch, changedExactlyOne, type Database } from '../../../db'
import { constraintSafe } from '../../constraints'
import { coreRole, coreRolePermission, coreUserRoleGrant } from '../../../db/schema'
import { isCataloguePermission, type Permission } from '../permissions'
import {
  hasActiveBuiltinRole,
  insertAuditEventWhere,
  type AuditEventRecord,
} from './auth'

/** One composed role, with what it may do and how many people hold it. */
export type ManagedRole = {
  id: string
  key: string
  name: string
  description: string
  permissions: Permission[]
  /** How many live accounts hold it. What makes retiring one a legible decision. */
  memberCount: number
  version: number
  createdAt: Date
  updatedAt: Date
}

/**
 * The outer row's id, written out rather than interpolated.
 *
 * Drizzle renders `${coreRole.id}` as a bare `"id"` when the outer query has no
 * join, and inside these subqueries that binds to the *subquery's* own `id`
 * column — both `core_role_permission` and `core_user_role_grant` have one. The
 * correlation then compares a permission's id to a role's id, matches nothing,
 * and every role reports an empty permission set.
 *
 * That is not a cosmetic bug. An empty set makes every role a subset of every
 * other, so the invitation ceiling — "you may offer only what you hold" —
 * accepts everything. It was found by a ceiling test that expected a refusal
 * and got a success.
 */
const OUTER_ROLE_ID = sql.raw('"core_role"."id"')

/**
 * Folds a role, its permissions and its holder count into one row.
 *
 * Correlated aggregates rather than joins: joining both would multiply the
 * permission rows by the grant rows, and both answers are sets.
 *
 * **Stored pairs are filtered against the catalogue in application code, not
 * here.** A resource can be removed from the catalogue while its rows survive,
 * and the direction that must fail is closed — see `permissions.ts`.
 */
const roleSelection = {
  id: coreRole.id,
  key: coreRole.key,
  name: coreRole.name,
  description: coreRole.description,
  version: coreRole.currentVersion,
  createdAt: coreRole.createdAt,
  updatedAt: coreRole.updatedAt,
  pairs: sql<string[]>`COALESCE((
    SELECT array_agg(p.resource || ':' || p.action ORDER BY p.resource, p.action)
      FROM ${coreRolePermission} p
     WHERE p.role_id = ${OUTER_ROLE_ID}), '{}')`,
  memberCount: sql<number>`(
    SELECT count(*)::int FROM ${coreUserRoleGrant} g
     WHERE g.role_id = ${OUTER_ROLE_ID} AND g.revoked_at IS NULL)`,
}

type RoleRow = {
  id: string
  key: string
  name: string
  description: string
  version: number
  createdAt: Date
  updatedAt: Date
  pairs: string[]
  memberCount: number
}

const toManagedRole = (row: RoleRow): ManagedRole => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  permissions: row.pairs.flatMap((pair) => {
    const [resource, action] = pair.split(':')
    // A pair the catalogue no longer allows grants nothing, so it is not
    // reported either — a screen offering it would be offering a refusal.
    return resource !== undefined && action !== undefined && isCataloguePermission(resource, action)
      ? [{ resource, action } as Permission]
      : []
  }),
  memberCount: row.memberCount,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** Every live role, in the order an operator reads them. */
export const findRoles = async (db: Database): Promise<ManagedRole[]> => {
  const rows = await db
    .select(roleSelection)
    .from(coreRole)
    .where(isNull(coreRole.deletedAt))
    .orderBy(coreRole.name)
  return rows.map(toManagedRole)
}

const findRoleWhere = async (db: Database, where: SQL): Promise<ManagedRole | null> => {
  const [row] = await db
    .select(roleSelection)
    .from(coreRole)
    .where(and(where, isNull(coreRole.deletedAt)))
    .limit(1)
  return row ? toManagedRole(row) : null
}

export const findRoleById = (db: Database, id: string): Promise<ManagedRole | null> =>
  findRoleWhere(db, eq(coreRole.id, id))

export const findRoleByKey = (db: Database, key: string): Promise<ManagedRole | null> =>
  findRoleWhere(db, eq(coreRole.key, key))

export type CreateRoleInput = {
  role: typeof coreRole.$inferInsert
  /** Re-checked in the statement itself — see the module comment. */
  actorUserId: string
  audit: AuditEventRecord
}

/**
 * Creates a role holding nothing, with its audit row.
 *
 * No permissions are written here, and the parameter for them is deliberately
 * absent rather than accepted and usually empty: naming a role and deciding
 * what it may do are two acts, so a role is never live half-configured, and
 * `updateRoleWrite` is the one place a permission set is written. A second
 * place would be a second set of concurrency rules for the same rows.
 *
 * `constraintSafe` because the unique key is the authority on a duplicate: the
 * controller's own "that key is taken" read is a decision about whether a row
 * exists anywhere, which no predicate can make safely — an uncommitted row is
 * invisible by definition. The read exists to make the ordinary case a clean
 * refusal rather than a caught violation.
 */
export const createRoleWrite = async (
  db: Database,
  input: CreateRoleInput,
): Promise<boolean> => {
  const roleExists = sql`EXISTS (
    SELECT 1 FROM ${coreRole} WHERE ${coreRole.id} = ${input.role.id})`
  /*
   * `INSERT … SELECT` rather than `VALUES`, because only a select can carry a
   * `WHERE`. The column list is positional and matches `core_role`'s declared
   * order; `check:insert-arity` counts it against `database/schema.sql`.
   */
  const written = await constraintSafe(() => batch(db, (tx) => [
    tx.insert(coreRole).select(sql`
      SELECT
        ${input.role.id},
        ${input.role.key},
        ${input.role.name},
        ${input.role.description},
        ${input.role.currentVersion},
        ${input.role.createdAt},
        ${input.role.updatedAt},
        NULL,
        NULL,
        NULL,
        ${input.actorUserId}
      WHERE ${hasActiveBuiltinRole(db, input.actorUserId, 'SUPER_ADMIN')}
    `).returning({ id: coreRole.id }),
    insertAuditEventWhere(tx, input.audit, roleExists),
  ]))
  /*
   * The row count, not merely "the batch ran". A `VALUES` insert either writes
   * or throws, so this used to be `written !== null` — with a `WHERE` on the
   * select, writing nothing is an ordinary outcome and the caller would be told
   * the role exists. A test written against the predicate caught it saying so.
   */
  return written !== null && changedExactlyOne(written[0])
}

export type UpdateRoleInput = {
  roleId: string
  expectedVersion: number
  name: string
  description: string
  permissions: readonly Permission[]
  /** Re-checked in the statement itself — see the module comment. */
  actorUserId: string
  now: Date
  audit: AuditEventRecord
}

/**
 * Rewrites a role's name, purpose and whole permission set, or writes nothing.
 *
 * The version is a term in the `WHERE`, not a value read beforehand, so two
 * operators editing one role contend on the same row: the loser blocks,
 * re-reads the committed row under READ COMMITTED, matches nothing, and its
 * dependent writes select nothing.
 *
 * **The dependents key on the instant, not on `expectedVersion + 1`.** That
 * obvious restatement is true whenever the row was *already* at the new
 * version, so an operator acting one version stale would have had their update
 * refused and their permission rewrite applied — the `headJustMovedTo` scar in
 * `admin/support.ts`, in a different table. Each write mints one `now` and
 * stamps it on the role in the same statement, so the pair identifies this
 * update and no other.
 *
 * The set is replaced wholesale rather than added to and removed from, because
 * a half-applied role is live: every holder's next request is authorized
 * against whatever state the sequence had reached.
 */
export const updateRoleWrite = async (
  db: Database,
  input: UpdateRoleInput,
): Promise<boolean> => {
  const thisUpdateLanded = sql`EXISTS (
    SELECT 1 FROM ${coreRole}
     WHERE ${coreRole.id} = ${input.roleId}
       AND ${coreRole.currentVersion} = ${input.expectedVersion + 1}
       AND ${coreRole.updatedAt} = ${input.now})`

  const [changed] = await batch(db, (tx) => [
    tx
      .update(coreRole)
      .set({
        name: input.name,
        description: input.description,
        currentVersion: input.expectedVersion + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(coreRole.id, input.roleId),
          eq(coreRole.currentVersion, input.expectedVersion),
          isNull(coreRole.deletedAt),
          hasActiveBuiltinRole(db, input.actorUserId, 'SUPER_ADMIN'),
        ),
      )
      .returning({ id: coreRole.id }),
    tx.delete(coreRolePermission).where(
      and(eq(coreRolePermission.roleId, input.roleId), thisUpdateLanded),
    ),
    ...input.permissions.map((permission) =>
      tx.insert(coreRolePermission).select(sql`
        SELECT
          ${crypto.randomUUID()},
          ${input.roleId},
          ${permission.resource},
          ${permission.action},
          ${input.now}
        WHERE ${thisUpdateLanded}
      `)),
    insertAuditEventWhere(tx, input.audit, thisUpdateLanded),
  ])
  return changedExactlyOne(changed)
}

export type RetireRoleInput = {
  roleId: string
  expectedVersion: number
  actorUserId: string
  reason: string
  now: Date
  audit: AuditEventRecord
}

/**
 * Retires a role and closes every grant of it that exists at this instant.
 *
 * Deliberately carries no "nobody holds it" precondition — see the module
 * comment. A grant inserted concurrently with this statement still lands and is
 * inert, because every authority read excludes a retired role. That is the
 * fail-closed direction, and it reads as inert to the operator immediately.
 */
export const retireRoleWrite = async (
  db: Database,
  input: RetireRoleInput,
): Promise<{ grantsClosed: number } | null> => {
  const thisRetirementLanded = sql`EXISTS (
    SELECT 1 FROM ${coreRole}
     WHERE ${coreRole.id} = ${input.roleId}
       AND ${coreRole.currentVersion} = ${input.expectedVersion + 1}
       AND ${coreRole.deletedAt} = ${input.now})`

  const [changed, closed] = await batch(db, (tx) => [
    tx
      .update(coreRole)
      .set({
        currentVersion: input.expectedVersion + 1,
        deletedAt: input.now,
        deletedByUserId: input.actorUserId,
        deleteReason: input.reason,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(coreRole.id, input.roleId),
          eq(coreRole.currentVersion, input.expectedVersion),
          isNull(coreRole.deletedAt),
          hasActiveBuiltinRole(db, input.actorUserId, 'SUPER_ADMIN'),
        ),
      )
      .returning({ id: coreRole.id }),
    /*
     * History, not correctness. The read above already made the role powerless;
     * this stops its grants sitting open for ever against something nobody can
     * hold, so the account's history reads honestly.
     *
     * **`GREATEST`, not the retirement instant.** `now` is minted in the
     * controller, before this batch opens. Another operator's grant of this same
     * role can commit in between, and under READ COMMITTED this statement then
     * sees a row whose `granted_at` is *later* than `now` — so writing `now`
     * would produce a grant revoked before it was granted.
     * `core_user_role_grant_revocation_check` refuses that, and a CHECK
     * violation is SQLSTATE 23514, which `constraintSafe` deliberately does not
     * swallow: the whole batch would roll back and the operator would get an
     * unhandled failure instead of a retired role.
     *
     * Closing such a grant at its own `granted_at` says what happened — it was
     * granted and immediately closed by a retirement already under way.
     */
    tx
      .update(coreUserRoleGrant)
      .set({
        revokedAt: sql`GREATEST(${input.now}, ${coreUserRoleGrant.grantedAt})`,
        revokedByUserId: input.actorUserId,
        revocationReason: 'ROLE_RETIRED',
      })
      .where(
        and(
          eq(coreUserRoleGrant.roleId, input.roleId),
          isNull(coreUserRoleGrant.revokedAt),
          thisRetirementLanded,
        ),
      )
      /*
       * The count comes from the statement that closed them, never from a read
       * taken beforehand. A grant can land or be revoked between the
       * controller's read and this write — the module comment above says so —
       * and a number that disagrees with what happened is worse in retained
       * history than no number at all.
       */
      .returning({ id: coreUserRoleGrant.id }),
    insertAuditEventWhere(tx, input.audit, thisRetirementLanded),
  ])
  return changedExactlyOne(changed) ? { grantsClosed: closed.length } : null
}
