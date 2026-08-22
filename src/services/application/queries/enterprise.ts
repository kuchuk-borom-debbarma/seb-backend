/** Drizzle persistence for the canonical enterprise aggregate. */
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebEnterprise,
  sebEnterpriseVersion,
  sebFundingAward,
  sebFundingCase,
  sebFundingCaseVersion,
} from '../../../db/schema'
import { d1ChangedExactlyOne, sqlNullable, type AuditRecord } from '../support'
import type { Connection, Enterprise, EnterpriseProfileInput } from '../types'
import { encodeCursor } from '../pagination'

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
    .where(
      and(
        eq(sebEnterprise.portalOwnerUserId, input.userId),
        input.includeDeleted ? undefined : isNull(sebEnterprise.deletedAt),
        cursorPredicate,
      ),
    )
    .orderBy(asc(sebEnterprise.updatedAt), asc(sebEnterprise.id))
    .limit(input.first + 1)
  const hasNextPage = rows.length > input.first
  const selected = rows.slice(0, input.first)
  const last = selected.at(-1)?.head
  return {
    nodes: selected.map((row) => toEnterprise(row.head, row.version)),
    pageInfo: {
      hasNextPage,
      endCursor: last ? encodeCursor(last.updatedAt, last.id) : null,
    },
  }
}

export const insertEnterpriseAggregate = async (
  db: Database,
  input: {
    enterpriseId: string
    fundingCaseId: string
    userId: string
    profile: EnterpriseProfileInput
    status: 'PROPOSED' | 'ACTIVE'
    now: Date
    audit: AuditRecord
  },
): Promise<void> => {
  const enterpriseVersionId = crypto.randomUUID()
  const caseVersionId = crypto.randomUUID()
  await db.batch([
    db.insert(sebEnterprise).values({
      id: input.enterpriseId,
      portalOwnerUserId: input.userId,
      currentName: input.profile.name,
      registrationType: input.profile.registrationType,
      registrationNumber: input.profile.registrationNumber,
      gstin: input.profile.gstin,
      status: input.status,
      currentVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
    }),
    db.insert(sebEnterpriseVersion).values({
      id: enterpriseVersionId,
      enterpriseId: input.enterpriseId,
      version: 1,
      changeType: 'CREATED',
      changeReason: null,
      changedByUserId: input.userId,
      createdAt: input.now,
      ...input.profile,
      status: input.status,
    }),
    db.insert(sebFundingCase).values({
      id: input.fundingCaseId,
      enterpriseId: input.enterpriseId,
      status: 'OPEN',
      currentVersion: 1,
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
    }),
    db.insert(sebFundingCaseVersion).values({
      id: caseVersionId,
      fundingCaseId: input.fundingCaseId,
      version: 1,
      status: 'OPEN',
      changeType: 'CREATED',
      changeReason: null,
      changedByUserId: input.userId,
      createdAt: input.now,
    }),
    db.insert(coreAuditEvent).values(input.audit),
  ])
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
      ${input.userId}, ${input.now.getTime()}, ${input.profile.name},
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
        AND ${sebEnterprise.updatedAt} = ${input.now.getTime()}
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebEnterprise}
      WHERE ${sebEnterprise.id} = ${input.enterpriseId}
        AND ${sebEnterprise.currentVersion} = ${nextVersion}
        AND ${sebEnterprise.updatedAt} = ${input.now.getTime()}
    )
  `)
  const [result] = await db.batch([updated, version, audit])
  return d1ChangedExactlyOne(result)
}

export const enterpriseHasBlockingHistory = async (
  db: Database,
  userId: string,
  enterpriseId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: sebApplication.id })
    .from(sebApplication)
    .leftJoin(sebFundingAward, eq(sebFundingAward.applicationId, sebApplication.id))
    .where(
      and(
        eq(sebApplication.enterpriseId, enterpriseId),
        // Ownership belongs in this preflight read as well as the final write.
        // Otherwise different failure messages would reveal whether another
        // applicant's opaque enterprise ID has application or award history.
        eq(sebApplication.applicantUserId, userId),
        or(isNull(sebApplication.deletedAt), isNotNull(sebFundingAward.id)),
      ),
    )
    .limit(1)
  return row !== undefined
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
      ${input.now.getTime()}
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
  const [result] = await db.batch([claim, updateEnterprise, updateCase])
  return d1ChangedExactlyOne(result)
}
