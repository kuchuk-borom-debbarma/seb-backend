/** Applicant document authorization, finalization, download, and lifecycle. */
import { auditActions, documentTypes } from '../../../db/schema'
import {
  claimExpiredUploadIntents,
  claimUploadIntentForCleanup,
  finalizeUploadIntent,
  findApplicationDocument,
  findOwnedDocumentVersion,
  findOwnedUploadIntent,
  insertUploadIntent,
  markUploadIntentExpired,
  markUploadIntentRejected,
  setDocumentDeleted,
} from '../queries/document'
import {
  findOwnedApplicationHead,
  listOpenRevisionSections,
} from '../queries/application'
import {
  AUTH_REQUIRED_MESSAGE,
  afterSuccessfulClaim,
  auditRecord,
  currentApplicant,
  failure,
  runConstraintSafe,
  success,
} from '../support'
import type {
  ApplicationOperationContext,
  DownloadAuthorization,
  DocumentType,
  SebResult,
  UploadAuthorization,
} from '../types'
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  createDocumentObjectKey,
  MAX_DOCUMENT_BYTES,
  sanitizeFilename,
  validSha256Base64,
  verifyUploadedObject,
  type AllowedContentType,
} from '../uploads'
import { queue, sendBestEffort } from '../../queue'
import {
  storage,
  UPLOAD_TTL_SECONDS,
  type UploadRequest,
} from '../../storage'

const canEditDocuments = async (
  context: ApplicationOperationContext,
  applicationId: string,
  status: string,
): Promise<boolean> =>
  status === 'DRAFT' ||
  (status === 'REVISION_REQUIRED' &&
    (await listOpenRevisionSections(context.db, applicationId)).has('DOCUMENTS'))

export const issueDocumentUpload = async (
  input: {
    applicationId: string
    documentType: DocumentType
    expectedDocumentVersion: number
    originalFilename: string
    contentType: string
    sizeBytes: number
    checksumSha256: string
  },
  context: ApplicationOperationContext,
): Promise<SebResult<UploadAuthorization>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!documentTypes.includes(input.documentType)) return failure('Select a valid document type.')
  if (!Number.isInteger(input.expectedDocumentVersion) || input.expectedDocumentVersion < 0) {
    return failure('Expected document version must be a non-negative integer.')
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_DOCUMENT_BYTES
  ) return failure('Documents must contain 1 byte through 10 MB.')
  if (!ALLOWED_DOCUMENT_CONTENT_TYPES.includes(input.contentType as AllowedContentType)) {
    return failure('Documents must be PDF, JPEG, or PNG.')
  }
  if (!validSha256Base64(input.checksumSha256)) {
    return failure('Provide the base64-encoded SHA-256 checksum.')
  }
  const originalFilename = sanitizeFilename(input.originalFilename)
  if (!originalFilename) return failure('The original filename is invalid.')
  const application = await findOwnedApplicationHead(
    context.db,
    applicant.id,
    input.applicationId,
  )
  if (!application) return failure('The application was not found.')
  if (!(await canEditDocuments(context, application.id, application.status))) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const current = await findApplicationDocument(context.db, application.id, input.documentType)
  if (
    (current === null && input.expectedDocumentVersion !== 0) ||
    (current !== null &&
      (current.deletedAt !== null || current.currentVersion !== input.expectedDocumentVersion))
  ) return failure('The document changed. Refresh it and try again.')

  const now = new Date()
  const uploadId = crypto.randomUUID()
  const objectKey = createDocumentObjectKey(application.id, input.documentType)
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000)
  const authorization = await storage(context.env, context.requestUrl).authorizeUpload({
    uploadId,
    objectKey,
    originalFilename,
    contentType: input.contentType as AllowedContentType,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
    expiresAt,
  })
  const issued = await insertUploadIntent(
    context.db,
    {
      id: uploadId,
      applicationId: application.id,
      applicantUserId: applicant.id,
      documentType: input.documentType,
      expectedDocumentVersion: input.expectedDocumentVersion,
      objectKey,
      originalFilename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      status: 'ISSUED',
      expiresAt,
      finalizedDocumentVersionId: null,
      createdAt: now,
      updatedAt: now,
    },
    auditRecord(context, {
      actorUserId: applicant.id,
      action: auditActions.documentUploadIssued,
      entityType: 'SEB_DOCUMENT_UPLOAD_INTENT',
      entityId: uploadId,
      metadata: { documentType: input.documentType },
      now,
    }),
  )
  if (!issued) {
    return failure('The application or document changed. Refresh it and try again.')
  }
  return success({ uploadId, ...authorization })
}

export const finalizeDocumentUpload = async (
  uploadId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<{ documentId: string; version: number }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const intent = await findOwnedUploadIntent(context.db, applicant.id, uploadId)
  if (!intent || intent.status !== 'ISSUED') return failure('The upload authorization is invalid or already used.')
  const now = new Date()
  if (intent.expiresAt.getTime() <= now.getTime()) {
    const claimed = await claimUploadIntentForCleanup(context.db, intent.id, now, 'EXPIRED')
    await afterSuccessfulClaim(claimed, async () => {
      await context.env.STORAGE.delete(intent.objectKey)
      await markUploadIntentExpired(context.db, intent.id, now)
    })
    return failure('The upload authorization expired.')
  }
  const application = await findOwnedApplicationHead(
    context.db,
    applicant.id,
    intent.applicationId,
  )
  if (!application || !(await canEditDocuments(context, intent.applicationId, application.status))) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const verification = await verifyUploadedObject(storage(context.env, context.requestUrl), {
    objectKey: intent.objectKey,
    contentType: intent.contentType as AllowedContentType,
    sizeBytes: intent.sizeBytes,
    checksumSha256: intent.checksumSha256,
  })
  if (!verification.valid) {
    const claimed = await claimUploadIntentForCleanup(context.db, intent.id, now, 'REJECTED')
    await afterSuccessfulClaim(claimed, async () => {
      await context.env.STORAGE.delete(intent.objectKey)
      await markUploadIntentRejected(context.db, intent.id, now)
    })
    return failure(verification.message)
  }
  const existing = await findApplicationDocument(
    context.db,
    intent.applicationId,
    intent.documentType,
  )
  const documentId = existing?.id ?? crypto.randomUUID()
  const nextVersion = intent.expectedDocumentVersion + 1
  const documentVersionId = crypto.randomUUID()
  const finalized = await runConstraintSafe(() => finalizeUploadIntent(context.db, {
      intent,
      documentId,
      documentVersionId,
      nextVersion,
      userId: applicant.id,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: auditActions.documentFinalized,
        entityType: 'SEB_APPLICATION_DOCUMENT',
        entityId: documentId,
        metadata: { documentType: intent.documentType, version: nextVersion },
        now,
      }),
    }))
  if (!finalized) return failure('The document changed. Refresh it and try again.')

  /*
   * The document is stored and immutable, so it can be scanned. Queued rather
   * than done here: scanning is somebody else's work and however long it takes
   * must not be time the applicant spends waiting.
   *
   * A failure to queue is deliberately swallowed. The document is already
   * finalized and the applicant's upload genuinely succeeded — telling them it
   * failed would be untrue, and would invite them to upload it again. What the
   * unscanned document cannot do is be opened by staff: administrative
   * download fails closed until an ACCEPTED scan result is appended, so the
   * consequence of a lost message is a document nobody can read, not a
   * document nobody checked.
   */
  await sendBestEffort(
    queue(context.env),
    { kind: 'DOCUMENT_SCAN_REQUESTED', documentVersionId },
    'The document scan',
  )
  return success({ documentId, version: nextVersion })
}

export const documentDownloadUrl = async (
  documentId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<DownloadAuthorization>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const document = await findOwnedDocumentVersion(context.db, applicant.id, documentId)
  if (!document) return failure('The document was not found.')
  return success(
    await storage(context.env, context.requestUrl).authorizeDownload(
      document.version.r2ObjectKey,
      document.version.originalFilename,
      new Date(),
    ),
  )
}

const changeDocumentDeletion = async (
  input: {
    applicationId: string
    documentId: string
    expectedVersion: number
  },
  context: ApplicationOperationContext,
  deleted: boolean,
): Promise<SebResult<{ value: boolean }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return failure('Expected document version must be a positive integer.')
  }
  const application = await findOwnedApplicationHead(
    context.db,
    applicant.id,
    input.applicationId,
  )
  if (!application) return failure('The application was not found.')
  if (!(await canEditDocuments(context, application.id, application.status))) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const now = new Date()
  const changed = await setDocumentDeleted(context.db, {
    applicationId: application.id,
    documentId: input.documentId,
    expectedVersion: input.expectedVersion,
    userId: applicant.id,
    deleted,
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: deleted ? auditActions.documentDeleted : auditActions.documentRestored,
      entityType: 'SEB_APPLICATION_DOCUMENT',
      entityId: input.documentId,
      now,
    }),
  })
  return changed
    ? success({ value: true })
    : failure('The document was not found or its state changed.')
}

export const softDeleteApplicationDocument = (
  input: { applicationId: string; documentId: string; expectedVersion: number },
  context: ApplicationOperationContext,
) => changeDocumentDeletion(input, context, true)

export const restoreApplicationDocument = (
  input: { applicationId: string; documentId: string; expectedVersion: number },
  context: ApplicationOperationContext,
) => changeDocumentDeletion(input, context, false)

/** Claims at most 50 objects per cron invocation to keep maintenance bounded. */
export const cleanupExpiredDocumentUploads = async (
  context: Pick<ApplicationOperationContext, 'db' | 'env'>,
  now = new Date(),
): Promise<void> => {
  const claimed = await claimExpiredUploadIntents(context.db, now, 50)
  for (const intent of claimed) {
    try {
      await context.env.STORAGE.delete(intent.objectKey)
      if (intent.cleanupTargetStatus === 'REJECTED') {
        await markUploadIntentRejected(context.db, intent.id, now)
      } else {
        await markUploadIntentExpired(context.db, intent.id, now)
      }
    } catch {
      // Keep this row CLEANUP_PENDING and continue. A single unavailable R2
      // object must not starve every later intent in the bounded cron batch.
      // Do not log object keys because storage identifiers are sensitive.
      console.error('Document upload cleanup failed', intent.id)
    }
  }
}
