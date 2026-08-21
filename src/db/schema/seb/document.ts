import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { coreUser } from '../core/auth'
import { versionedSoftDeleteColumns } from '../shared'
import { sebApplication } from './application'

export const documentTypes = [
  'IDENTITY_AGE_PROOF',
  'ST_CERTIFICATE',
  'ADDRESS_PROOF',
  'BUSINESS_REGISTRATION',
  'GST_REGISTRATION',
  'DPR',
  'BANK_DETAILS',
  'NOC',
] as const
export const documentVersionOperations = ['UPLOAD', 'REPLACE'] as const

/** Stable logical slot for one kind of application evidence. */
export const sebApplicationDocument = sqliteTable(
  'seb_application_document',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => sebApplication.id, { onDelete: 'restrict' }),
    documentType: text('document_type', { enum: documentTypes }).notNull(),
    ...versionedSoftDeleteColumns(() => coreUser.id),
  },
  (table) => [
    uniqueIndex('seb_application_document_type_uq').on(
      table.applicationId,
      table.documentType,
    ),
    check('seb_application_document_version_check', sql`${table.currentVersion} >= 1`),
    check(
      'seb_application_document_type_check',
      sql`${table.documentType} IN ('IDENTITY_AGE_PROOF', 'ST_CERTIFICATE', 'ADDRESS_PROOF', 'BUSINESS_REGISTRATION', 'GST_REGISTRATION', 'DPR', 'BANK_DETAILS', 'NOC')`,
    ),
  ],
)

/**
 * Immutable file history. Every replacement receives a fresh R2 key; logical
 * deletion and restoration are recorded on the document head and in audit.
 */
export const sebApplicationDocumentVersion = sqliteTable(
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
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('seb_application_document_version_number_uq').on(
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
