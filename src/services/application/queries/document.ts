/** Drizzle persistence for upload intents and immutable document versions. */
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  coreAuditEvent,
  sebApplication,
  sebApplicationDocument,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
  sebApplicationEvent,
  sebRevisionRequest,
  sebDocumentUploadIntent,
} from '../../../db/schema'
import {
  appendWhenChanged,
  d1ChangedExactlyOne,
  sqlDateMilliseconds,
  sqlNullable,
  type AuditRecord,
} from '../support'
import type { DocumentType } from '../types'

export type UploadIntentRecord = typeof sebDocumentUploadIntent.$inferSelect

/**
 * Rechecks document editability inside the write transaction. Controller
 * checks produce friendly failures; this predicate closes submit/finalize and
 * submit/delete races after those checks have completed.
 */
const applicationDocumentsEditable = (
  applicationId: string,
  userId: string,
) => sql`EXISTS (
  SELECT 1 FROM ${sebApplication}
  WHERE ${sebApplication.id} = ${applicationId}
    AND ${sebApplication.applicantUserId} = ${userId}
    AND ${sebApplication.deletedAt} IS NULL
    AND (
      ${sebApplication.status} = 'DRAFT'
      OR (
        ${sebApplication.status} = 'REVISION_REQUIRED'
        AND EXISTS (
          SELECT 1 FROM ${sebRevisionRequest}
          WHERE ${sebRevisionRequest.applicationId} = ${applicationId}
            AND ${sebRevisionRequest.section} = 'DOCUMENTS'
            AND ${sebRevisionRequest.resolvedAt} IS NULL
            AND ${sebRevisionRequest.cancelledAt} IS NULL
        )
      )
    )
)`

export const insertUploadIntent = async (
  db: Database,
  input: typeof sebDocumentUploadIntent.$inferInsert,
  audit: AuditRecord,
): Promise<boolean> => {
  // The controller signs only after a friendly ownership/status check. This
  // guarded INSERT repeats that check at the database boundary so a concurrent
  // submission or document replacement cannot leave behind a usable intent.
  const insertIntent = db.insert(sebDocumentUploadIntent).select(sql`
    SELECT ${input.id}, ${input.applicationId}, ${input.applicantUserId},
      ${input.documentType}, ${input.expectedDocumentVersion}, ${input.objectKey},
      ${input.originalFilename}, ${input.contentType}, ${input.sizeBytes},
      ${input.checksumSha256}, 'ISSUED', NULL,
      ${sqlDateMilliseconds(input.expiresAt)},
      ${sqlNullable(input.finalizedDocumentVersionId)},
      ${sqlDateMilliseconds(input.createdAt)}, ${sqlDateMilliseconds(input.updatedAt)}
    WHERE ${applicationDocumentsEditable(input.applicationId, input.applicantUserId)}
      AND (
        (${input.expectedDocumentVersion} = 0 AND NOT EXISTS (
          SELECT 1 FROM ${sebApplicationDocument}
          WHERE ${sebApplicationDocument.applicationId} = ${input.applicationId}
            AND ${sebApplicationDocument.documentType} = ${input.documentType}
        ))
        OR EXISTS (
          SELECT 1 FROM ${sebApplicationDocument}
          WHERE ${sebApplicationDocument.applicationId} = ${input.applicationId}
            AND ${sebApplicationDocument.documentType} = ${input.documentType}
            AND ${sebApplicationDocument.currentVersion} = ${input.expectedDocumentVersion}
            AND ${sebApplicationDocument.deletedAt} IS NULL
        )
      )
  `).returning({ id: sebDocumentUploadIntent.id })
  const insertAudit = db.insert(coreAuditEvent).select(sql`
    SELECT ${audit.id}, ${sqlNullable(audit.actorUserId)}, ${audit.action},
      ${audit.entityType}, ${audit.entityId}, ${audit.outcome},
      ${sqlNullable(audit.requestId)}, ${sqlNullable(audit.ipAddress)},
      ${sqlNullable(audit.userAgent)}, ${sqlNullable(audit.changesJson)},
      ${sqlNullable(audit.metadataJson)}, ${sqlDateMilliseconds(audit.createdAt)}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.id}
    )
  `)
  const [inserted] = await db.batch([
    insertIntent,
    insertAudit,
  ])
  return d1ChangedExactlyOne(inserted)
}

export const findOwnedUploadIntent = async (
  db: Database,
  userId: string,
  uploadId: string,
): Promise<UploadIntentRecord | null> => {
  const [record] = await db
    .select()
    .from(sebDocumentUploadIntent)
    .where(
      and(
        eq(sebDocumentUploadIntent.id, uploadId),
        eq(sebDocumentUploadIntent.applicantUserId, userId),
      ),
    )
    .limit(1)
  return record ?? null
}

export const findApplicationDocument = async (
  db: Database,
  applicationId: string,
  documentType: DocumentType,
) => {
  const [record] = await db
    .select()
    .from(sebApplicationDocument)
    .where(
      and(
        eq(sebApplicationDocument.applicationId, applicationId),
        eq(sebApplicationDocument.documentType, documentType),
      ),
    )
    .limit(1)
  return record ?? null
}

export const finalizeUploadIntent = async (
  db: Database,
  input: {
    intent: UploadIntentRecord
    documentId: string
    documentVersionId: string
    nextVersion: number
    userId: string
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const document = await findApplicationDocument(
    db,
    input.intent.applicationId,
    input.intent.documentType,
  )
  const newDocument = document === null
  const createOrAdvance = newDocument
    ? db.insert(sebApplicationDocument).select(sql`
        SELECT ${input.documentId}, ${input.intent.applicationId},
          ${input.intent.documentType}, 1, ${input.now.getTime()}, ${input.now.getTime()},
          NULL, NULL, NULL
        WHERE EXISTS (
          SELECT 1 FROM ${sebDocumentUploadIntent}
          WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
            AND ${sebDocumentUploadIntent.status} = 'ISSUED'
            AND ${sebDocumentUploadIntent.expiresAt} > ${input.now.getTime()}
        )
        AND ${applicationDocumentsEditable(input.intent.applicationId, input.userId)}
      `).returning({ id: sebApplicationDocument.id })
    : db
        .update(sebApplicationDocument)
        .set({ currentVersion: input.nextVersion, updatedAt: input.now })
        .where(
          and(
            eq(sebApplicationDocument.id, document.id),
            eq(sebApplicationDocument.currentVersion, input.intent.expectedDocumentVersion),
            isNull(sebApplicationDocument.deletedAt),
            sql`EXISTS (
              SELECT 1 FROM ${sebDocumentUploadIntent}
              WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
                AND ${sebDocumentUploadIntent.status} = 'ISSUED'
                AND ${sebDocumentUploadIntent.expiresAt} > ${input.now.getTime()}
            )`,
            applicationDocumentsEditable(input.intent.applicationId, input.userId),
          ),
        )
  const insertVersion = db.insert(sebApplicationDocumentVersion).select(sql`
    SELECT ${input.documentVersionId}, ${input.documentId}, ${input.nextVersion},
      ${newDocument ? 'UPLOAD' : 'REPLACE'}, ${input.intent.objectKey},
      ${input.intent.originalFilename}, ${input.intent.contentType},
      ${input.intent.sizeBytes}, ${input.intent.checksumSha256}, ${input.userId},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationDocument}
      WHERE ${sebApplicationDocument.id} = ${input.documentId}
        AND ${sebApplicationDocument.currentVersion} = ${input.nextVersion}
        AND ${sebApplicationDocument.updatedAt} = ${input.now.getTime()}
    )
  `)
  const finalizeIntent = db
    .update(sebDocumentUploadIntent)
    .set({
      status: 'FINALIZED',
      finalizedDocumentVersionId: input.documentVersionId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebDocumentUploadIntent.id, input.intent.id),
        eq(sebDocumentUploadIntent.status, 'ISSUED'),
        sql`EXISTS (
          SELECT 1 FROM ${sebApplicationDocumentVersion}
          WHERE ${sebApplicationDocumentVersion.id} = ${input.documentVersionId}
        )`,
      ),
    )
  // Finalization never makes a file staff-readable. It merely queues the
  // immutable object for the future malware scanner; administrative download
  // authorization fails closed until an ACCEPTED result is appended.
  const pendingScan = db.insert(sebApplicationDocumentScan).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.documentVersionId}, 1, 'PENDING',
      NULL, NULL, NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'FINALIZED'
    )
  `)
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.intent.applicationId}, 'DOCUMENT_FINALIZED',
      ${input.userId}, NULL, NULL, NULL, NULL, NULL, 'DOCUMENTS',
      'Application document updated.', NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'FINALIZED'
    )
  `)
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'FINALIZED'
    )
  `)
  const [changed] = await db.batch([
    createOrAdvance,
    insertVersion,
    finalizeIntent,
    pendingScan,
    event,
    audit,
  ])
  return d1ChangedExactlyOne(changed)
}

export const markUploadIntentRejected = async (
  db: Database,
  uploadId: string,
  now: Date,
): Promise<void> => {
  await db
    .update(sebDocumentUploadIntent)
    .set({ status: 'REJECTED', cleanupTargetStatus: null, updatedAt: now })
    .where(
      and(
        eq(sebDocumentUploadIntent.id, uploadId),
        eq(sebDocumentUploadIntent.status, 'CLEANUP_PENDING'),
        eq(sebDocumentUploadIntent.cleanupTargetStatus, 'REJECTED'),
      ),
    )
}

/**
 * Claims one upload before deleting its object. Finalization only accepts
 * `ISSUED`, so changing the state first closes the finalization/cleanup race.
 * If R2 deletion fails, cron can safely retry every `CLEANUP_PENDING` row.
 */
export const claimUploadIntentForCleanup = async (
  db: Database,
  uploadId: string,
  now: Date,
  targetStatus: 'REJECTED' | 'EXPIRED',
): Promise<boolean> => {
  const result = await db
    .update(sebDocumentUploadIntent)
    .set({ status: 'CLEANUP_PENDING', cleanupTargetStatus: targetStatus, updatedAt: now })
    .where(
      and(
        eq(sebDocumentUploadIntent.id, uploadId),
        eq(sebDocumentUploadIntent.status, 'ISSUED'),
      ),
    )
  return d1ChangedExactlyOne(result)
}

export const findOwnedDocumentVersion = async (
  db: Database,
  userId: string,
  documentId: string,
) => {
  const [record] = await db
    .select({ head: sebApplicationDocument, version: sebApplicationDocumentVersion })
    .from(sebApplicationDocument)
    .innerJoin(
      sebApplication,
      and(
        eq(sebApplication.id, sebApplicationDocument.applicationId),
        eq(sebApplication.applicantUserId, userId),
      ),
    )
    .innerJoin(
      sebApplicationDocumentVersion,
      and(
        eq(sebApplicationDocumentVersion.documentId, sebApplicationDocument.id),
        eq(sebApplicationDocumentVersion.version, sebApplicationDocument.currentVersion),
      ),
    )
    .where(
      and(
        eq(sebApplicationDocument.id, documentId),
        isNull(sebApplicationDocument.deletedAt),
      ),
    )
    .limit(1)
  return record ?? null
}

export const setDocumentDeleted = async (
  db: Database,
  input: {
    applicationId: string
    documentId: string
    expectedVersion: number
    userId: string
    deleted: boolean
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  // The append-only audit ID doubles as an operation claim. Every later
  // statement in the batch checks this exact ID, so two transitions occurring
  // in the same millisecond cannot attribute events to the wrong request.
  const audit = db.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationDocument}
      WHERE ${sebApplicationDocument.id} = ${input.documentId}
        AND ${sebApplicationDocument.applicationId} = ${input.applicationId}
        AND ${sebApplicationDocument.currentVersion} = ${input.expectedVersion}
        AND ${input.deleted
          ? sql`${sebApplicationDocument.deletedAt} IS NULL`
          : sql`${sebApplicationDocument.deletedAt} IS NOT NULL`}
        AND ${applicationDocumentsEditable(input.applicationId, input.userId)}
    )
  `)
  const update = db
    .update(sebApplicationDocument)
    .set(
      input.deleted
        ? {
            deletedAt: input.now,
            deletedByUserId: input.userId,
            deleteReason: 'REMOVED_BY_APPLICANT',
            updatedAt: input.now,
          }
        : {
            deletedAt: null,
            deletedByUserId: null,
            deleteReason: null,
            updatedAt: input.now,
          },
    )
    .where(
      and(
        eq(sebApplicationDocument.id, input.documentId),
        eq(sebApplicationDocument.applicationId, input.applicationId),
        eq(sebApplicationDocument.currentVersion, input.expectedVersion),
        input.deleted
          ? isNull(sebApplicationDocument.deletedAt)
          : isNotNull(sebApplicationDocument.deletedAt),
        applicationDocumentsEditable(input.applicationId, input.userId),
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const event = db.insert(sebApplicationEvent).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.applicationId},
      ${input.deleted ? 'DOCUMENT_DELETED' : 'DOCUMENT_RESTORED'}, ${input.userId},
      NULL, NULL, NULL, NULL, NULL, 'DOCUMENTS',
      ${input.deleted ? 'Application document removed.' : 'Application document restored.'},
      NULL, ${input.now.getTime()}
    WHERE EXISTS (
      SELECT 1 FROM ${coreAuditEvent}
      WHERE ${coreAuditEvent.id} = ${input.audit.id}
    )
  `)
  const [changed] = await db.batch([audit, update, event])
  return d1ChangedExactlyOne(changed)
}

export const claimExpiredUploadIntents = async (
  db: Database,
  now: Date,
  limit: number,
): Promise<Array<{
  id: string
  objectKey: string
  cleanupTargetStatus: 'REJECTED' | 'EXPIRED'
}>> => {
  const candidates = await db
    .select({
      id: sebDocumentUploadIntent.id,
      objectKey: sebDocumentUploadIntent.objectKey,
      status: sebDocumentUploadIntent.status,
      cleanupTargetStatus: sebDocumentUploadIntent.cleanupTargetStatus,
    })
    .from(sebDocumentUploadIntent)
    .where(
      or(
        and(
          eq(sebDocumentUploadIntent.status, 'ISSUED'),
          lte(sebDocumentUploadIntent.expiresAt, now),
        ),
        and(
          eq(sebDocumentUploadIntent.status, 'CLEANUP_PENDING'),
          isNotNull(sebDocumentUploadIntent.cleanupTargetStatus),
        ),
      ),
    )
    .limit(limit)
  const claimed: Array<{
    id: string
    objectKey: string
    cleanupTargetStatus: 'REJECTED' | 'EXPIRED'
  }> = []
  for (const candidate of candidates) {
    // The lifecycle CHECK guarantees a pending row has a target. The cast
    // narrows Drizzle's nullable select type after the SQL predicate above.
    const cleanupTargetStatus = candidate.status === 'ISSUED'
      ? 'EXPIRED' as const
      : candidate.cleanupTargetStatus as 'REJECTED' | 'EXPIRED'
    const result = await db
      .update(sebDocumentUploadIntent)
      .set({ status: 'CLEANUP_PENDING', cleanupTargetStatus, updatedAt: now })
      .where(
        and(
          eq(sebDocumentUploadIntent.id, candidate.id),
          or(
            and(
              eq(sebDocumentUploadIntent.status, 'ISSUED'),
              lte(sebDocumentUploadIntent.expiresAt, now),
            ),
            and(
              eq(sebDocumentUploadIntent.status, 'CLEANUP_PENDING'),
              eq(sebDocumentUploadIntent.cleanupTargetStatus, cleanupTargetStatus),
            ),
          ),
        ),
      )
    appendWhenChanged(
      claimed,
      { id: candidate.id, objectKey: candidate.objectKey, cleanupTargetStatus },
      result,
    )
  }
  return claimed
}

export const markUploadIntentExpired = async (
  db: Database,
  id: string,
  now: Date,
): Promise<void> => {
  await db
    .update(sebDocumentUploadIntent)
    .set({ status: 'EXPIRED', cleanupTargetStatus: null, updatedAt: now })
    .where(
      and(
        eq(sebDocumentUploadIntent.id, id),
        eq(sebDocumentUploadIntent.status, 'CLEANUP_PENDING'),
        eq(sebDocumentUploadIntent.cleanupTargetStatus, 'EXPIRED'),
      ),
    )
}
