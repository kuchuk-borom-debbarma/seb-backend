/** Drizzle persistence for the canonical enterprise aggregate. */
import { and, asc, count, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { COUNT_MISSING, requireInvariant } from '../support'
import { batch, changedExactlyOne, type Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebEnterprise,
  sebEnterpriseVersion,
  sebFundingAward,
  sebFundingCase,
  sebFundingCaseVersion,
} from '../../../db/schema'
import { sqlNullable, type AuditRecord } from '../support'
import type {
  BusinessSector,
  Connection,
  Enterprise,
  EnterpriseDeletionBlocker,
  EnterpriseProfileInput,
  EnterpriseStatus,
} from '../types'
import { encodeCursor } from '../pagination'
import { prefixMatch, prefixPattern } from '../../search'

type EnterpriseRecord = typeof sebEnterprise.$inferSelect

const toEnterprise = (
  head: EnterpriseRecord,
  version: typeof sebEnterpriseVersion.$inferSelect,
): Enterprise => ({
  id: head.id,
  name: version.name,
  establishmentDate: version.establishmentDate,
  registrationType: version.registrationType,
  registrationNumber: version.registrationNumber,
  gstin: version.gstin,
  businessSector: version.businessSector,
  otherBusinessSector: version.otherBusinessSector,
  businessBlockOrVillage: version.businessBlockOrVillage,
  businessDistrict: version.businessDistrict,
  businessPinCode: version.businessPinCode,
  contactNumber: version.contactNumber,
  contactEmail: version.contactEmail,
  status: head.status,
  currentVersion: head.currentVersion,
  createdAt: head.createdAt,
  updatedAt: head.updatedAt,
  deletedAt: head.deletedAt,
})

export const findOwnedEnterprise = async (
  db: Database,
  userId: string,
  enterpriseId: string,
  includeDeleted = false,
): Promise<Enterprise | null> => {
  const [row] = await db
    .select({ head: sebEnterprise, version: sebEnterpriseVersion })
    .from(sebEnterprise)
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .where(
      and(
        eq(sebEnterprise.id, enterpriseId),
        eq(sebEnterprise.portalOwnerUserId, userId),
        includeDeleted ? undefined : isNull(sebEnterprise.deletedAt),
      ),
    )
    .limit(1)
  return row ? toEnterprise(row.head, row.version) : null
}

export const listOwnedEnterprises = async (
  db: Database,
  input: {
    userId: string
    first: number
    cursor: { timestamp: Date; id: string } | null
    includeDeleted: boolean
    search?: string | null
    status?: EnterpriseStatus | null
    sector?: BusinessSector | null
  },
): Promise<Connection<Enterprise>> => {
  const cursorPredicate = input.cursor
    ? or(
        gt(sebEnterprise.updatedAt, input.cursor.timestamp),
        and(
          eq(sebEnterprise.updatedAt, input.cursor.timestamp),
          gt(sebEnterprise.id, input.cursor.id),
        ),
      )
    : undefined
  /*
   * Everything the filters say, without the cursor. The page seeks from a
   * position; the total counts the whole matching set, so it must not carry
   * the position with it.
   */
  const pattern = prefixPattern(input.search)
  const filters = and(
    eq(sebEnterprise.portalOwnerUserId, input.userId),
    input.includeDeleted ? undefined : isNull(sebEnterprise.deletedAt),
    input.status ? eq(sebEnterprise.status, input.status) : undefined,
    input.sector ? eq(sebEnterpriseVersion.businessSector, input.sector) : undefined,
    pattern ? prefixMatch(sebEnterprise.currentName, pattern) : undefined,
  )
  const rows = await db
    .select({ head: sebEnterprise, version: sebEnterpriseVersion })
    .from(sebEnterprise)
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .where(and(filters, cursorPredicate))
    .orderBy(asc(sebEnterprise.updatedAt), asc(sebEnterprise.id))
    .limit(input.first + 1)
  const hasNextPage = rows.length > input.first
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)?.head
  const [total] = await db
    .select({ value: count() })
    .from(sebEnterprise)
    .innerJoin(
      sebEnterpriseVersion,
      and(
        eq(sebEnterpriseVersion.enterpriseId, sebEnterprise.id),
        eq(sebEnterpriseVersion.version, sebEnterprise.currentVersion),
      ),
    )
    .where(filters)
  return {
    nodes: selected.map((row) => toEnterprise(row.head, row.version)),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor('updatedAt', last.updatedAt, last.id) : null,
      totalCount: requireInvariant(total, COUNT_MISSING).value,
    },
  }
}

/**
 * Registers an enterprise, its funding case, and the first version of each.
 *
 * **The cap is a term in the insert, not only a check before it.** The
 * controller counts first so it can say how many are allowed and what to do
 * about it; without the predicate here, two requests arriving together would
 * both read "four of five" and both succeed. Everything else in the transition
 * depends on this row existing, so a losing writer writes nothing at all.
 */
/**
 * How many live enterprises this applicant holds, and whether the name is taken.
 *
 * One read for both, because the controller needs both before it can say
 * anything useful and two reads would be two round trips for one decision.
 *
 * The name comparison is `lower(current_name)`, which is exactly the expression
 * the partial unique index is built on — see `comparableEnterpriseName`. A
 * friendly check that normalised differently from the constraint would refuse a
 * name the database would have accepted, or accept one it then rejects as "the
 * record changed".
 */
export const countOwnedEnterprises = async (
  db: Database,
  userId: string,
  comparableName: string,
): Promise<{ held: number; nameTaken: boolean }> => {
  const [row] = await db
    .select({
      held: count(),
      nameTaken: sql<number>`
        count(*) FILTER (WHERE lower(${sebEnterprise.currentName}) = ${comparableName})
      `.mapWith(Number),
    })
    .from(sebEnterprise)
    .where(
      and(
        eq(sebEnterprise.portalOwnerUserId, userId),
        isNull(sebEnterprise.deletedAt),
      ),
    )
  const found = requireInvariant(row, COUNT_MISSING)
  return { held: found.held, nameTaken: found.nameTaken > 0 }
}

export const insertEnterpriseAggregate = async (
  db: Database,
  input: {
    enterpriseId: string
    fundingCaseId: string
    userId: string
    profile: EnterpriseProfileInput
    status: 'PROPOSED' | 'ACTIVE'
    /** How many this deployment allows one applicant, from `maxEnterprisesPerUser`. */
    limit: number
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const enterpriseVersionId = crypto.randomUUID()
  const caseVersionId = crypto.randomUUID()
  /*
   * Soft-deleted enterprises do not count.
   *
   * Deliberate, and it means delete-then-create-then-restore can exceed the
   * cap by one. The alternative is worse: counting them would leave somebody at
   * the limit with no way to reach it except by deleting a record the programme
   * keeps on purpose, and a restore is refused for other reasons long before
   * this becomes a way to hold dozens.
   */
  const withinLimit = sql`(
    SELECT count(*) FROM ${sebEnterprise}
    WHERE ${sebEnterprise.portalOwnerUserId} = ${input.userId}
      AND ${sebEnterprise.deletedAt} IS NULL
  ) < ${input.limit}`
  const head = db.insert(sebEnterprise).select(sql`
    SELECT ${input.enterpriseId}, ${input.userId}, ${input.profile.name},
      ${input.profile.registrationType}, ${sqlNullable(input.profile.registrationNumber)},
      ${sqlNullable(input.profile.gstin)}, ${input.status}, 1,
      ${input.now}, ${input.now}, NULL, NULL, NULL
    WHERE ${withinLimit}
  `).returning({ id: sebEnterprise.id })
  const exists = sql`EXISTS (
    SELECT 1 FROM ${sebEnterprise} WHERE ${sebEnterprise.id} = ${input.enterpriseId}
  )`
  const [created] = await batch(db, (tx) => [
    head,
    tx
      .insert(sebEnterpriseVersion)
      .values({
        id: enterpriseVersionId,
        enterpriseId: input.enterpriseId,
        version: 1,
        changeType: 'CREATED',
        changeReason: null,
        changedByUserId: input.userId,
        createdAt: input.now,
        ...input.profile,
        status: input.status,
      })
      /*
       * A foreign key would refuse these anyway once the head is absent, but a
       * refusal is an exception the caller has to classify. Selecting on the
       * head instead makes a losing writer write nothing and say so.
       */
      .onConflictDoNothing(),
    tx.insert(sebFundingCase).select(sql`
      SELECT ${input.fundingCaseId}, ${input.enterpriseId}, 'OPEN', 1,
        ${input.now}, ${input.now}, NULL, NULL, NULL
      WHERE ${exists}
    `),
    tx.insert(sebFundingCaseVersion).select(sql`
      SELECT ${caseVersionId}, ${input.fundingCaseId}, 1, 'OPEN', 'CREATED', NULL,
        ${input.userId}, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebFundingCase}
        WHERE ${sebFundingCase.id} = ${input.fundingCaseId}
      )
    `),
    tx.insert(coreAuditEvent).select(sql`
      SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
        ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
        ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
        ${sqlNullable(input.audit.userAgent)}, NULL,
        ${sqlNullable(input.audit.metadataJson)}, ${input.now}
      WHERE ${exists}
    `),
  ])
  return changedExactlyOne(created)
}

export const updateEnterpriseAggregate = async (
  db: Database,
  input: {
    enterpriseId: string
    userId: string
    expectedVersion: number
    profile: EnterpriseProfileInput
    status: 'PROPOSED' | 'ACTIVE'
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const nextVersion = input.expectedVersion + 1
  const updated = db
    .update(sebEnterprise)
    .set({
      currentName: input.profile.name,
      registrationType: input.profile.registrationType,
      registrationNumber: input.profile.registrationNumber,
      gstin: input.profile.gstin,
      status: input.status,
      currentVersion: nextVersion,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebEnterprise.id, input.enterpriseId),
        eq(sebEnterprise.portalOwnerUserId, input.userId),
        eq(sebEnterprise.currentVersion, input.expectedVersion),
        isNull(sebEnterprise.deletedAt),
      ),
    )
  const version = db.insert(sebEnterpriseVersion).select(sql`
    SELECT
      ${crypto.randomUUID()}, ${input.enterpriseId}, ${nextVersion}, 'UPDATED', NULL,
      ${input.userId}, ${input.now}, ${input.profile.name},
      ${input.profile.establishmentDate}, ${input.profile.registrationType},
      ${input.profile.registrationNumber}, ${input.profile.gstin},
      ${input.profile.businessSector}, ${input.profile.otherBusinessSector},
      ${input.profile.businessBlockOrVillage}, ${input.profile.businessDistrict},
      ${input.profile.businessPinCode}, ${input.profile.contactNumber},
      ${input.profile.contactEmail}, ${input.status}
    WHERE EXISTS (
      SELECT 1 FROM ${sebEnterprise}
      WHERE ${sebEnterprise.id} = ${input.enterpriseId}
        AND ${sebEnterprise.portalOwnerUserId} = ${input.userId}
        AND ${sebEnterprise.currentVersion} = ${nextVersion}
        AND ${sebEnterprise.updatedAt} = ${input.now}
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebEnterprise}
      WHERE ${sebEnterprise.id} = ${input.enterpriseId}
        AND ${sebEnterprise.currentVersion} = ${nextVersion}
        AND ${sebEnterprise.updatedAt} = ${input.now}
    )
  `)
  const [result] = await batch(db, (tx) => [updated, version, audit])
  return result.rowCount === 1
}

/**
 * Names the exact applications that prevent an enterprise from being deleted.
 *
 * Returning the list rather than a bare boolean is what lets the refusal say
 * "these two applications" instead of leaving the applicant to guess which of
 * their drafts to remove first.
 *
 * Ownership scoping belongs in this read as well as in the final write.
 * Without it the richer response would reveal whether another applicant's
 * opaque enterprise ID has application or award history.
 */
export const listEnterpriseDeletionBlockers = async (
  db: Database,
  userId: string,
  enterpriseId: string,
): Promise<EnterpriseDeletionBlocker[]> => {
  const rows = await db
    .select({
      applicationId: sebApplication.id,
      referenceNumber: sebApplication.referenceNumber,
      status: sebApplication.status,
      awardId: sebFundingAward.id,
    })
    .from(sebApplication)
    .leftJoin(sebFundingAward, eq(sebFundingAward.applicationId, sebApplication.id))
    .where(
      and(
        eq(sebApplication.enterpriseId, enterpriseId),
        eq(sebApplication.applicantUserId, userId),
        // A live application blocks deletion. So does a deleted one that still
        // has an award, because the award has to keep its enterprise.
        or(isNull(sebApplication.deletedAt), isNotNull(sebFundingAward.id)),
      ),
    )
    .orderBy(asc(sebApplication.phaseNumber), asc(sebApplication.createdAt))
  return rows.map((row) => ({
    applicationId: row.applicationId,
    referenceNumber: row.referenceNumber,
    status: row.status,
    hasAward: row.awardId !== null,
  }))
}

export const setEnterpriseDeleted = async (
  db: Database,
  input: {
    enterpriseId: string
    userId: string
    expectedVersion: number
    deleted: boolean
    reason: string | null
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  // Repeat the lifecycle guard in the update itself. Without this predicate an
  // application could start after the controller's pre-check but before this
  // batch, leaving a soft-deleted enterprise with active business history.
  const deletionStillAllowed = input.deleted
    ? sql`NOT EXISTS (
        SELECT 1
        FROM ${sebApplication}
        LEFT JOIN ${sebFundingAward}
          ON ${sebFundingAward.applicationId} = ${sebApplication.id}
        WHERE ${sebApplication.enterpriseId} = ${input.enterpriseId}
          AND (
            ${sebApplication.deletedAt} IS NULL
            OR ${sebFundingAward.id} IS NOT NULL
          )
      )`
    : undefined
  const statePredicate = input.deleted
    ? isNull(sebEnterprise.deletedAt)
    : isNotNull(sebEnterprise.deletedAt)
  const deletedValues = input.deleted
    ? {
        deletedAt: input.now,
        deletedByUserId: input.userId,
        deleteReason: input.reason,
      }
    : { deletedAt: null, deletedByUserId: null, deleteReason: null }
  // The audit row is also a unique, per-operation claim. Statements later in
  // the D1 batch depend on this exact ID, rather than a millisecond timestamp
  // that a second request could accidentally share with the winning request.
  const claim = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebEnterprise}
      WHERE ${sebEnterprise.id} = ${input.enterpriseId}
        AND ${sebEnterprise.portalOwnerUserId} = ${input.userId}
        AND ${sebEnterprise.currentVersion} = ${input.expectedVersion}
        AND ${statePredicate}
        AND ${deletionStillAllowed ?? sql`1 = 1`}
    )
  `)
  const updateEnterprise = db
    .update(sebEnterprise)
    .set({ ...deletedValues, updatedAt: input.now })
    .where(
      and(
        eq(sebEnterprise.id, input.enterpriseId),
        eq(sebEnterprise.portalOwnerUserId, input.userId),
        eq(sebEnterprise.currentVersion, input.expectedVersion),
        statePredicate,
        deletionStillAllowed,
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const updateCase = db
    .update(sebFundingCase)
    .set({ ...deletedValues, updatedAt: input.now })
    .where(
      and(
        eq(sebFundingCase.enterpriseId, input.enterpriseId),
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const [result] = await batch(db, (tx) => [claim, updateEnterprise, updateCase])
  return result.rowCount === 1
}
