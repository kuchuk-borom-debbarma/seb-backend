/**
 * Internal scanner callback contract.
 *
 * This function is intentionally not exported through GraphQL or HTTP. A
 * future trusted Queue consumer calls it after scanning the immutable R2
 * object. Staff access still fails closed unless the latest appended result is
 * ACCEPTED.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../db'
import {
  documentScanStatuses,
  sebApplicationDocumentScan,
  sebApplicationDocumentVersion,
} from '../../db/schema'
import { constraintSafe } from './support'

export type DocumentScanResult = {
  documentVersionId: string
  status: Exclude<(typeof documentScanStatuses)[number], 'PENDING'>
  scannerReference: string
  safeMessage?: string | null
  scannedAt: Date
}

export const recordDocumentScanResult = async (
  db: Database,
  input: DocumentScanResult,
): Promise<boolean> => {
  if (!input.scannerReference.trim() || Number.isNaN(input.scannedAt.getTime())) return false
  const [latest] = await db.select({ sequence: sebApplicationDocumentScan.sequenceNumber })
    .from(sebApplicationDocumentScan)
    .innerJoin(
      sebApplicationDocumentVersion,
      eq(sebApplicationDocumentVersion.id, sebApplicationDocumentScan.documentVersionId),
    )
    .where(and(
      eq(sebApplicationDocumentScan.documentVersionId, input.documentVersionId),
    ))
    .orderBy(desc(sebApplicationDocumentScan.sequenceNumber))
    .limit(1)
  if (!latest) return false
  const inserted = await constraintSafe(() => db.insert(sebApplicationDocumentScan).values({
    id: crypto.randomUUID(),
    documentVersionId: input.documentVersionId,
    sequenceNumber: latest.sequence + 1,
    status: input.status,
    scannerReference: input.scannerReference.trim(),
    safeMessage: input.safeMessage?.trim() || null,
    scannedAt: input.scannedAt,
    createdAt: new Date(),
  }).returning({ id: sebApplicationDocumentScan.id }))
  return inserted !== null && inserted.length === 1
}
