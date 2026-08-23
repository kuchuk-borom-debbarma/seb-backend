/**
 * Reading `core_audit_event`.
 *
 * The largest table in the database, and the one most likely to be read with no
 * filter at all, so every query here is written to seek rather than scan. Which
 * index each combination lands on is noted beside the filter that causes it.
 */
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import { coreAuditEvent, coreUser, coreUserRoleGrant, type UserRole } from '../../../db/schema'
import { COUNT_MISSING, requireInvariant } from '../../application/support'
/*
 * The same cursor contract every other list uses, including its refusal of a
 * cursor minted under a different ordering. Audit rows are ordered by
 * `createdAt`, which is already one of the sort keys it knows.
 */
import { encodeCursor, MAX_COLLECTION_ROWS } from '../../application/pagination'
import type { AuditEvent, AuditFilters } from '../types'

/**
 * How many actors one request may name.
 *
 * `IN (…)` with an unbounded list is a way to make one request do arbitrary
 * work, and a screen offering a person-picker will never legitimately need
 * hundreds. Well above any real use, so it is a backstop rather than a limit
 * anybody meets.
 */
export const MAX_ACTOR_FILTER = 50

/** Same reasoning, for the action filter. */
export const MAX_ACTION_FILTER = 50

/**
 * Everything the filters say, without the cursor.
 *
 * The page seeks from a position; the total counts the whole matching set. They
 * must therefore share exactly these terms and differ only by the cursor, or
 * the count describes a different question than the page answers.
 */
const auditFilters = (input: AuditFilters) => {
  const actorIds = input.actorUserIds?.slice(0, MAX_ACTOR_FILTER)
  const actions = input.action?.slice(0, MAX_ACTION_FILTER)
  return and(
    // Uses core_audit_event_actor_idx, one seek per named actor.
    actorIds?.length ? inArray(coreAuditEvent.actorUserId, actorIds) : undefined,
    /*
     * "Everybody holding this role." An EXISTS against the grant table rather
     * than a join, so one actor with several active grants cannot multiply
     * their own events into duplicate rows — which a join would do, silently,
     * and only for people holding more than one role.
     *
     * Seeks core_user_role_grant_role_idx on (role, revoked_at, user_id).
     */
    input.actorRole
      ? sql`EXISTS (
          SELECT 1 FROM ${coreUserRoleGrant}
          WHERE ${coreUserRoleGrant.userId} = ${coreAuditEvent.actorUserId}
            AND ${coreUserRoleGrant.role} = ${input.actorRole}
            AND ${coreUserRoleGrant.revokedAt} IS NULL
        )`
      : undefined,
    // Uses core_audit_event_entity_idx.
    input.applicationId
      ? and(
          eq(coreAuditEvent.entityType, 'SEB_APPLICATION'),
          eq(coreAuditEvent.entityId, input.applicationId),
        )
      : undefined,
    input.entityType ? eq(coreAuditEvent.entityType, input.entityType) : undefined,
    // Uses core_audit_event_action_idx.
    actions?.length ? inArray(coreAuditEvent.action, actions) : undefined,
    input.outcome ? eq(coreAuditEvent.outcome, input.outcome) : undefined,
    input.from ? gte(coreAuditEvent.createdAt, input.from) : undefined,
    input.to ? lte(coreAuditEvent.createdAt, input.to) : undefined,
  )
}

export type AuditPage = {
  nodes: AuditEvent[]
  pageInfo: { endCursor: string | null; hasNextPage: boolean; totalCount: number }
}

/**
 * One page of history, newest first unless asked otherwise.
 *
 * The actor is resolved in the same statement with a left join rather than a
 * second read per row: a page of fifty would otherwise be fifty-one queries,
 * and the roles would be fifty-one more. The roles are folded from a grouped
 * subquery for the same reason.
 *
 * A left join because an actor is genuinely optional — trusted system
 * transitions such as verified signup and the bootstrap have no actor at all,
 * and an inner join would quietly hide exactly those events.
 */
export const listAuditEvents = async (
  db: Database,
  input: AuditFilters,
): Promise<AuditPage> => {
  const descending = (input.order ?? 'NEWEST_FIRST') === 'NEWEST_FIRST'
  const filters = auditFilters(input)
  const cursor = input.after
    ? or(
        descending
          ? lt(coreAuditEvent.createdAt, input.after.timestamp)
          : gt(coreAuditEvent.createdAt, input.after.timestamp),
        and(
          eq(coreAuditEvent.createdAt, input.after.timestamp),
          descending
            ? lt(coreAuditEvent.id, input.after.id)
            : gt(coreAuditEvent.id, input.after.id),
        ),
      )
    : undefined

  /*
   * The roles each actor holds now, as one grouped read rather than a join.
   * Joining the grant table directly would repeat an event once per role its
   * actor holds.
   */
  const actorRoles = db
    .select({
      userId: coreUserRoleGrant.userId,
      roles: sql<string>`group_concat(${coreUserRoleGrant.role})`.as('roles'),
    })
    .from(coreUserRoleGrant)
    .where(isNull(coreUserRoleGrant.revokedAt))
    .groupBy(coreUserRoleGrant.userId)
    .as('actor_roles')

  const rows = await db
    .select({
      id: coreAuditEvent.id,
      action: coreAuditEvent.action,
      entityType: coreAuditEvent.entityType,
      entityId: coreAuditEvent.entityId,
      outcome: coreAuditEvent.outcome,
      requestId: coreAuditEvent.requestId,
      ipAddress: coreAuditEvent.ipAddress,
      userAgent: coreAuditEvent.userAgent,
      metadata: coreAuditEvent.metadataJson,
      createdAt: coreAuditEvent.createdAt,
      actorId: coreUser.id,
      actorEmail: coreUser.email,
      actorRoles: actorRoles.roles,
    })
    .from(coreAuditEvent)
    .leftJoin(coreUser, eq(coreUser.id, coreAuditEvent.actorUserId))
    .leftJoin(actorRoles, eq(actorRoles.userId, coreAuditEvent.actorUserId))
    .where(and(filters, cursor))
    .orderBy(
      descending ? desc(coreAuditEvent.createdAt) : asc(coreAuditEvent.createdAt),
      descending ? desc(coreAuditEvent.id) : asc(coreAuditEvent.id),
    )
    // One extra row is how hasNextPage is known without a second count.
    .limit(Math.min(input.first, MAX_COLLECTION_ROWS) + 1)

  const [total] = await db
    .select({ value: count() })
    .from(coreAuditEvent)
    .where(filters)

  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)
  return {
    nodes: selected.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      outcome: row.outcome,
      actor: row.actorId
        ? {
            id: row.actorId,
            email: requireInvariant(row.actorEmail, 'Audit actor has no address.'),
            // Nobody holding no active role can act, but the row survives them
            // being deactivated, so an empty list is a real state here.
            roles: (row.actorRoles?.split(',') ?? []) as UserRole[],
          }
        : null,
      requestId: row.requestId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      metadata: row.metadata,
      createdAt: row.createdAt,
    })),
    pageInfo: {
      endCursor: last ? encodeCursor('createdAt', last.createdAt, last.id) : null,
      hasNextPage: rows.length > input.first,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
    },
  }
}

/**
 * Distinct action names, so a filter can offer what actually occurred.
 *
 * Reads the recorded history rather than the `auditActions` constant on
 * purpose: the constant says what this version of the code can write, and the
 * history holds what was written, including actions from releases that have
 * since been renamed. A filter listing actions that appear nowhere would be a
 * list of dead ends.
 */
export const listAuditActions = async (db: Database): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ action: coreAuditEvent.action })
    .from(coreAuditEvent)
    .orderBy(asc(coreAuditEvent.action))
    .limit(MAX_COLLECTION_ROWS)
  return rows.map((row) => row.action)
}
