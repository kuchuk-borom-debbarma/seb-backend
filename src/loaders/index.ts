/**
 * Per-request batching for the lookups that repeat across a page of rows.
 *
 * A queue of twenty applications names up to twenty different people. Resolving
 * each one where it is needed would be twenty queries; resolving them with a
 * join would duplicate an application once per role its assignee holds, which
 * is a bug the audit query already had to work around. A loader collects the
 * ids asked for during one tick and answers them all with a single `IN (…)`.
 *
 * ## The rule that matters more than the batching
 *
 * **Loaders are created per request and never at module scope.** A loader is a
 * cache. One built once and shared would be shared by every request the isolate
 * ever serves — so one applicant's data would answer another's query, and a
 * revoked role would keep reading as held long after it was taken away. That is
 * not a stale-cache annoyance, it is a data leak, and it is the single thing
 * this file exists to get right. `createLoaders` is called where the request's
 * database is created and nowhere else.
 *
 * ## What must never be loaded
 *
 * **Authorization.** `getCurrentSession` re-reads roles live so that revoking a
 * role takes effect on the caller's very next action. Caching that within one
 * request would in fact be safe — a request is one instant — but the guard
 * would then look cacheable, and the next person to widen it would be widening
 * a security check. It stays off the loader entirely.
 */
import DataLoader from 'dataloader'
import { and, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../db'
import { coreUser, coreUserRoleGrant, type UserRole } from '../db/schema'
import type { StaffMember } from './staff'

export type { StaffMember } from './staff'

export type Loaders = {
  /** Resolves a person by id. `null` for one that no longer exists. */
  userById: DataLoader<string, StaffMember | null>
}

export const createLoaders = (db: Database): Loaders => ({
  userById: new DataLoader<string, StaffMember | null>(async (ids) => {
    const wanted = [...ids]
    const [people, grants] = await Promise.all([
      db
        .select({ id: coreUser.id, email: coreUser.email })
        .from(coreUser)
        .where(inArray(coreUser.id, wanted)),
      /*
       * Read separately rather than joined, so somebody holding two roles
       * yields one person with two roles instead of two people. Two small
       * statements, not one per id.
       */
      db
        .select({ userId: coreUserRoleGrant.userId, role: coreUserRoleGrant.role })
        .from(coreUserRoleGrant)
        .where(
          and(
            inArray(coreUserRoleGrant.userId, wanted),
            // Active grants only. Revocation closes a grant rather than
            // deleting it, so the history would otherwise report authority
            // somebody no longer holds.
            isNull(coreUserRoleGrant.revokedAt),
          ),
        ),
    ])

    const rolesByUser = new Map<string, UserRole[]>()
    for (const grant of grants) {
      const held = rolesByUser.get(grant.userId)
      if (held) held.push(grant.role)
      else rolesByUser.set(grant.userId, [grant.role])
    }
    const found = new Map(
      people.map((person) => [
        person.id,
        { ...person, roles: rolesByUser.get(person.id) ?? [] },
      ]),
    )

    /*
     * DataLoader's contract: exactly one result per key, in the order asked.
     * A missing person must come back as `null` in their own place rather than
     * being omitted — dropping one would shift every later answer onto the
     * wrong row, silently.
     */
    return wanted.map((id) => found.get(id) ?? null)
  }),
})
