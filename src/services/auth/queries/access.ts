/**
 * Drizzle persistence for administrative role management.
 *
 * This module deliberately sits beside the authentication queries rather than
 * in the administrative service: `core_user`, `core_user_role_grant` and
 * `core_session` are written from exactly one place, so the last-super-admin
 * guard, the bootstrap swap, and session deactivation cannot drift apart.
 *
 * Every write repeats its authorization terms in SQL. Password confirmation
 * runs scrypt outside D1 and takes real time, so a grant read before that work
 * can be stale by the time the statement lands.
 */
import {
  and, eq, exists, inArray, isNotNull, isNull, ne, or, sql, type SQL,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { batch, type Database, type Transaction } from '../../../db'
import { constraintSafe } from '../../constraints'
import { coreUser, coreUserRoleGrant, type UserRole } from '../../../db/schema'
import type { ManagedUser } from '../types'
import {
  hasActiveRole,
  insertAuditEventWhere,
  orderedRoles,
  type AuditEventRecord,
  type UserRoleGrantRecord,
} from './auth'

/**
 * Roles a super administrator may grant or revoke.
 *
 * `APPLICANT` is intentionally absent. It is created only by verified signup
 * and no operation can grant it back, so exposing it here would let one
 * revocation strip an applicant permanently with no recovery path.
 */
const manageableRoles = ['REVIEWER', 'APPROVER', 'ADMIN', 'SUPER_ADMIN'] as const
export type ManageableRole = (typeof manageableRoles)[number]

export const isManageableRole = (role: UserRole): role is ManageableRole =>
  manageableRoles.some((manageable) => manageable === role)

/**
 * Loads one identity with every grant it has ever held.
 *
 * The grant read is sequential rather than parallel because a missing user must
 * not cost a second query, and active roles are folded from the same rows
 * instead of calling `findActiveUserRoles`, which would repeat the read.
 */
const withRoleHistory = async (
  db: Database,
  user: typeof coreUser.$inferSelect,
): Promise<ManagedUser> => {
  const grants = await db
    .select()
    .from(coreUserRoleGrant)
    .where(eq(coreUserRoleGrant.userId, user.id))
    .orderBy(coreUserRoleGrant.grantedAt, coreUserRoleGrant.id)
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    deleted: user.deletedAt !== null,
    createdAt: user.createdAt,
    roles: orderedRoles(
      grants.filter((grant) => grant.revokedAt === null).map((grant) => grant.role),
    ),
    // Mapped field by field rather than passed through, so a column added to
    // the grant table cannot silently widen the administrative response.
    grants: grants.map((grant) => ({
      id: grant.id,
      role: grant.role,
      grantReason: grant.grantReason,
      grantedAt: grant.grantedAt,
      grantedByUserId: grant.grantedByUserId,
      revokedByUserId: grant.revokedByUserId,
      revokedAt: grant.revokedAt,
      revocationReason: grant.revocationReason,
    })),
  }
}

const loadManagedUser = async (
  db: Database,
  where: SQL,
): Promise<ManagedUser | null> => {
  const [user] = await db.select().from(coreUser).where(where).limit(1)
  return user ? withRoleHistory(db, user) : null
}

/**
 * Soft-deleted identities are returned rather than hidden. An operator
 * investigating a closed account still needs to see who held what and when.
 */
export const findManagedUserById = (
  db: Database,
  userId: string,
): Promise<ManagedUser | null> => loadManagedUser(db, eq(coreUser.id, userId))

export const findManagedUserByEmail = (
  db: Database,
  email: string,
): Promise<ManagedUser | null> => loadManagedUser(db, eq(coreUser.email, email))

/**
 * Loads one grant together with the identity it belongs to.
 *
 * Both are returned from a single join so a revocation can be validated against
 * the subject's full history without the caller naming them, and without
 * re-finding a row whose presence the join already proved.
 */
export const findManagedGrant = async (
  db: Database,
  grantId: string,
): Promise<{ subject: ManagedUser; grant: UserRoleGrantRecord } | null> => {
  const [row] = await db
    .select({ grant: coreUserRoleGrant, user: coreUser })
    .from(coreUserRoleGrant)
    .innerJoin(coreUser, eq(coreUser.id, coreUserRoleGrant.userId))
    .where(eq(coreUserRoleGrant.id, grantId))
    .limit(1)
  return row ? { subject: await withRoleHistory(db, row.user), grant: row.grant } : null
}

/**
 * Reads the actor's own credential immediately before a step-up confirmation.
 *
 * The row is always present: the caller reached this point through a resolved
 * session, and `findUserSessionByDigest` already required a live, non-deleted
 * identity to produce one.
 */
export const findActorPasswordHash = async (
  db: Database,
  userId: string,
): Promise<string> => {
  const [record] = await db
    .select({ passwordHash: coreUser.passwordHash })
    .from(coreUser)
    .where(eq(coreUser.id, userId))
    .limit(1)
  return record!.passwordHash
}

/**
 * The one definition of "another usable super administrator exists".
 *
 * "Usable" repeats exactly what sign-in requires — an active grant on an
 * identity that is neither soft-deleted nor unverified — so the guard can never
 * be satisfied by an account that could not actually log in and act.
 *
 * The aliased table is required: this runs as a subquery inside an UPDATE of
 * `core_user_role_grant`, where an unqualified self-reference would resolve to
 * the row being written.
 */
const otherSuperAdminGrant = alias(coreUserRoleGrant, 'other_super_admin_grant')

const usableSuperAdminQuery = (db: Database, excludedGrantId: string) =>
  db
    .select({ id: otherSuperAdminGrant.id })
    .from(otherSuperAdminGrant)
    .innerJoin(coreUser, eq(coreUser.id, otherSuperAdminGrant.userId))
    .where(
      and(
        eq(otherSuperAdminGrant.role, 'SUPER_ADMIN'),
        isNull(otherSuperAdminGrant.revokedAt),
        ne(otherSuperAdminGrant.id, excludedGrantId),
        isNull(coreUser.deletedAt),
        isNotNull(coreUser.emailVerifiedAt),
      ),
    )

const anotherUsableSuperAdminExists = (db: Database, excludedGrantId: string): SQL =>
  exists(usableSuperAdminQuery(db, excludedGrantId))

/**
 * Read form of the same query, used only to choose a helpful refusal message.
 * The authoritative decision is made by the predicate inside `revokeRoleWrite`,
 * which is why both forms are built from one definition.
 */
export const usableSuperAdminExistsExcluding = async (
  db: Database,
  excludedGrantId: string,
): Promise<boolean> => {
  const [row] = await usableSuperAdminQuery(db, excludedGrantId).limit(1)
  return row !== undefined
}

/** True while the identity can hold a new administrative role at all. */
const subjectIsGrantable = (db: Database, subjectUserId: string): SQL => exists(
  db
    .select({ id: coreUser.id })
    .from(coreUser)
    .where(
      and(
        eq(coreUser.id, subjectUserId),
        isNull(coreUser.deletedAt),
        isNotNull(coreUser.emailVerifiedAt),
      ),
    ),
)

export type GrantRoleWriteInput = {
  actorUserId: string
  grant: UserRoleGrantRecord
  auditEvent: AuditEventRecord
}

/**
 * Grants one administrative role, or writes nothing at all.
 *
 * The insert carries three predicates the controller already checked. Repeating
 * them is what makes the write authoritative: between the controller's reads
 * and this statement the subject can be soft-deleted, the same role can be
 * granted by a concurrent operator, or the actor's own SUPER_ADMIN grant can be
 * revoked.
 *
 * **The `NOT hasActiveRole` term is not sufficient on its own, and its old
 * justification is gone with the engine it named.** It said the partial unique
 * index never had to raise because D1 serialized writers; Postgres does not.
 * Two operators granting the same role concurrently each evaluate that term
 * against their own snapshot, both find no active grant, and the second blocks
 * on `core_user_role_grant_active_uq` and then raises `23505` — which reached
 * the operator as an unhandled error rather than as "they already hold it".
 *
 * `constraintSafe` turns that into `false`, which is what every other predicate
 * in this statement already produces for a lost race. The index stays the
 * authority; the term stays because it is what makes the *ordinary* case a
 * clean refusal instead of a caught violation.
 */
export const grantRoleWrite = async (
  db: Database,
  input: GrantRoleWriteInput,
): Promise<boolean> => {
  const { grant } = input
  const insertGrant = db
    .insert(coreUserRoleGrant)
    .select(sql`
      SELECT
        ${grant.id},
        ${grant.userId},
        ${grant.role},
        ${grant.grantedByUserId},
        ${grant.grantReason},
        ${grant.grantedAt},
        NULL,
        NULL,
        NULL
      WHERE ${subjectIsGrantable(db, grant.userId)}
        AND ${hasActiveRole(db, input.actorUserId, 'SUPER_ADMIN')}
        AND NOT ${hasActiveRole(db, grant.userId, grant.role)}
    `)
    .returning({ id: coreUserRoleGrant.id })

  // Sharing the insert's outcome as the audit predicate keeps the pair
  // all-or-nothing: a request that loses the race records no history either.
  const grantLanded = exists(
    db
      .select({ id: coreUserRoleGrant.id })
      .from(coreUserRoleGrant)
      .where(eq(coreUserRoleGrant.id, grant.id)),
  )

  // One batch is one D1 transaction, so the grant and its audit event are never
  // observable half-applied.
  const inserted = await constraintSafe(() => batch(db, (tx) => [
    insertGrant,
    insertAuditEventWhere(tx, input.auditEvent, grantLanded),
  ]))
  return inserted !== null && inserted[0].length === 1
}

export type RevokeRoleWriteInput = {
  actorUserId: string
  grantId: string
  reason: string
  now: Date
  auditEvent: AuditEventRecord
}

/**
 * Locks the super-administrator roster for the rest of the transaction.
 *
 * **The `EXISTS` guard below is not sufficient on its own, and that was a real
 * hole.** Version-in-the-`WHERE` works everywhere else in this repository
 * because two writers contend for *the same row*: the loser blocks, re-reads
 * the committed row under READ COMMITTED, and its predicate fails. This guard
 * is different in kind — it reads rows the statement does not write. Two
 * operators revoking *different* super-administrator grants never touch a
 * common row, so neither blocks; each `EXISTS` runs against a snapshot taken
 * before the other committed; each sees the other still live; both succeed.
 * The portal is left with no super administrator, and bootstrap has permanently
 * closed, so there is no way back.
 *
 * Locking every live super-administrator grant first makes the two contend
 * after all. The second waits, and because each statement in READ COMMITTED
 * takes a fresh snapshot, its guard then runs against a roster that includes
 * the first revocation — and refuses. Every caller locks the same set with the
 * same query, so they acquire the rows in the same order and cannot deadlock.
 *
 * Taken for any revocation rather than only a super administrator's: the role
 * is a property of the row being revoked, so knowing whether the lock is needed
 * would itself be a read-then-decide. Revocations are rare and this is one
 * indexed lookup.
 *
 * **Demonstrated, not reasoned about.** Three sessions, each opening a
 * transaction and holding at a barrier until all three were inside, then each
 * running exactly this UPDATE against a different grant in a cycle — A closes
 * B's, B closes C's, C closes A's. Without the lock all three reported one row
 * changed and the table was left with no live super administrator. With it,
 * one landed and one remained.
 *
 * **Two operators cannot cause it and three can**, which is why the obvious
 * two-operator test passes against the broken code: with two, each actor is
 * also the other's subject, so whoever commits second is caught by the separate
 * term requiring the actor to still hold the role. A cycle of three leaves
 * every actor live at their own snapshot.
 *
 * No test here reproduces it. The window needs all three transactions open
 * simultaneously, and the suite drives the product over HTTP where nothing can
 * hold one there — `auth.test.ts` asserts the invariant rather than the race,
 * and says so. Recorded here because this is where somebody will ask whether
 * the lock earns its statement.
 */
const lockSuperAdminRoster = (db: Database) =>
  db.execute(sql`
    SELECT id FROM ${coreUserRoleGrant}
     WHERE ${coreUserRoleGrant.role} = 'SUPER_ADMIN'
       AND ${coreUserRoleGrant.revokedAt} IS NULL
     ORDER BY id
       FOR UPDATE
  `)

/**
 * Closes one administrative grant, or writes nothing at all.
 *
 * The `anotherUsableSuperAdminExists` term is the last-super-administrator
 * guard, and it belongs here rather than in the controller. A read-then-write
 * version loses to a concurrent revocation: two operators could each observe
 * two super administrators and each remove one, leaving the portal with none
 * and no way to create another, because bootstrap has permanently closed.
 *
 * The term alone does not close that race — see `lockSuperAdminRoster`, which
 * is what makes it authoritative.
 */
export const revokeRoleWrite = async (
  db: Database,
  input: RevokeRoleWriteInput,
): Promise<boolean> => {
  const revokeGrant = db
    .update(coreUserRoleGrant)
    .set({
      revokedByUserId: input.actorUserId,
      revokedAt: input.now,
      revocationReason: input.reason,
    })
    .where(
      and(
        eq(coreUserRoleGrant.id, input.grantId),
        isNull(coreUserRoleGrant.revokedAt),
        /*
         * Revoking APPLICANT is not an administrative operation; see
         * `manageableRoles`. The enum stops it at the GraphQL boundary for
         * grants, but a revocation names a grant ID, so the role of the row it
         * resolves to has to be checked here.
         *
         * Built from `manageableRoles` rather than listed again. Written out,
         * this said ADMIN and SUPER_ADMIN and stayed that way when the office
         * grew two more roles — so revoking a reviewer matched no rows and
         * reported that the record had changed, on every attempt, for ever.
         * Invitations are how reviewers and approvers are created, which made
         * staff access one-way.
         */
        inArray(coreUserRoleGrant.role, [...manageableRoles]),
        or(
          ne(coreUserRoleGrant.role, 'SUPER_ADMIN'),
          anotherUsableSuperAdminExists(db, input.grantId),
        ),
        hasActiveRole(db, input.actorUserId, 'SUPER_ADMIN'),
      ),
    )

  // The revocation timestamp is unique to this attempt, so observing it proves
  // the update above landed. Batch statements see each other's effects in order.
  const revocationLanded = exists(
    db
      .select({ id: coreUserRoleGrant.id })
      .from(coreUserRoleGrant)
      .where(
        and(
          eq(coreUserRoleGrant.id, input.grantId),
          eq(coreUserRoleGrant.revokedAt, input.now),
        ),
      ),
  )

  const [, revoked] = await batch(db, (tx) => [
    lockSuperAdminRoster(tx as unknown as Database),
    revokeGrant,
    insertAuditEventWhere(tx, input.auditEvent, revocationLanded),
  ])
  return revoked.rowCount === 1
}

export type AcceptRoleInviteWriteInput = {
  userId: string
  grant: UserRoleGrantRecord
  auditEvent: AuditEventRecord
}

/**
 * Exchanges an applicant grant for the staff role an invitation named.
 *
 * **There is no actor term in this write, and that is deliberate.** Every other
 * statement in this module repeats the caller's authority in SQL; here the
 * authority was established when the invitation was sealed, by an administrator
 * who held `ROLE_INVITE`, and the person accepting is the subject rather than
 * an operator. The sealed token is the credential, and `invite.ts` is what
 * validates it.
 *
 * What this write does repeat is the *precondition*, which is what makes a
 * stateless invitation single-use. It lands only while the subject still holds
 * `APPLICANT` and does not already hold the target role — so once accepted,
 * neither is true and a replayed link writes nothing. That check has to be here
 * rather than only in the controller: two clicks arriving together would both
 * pass a read.
 *
 * It used to say the second click observes the first because D1 serializes
 * these statements. Postgres does not, so two clicks landing together both see
 * no grant and the second raises `23505` on the partial unique index — which is
 * a lost race and must read as one. `constraintSafe` makes it so; the
 * precondition above still decides every case that is not a dead heat.
 *
 * The revocation shares the insert's outcome, so a request that loses that race
 * revokes nothing. Stranding the account with no active role would leave
 * somebody unable to sign in at all.
 */
export const acceptRoleInviteWrite = async (
  db: Database,
  input: AcceptRoleInviteWriteInput,
): Promise<boolean> => {
  const { grant } = input
  const insertGrant = db
    .insert(coreUserRoleGrant)
    .select(sql`
      SELECT
        ${grant.id},
        ${grant.userId},
        ${grant.role},
        ${grant.grantedByUserId},
        ${grant.grantReason},
        ${grant.grantedAt},
        NULL,
        NULL,
        NULL
      WHERE ${subjectIsGrantable(db, grant.userId)}
        AND ${hasActiveRole(db, grant.userId, 'APPLICANT')}
        AND NOT ${hasActiveRole(db, grant.userId, grant.role)}
    `)
    .returning({ id: coreUserRoleGrant.id })

  const grantLanded = exists(
    db
      .select({ id: coreUserRoleGrant.id })
      .from(coreUserRoleGrant)
      .where(eq(coreUserRoleGrant.id, grant.id)),
  )

  // Matched on user and role rather than on a grant id read earlier: a grant
  // revoked and re-created in between would leave a stale id matching nothing,
  // silently leaving the account holding both roles.
  const revokeApplicantGrant = db
    .update(coreUserRoleGrant)
    .set({
      // Taking both from the new grant keeps the swap structurally one event,
      // so the pair cannot drift to different times or different reasons.
      revokedByUserId: grant.grantedByUserId,
      revokedAt: grant.grantedAt,
      revocationReason: grant.grantReason,
    })
    .where(
      and(
        eq(coreUserRoleGrant.userId, input.userId),
        eq(coreUserRoleGrant.role, 'APPLICANT'),
        isNull(coreUserRoleGrant.revokedAt),
        grantLanded,
      ),
    )

  const inserted = await constraintSafe(() => batch(db, (tx) => [
    insertGrant,
    revokeApplicantGrant,
    insertAuditEventWhere(tx, input.auditEvent, grantLanded),
  ]))
  return inserted !== null && inserted[0].length === 1
}
