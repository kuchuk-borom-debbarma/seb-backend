/**
 * Reading `core_audit_event`.
 *
 * The largest table in the database, and the one most likely to be read with no
 * filter at all, so every query here is written to seek rather than scan. Which
 * index each filter lands on is noted beside the filter that causes it, and
 * `test/service/audit.test.ts` holds the plans to that at a hundred thousand
 * rows.
 *
 * A page is three statements whatever its size: the rows (with actor and
 * subject resolved in the same statement), the total, and one folded read of
 * every other record the page's payloads name. Nothing here is read per row.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  coreRole,
  coreUser,
  coreUserRoleGrant,
  sebApplication,
  sebEnterprise,
  sebProgrammeCycle,
  type AuditAction,
} from '../../../db/schema'
import { COUNT_MISSING, requireInvariant } from '../../application/support'
import { auditActionsIn, auditVocabulary } from '../../audit-vocabulary'
import type { AuditReferenceKind } from '../../audit-vocabulary/types'
import type { AuditActor, AuditFilter, AuditOrder, AuditPageRequest } from '../types'

/**
 * How many people one request may name, per people filter.
 *
 * `IN (…)` with an unbounded list is a way to make one request do arbitrary
 * work, and a screen offering a person-picker will never legitimately need
 * hundreds. Well above any real use, so it is a backstop rather than a limit
 * anybody meets.
 */
export const MAX_PEOPLE_FILTER = 50

/** Same reasoning, for the action filter. */
export const MAX_ACTION_FILTER = 50

/** Same reasoning, for the entity-type filter; there are fewer than twenty types. */
export const MAX_ENTITY_TYPE_FILTER = 20

/**
 * The most rows one export carries.
 *
 * An export is built in the Worker's memory and returned in one response, so it
 * needs a ceiling: ten thousand rows is about eight megabytes of CSV, well
 * inside what a Worker can hold, and far more than a person reads. A filter
 * matching more is told so rather than silently cut.
 */
export const MAX_EXPORT_ROWS = 10_000

/** How far apart two events of one request may be before they are not linked. */
const SAME_REQUEST_WINDOW_MS = 10 * 60 * 1000

/** How many events one request is shown with. */
const MAX_SAME_REQUEST = 50

const declaredActions = Object.keys(auditVocabulary) as AuditAction[]

const subjectUser = alias(coreUser, 'subject_user')

/**
 * The roles a person holds now, as one correlated read per row.
 *
 * Correlated rather than a grouped subquery joined on: the grouped form
 * aggregated the whole grant table on every page, which grows with the number
 * of people, whereas this seeks `core_user_role_grant_user_idx` once per row on
 * the page. A retired role names nobody, and is left out; a grant of one of the
 * two authorities decided in code has no role row at all, and is kept.
 */
const rolesHeldBy = (userId: SQL | AnyColumn) => sql<string[] | null>`(
  SELECT array_agg(COALESCE(grant_row.role, role_row.key) ORDER BY COALESCE(grant_row.role, role_row.key))
    FROM ${coreUserRoleGrant} AS grant_row
    LEFT JOIN ${coreRole} AS role_row
      ON role_row.id = grant_row.role_id AND role_row.deleted_at IS NULL
   WHERE grant_row.user_id = ${userId}
     AND grant_row.revoked_at IS NULL
     AND COALESCE(grant_row.role, role_row.key) IS NOT NULL
)`

/** Terms about people: who acted, who it was about, or either. */
const peopleTerms = (filter: AuditFilter): (SQL | undefined)[] => [
  // core_audit_event_actor_idx, one seek per named actor.
  filter.actorUserIds?.length ? inArray(coreAuditEvent.actorUserId, [...filter.actorUserIds]) : undefined,
  // core_audit_event_subject_idx.
  filter.subjectUserIds?.length ? inArray(coreAuditEvent.subjectUserId, [...filter.subjectUserIds]) : undefined,
  // One person's whole history: the actor and subject indexes, or a walk of
  // the created index when the person is common — the planner chooses.
  filter.involvingUserId
    ? or(
        eq(coreAuditEvent.actorUserId, filter.involvingUserId),
        eq(coreAuditEvent.subjectUserId, filter.involvingUserId),
      )
    : undefined,
  /*
   * "Everybody holding this role." An EXISTS rather than a join, so one actor
   * with several active grants cannot multiply their own events into
   * duplicate rows — which a join would do, silently, and only for people
   * holding more than one role.
   */
  filter.actorRole
    ? sql`EXISTS (
        SELECT 1 FROM ${coreUserRoleGrant} AS grant_row
        LEFT JOIN ${coreRole} AS role_row
          ON role_row.id = grant_row.role_id AND role_row.deleted_at IS NULL
        WHERE grant_row.user_id = ${coreAuditEvent.actorUserId}
          AND grant_row.revoked_at IS NULL
          AND COALESCE(grant_row.role, role_row.key) = ${filter.actorRole}
      )`
    : undefined,
]

/**
 * Terms about what was done. A category is a set of actions, so it seeks
 * core_audit_event_action_idx like the action filter does. `OTHER` is
 * everything this build does not declare — a legacy name — and is the one
 * category answered by exclusion.
 */
const actionTerms = (filter: AuditFilter): (SQL | undefined)[] => {
  const categories = filter.categories ?? []
  const declared = auditActionsIn(categories.filter((category) => category !== 'OTHER'))
  return [
    categories.length
      ? or(
          declared.length ? inArray(coreAuditEvent.action, declared) : undefined,
          categories.includes('OTHER') ? notInArray(coreAuditEvent.action, declaredActions) : undefined,
        )
      : undefined,
    filter.actions?.length ? inArray(coreAuditEvent.action, [...filter.actions]) : undefined,
    filter.outcome ? eq(coreAuditEvent.outcome, filter.outcome) : undefined,
  ]
}

/** Terms about what it was done to. */
const recordTerms = (filter: AuditFilter): (SQL | undefined)[] => [
  // core_audit_event_entity_idx leads with the type.
  filter.entityTypes?.length ? inArray(coreAuditEvent.entityType, [...filter.entityTypes]) : undefined,
  filter.entityId ? eq(coreAuditEvent.entityId, filter.entityId) : undefined,
  // core_audit_event_application_idx.
  filter.applicationId ? eq(coreAuditEvent.applicationId, filter.applicationId) : undefined,
  /*
   * The reference number an officer has in hand, resolved inside the query so
   * an unknown one is an empty result rather than a second round trip. The
   * inner seek uses seb_application_reference_search_idx.
   */
  filter.applicationReference
    ? sql`${coreAuditEvent.applicationId} = (
        SELECT ${sebApplication.id} FROM ${sebApplication}
         WHERE lower(${sebApplication.referenceNumber}) = lower(${filter.applicationReference}))`
    : undefined,
]

/** Terms about when, and which request. */
const occasionTerms = (filter: AuditFilter): (SQL | undefined)[] => [
  filter.from ? gte(coreAuditEvent.createdAt, filter.from) : undefined,
  filter.to ? lte(coreAuditEvent.createdAt, filter.to) : undefined,
  // core_audit_event_request_idx.
  filter.requestId ? eq(coreAuditEvent.requestId, filter.requestId) : undefined,
]

/**
 * Everything the filter says, without the cursor.
 *
 * The page seeks from a position; the total counts the whole matching set. They
 * must therefore share exactly these terms and differ only by the cursor, or
 * the count describes a different question than the page answers.
 */
const auditFilterSql = (filter: AuditFilter): SQL | undefined =>
  and(...peopleTerms(filter), ...actionTerms(filter), ...recordTerms(filter), ...occasionTerms(filter))

/** One stored row, with its actor and subject already resolved. */
export type AuditRow = {
  id: string
  action: string
  entityType: string
  entityId: string | null
  outcome: 'SUCCESS' | 'FAILURE'
  requestId: string | null
  ipAddress: string | null
  userAgent: string | null
  metadataJson: string | null
  payload: unknown
  payloadVersion: number
  applicationId: string | null
  createdAt: Date
  actor: AuditActor | null
  subject: AuditActor | null
}

const personOf = (id: string | null, email: string | null, roles: string[] | null): AuditActor | null =>
  id
    ? {
        id,
        email: requireInvariant(email, 'An audited person has no address.'),
        // Nobody holding no active role can act, but the row survives them
        // being deactivated, so an empty list is a real state here.
        roles: roles ?? [],
      }
    : null

/**
 * The rows matching `where`, in order, with actor and subject resolved.
 *
 * Left joins, because both people are genuinely optional: signup and the
 * bootstrap have no actor, and most events have no subject. An inner join
 * would quietly hide exactly those rows.
 */
const auditRows = async (
  db: Database,
  where: SQL | undefined,
  order: AuditOrder,
  limit: number,
): Promise<AuditRow[]> => {
  const descending = order === 'NEWEST_FIRST'
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
      metadataJson: coreAuditEvent.metadataJson,
      payload: coreAuditEvent.payload,
      payloadVersion: coreAuditEvent.payloadVersion,
      applicationId: coreAuditEvent.applicationId,
      createdAt: coreAuditEvent.createdAt,
      actorId: coreUser.id,
      actorEmail: coreUser.email,
      actorRoles: rolesHeldBy(coreAuditEvent.actorUserId),
      subjectId: subjectUser.id,
      subjectEmail: subjectUser.email,
      subjectRoles: rolesHeldBy(coreAuditEvent.subjectUserId),
    })
    .from(coreAuditEvent)
    .leftJoin(coreUser, eq(coreUser.id, coreAuditEvent.actorUserId))
    .leftJoin(subjectUser, eq(subjectUser.id, coreAuditEvent.subjectUserId))
    .where(where)
    .orderBy(
      descending ? desc(coreAuditEvent.createdAt) : asc(coreAuditEvent.createdAt),
      descending ? desc(coreAuditEvent.id) : asc(coreAuditEvent.id),
    )
    .limit(limit)
  return rows.map(({ actorId, actorEmail, actorRoles, subjectId, subjectEmail, subjectRoles, ...row }) => ({
    ...row,
    actor: personOf(actorId, actorEmail, actorRoles),
    subject: personOf(subjectId, subjectEmail, subjectRoles),
  }))
}

/**
 * One page of history.
 *
 * Seeks `core_audit_event_created_idx` — or the filter's own index — from the
 * cursor, so page ten costs what page one costs.
 */
export const listAuditEvents = async (
  db: Database,
  request: AuditPageRequest,
): Promise<{ rows: AuditRow[]; hasNextPage: boolean; totalCount: number }> => {
  const descending = request.order === 'NEWEST_FIRST'
  const filters = auditFilterSql(request.filter)
  const after = request.after
  const cursor = after
    ? or(
        descending ? lt(coreAuditEvent.createdAt, after.timestamp) : gt(coreAuditEvent.createdAt, after.timestamp),
        and(
          eq(coreAuditEvent.createdAt, after.timestamp),
          descending ? lt(coreAuditEvent.id, after.id) : gt(coreAuditEvent.id, after.id),
        ),
      )
    : undefined
  // One extra row is how hasNextPage is known without a second read.
  const rows = await auditRows(db, and(filters, cursor), request.order, request.first + 1)
  const [total] = await db.select({ value: count() }).from(coreAuditEvent).where(filters)
  return {
    rows: rows.slice(0, request.first),
    hasNextPage: rows.length > request.first,
    totalCount: requireInvariant(total, COUNT_MISSING).value,
  }
}

/**
 * Every row a filter matches, up to one more than an export carries.
 *
 * The extra row is how a truncated export knows it was cut; the caller keeps
 * {@link MAX_EXPORT_ROWS}. Oldest first, because an exported history is read
 * as a sequence.
 */
export const exportAuditRows = (db: Database, filter: AuditFilter): Promise<AuditRow[]> =>
  auditRows(db, auditFilterSql(filter), 'OLDEST_FIRST', MAX_EXPORT_ROWS + 1)

/** One event by id, or nothing. */
export const findAuditRow = async (db: Database, id: string): Promise<AuditRow | null> =>
  (await auditRows(db, eq(coreAuditEvent.id, id), 'NEWEST_FIRST', 1))[0] ?? null

/**
 * The other events the same request produced.
 *
 * Bounded to ten minutes either side because the request id is not always
 * Cloudflare's: where `CF-Ray` is absent it is the caller's own `X-Request-ID`,
 * which anybody can repeat. Without the window, one reused header would link a
 * person's event to every other event ever sent with the same text.
 */
export const listSameRequestRows = (db: Database, event: AuditRow): Promise<AuditRow[]> => {
  if (event.requestId === null) return Promise.resolve([])
  return auditRows(
    db,
    and(
      eq(coreAuditEvent.requestId, event.requestId),
      gte(coreAuditEvent.createdAt, new Date(event.createdAt.getTime() - SAME_REQUEST_WINDOW_MS)),
      lte(coreAuditEvent.createdAt, new Date(event.createdAt.getTime() + SAME_REQUEST_WINDOW_MS)),
      sql`${coreAuditEvent.id} <> ${event.id}`,
    ),
    'OLDEST_FIRST',
    MAX_SAME_REQUEST,
  )
}

/** The ids a page wants named, by kind. */
export type ReferenceRequest = Record<AuditReferenceKind, Set<string>>

/** What those ids are called, by kind and id. Absent means no such record. */
export type ReferenceNames = Record<AuditReferenceKind, Map<string, string | null>>

const idsOf = (ids: Set<string>): string[] => [...ids].slice(0, 1_000)

/**
 * Every record a set of events names, in one statement.
 *
 * A `UNION ALL` of primary-key seeks, one arm per kind that has anything to
 * name, rather than a read per kind or — worse — per row. A role is named by
 * its key, because that is what a grant records; a retired role still has its
 * name, which is what a reader of old history needs.
 *
 * A draft application has no reference number yet, so it resolves to a null
 * label and is still found.
 */
export const resolveReferences = async (
  db: Database,
  wanted: ReferenceRequest,
): Promise<ReferenceNames> => {
  const names: ReferenceNames = {
    USER: new Map(),
    ROLE: new Map(),
    APPLICATION: new Map(),
    ENTERPRISE: new Map(),
    CYCLE: new Map(),
  }
  const arm = (kind: AuditReferenceKind, id: AnyColumn, label: AnyColumn, table: SQL) => {
    const ids = idsOf(wanted[kind])
    return ids.length
      ? sql`SELECT ${kind} AS kind, ${id} AS id, ${label} AS label FROM ${table} WHERE ${inArray(id, ids)}`
      : null
  }
  const arms = [
    arm('USER', coreUser.id, coreUser.email, sql`${coreUser}`),
    arm('ROLE', coreRole.key, coreRole.name, sql`${coreRole}`),
    arm('APPLICATION', sebApplication.id, sebApplication.referenceNumber, sql`${sebApplication}`),
    arm('ENTERPRISE', sebEnterprise.id, sebEnterprise.currentName, sql`${sebEnterprise}`),
    arm('CYCLE', sebProgrammeCycle.id, sebProgrammeCycle.displayName, sql`${sebProgrammeCycle}`),
  ].filter((part): part is SQL => part !== null)
  // Nothing to name costs nothing: no statement at all.
  if (arms.length === 0) return names
  const result = await db.execute<{ kind: AuditReferenceKind; id: string; label: string | null }>(
    sql.join(arms, sql` UNION ALL `),
  )
  for (const row of result.rows) names[row.kind].set(row.id, row.label)
  return names
}

/**
 * The action names that actually occur, in name order.
 *
 * A loose index scan: each step seeks `core_audit_event_action_idx` for the
 * first name after the previous one, so the cost is one probe per distinct
 * action — about eighty — rather than a `DISTINCT` over every row in the table.
 *
 * Reads the recorded history rather than the vocabulary on purpose: the
 * vocabulary says what this build can write, and the history holds what was
 * written, including names from releases that have since been renamed. A
 * filter offering actions that appear nowhere would be a list of dead ends.
 */
export const listRecordedActions = async (db: Database): Promise<string[]> => {
  const result = await db.execute<{ action: string }>(sql`
    WITH RECURSIVE recorded(action) AS (
      (SELECT ${coreAuditEvent.action} FROM ${coreAuditEvent} ORDER BY ${coreAuditEvent.action} LIMIT 1)
      UNION ALL
      SELECT (SELECT next_row.action FROM ${coreAuditEvent} AS next_row
               WHERE next_row.action > recorded.action ORDER BY next_row.action LIMIT 1)
        FROM recorded
       WHERE recorded.action IS NOT NULL
    )
    SELECT action FROM recorded WHERE action IS NOT NULL LIMIT 500
  `)
  return result.rows.map((row) => row.action)
}

/**
 * People named for a filter: by exact address, or by id.
 *
 * Exact match only, like `access.userByEmail`: there is no prefix and no list,
 * so this cannot be used to enumerate accounts. It exists so the history's
 * person filter works for a reader who may read the history but not administer
 * people — the addresses it returns are ones the history already shows them.
 */
export const findAuditPeople = async (
  db: Database,
  input: { email: string } | { ids: readonly string[] },
): Promise<AuditActor[]> => {
  const rows = await db
    .select({ id: coreUser.id, email: coreUser.email, roles: rolesHeldBy(sql`${coreUser.id}`) })
    .from(coreUser)
    .where('email' in input ? eq(coreUser.email, input.email) : inArray(coreUser.id, [...input.ids]))
    .orderBy(asc(coreUser.email))
    .limit(MAX_PEOPLE_FILTER)
  return rows.map((row) => ({ id: row.id, email: row.email, roles: row.roles ?? [] }))
}
