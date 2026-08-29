import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { instant } from '../shared'
import { sebProgrammeCycle } from './programme'
import {
  documentScanStatuses,
  documentUploadCleanupTargetStatuses,
  documentUploadIntentStatuses,
  documentVersionOperations,
} from './document'

/**
 * The order or circular one programme cycle implements, as a published PDF.
 *
 * One head per cycle, not per cycle version: the document is the publication
 * of the order — like the applicant guidance, it may be replaced while the
 * cycle is live, and applicants always read the latest accepted copy. The
 * rules an application is judged by are frozen elsewhere; this is not one.
 */
export const sebCyclePolicyDocument = pgTable(
  'seb_cycle_policy_document',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    currentVersion: integer('current_version').notNull(),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_cycle_policy_document_cycle_uq').on(table.programmeCycleId),
    check('seb_cycle_policy_document_version_check', sql`${table.currentVersion} >= 1`),
  ],
)

/**
 * Immutable file history. Every replacement receives a fresh R2 key, so an
 * audit of "what did applicants read on date X" stays answerable after the
 * office uploads a corrected copy.
 */
export const sebCyclePolicyDocumentVersion = pgTable(
  'seb_cycle_policy_document_version',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => sebCyclePolicyDocument.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    operation: text('operation', { enum: documentVersionOperations }).notNull(),
    r2ObjectKey: text('r2_object_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksum: text('checksum').notNull(),
    // Audit only. Any CYCLE_ADMIN may replace or finalize the document; the
    // office acts as one actor, unlike an applicant who owns their uploads.
    uploadedByUserId: text('uploaded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('seb_cycle_policy_document_version_number_uq').on(
      table.documentId,
      table.version,
    ),
    check('seb_cycle_policy_document_version_number_check', sql`${table.version} >= 1`),
    check('seb_cycle_policy_document_size_check', sql`${table.sizeBytes} >= 0`),
    check(
      'seb_cycle_policy_document_operation_check',
      sql`${table.operation} IN ('UPLOAD', 'REPLACE')`,
    ),
  ],
)

/**
 * Append-only malware scan history for one immutable policy PDF version.
 * The latest sequence is authoritative. The policy document is the highest-
 * fanout file in the system — served to every applicant — so downloads and
 * cycle opening both fail closed unless it is ACCEPTED.
 */
export const sebCyclePolicyDocumentScan = pgTable(
  'seb_cycle_policy_document_scan',
  {
    id: text('id').primaryKey(),
    documentVersionId: text('document_version_id')
      .notNull()
      .references(() => sebCyclePolicyDocumentVersion.id, { onDelete: 'restrict' }),
    sequenceNumber: integer('sequence_number').notNull(),
    status: text('status', { enum: documentScanStatuses }).notNull(),
    scannerReference: text('scanner_reference'),
    safeMessage: text('safe_message'),
    scannedAt: instant('scanned_at'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_cycle_policy_document_scan_sequence_uq').on(
      table.documentVersionId,
      table.sequenceNumber,
    ),
    check(
      'seb_cycle_policy_document_scan_sequence_check',
      sql`${table.sequenceNumber} >= 1`,
    ),
    check(
      'seb_cycle_policy_document_scan_status_check',
      sql`${table.status} IN ('PENDING', 'ACCEPTED', 'REJECTED', 'ERROR')`,
    ),
    check(
      'seb_cycle_policy_document_scan_lifecycle_check',
      sql`(${table.status} = 'PENDING' AND ${table.scannedAt} IS NULL)
        OR (${table.status} <> 'PENDING' AND ${table.scannedAt} IS NOT NULL)`,
    ),
  ],
)

/**
 * Retained authorization for one direct browser-to-R2 policy PDF upload.
 *
 * The URL itself is never stored. The intent binds one opaque object key to a
 * cycle, expected document version, checksum, and expiry, which makes the
 * later GraphQL finalization race-safe and gives the scheduled cleanup an
 * exact object key without scanning the private bucket. Unlike the applicant
 * intent there is no owner pair: the issuer is recorded for audit, but any
 * CYCLE_ADMIN may finalize.
 */
export const sebCyclePolicyUploadIntent = pgTable(
  'seb_cycle_policy_upload_intent',
  {
    id: text('id').primaryKey(),
    programmeCycleId: text('programme_cycle_id')
      .notNull()
      .references(() => sebProgrammeCycle.id, { onDelete: 'restrict' }),
    issuedByUserId: text('issued_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    expectedDocumentVersion: integer('expected_document_version').notNull(),
    objectKey: text('object_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    status: text('status', { enum: documentUploadIntentStatuses })
      .notNull()
      .default('ISSUED'),
    // Cleanup may span multiple cron runs when R2 is unavailable. Persisting
    // the intended terminal state prevents a rejected upload from later being
    // mislabeled as merely expired (or vice versa).
    cleanupTargetStatus: text('cleanup_target_status', {
      enum: documentUploadCleanupTargetStatuses,
    }),
    expiresAt: instant('expires_at').notNull(),
    finalizedDocumentVersionId: text('finalized_document_version_id').references(
      () => sebCyclePolicyDocumentVersion.id,
      { onDelete: 'restrict' },
    ),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'seb_cycle_policy_upload_intent_status_check',
      sql`${table.status} IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')`,
    ),
    check(
      'seb_cycle_policy_upload_intent_expected_version_check',
      sql`${table.expectedDocumentVersion} >= 0`,
    ),
    check(
      'seb_cycle_policy_upload_intent_size_check',
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 5242880`,
    ),
    check(
      'seb_cycle_policy_upload_intent_lifecycle_check',
      sql`(${table.status} = 'FINALIZED'
          AND ${table.finalizedDocumentVersionId} IS NOT NULL
          AND ${table.cleanupTargetStatus} IS NULL)
        OR (${table.status} = 'CLEANUP_PENDING'
          AND ${table.finalizedDocumentVersionId} IS NULL
          AND ${table.cleanupTargetStatus} IN ('REJECTED', 'EXPIRED'))
        OR (${table.status} NOT IN ('FINALIZED', 'CLEANUP_PENDING')
          AND ${table.finalizedDocumentVersionId} IS NULL
          AND ${table.cleanupTargetStatus} IS NULL)`,
    ),
    index('seb_cycle_policy_upload_intent_cleanup_idx').on(
      table.status,
      table.expiresAt,
    ),
  ],
)
