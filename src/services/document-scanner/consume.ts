/**
 * Turning a queued scan request into a recorded result.
 *
 * The step between the queue and the audit trail: find the object the request
 * names, ask whichever scanner this environment has, and append what it said.
 *
 * Kept out of `src/index.ts` because it is business logic — which document, what
 * was concluded, what gets written down — and the Worker entry point holds
 * none.
 */
import { eq } from 'drizzle-orm'
import type { AppBindings } from '../../bindings'
import type { Database } from '../../db'
import { sebApplicationDocumentVersion } from '../../db/schema'
import { recordDocumentScanResult } from '../admin/document-scanner'
import { documentScanner } from './index'

/**
 * Scans one document version and records the verdict.
 *
 * Returns whether a result was recorded. A `false` is not an error the caller
 * should hide: the document simply stays unopenable, which is the safe
 * direction, and the message can be retried.
 *
 * Nothing here logs an object key or a document id — a storage identifier is
 * sensitive, and this runs where logs are kept.
 */
export const scanDocumentVersion = async (
  db: Database,
  env: AppBindings,
  documentVersionId: string,
): Promise<boolean> => {
  const [version] = await db
    .select({ objectKey: sebApplicationDocumentVersion.r2ObjectKey })
    .from(sebApplicationDocumentVersion)
    .where(eq(sebApplicationDocumentVersion.id, documentVersionId))
    .limit(1)
  // The document was deleted between the request being queued and read. There
  // is nothing to scan and nothing to record.
  if (!version) return false

  const outcome = await documentScanner(env).scan(version.objectKey)
  return recordDocumentScanResult(db, {
    documentVersionId,
    status: outcome.verdict,
    scannerReference: outcome.reference,
    safeMessage: outcome.message,
    scannedAt: new Date(),
  })
}
