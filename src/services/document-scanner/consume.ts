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
 * What became of one scan request.
 *
 * Three outcomes rather than a boolean, because two of them look alike and must
 * be settled differently. `GONE` is permanent — retrying it can only ever reach
 * the same missing row, so redelivering until the platform gives up would spend
 * a whole retry budget to arrive where it started, and on a queue whose retries
 * are shared with real failures. `NOT_RECORDED` may succeed later.
 */
export type ScanDisposition = 'RECORDED' | 'GONE' | 'NOT_RECORDED'

/**
 * Scans one document version and records the verdict.
 *
 * Throwing still means no conclusion was reached, and is the caller's cue to
 * retry. A returned `NOT_RECORDED` says the same thing without an error; `GONE`
 * says there is nothing left to conclude about.
 *
 * Nothing here logs an object key or a document id — a storage identifier is
 * sensitive, and this runs where logs are kept.
 */
export const scanDocumentVersion = async (
  db: Database,
  env: AppBindings,
  documentVersionId: string,
): Promise<ScanDisposition> => {
  const [version] = await db
    .select({ objectKey: sebApplicationDocumentVersion.r2ObjectKey })
    .from(sebApplicationDocumentVersion)
    .where(eq(sebApplicationDocumentVersion.id, documentVersionId))
    .limit(1)
  // The document was deleted between the request being queued and read. There
  // is nothing to scan and nothing to record, and no later attempt can change
  // that — so this is settled, not deferred.
  if (!version) return 'GONE'

  const outcome = await documentScanner(env).scan(version.objectKey)
  const recorded = await recordDocumentScanResult(db, {
    documentVersionId,
    status: outcome.verdict,
    scannerReference: outcome.reference,
    safeMessage: outcome.message,
    scannedAt: new Date(),
  })
  return recorded ? 'RECORDED' : 'NOT_RECORDED'
}
