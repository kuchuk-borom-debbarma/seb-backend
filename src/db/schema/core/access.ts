/**
 * Who may do what: the roles the office composed, and who holds them.
 *
 * Authority used to be a fixed table: six roles in a TypeScript tuple, eight
 * capabilities, and one hardcoded map between them. Changing what anybody could
 * do meant a code change and a deploy. These tables are what let a super
 * administrator compose a role out of the catalogue instead.
 *
 * The grant table lives here rather than beside `core_user` because it is the
 * one table that names both an identity and a role, and a module holding it
 * next to `coreUser` would have to import back from this one — the circular
 * pair `shared.ts` already exists to avoid.
 *
 * ## What is deliberately not here
 *
 * **A super administrator has no row in either table, and never will.** Their
 * access is the wildcard, decided in `services/auth/permissions.ts`, so a
 * resource or action added to `catalog.json` is theirs the moment it is added —
 * with no migration and nothing to backfill. A row could be edited empty or
 * deleted, and bootstrap has permanently closed, so there would be no way back.
 *
 * **An applicant has no row either.** That grant is created only by verified
 * signup, nothing can grant it back, and it gates the applicant portal — a
 * different question from what a member of staff may do.
 *
 * ## Why the catalogue is not a CHECK here
 *
 * Every other closed set in this schema is written out as an `IN (…)`. This one
 * is not, because the catalogue is a code artifact that moves with the code: a
 * CHECK would demand a migration for every catalogue edit, and the two would
 * drift the first time somebody forgot. Instead the resolution step intersects
 * what is stored against the catalogue, so a row naming a resource that no
 * longer exists grants nothing. That fails closed, which is the direction this
 * repository requires, and it makes removing a resource take effect at once
 * rather than pending a data migration.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { instant, versionedSoftDeleteColumns } from '../shared'
import { coreUser } from './auth'

/**
 * The two authorities decided in code rather than read from a row.
 *
 * `SUPER_ADMIN` holds the wildcard: everything in the permission catalogue, and
 * anything added to it later, with no row to edit and nothing to backfill. It
 * cannot be a `core_role` because a row could be emptied or retired, and
 * bootstrap has permanently closed, so the programme would be locked out of its
 * own administration with no way back.
 *
 * `APPLICANT` is not a staff authority at all. Verified signup is the only
 * thing that creates it and nothing can grant it back, so role administration
 * deliberately cannot touch it — one revocation would strip somebody
 * permanently.
 *
 * Everything else the office does is a role somebody composed, below.
 */
export const builtinRoles = ['APPLICANT', 'SUPER_ADMIN'] as const
export type BuiltinRole = (typeof builtinRoles)[number]

/**
 * The fixed vocabulary this table accepted before roles became data.
 *
 * Retained because a grant is never deleted, only closed: an audit row naming
 * what somebody did as an administrator is unreadable if the grant that gave
 * them the authority has vanished. Nothing writes these any more, and the
 * table's own CHECK permits one only on a row that is already revoked.
 */
export const legacyRoles = ['REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER'] as const
export type LegacyRole = (typeof legacyRoles)[number]

/**
 * A role a super administrator composed out of catalogue permissions.
 *
 * Soft-deleted rather than removed, like every other root here, so a grant that
 * named it stays readable and "who held what, when" survives the role being
 * retired. `key` stays unique across deleted rows for the same reason a deleted
 * email address stays reserved: a reused key would make two different
 * authorities indistinguishable in retained history.
 *
 * `current_version` guards the permission set. Two operators editing one role
 * contend on this row, which is the shape optimistic concurrency actually works
 * for — the loser blocks, re-reads the committed row, and its predicate fails.
 */
export const coreRole = pgTable(
  'core_role',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    ...versionedSoftDeleteColumns((): AnyPgColumn => coreUser.id),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
  },
  (table) => [
    /*
     * An identifier, not a label. Bounded and character-restricted because it
     * travels into audit metadata and into the `resource:action`-shaped key the
     * session join builds, where a colon or a space would make two different
     * things parse as one.
     */
    check('core_role_key_check', sql`${table.key} ~ '^[A-Z][A-Z0-9_]{1,62}$'`),
    /*
     * What stops a custom role impersonating an authority decided in code.
     *
     * Without it a super administrator could create a role keyed `SUPER_ADMIN`,
     * and every screen showing a role key would show two different authorities
     * under one name — while the guards, which read the grant table's own
     * column, would disagree with all of them.
     */
    check(
      'core_role_key_reserved_check',
      sql`${table.key} NOT IN ('APPLICANT', 'SUPER_ADMIN', 'REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')`,
    ),
    check('core_role_current_version_check', sql`${table.currentVersion} >= 1`),
    // A constraint rather than an index: nothing references it today, and the
    // schema's ordering rule for composite foreign keys costs nothing to honour
    // in advance.
    unique('core_role_key_uq').on(table.key),
    index('core_role_live_idx').on(table.deletedAt, table.key),
  ],
)

/**
 * One resource/action pair a role carries.
 *
 * A row per pair rather than a JSON column, for the reason the form template
 * gives for its own shape: rows make cross-row uniqueness a one-line index, let
 * two roles be compared in SQL, and let the session join fold a person's whole
 * permission set with an aggregate instead of parsing documents in application
 * code.
 */
export const coreRolePermission = pgTable(
  'core_role_permission',
  {
    id: text('id').primaryKey(),
    roleId: text('role_id')
      .notNull()
      .references(() => coreRole.id, { onDelete: 'restrict' }),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    /*
     * Shape only. Which pairs are legal is the catalogue's business, and the
     * module comment says why that is not a CHECK — but a value that could not
     * be a catalogue key at all is a bug in the layer above, and this is the
     * cheapest place to refuse it.
     */
    check('core_role_permission_resource_check', sql`${table.resource} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check('core_role_permission_action_check', sql`${table.action} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    uniqueIndex('core_role_permission_pair_uq').on(table.roleId, table.resource, table.action),
    index('core_role_permission_role_idx').on(table.roleId),
  ],
)

/**
 * Retained history of what an identity has been allowed to be.
 *
 * Revocation closes a grant instead of deleting it. A later re-grant creates a
 * new row, preserving who held which authority at the time of every audit
 * event. The partial unique indexes are the concurrency guard that prevents two
 * active copies of the same authority while still permitting historical copies.
 *
 * A row names its authority in exactly one of three columns, and the CHECK
 * below enforces that: `role` for the two decided in code, `role_id` for a
 * composed one, and `role` again — in the removed vocabulary — for closed
 * history that predates roles being data.
 */
export const coreUserRoleGrant = pgTable(
  'core_user_role_grant',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    /*
     * An authority decided in code: `APPLICANT`, `SUPER_ADMIN`, or one of the
     * four removed roles on a row that is already closed.
     *
     * Nullable since roles became data, and that is the whole reason the two
     * unique indexes below are partial on it being non-null: Postgres treats
     * NULLs in a unique index as distinct, so one index over the nullable pair
     * would accept two identical active grants of the same composed role while
     * looking exactly like the guarantee this table has always carried.
     */
    role: text('role'),
    // Null identifies a trusted system transition such as verified signup or
    // the one-time first-super-admin bootstrap. Public input never controls it.
    grantedByUserId: text('granted_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    grantReason: text('grant_reason').notNull(),
    grantedAt: instant('granted_at').notNull(),
    revokedByUserId: text('revoked_by_user_id').references(() => coreUser.id, {
      onDelete: 'restrict',
    }),
    revokedAt: instant('revoked_at'),
    revocationReason: text('revocation_reason'),
    /*
     * DECLARED LAST ON PURPOSE.
     *
     * `ALTER TABLE … ADD COLUMN` appends in Postgres, while `drizzle-kit export`
     * writes `CREATE TABLE` in the order declared here. Every guarded write into
     * this table is a positional `INSERT … SELECT` with no column list, so a
     * database built from `schema.sql` and a migrated one must agree on physical
     * order or the same statement writes different columns in each.
     * `check:insert-arity` counts columns and cannot see an ordering difference.
     */
    roleId: text('role_id').references(() => coreRole.id, { onDelete: 'restrict' }),
  },
  (table) => [
    /*
     * Exactly one authority per row, with the null arms spelled out.
     *
     * A CHECK passes when its result is NULL, not only when it is true, so an
     * arm naming a nullable column without `IS NOT NULL` accepts the very rows
     * it was written to refuse.
     */
    check(
      'core_user_role_grant_target_check',
      sql`(${table.role} IS NOT NULL AND ${table.roleId} IS NULL)
        OR (${table.role} IS NULL AND ${table.roleId} IS NOT NULL)`,
    ),
    /*
     * The removed vocabulary is history and cannot be written afresh.
     *
     * A plain widening to all six values would have let a new `ADMIN` grant be
     * created years after the role stopped meaning anything. Requiring the row
     * to be closed is what makes these readable without making them writable —
     * and narrowing to the two current values instead would have rejected the
     * very rows the migration exists to preserve.
     */
    check(
      'core_user_role_grant_role_check',
      sql`${table.role} IS NULL
        OR ${table.role} IN ('APPLICANT', 'SUPER_ADMIN')
        OR (${table.role} IN ('REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')
            AND ${table.revokedAt} IS NOT NULL)`,
    ),
    // Active grants contain no revocation metadata. Automated revocation may
    // have no user actor, but every closed grant must retain when and why.
    check(
      'core_user_role_grant_revocation_check',
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationReason} IS NULL)
        OR (${table.revokedAt} IS NOT NULL
          AND ${table.revocationReason} IS NOT NULL
          AND ${table.revokedAt} >= ${table.grantedAt})`,
    ),
    uniqueIndex('core_user_role_grant_active_uq')
      .on(table.userId, table.role)
      .where(sql`${table.revokedAt} IS NULL AND ${table.role} IS NOT NULL`),
    uniqueIndex('core_user_role_grant_active_role_uq')
      .on(table.userId, table.roleId)
      .where(sql`${table.revokedAt} IS NULL AND ${table.roleId} IS NOT NULL`),
    index('core_user_role_grant_user_idx').on(table.userId, table.revokedAt),
    // Serves the super-administrator roster lock and the permanent bootstrap
    // lock, which scans every historical row, so the role column leads.
    index('core_user_role_grant_role_idx').on(table.role, table.revokedAt, table.userId),
    // "Is this composed role granted to anybody", which retirement asks.
    index('core_user_role_grant_role_id_idx').on(table.roleId, table.revokedAt, table.userId),
  ],
)
