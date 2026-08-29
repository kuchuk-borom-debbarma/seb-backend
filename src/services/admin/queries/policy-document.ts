/**
 * Drizzle persistence for cycle policy PDF uploads and immutable versions.
 *
 * The shapes mirror the applicant document store: an intent retained per
 * authorized upload, an immutable version history, and an append-only scan
 * trail. What differs is ownership — the office acts as one actor, so nothing
 * here proves an issuer/finalizer pair the way the applicant tables prove an
 * applicant owns their application.
 */
import { and, desc, eq, isNotNull, lte, or, sql } from 'drizzle-orm'
import { batch, changedExactlyOne, type Database, type Transaction } from '../../../db'
import {
  coreAuditEvent,
  sebCyclePolicyDocument,
  sebCyclePolicyDocumentScan,
  sebCyclePolicyDocumentVersion,
  sebCyclePolicyUploadIntent,
} from '../../../db/schema'
import { appendWhenChanged } from '../../application/support'

export type PolicyUploadIntentRecord = typeof sebCyclePolicyUploadIntent.$inferSelect

/**
 * The cycle's policy document head with its current version row and the
 * latest scan verdict — everything the open gate and both download paths ask.
 */
export const findCyclePolicyDocument = async (
  db: Database,
  programmeCycleId: string,
) => {
  const [record] = await db
    .select({
      head: sebCyclePolicyDocument,
      version: sebCyclePolicyDocumentVersion,
    })
    .from(sebCyclePolicyDocument)
    .innerJoin(
      sebCyclePolicyDocumentVersion,
      and(
        eq(sebCyclePolicyDocumentVersion.documentId, sebCyclePolicyDocument.id),
        eq(sebCyclePolicyDocumentVersion.version, sebCyclePolicyDocument.currentVersion),
      ),
    )
    .where(eq(sebCyclePolicyDocument.programmeCycleId, programmeCycleId))
    .limit(1)
  if (!record) return null
  return { ...record, scanStatus: await latestScanStatus(db, record.version.id) }
}

/** One named version of the cycle's policy document, with its scan verdict. */
export const findCyclePolicyDocumentVersion = async (
  db: Database,
  programmeCycleId: string,
  version: number,
) => {
  const [record] = await db
    .select({
      head: sebCyclePolicyDocument,
      version: sebCyclePolicyDocumentVersion,
    })
    .from(sebCyclePolicyDocument)
    .innerJoin(
      sebCyclePolicyDocumentVersion,
      and(
        eq(sebCyclePolicyDocumentVersion.documentId, sebCyclePolicyDocument.id),
        eq(sebCyclePolicyDocumentVersion.version, version),
      ),
    )
    .where(eq(sebCyclePolicyDocument.programmeCycleId, programmeCycleId))
    .limit(1)
  if (!record) return null
  return { ...record, scanStatus: await latestScanStatus(db, record.version.id) }
}

/** Every version of the cycle's policy document, newest first, with verdicts. */
export const listCyclePolicyDocumentVersions = async (
  db: Database,
  programmeCycleId: string,
) => {
  const rows = await db
    .select({ version: sebCyclePolicyDocumentVersion })
    .from(sebCyclePolicyDocument)
    .innerJoin(
      sebCyclePolicyDocumentVersion,
      eq(sebCyclePolicyDocumentVersion.documentId, sebCyclePolicyDocument.id),
    )
    .where(eq(sebCyclePolicyDocument.programmeCycleId, programmeCycleId))
    .orderBy(desc(sebCyclePolicyDocumentVersion.version))
  return Promise.all(rows.map(async (row) => ({
    ...row.version,
    scanStatus: await latestScanStatus(db, row.version.id),
  })))
}

/**
 * The authoritative scan verdict: the highest sequence wins. Absence reads as
 * PENDING — a version with no trail must never be more open than one whose
 * scan is still running.
 */
const latestScanStatus = async (
  db: Database,
  documentVersionId: string,
): Promise<'PENDING' | 'ACCEPTED' | 'REJECTED' | 'ERROR'> => {
  const [scan] = await db
    .select({ status: sebCyclePolicyDocumentScan.status })
    .from(sebCyclePolicyDocumentScan)
    .where(eq(sebCyclePolicyDocumentScan.documentVersionId, documentVersionId))
    .orderBy(desc(sebCyclePolicyDocumentScan.sequenceNumber))
    .limit(1)
  return scan?.status ?? 'PENDING'
}

export const insertPolicyUploadIntent = async (
  db: Database,
  intent: typeof sebCyclePolicyUploadIntent.$inferInsert,
  audit: typeof coreAuditEvent.$inferInsert,
): Promise<void> => {
  // A plain insert is race-safe here: a stale `expectedDocumentVersion` makes
  // the later guarded finalize miss, and an intent that never finalizes is
  // exactly what the scheduled cleanup exists to sweep.
  await batch(db, (tx) => [
    tx.insert(sebCyclePolicyUploadIntent).values(intent),
    tx.insert(coreAuditEvent).values(audit),
  ])
}

export const findPolicyUploadIntent = async (
  db: Database,
  uploadId: string,
): Promise<PolicyUploadIntentRecord | null> => {
  const [record] = await db
    .select()
    .from(sebCyclePolicyUploadIntent)
    .where(eq(sebCyclePolicyUploadIntent.id, uploadId))
    .limit(1)
  return record ?? null
}

export const finalizePolicyUploadIntent = async (
  db: Database,
  input: {
    intent: PolicyUploadIntentRecord
    documentId: string
    documentVersionId: string
    nextVersion: number
    userId: string
    now: Date
    audit: typeof coreAuditEvent.$inferInsert
  },
): Promise<boolean> => {
  const newDocument = input.nextVersion === 1
  /*
   * The same dependency chain as the applicant finalize: the head write is the
   * guarded step, and every later statement fires only if its predecessor
   * landed, so a concurrent finalize of a second intent leaves no partial
   * version, dangling scan row, or audit entry.
   */
  const createOrAdvance = (tx: Transaction) => newDocument
    ? tx.insert(sebCyclePolicyDocument).select(sql`
        SELECT ${input.documentId}, ${input.intent.programmeCycleId}, 1,
          ${input.now}, ${input.now}
        WHERE EXISTS (
          SELECT 1 FROM ${sebCyclePolicyUploadIntent}
          WHERE ${sebCyclePolicyUploadIntent.id} = ${input.intent.id}
            AND ${sebCyclePolicyUploadIntent.status} = 'ISSUED'
            AND ${sebCyclePolicyUploadIntent.expiresAt} > ${input.now}
        )
      `).returning({ id: sebCyclePolicyDocument.id })
    : tx
        .update(sebCyclePolicyDocument)
        .set({ currentVersion: input.nextVersion, updatedAt: input.now })
        .where(
          and(
            eq(sebCyclePolicyDocument.id, input.documentId),
            eq(
              sebCyclePolicyDocument.currentVersion,
              input.intent.expectedDocumentVersion,
            ),
            sql`EXISTS (
              SELECT 1 FROM ${sebCyclePolicyUploadIntent}
              WHERE ${sebCyclePolicyUploadIntent.id} = ${input.intent.id}
                AND ${sebCyclePolicyUploadIntent.status} = 'ISSUED'
                AND ${sebCyclePolicyUploadIntent.expiresAt} > ${input.now}
            )`,
          ),
        )
        .returning({ id: sebCyclePolicyDocument.id })
  const insertVersion = (tx: Transaction) => tx
    .insert(sebCyclePolicyDocumentVersion).select(sql`
      SELECT ${input.documentVersionId}, ${input.documentId}, ${input.nextVersion},
        ${newDocument ? 'UPLOAD' : 'REPLACE'}, ${input.intent.objectKey},
        ${input.intent.originalFilename}, ${input.intent.contentType},
        ${input.intent.sizeBytes}, ${input.intent.checksumSha256}, ${input.userId},
        ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebCyclePolicyDocument}
        WHERE ${sebCyclePolicyDocument.id} = ${input.documentId}
          AND ${sebCyclePolicyDocument.currentVersion} = ${input.nextVersion}
          AND ${sebCyclePolicyDocument.updatedAt} = ${input.now}
      )
    `)
  const finalizeIntent = (tx: Transaction) => tx
    .update(sebCyclePolicyUploadIntent)
    .set({
      status: 'FINALIZED',
      finalizedDocumentVersionId: input.documentVersionId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(sebCyclePolicyUploadIntent.id, input.intent.id),
        eq(sebCyclePolicyUploadIntent.status, 'ISSUED'),
        sql`EXISTS (
          SELECT 1 FROM ${sebCyclePolicyDocumentVersion}
          WHERE ${sebCyclePolicyDocumentVersion.id} = ${input.documentVersionId}
        )`,
      ),
    )
  // Finalization never makes the file readable. It queues the immutable
  // object for the scanner; downloads and cycle opening fail closed until an
  // ACCEPTED result is appended.
  const pendingScan = (tx: Transaction) => tx
    .insert(sebCyclePolicyDocumentScan).select(sql`
      SELECT ${crypto.randomUUID()}, ${input.documentVersionId}, 1, 'PENDING',
        NULL, NULL, NULL, ${input.now}
      WHERE EXISTS (
        SELECT 1 FROM ${sebCyclePolicyUploadIntent}
        WHERE ${sebCyclePolicyUploadIntent.id} = ${input.intent.id}
          AND ${sebCyclePolicyUploadIntent.status} = 'FINALIZED'
      )
    `)
  const audit = (tx: Transaction) => tx.insert(coreAuditEvent).select(sql`
    SELECT ${input.audit.id}, ${input.audit.actorUserId}, ${input.audit.action},
      ${input.audit.entityType}, ${input.audit.entityId}, ${input.audit.outcome},
      ${input.audit.requestId ?? null}, ${input.audit.ipAddress ?? null},
      ${input.audit.userAgent ?? null}, NULL, ${input.audit.metadataJson ?? null},
      ${input.now}
    WHERE EXISTS (
      SELECT 1 FROM ${sebCyclePolicyUploadIntent}
      WHERE ${sebCyclePolicyUploadIntent.id} = ${input.intent.id}
        AND ${sebCyclePolicyUploadIntent.status} = 'FINALIZED'
    )
  `)
  const [changed] = await batch(db, (tx) => [
    createOrAdvance(tx),
    insertVersion(tx),
    finalizeIntent(tx),
    pendingScan(tx),
    audit(tx),
  ])
  return changedExactlyOne(changed)
}

/** See `closeUploadIntentStatement`: a statement, so cleanup can batch them. */
export const closePolicyUploadIntentStatement = (
  db: Database | Transaction,
  uploadId: string,
  target: 'REJECTED' | 'EXPIRED',
  now: Date,
) =>
  db
    .update(sebCyclePolicyUploadIntent)
    .set({ status: target, cleanupTargetStatus: null, updatedAt: now })
    .where(
      and(
        eq(sebCyclePolicyUploadIntent.id, uploadId),
        eq(sebCyclePolicyUploadIntent.status, 'CLEANUP_PENDING'),
        eq(sebCyclePolicyUploadIntent.cleanupTargetStatus, target),
      ),
    )

/**
 * Claims one upload before deleting its object, closing the finalize/cleanup
 * race the same way the applicant intent does: finalization only accepts
 * `ISSUED`, so the state change comes first.
 */
export const claimPolicyUploadIntentForCleanup = async (
  db: Database,
  uploadId: string,
  now: Date,
  targetStatus: 'REJECTED' | 'EXPIRED',
): Promise<boolean> => {
  const result = await db
    .update(sebCyclePolicyUploadIntent)
    .set({ status: 'CLEANUP_PENDING', cleanupTargetStatus: targetStatus, updatedAt: now })
    .where(
      and(
        eq(sebCyclePolicyUploadIntent.id, uploadId),
        eq(sebCyclePolicyUploadIntent.status, 'ISSUED'),
      ),
    )
  return result.rowCount === 1
}

export const claimExpiredPolicyUploadIntents = async (
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
      id: sebCyclePolicyUploadIntent.id,
      objectKey: sebCyclePolicyUploadIntent.objectKey,
      status: sebCyclePolicyUploadIntent.status,
      cleanupTargetStatus: sebCyclePolicyUploadIntent.cleanupTargetStatus,
    })
    .from(sebCyclePolicyUploadIntent)
    .where(
      or(
        and(
          eq(sebCyclePolicyUploadIntent.status, 'ISSUED'),
          lte(sebCyclePolicyUploadIntent.expiresAt, now),
        ),
        and(
          eq(sebCyclePolicyUploadIntent.status, 'CLEANUP_PENDING'),
          isNotNull(sebCyclePolicyUploadIntent.cleanupTargetStatus),
        ),
      ),
    )
    .limit(limit)
  const intended = candidates.map((candidate) => ({
    id: candidate.id,
    objectKey: candidate.objectKey,
    // The lifecycle CHECK guarantees a pending row has a target. The cast
    // narrows Drizzle's nullable select type after the SQL predicate above.
    cleanupTargetStatus: candidate.status === 'ISSUED'
      ? ('EXPIRED' as const)
      : (candidate.cleanupTargetStatus as 'REJECTED' | 'EXPIRED'),
  }))
  if (intended.length === 0) return []

  const results = await batch(db, (tx) =>
    intended.map((candidate) =>
      tx
        .update(sebCyclePolicyUploadIntent)
        .set({
          status: 'CLEANUP_PENDING',
          cleanupTargetStatus: candidate.cleanupTargetStatus,
          updatedAt: now,
        })
        .where(
          and(
            eq(sebCyclePolicyUploadIntent.id, candidate.id),
            or(
              and(
                eq(sebCyclePolicyUploadIntent.status, 'ISSUED'),
                lte(sebCyclePolicyUploadIntent.expiresAt, now),
              ),
              and(
                eq(sebCyclePolicyUploadIntent.status, 'CLEANUP_PENDING'),
                eq(
                  sebCyclePolicyUploadIntent.cleanupTargetStatus,
                  candidate.cleanupTargetStatus,
                ),
              ),
            ),
          ),
        ),
    ),
  )

  const claimed: typeof intended = []
  intended.forEach((candidate, index) => {
    appendWhenChanged(claimed, candidate, results[index] as never)
  })
  return claimed
}
