/** Drizzle persistence for upload intents and immutable document versions. */
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { batch, writeFolded, type Database, type Transaction } from '../../../db'
import {
  sebApplication,
  sebApplicationDocument,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
  sebApplicationVersion,
  sebRevisionRequest,
  sebDocumentUploadIntent,
} from '../../../db/schema'
import { auditEventCteMember } from '../../audit-event'
import { applicationEventMember, eventValues } from './application'
import {
  appendWhenChanged,
  sqlNullable,
  type AuditRecord,
} from '../support'

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
        ${sebApplication.status} = 'IN_PIPELINE'
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

export type DocumentHead = Pick<
  typeof sebApplicationDocument.$inferSelect,
  'id' | 'fieldKey' | 'currentVersion' | 'deletedAt'
>

/**
 * What any change to an application's documents is decided on, in one
 * statement: the head, the cycle version its form is pinned to, the stages
 * open revision requests name, and every document's head.
 *
 * Every document rather than the one slot, because the three callers find
 * their slot differently — by field, by the intent's field, by id — and an
 * application has only a handful. The write repeats every check that matters.
 */
export const findApplicationForDocuments = async (
  db: Database,
  userId: string,
  applicationId: string,
): Promise<{
  head: Pick<typeof sebApplication.$inferSelect, 'id' | 'status' | 'programmeCycleId'>
  /** Null only if the current version is missing, an invariant failure. */
  pinnedCycleVersion: number | null
  openRevisionStageKeys: Set<string>
  documents: DocumentHead[]
} | null> => {
  const [row] = await db
    .select({
      id: sebApplication.id,
      status: sebApplication.status,
      programmeCycleId: sebApplication.programmeCycleId,
      pinnedCycleVersion: sebApplicationVersion.programmeCycleVersion,
      openRevisionStageKeys: sql<string[]>`ARRAY(
        SELECT DISTINCT r.stage_key FROM ${sebRevisionRequest} r
        WHERE r.application_id = ${sebApplication.id}
          AND r.resolved_at IS NULL AND r.cancelled_at IS NULL
      )`,
      documents: sql<Array<Omit<DocumentHead, 'deletedAt'> & { deletedAt: string | null }>>`COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', d.id, 'fieldKey', d.field_key, 'currentVersion', d.current_version,
          'deletedAt', d.deleted_at
        ))
        FROM ${sebApplicationDocument} d
        WHERE d.application_id = ${sebApplication.id}
      ), '[]'::jsonb)`,
    })
    .from(sebApplication)
    .leftJoin(
      sebApplicationVersion,
      and(
        eq(sebApplicationVersion.applicationId, sebApplication.id),
        eq(sebApplicationVersion.version, sebApplication.currentVersion),
      ),
    )
    .where(and(
      eq(sebApplication.id, applicationId),
      eq(sebApplication.applicantUserId, userId),
      isNull(sebApplication.deletedAt),
    ))
    .limit(1)
  if (!row) return null
  return {
    head: { id: row.id, status: row.status, programmeCycleId: row.programmeCycleId },
    pinnedCycleVersion: row.pinnedCycleVersion,
    openRevisionStageKeys: new Set(row.openRevisionStageKeys),
    documents: row.documents.map((document) => ({
      ...document,
      deletedAt: document.deletedAt === null ? null : new Date(document.deletedAt),
    })),
  }
}

export const insertUploadIntent = async (
  db: Database,
  /** The intent row, and the stage its FILE question sits in. */
  input: typeof sebDocumentUploadIntent.$inferInsert & { stageKey: string },
  audit: AuditRecord,
): Promise<boolean> => {
  // The controller signs only after a friendly ownership/status check. This
  // guarded INSERT repeats that check at the database boundary so a concurrent
  // submission or document replacement cannot leave behind a usable intent.
  const written = await writeFolded(db, [
    sql`head AS (
      INSERT INTO ${sebDocumentUploadIntent} (
        id, application_id, applicant_user_id, field_key, expected_document_version,
        object_key, original_filename, content_type, size_bytes, checksum_sha256,
        status, cleanup_target_status, expires_at, finalized_document_version_id,
        created_at, updated_at
      )
      SELECT ${input.id}, ${input.applicationId}, ${input.applicantUserId},
        ${input.fieldKey}, ${input.expectedDocumentVersion}::int, ${input.objectKey},
        ${input.originalFilename}, ${input.contentType}, ${input.sizeBytes}::int,
        ${input.checksumSha256}, 'ISSUED', NULL,
        ${sqlNullable(input.expiresAt)},
        ${sqlNullable(input.finalizedDocumentVersionId)},
        ${input.createdAt}, ${input.updatedAt}
      WHERE ${applicationDocumentsEditable(input.applicationId, input.applicantUserId, input.stageKey)}
        AND ${slotStillAt(input.applicationId, input.fieldKey, input.expectedDocumentVersion)}
      RETURNING id
    )`,
    sql`audit AS (${auditEventCteMember(audit, sql`head`)})`,
  ])
  return written !== null
}

/**
 * The slot is where the caller last saw it: empty when it expects version 0,
 * otherwise live at exactly the version it expects.
 */
const slotStillAt = (applicationId: string, fieldKey: string, expectedVersion: number) => sql`(
  (${expectedVersion}::int = 0 AND NOT EXISTS (
    SELECT 1 FROM ${sebApplicationDocument}
    WHERE ${sebApplicationDocument.applicationId} = ${applicationId}
      AND ${sebApplicationDocument.fieldKey} = ${fieldKey}
  ))
  OR EXISTS (
    SELECT 1 FROM ${sebApplicationDocument}
    WHERE ${sebApplicationDocument.applicationId} = ${applicationId}
      AND ${sebApplicationDocument.fieldKey} = ${fieldKey}
      AND ${sebApplicationDocument.currentVersion} = ${expectedVersion}::int
      AND ${sebApplicationDocument.deletedAt} IS NULL
  )
)`

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

export const finalizeUploadIntent = async (
  db: Database,
  input: {
    /** The stage this document's FILE question sits in. */
    stageKey: string
    intent: UploadIntentRecord
    /** The slot's document as the caller read it; null when the slot is empty. */
    existing: DocumentHead | null
    documentId: string
    documentVersionId: string
    nextVersion: number
    userId: string
    now: Date
    audit: AuditRecord
  },
): Promise<boolean> => {
  const newDocument = input.existing === null
  /*
   * The intent, locked. Without the lock the document could advance while the
   * cleanup cron claimed the intent in between: the intent then stayed
   * unfinalized, the applicant was told the upload succeeded, and the cleanup
   * deleted the object the document's new version points at. Locked, a claim
   * that committed first is seen when this re-checks the row after waiting,
   * and nothing is written; a claim that comes second waits for this and then
   * finds the intent FINALIZED.
   */
  const claim = sql`claim AS (
    SELECT ${sebDocumentUploadIntent.id} AS claimed_id FROM ${sebDocumentUploadIntent}
    WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
      AND ${sebDocumentUploadIntent.status} = 'ISSUED'
      AND ${sebDocumentUploadIntent.expiresAt} > ${input.now}
    FOR UPDATE
  )`
  const editable = applicationDocumentsEditable(input.intent.applicationId, input.userId, input.stageKey)
  /*
   * The document head is the guarded write: created for an empty slot, or
   * advanced from exactly the version the intent was issued against. A second
   * finalization of a new slot meets the `(application, field)` key; of an
   * existing one, the version guard. It selects from the claimed intent, and
   * everything after it from what it, or a member built on it, returned — so
   * a refused claim or head writes nothing.
   */
  const head = newDocument
    ? sql`head AS (
      INSERT INTO ${sebApplicationDocument} (
        id, application_id, field_key, current_version, created_at, updated_at,
        deleted_at, deleted_by_user_id, delete_reason
      )
      SELECT ${input.documentId}, ${input.intent.applicationId},
        ${input.intent.fieldKey}, 1, ${input.now}, ${input.now},
        NULL, NULL, NULL
      FROM claim
      WHERE ${editable}
      RETURNING id
    )`
    : sql`head AS (
      UPDATE ${sebApplicationDocument}
      SET current_version = ${input.nextVersion}::int, updated_at = ${input.now}
      FROM claim
      WHERE ${and(
        eq(sebApplicationDocument.id, input.existing!.id),
        eq(sebApplicationDocument.currentVersion, input.intent.expectedDocumentVersion),
        isNull(sebApplicationDocument.deletedAt),
        editable,
      )}
      RETURNING id
    )`
  const operation = newDocument ? 'UPLOAD' : 'REPLACE'
  const written = await writeFolded(db, [
    claim,
    head,
    sql`version AS (
      INSERT INTO ${sebApplicationDocumentVersion} (
        id, document_id, version, operation, r2_object_key, original_filename,
        content_type, size_bytes, checksum, uploaded_by_user_id, created_at
      )
      SELECT ${input.documentVersionId}, head.id, ${input.nextVersion}::int,
        ${operation}, ${input.intent.objectKey},
        ${input.intent.originalFilename}, ${input.intent.contentType},
        ${input.intent.sizeBytes}::int, ${input.intent.checksumSha256}, ${input.userId},
        ${input.now}
      FROM head
      RETURNING id
    )`,
    sql`finalized AS (
      UPDATE ${sebDocumentUploadIntent} SET
        status = 'FINALIZED',
        finalized_document_version_id = version.id,
        updated_at = ${input.now}
      FROM version
      WHERE ${sebDocumentUploadIntent.id} = ${input.intent.id}
        AND ${sebDocumentUploadIntent.status} = 'ISSUED'
      RETURNING ${sebDocumentUploadIntent.id}
    )`,
    // Finalization never makes a file staff-readable. It merely queues the
    // immutable object for the future malware scanner; administrative download
    // authorization fails closed until an ACCEPTED result is appended.
    sql`scan AS (
      INSERT INTO ${sebApplicationDocumentScan} (
        id, document_version_id, sequence_number, status, scanner_reference,
        safe_message, scanned_at, created_at
      )
      SELECT ${crypto.randomUUID()}, ${input.documentVersionId}, 1, 'PENDING',
        NULL, NULL, NULL, ${input.now}
      FROM finalized
    )`,
    sql`event AS (${applicationEventMember({
      ...eventValues({
        applicationId: input.intent.applicationId,
        eventType: 'DOCUMENT_FINALIZED',
        actorUserId: input.userId,
        message: 'Application document updated.',
        createdAt: input.now,
      }),
      stageKey: input.stageKey,
    }, sql`finalized`)})`,
    sql`audit AS (${auditEventCteMember(input.audit, sql`finalized`)})`,
  ])
  return written !== null
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
  /*
   * Head first, with the event and the audit row selected from what it
   * returned. This used to be audit-first, the audit id serving as the claim,
   * because later statements correlated on time could match another request's
   * write in the same millisecond; selecting FROM the update's own row cannot.
   */
  const written = await writeFolded(db, [
    sql`head AS (
      UPDATE ${sebApplicationDocument} SET
        deleted_at = ${input.deleted ? input.now : null},
        deleted_by_user_id = ${input.deleted ? input.userId : null},
        delete_reason = ${input.deleted ? 'REMOVED_BY_APPLICANT' : null},
        updated_at = ${input.now}
      WHERE ${and(
        eq(sebApplicationDocument.id, input.documentId),
        eq(sebApplicationDocument.applicationId, input.applicationId),
        eq(sebApplicationDocument.currentVersion, input.expectedVersion),
        input.deleted
          ? isNull(sebApplicationDocument.deletedAt)
          : isNotNull(sebApplicationDocument.deletedAt),
        applicationDocumentsEditable(input.applicationId, input.userId, input.stageKey),
      )}
      RETURNING id
    )`,
    sql`event AS (${applicationEventMember({
      ...eventValues({
        applicationId: input.applicationId,
        eventType: input.deleted ? 'DOCUMENT_DELETED' : 'DOCUMENT_RESTORED',
        actorUserId: input.userId,
        message: input.deleted ? 'Application document removed.' : 'Application document restored.',
        createdAt: input.now,
      }),
      stageKey: input.stageKey,
    }, sql`head`)})`,
    sql`audit AS (${auditEventCteMember(input.audit, sql`head`)})`,
  ])
  return written !== null
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

