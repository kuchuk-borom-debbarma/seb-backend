import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { coreUser } from '../core/auth'
import { instant, versionedSoftDeleteColumns } from '../shared'
import { sebApplication, sebApplicationSubmission } from './application'

export const documentVersionOperations = ['UPLOAD', 'REPLACE'] as const
export const documentUploadIntentStatuses = [
  'ISSUED',
  'FINALIZED',
  'REJECTED',
  'CLEANUP_PENDING',
  'EXPIRED',
] as const
export const documentUploadCleanupTargetStatuses = ['REJECTED', 'EXPIRED'] as const
export const documentScanStatuses = ['PENDING', 'ACCEPTED', 'REJECTED', 'ERROR'] as const

/** Stable logical slot for one kind of application evidence. */
export const sebApplicationDocument = pgTable(
  'seb_application_document',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    fieldKey: text('field_key').notNull(),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    uniqueIndex('seb_application_document_field_key_uq').on(
      table.applicationId,
      table.fieldKey,
    ),
    check('seb_application_document_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_application_document_field_key_check',
      sql`${table.fieldKey} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
  ],
)

/**
 * Immutable file history. Every replacement receives a fresh R2 key; logical
 * deletion and restoration are recorded on the document head and in audit.
 */
export const sebApplicationDocumentVersion = pgTable(
  'seb_application_document_version',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => sebApplicationDocument.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    operation: text('operation', { enum: documentVersionOperations }).notNull(),
    r2ObjectKey: text('r2_object_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksum: text('checksum').notNull(),
    uploadedByUserId: text('uploaded_by_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    unique('seb_application_document_version_number_uq').on(
      table.documentId,
      table.version,
    ),
    check('seb_application_document_version_number_check', sql`${table.version} >= 1`),
    check('seb_application_document_size_check', sql`${table.sizeBytes} >= 0`),
    check(
      'seb_application_document_operation_check',
      sql`${table.operation} IN ('UPLOAD', 'REPLACE')`,
    ),
  ],
)

/**
 * Exact document evidence attached to one formal submission.
 *
 * The logical slot and immutable file version are both pinned. A later upload
 * can therefore never make an old submission appear to contain a newer file.
 */
export const sebApplicationSubmissionDocument = pgTable(
  'seb_application_submission_document',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').notNull(),
    submissionId: text('submission_id').notNull(),
    documentId: text('document_id').notNull(),
    documentVersion: integer('document_version').notNull(),
    fieldKey: text('field_key').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId, table.submissionId],
      foreignColumns: [sebApplicationSubmission.applicationId, sebApplicationSubmission.id],
      name: 'seb_application_submission_document_submission_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.documentId, table.documentVersion],
      foreignColumns: [
        sebApplicationDocumentVersion.documentId,
        sebApplicationDocumentVersion.version,
      ],
      name: 'seb_application_submission_document_version_fk',
    }).onDelete('restrict'),
    uniqueIndex('seb_application_submission_document_field_key_uq').on(
      table.submissionId,
      table.fieldKey,
    ),
    check(
      'seb_application_submission_document_field_key_check',
      sql`${table.fieldKey} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'seb_application_submission_document_version_check',
      sql`${table.documentVersion} >= 1`,
    ),
  ],
)

/**
 * Append-only malware scan history for an immutable R2 object.
 * The latest sequence is authoritative; administrators fail closed unless it
 * is ACCEPTED. No environment flag can bypass this evidence.
 */
export const sebApplicationDocumentScan = pgTable(
  'seb_application_document_scan',
  {
    id: text('id').primaryKey(),
    documentVersionId: text('document_version_id')
      .notNull()
      .references(() => sebApplicationDocumentVersion.id, { onDelete: 'restrict' }),
    sequenceNumber: integer('sequence_number').notNull(),
    status: text('status', { enum: documentScanStatuses }).notNull(),
    scannerReference: text('scanner_reference'),
    safeMessage: text('safe_message'),
    scannedAt: instant('scanned_at'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('seb_application_document_scan_sequence_uq').on(
      table.documentVersionId,
      table.sequenceNumber,
    ),
    check('seb_application_document_scan_sequence_check', sql`${table.sequenceNumber} >= 1`),
    check(
      'seb_application_document_scan_status_check',
      sql`${table.status} IN ('PENDING', 'ACCEPTED', 'REJECTED', 'ERROR')`,
    ),
    check(
      'seb_application_document_scan_lifecycle_check',
      sql`(${table.status} = 'PENDING' AND ${table.scannedAt} IS NULL)
        OR (${table.status} <> 'PENDING' AND ${table.scannedAt} IS NOT NULL)`,
    ),
  ],
)

/**
 * Retained authorization for one direct browser-to-R2 upload.
 *
 * The URL itself is never stored. The intent binds one opaque object key to an
 * applicant, application, document slot, expected version, checksum, and
 * expiry. This makes the later GraphQL finalization race-safe and gives the
 * scheduled cleanup an exact object key without scanning the private bucket.
 */
export const sebDocumentUploadIntent = pgTable(
  'seb_document_upload_intent',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    applicantUserId: text('applicant_user_id')
      .notNull()
      .references(() => coreUser.id, { onDelete: 'restrict' }),
    fieldKey: text('field_key').notNull(),
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
      () => sebApplicationDocumentVersion.id,
      { onDelete: 'restrict' },
    ),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    // The applicant/application pair proves ownership at the database boundary
    // rather than trusting an ID supplied during finalization.
    foreignKey({
      columns: [table.applicantUserId, table.applicationId],
      foreignColumns: [sebApplication.applicantUserId, sebApplication.id],
      name: 'seb_document_upload_intent_owner_application_fk',
    }).onDelete('restrict'),
    check(
      'seb_document_upload_intent_field_key_check',
      sql`${table.fieldKey} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      'seb_document_upload_intent_status_check',
      sql`${table.status} IN ('ISSUED', 'FINALIZED', 'REJECTED', 'CLEANUP_PENDING', 'EXPIRED')`,
    ),
    check(
      'seb_document_upload_intent_expected_version_check',
      sql`${table.expectedDocumentVersion} >= 0`,
    ),
    check(
      'seb_document_upload_intent_size_check',
      sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 5242880`,
    ),
    check(
      'seb_document_upload_intent_lifecycle_check',
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
    index('seb_document_upload_intent_cleanup_idx').on(table.status, table.expiresAt),
    index('seb_document_upload_intent_owner_idx').on(
      table.applicantUserId,
      table.applicationId,
      table.createdAt,
    ),
  ],
)
