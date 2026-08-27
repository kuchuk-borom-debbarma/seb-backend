/** Drizzle persistence for upload intents and immutable document versions. */
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { batch, changedExactlyOne, type Database, type Transaction } from '../../../db'
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
  /*
   * The stage this *document* belongs to, taken from its own FILE field.
   *
   * This asked whether a stage literally named `DOCUMENTS` was open, which was
   * the removed enum's last surviving assumption. `canEditDocument` in the
   * controller was corrected to read the field's own stage; this was not, so
   * for any cycle that names the stage anything else, every upload, replacement
   * and removal during a revision was refused with "The application or document
   * changed. Refresh it and try again." — advice that could never work.
   */
  stageKey: string,
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
            AND ${sebRevisionRequest.stageKey} = ${stageKey}
            AND ${sebRevisionRequest.resolvedAt} IS NULL
            AND ${sebRevisionRequest.cancelledAt} IS NULL
        )
      )
    )
)`

export const insertUploadIntent = async (
  db: Database,
  /** The intent row, and the stage its FILE question sits in. */
  input: typeof sebDocumentUploadIntent.$inferInsert & { stageKey: string },
  audit: AuditRecord,
): Promise<boolean> => {
  // The controller signs only after a friendly ownership/status check. This
  // guarded INSERT repeats that check at the database boundary so a concurrent
  // submission or document replacement cannot leave behind a usable intent.
  const insertIntent = db.insert(sebDocumentUploadIntent).select(sql`
    SELECT ${input.id}, ${input.applicationId}, ${input.applicantUserId},
      ${input.fieldKey}, ${input.expectedDocumentVersion}, ${input.objectKey},
      ${input.originalFilename}, ${input.contentType}, ${input.sizeBytes},
      ${input.checksumSha256}, 'ISSUED', NULL,
      ${sqlNullable(input.expiresAt)},
      ${sqlNullable(input.finalizedDocumentVersionId)},
      ${input.createdAt}, ${input.updatedAt}
    WHERE ${applicationDocumentsEditable(input.applicationId, input.applicantUserId, input.stageKey)}
      AND (
        (${input.expectedDocumentVersion} = 0 AND NOT EXISTS (
          SELECT 1 FROM ${sebApplicationDocument}
          WHERE ${sebApplicationDocument.applicationId} = ${input.applicationId}
            AND ${sebApplicationDocument.fieldKey} = ${input.fieldKey}
        ))
        OR EXISTS (
          SELECT 1 FROM ${sebApplicationDocument}
          WHERE ${sebApplicationDocument.applicationId} = ${input.applicationId}
            AND ${sebApplicationDocument.fieldKey} = ${input.fieldKey}
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
      ${sqlNullable(audit.metadataJson)}, ${audit.createdAt}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.id}
    )
  `)
  const [inserted] = await batch(db, (tx) => [
    insertIntent,
    insertAudit,
  ])
  return changedExactlyOne(inserted)
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

/** One document by the slot it fills, or by its own id. */
export const findApplicationDocument = async (
  db: Database,
  applicationId: string,
  fieldKey: DocumentType,
) => {
  const [record] = await db
    .select()
    .from(sebApplicationDocument)
    .where(
      and(
        eq(sebApplicationDocument.applicationId, applicationId),
        eq(sebApplicationDocument.fieldKey, fieldKey),
      ),
    )
    .limit(1)
  return record ?? null
}

export const findApplicationDocumentById = async (
  db: Database,
  applicationId: string,
  documentId: string,
) => {
  const [record] = await db
    .select()
    .from(sebApplicationDocument)
    .where(
      and(
        eq(sebApplicationDocument.applicationId, applicationId),
        eq(sebApplicationDocument.id, documentId),
      ),
    )
    .limit(1)
  return record ?? null
}

export const finalizeUploadIntent = async (
  db: Database,
  input: {
    /** The stage this document's FILE question sits in. */
    stageKey: string
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
    input.intent.fieldKey,
  )
  const newDocument = document === null
  /*
   * Both branches return the row they touched.
   *
   * They used to differ — an insert returning an id, an update returning only a
   * count — because the old driver reported both as arrays and the difference
   * did not show. It does now, and a single outcome check that means one thing
   * for a new document and another for a replacement is the kind of difference
   * that is only found by the case nobody tried.
   */
  const createOrAdvance = (tx: Transaction) => newDocument
    ? tx.insert(sebApplicationDocument).select(sql`
        SELECT ${input.documentId}, ${input.intent.applicationId},
          ${input.intent.fieldKey}, 1, ${input.now}, ${input.now},
          NULL, NULL, NULL
        WHERE EXISTS (
          SELECT 1 FROM ${sebDocumentUploadIntent}
          WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
            AND ${sebDocumentUploadIntent.status} = 'ISSUED'
            AND ${sebDocumentUploadIntent.expiresAt} > ${input.now}
        )
        AND ${applicationDocumentsEditable(input.intent.applicationId, input.userId, input.stageKey)}
      `).returning({ id: sebApplicationDocument.id })
    : tx
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
                AND ${sebDocumentUploadIntent.expiresAt} > ${input.now}
            )`,
            applicationDocumentsEditable(input.intent.applicationId, input.userId, input.stageKey),
          ),
        )
        .returning({ id: sebApplicationDocument.id })
  const insertVersion = (tx: Transaction) => tx.insert(sebApplicationDocumentVersion).select(sql`
    SELECT ${input.documentVersionId}, ${input.documentId}, ${input.nextVersion},
      ${newDocument ? 'UPLOAD' : 'REPLACE'}, ${input.intent.objectKey},
      ${input.intent.originalFilename}, ${input.intent.contentType},
      ${input.intent.sizeBytes}, ${input.intent.checksumSha256}, ${input.userId},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationDocument}
      WHERE ${sebApplicationDocument.id} = ${input.documentId}
        AND ${sebApplicationDocument.currentVersion} = ${input.nextVersion}
        AND ${sebApplicationDocument.updatedAt} = ${input.now}
    )
  `)
  const finalizeIntent = (tx: Transaction) => tx
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
  const pendingScan = (tx: Transaction) => tx.insert(sebApplicationDocumentScan).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.documentVersionId}, 1, 'PENDING',
      NULL, NULL, NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'FINALIZED'
    )
  `)
  const event = (tx: Transaction) => tx.insert(sebApplicationEvent).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.intent.applicationId}, 'DOCUMENT_FINALIZED',
      ${input.userId}, NULL, NULL, NULL, NULL, NULL, ${input.stageKey},
      'Application document updated.', NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'FINALIZED'
    )
  `)
  const audit = (tx: Transaction) => tx.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebDocumentUploadIntent}
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'FINALIZED'
    )
  `)
  const [changed] = await batch(db, (tx) => [
    createOrAdvance(tx),
    insertVersion(tx),
    finalizeIntent(tx),
    pendingScan(tx),
    event(tx),
    audit(tx),
  ])
  return changedExactlyOne(changed)
}

/**
 * Closes a claimed intent, as a statement rather than a call.
 *
 * Returned unexecuted so the cron can settle a whole batch of them in one
 * statement. Each keeps the full predicate — still `CLEANUP_PENDING`, still
 * aimed at the same terminal status — so a row that changed underneath is left
 * alone rather than forced.
 */
export const closeUploadIntentStatement = (
  db: Database | Transaction,
  uploadId: string,
  target: 'REJECTED' | 'EXPIRED',
  now: Date,
) =>
  db
    .update(sebDocumentUploadIntent)
    .set({ status: target, cleanupTargetStatus: null, updatedAt: now })
    .where(
      and(
        eq(sebDocumentUploadIntent.id, uploadId),
        eq(sebDocumentUploadIntent.status, 'CLEANUP_PENDING'),
        eq(sebDocumentUploadIntent.cleanupTargetStatus, target),
      ),
    )

export const markUploadIntentRejected = async (
  db: Database,
  uploadId: string,
  now: Date,
): Promise<void> => {
  await closeUploadIntentStatement(db, uploadId, 'REJECTED', now)
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
  return result.rowCount === 1
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
    /** The stage this document's FILE question sits in. */
    stageKey: string
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
  const audit = (tx: Transaction) => tx.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${sqlNullable(input.audit.requestId)}, ${sqlNullable(input.audit.ipAddress)},
      ${sqlNullable(input.audit.userAgent)}, NULL, ${sqlNullable(input.audit.metadataJson)},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebApplicationDocument}
      WHERE ${sebApplicationDocument.id} = ${input.documentId}
        AND ${sebApplicationDocument.applicationId} = ${input.applicationId}
        AND ${sebApplicationDocument.currentVersion} = ${input.expectedVersion}
        AND ${input.deleted
          ? sql`${sebApplicationDocument.deletedAt} IS NULL`
          : sql`${sebApplicationDocument.deletedAt} IS NOT NULL`}
        AND ${applicationDocumentsEditable(input.applicationId, input.userId, input.stageKey)}
    )
  `)
  const update = (tx: Transaction) => tx
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
        applicationDocumentsEditable(input.applicationId, input.userId, input.stageKey),
        sql`EXISTS (
          SELECT 1 FROM ${coreAuditEvent}
          WHERE ${coreAuditEvent.id} = ${input.audit.id}
        )`,
      ),
    )
  const event = (tx: Transaction) => tx.insert(sebApplicationEvent).select(sql`
    SELECT ${crypto.randomUUID()}, ${input.applicationId},
      ${input.deleted ? 'DOCUMENT_DELETED' : 'DOCUMENT_RESTORED'}, ${input.userId},
      NULL, NULL, NULL, NULL, NULL, ${input.stageKey},
      ${input.deleted ? 'Application document removed.' : 'Application document restored.'},
      NULL, ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${coreAuditEvent}
      WHERE ${coreAuditEvent.id} = ${input.audit.id}
    )
  `)
  const [changed] = await batch(db, (tx) => [audit(tx), update(tx), event(tx)])
  return changedExactlyOne(changed)
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
  /*
   * Each candidate keeps its own guarded UPDATE — the predicate repeats the
   * lifecycle terms so a row another runner already claimed is not claimed
   * twice — but they go as one statement rather than fifty.
   *
   * These are single-row writes, which is the shape batching helps: the cost
   * is the call, not the result. A batch of large collection reads is the
   * opposite and is measured in `test/batching.test.ts`.
   */
  const intended = candidates.map((candidate) => ({
    id: candidate.id,
    objectKey: candidate.objectKey,
    // The lifecycle CHECK guarantees a pending row has a target. The cast
    // narrows Drizzle's nullable select type after the SQL predicate above.
    cleanupTargetStatus: candidate.status === 'ISSUED'
      ? ('EXPIRED' as const)
      : (candidate.cleanupTargetStatus as 'REJECTED' | 'EXPIRED'),
  }))
  // `db.batch` refuses an empty list, and an idle cron run is the common case.
  if (intended.length === 0) return []

  const results = await batch(db, (tx) =>
    intended.map((candidate) =>
      tx
        .update(sebDocumentUploadIntent)
        .set({
          status: 'CLEANUP_PENDING',
          cleanupTargetStatus: candidate.cleanupTargetStatus,
          updatedAt: now,
        })
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
                eq(
                  sebDocumentUploadIntent.cleanupTargetStatus,
                  candidate.cleanupTargetStatus,
                ),
              ),
            ),
          ),
        ),
    ),
  )

  const claimed: typeof intended = []
  // Results come back in the order the statements were given, so each one
  // answers for the candidate at the same index.
  intended.forEach((candidate, index) => {
    appendWhenChanged(claimed, candidate, results[index] as never)
  })
  return claimed
}

export const markUploadIntentExpired = async (
  db: Database,
  id: string,
  now: Date,
): Promise<void> => {
  await closeUploadIntentStatement(db, id, 'EXPIRED', now)
}

