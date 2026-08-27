/** Applicant document authorization, finalization, download, and lifecycle. */
import { auditActions } from '../../../db/schema'
import { batch } from '../../../db'
import { findPinnedRulesForApplication } from '../queries/form-template'
import {
  claimExpiredUploadIntents,
  claimUploadIntentForCleanup,
  closeUploadIntentStatement,
  finalizeUploadIntent,
  findApplicationDocument,
  findApplicationDocumentById,
  findOwnedDocumentVersion,
  findOwnedUploadIntent,
  insertUploadIntent,
  markUploadIntentExpired,
  markUploadIntentRejected,
  setDocumentDeleted,
} from '../queries/document'
import {
  findOwnedApplicationHead,
  listOpenRevisionStageKeys,
} from '../queries/application'
import {
  AUTH_REQUIRED_MESSAGE,
  afterSuccessfulClaim,
  auditRecord,
  currentApplicant,
  runConstraintSafe,
} from '../support'
import { failure, success } from '../../envelope'
import type { ResolvedFormTemplate } from '../form/types'
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
  extensionMatchesContentType,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_MEGABYTES,
  sanitizeFilename,
  validSha256Base64,
  verifyUploadedObject,
  type AllowedContentType,
} from '../uploads'
import { queue, sendBestEffort } from '../../queue'
import {
  objectRemover,
  storage,
  UPLOAD_TTL_SECONDS,
  type UploadRequest,
} from '../../storage'

/**
 * Whether this particular slot may be changed right now.
 *
 * Per slot rather than per application, because a document belongs to whatever
 * stage its FILE field sits in and a revision reopens named stages. The old
 * rule asked whether a stage literally called `DOCUMENTS` was open, which was
 * the enum's last surviving assumption: a cycle that puts its bank details
 * beside the financial questions would have had every upload refused.
 */
const canEditDocument = async (
  context: ApplicationOperationContext,
  applicationId: string,
  status: string,
  template: ResolvedFormTemplate,
  fieldKey: DocumentType,
): Promise<boolean> => {
  if (status === 'DRAFT') return true
  if (status !== 'REVISION_REQUIRED') return false
  const stageKey = template.byKey.get(fieldKey)?.stageKey
  if (!stageKey) return false
  return (await listOpenRevisionStageKeys(context.db, applicationId)).has(stageKey)
}

/**
 * The stage a document's FILE question sits in.
 *
 * The write guards on this too, so it has to be the same answer the controller
 * reached — a document belongs to whatever stage its question is in, and a
 * revision reopens stages by name.
 */
const documentStageKey = (
  template: ResolvedFormTemplate,
  fieldKey: DocumentType,
): string | null => template.byKey.get(fieldKey)?.stageKey ?? null

export const issueDocumentUpload = async (
  input: {
    applicationId: string
    fieldKey: DocumentType
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
  if (!Number.isInteger(input.expectedDocumentVersion) || input.expectedDocumentVersion < 0) {
    return failure('Expected document version must be a non-negative integer.')
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_DOCUMENT_BYTES
  ) return failure(`Documents must contain 1 byte through ${MAX_DOCUMENT_MEGABYTES} MB.`)
  if (!ALLOWED_DOCUMENT_CONTENT_TYPES.includes(input.contentType as AllowedContentType)) {
    return failure('Documents must be PDF, JPEG, or PNG.')
  }
  if (!validSha256Base64(input.checksumSha256)) {
    return failure('Provide the base64-encoded SHA-256 checksum.')
  }
  const originalFilename = sanitizeFilename(input.originalFilename)
  if (!originalFilename) return failure('The original filename is invalid.')
  /*
   * The name is the one thing about an upload that is stored and served back,
   * so it must not describe something the file is not. `report.pdf.exe` passes
   * the type and signature checks and fails here.
   */
  if (!extensionMatchesContentType(originalFilename, input.contentType as AllowedContentType)) {
    return failure('The file name must end in .pdf, .jpg, .jpeg or .png, matching the file.')
  }
  const application = await findOwnedApplicationHead(
    context.db,
    applicant.id,
    input.applicationId,
  )
  if (!application) return failure('The application was not found.')
  /*
   * Which documents exist is the cycle's decision, so the slot is checked
   * against the template this application is pinned to rather than a list in
   * code. Read before the edit rule, because that rule now needs the template
   * too: it asks which stage this slot belongs to.
   */
  const pinned = await findPinnedRulesForApplication(
    context.db,
    application.id,
    application.currentVersion,
  )
  if (!pinned) return failure('This application’s form is unavailable.')
  if (!pinned.template.documentFieldKeys.has(input.fieldKey)) {
    return failure('This application does not ask for that document.')
  }
  const slotStageKey = documentStageKey(pinned.template, input.fieldKey)
  if (slotStageKey === null) {
    return failure('This application does not ask for that document.')
  }
  /*
   * The slot's own size limit, where the cycle set one.
   *
   * **This column enforced nothing at all.** A cycle could declare "at most
   * 500 KB for the plan", the client would render the limit from the template,
   * and both size gates measured against `MAX_DOCUMENT_BYTES` alone — so the
   * programme's own two megabytes were accepted for every slot and the
   * authored figure was decoration. It bounds the authorization rather than
   * the arriving bytes because the arriving bytes must equal the size the
   * authorization fixed, which `verifyUploadedObject` already demands.
   *
   * Only downwards: `MAX_DOCUMENT_BYTES` is checked above and stays the
   * ceiling, so a cycle can ask for something smaller and never for more.
   */
  const slotLimit = pinned.template.byKey.get(input.fieldKey)?.rules.maxFileBytes ?? null
  if (slotLimit !== null && input.sizeBytes > slotLimit) {
    return failure(
      `${pinned.template.byKey.get(input.fieldKey)!.label} must be `
      + `${Math.floor(slotLimit / 1024)} KB or smaller.`,
    )
  }
  if (!(await canEditDocument(
    context, application.id, application.status, pinned.template, input.fieldKey,
  ))) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const current = await findApplicationDocument(context.db, application.id, input.fieldKey)
  if (
    (current === null && input.expectedDocumentVersion !== 0) ||
    (current !== null &&
      (current.deletedAt !== null || current.currentVersion !== input.expectedDocumentVersion))
  ) return failure('The document changed. Refresh it and try again.')

  const now = new Date()
  const uploadId = crypto.randomUUID()
  const objectKey = createDocumentObjectKey(application.id, input.fieldKey)
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
      fieldKey: input.fieldKey,
      stageKey: slotStageKey,
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
      metadata: { fieldKey: input.fieldKey },
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
      await objectRemover(context.env).remove([intent.objectKey])
      await markUploadIntentExpired(context.db, intent.id, now)
    })
    return failure('The upload authorization expired.')
  }
  const application = await findOwnedApplicationHead(
    context.db,
    applicant.id,
    intent.applicationId,
  )
  const finalizePinned = application
    ? await findPinnedRulesForApplication(
        context.db, application.id, application.currentVersion,
      )
    : null
  if (
    !application ||
    !finalizePinned ||
    !(await canEditDocument(
      context, intent.applicationId, application.status, finalizePinned.template, intent.fieldKey,
    ))
  ) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const slotStageKey = documentStageKey(finalizePinned.template, intent.fieldKey)
  if (slotStageKey === null) {
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
      await objectRemover(context.env).remove([intent.objectKey])
      await markUploadIntentRejected(context.db, intent.id, now)
    })
    return failure(verification.message)
  }
  const existing = await findApplicationDocument(
    context.db,
    intent.applicationId,
    intent.fieldKey,
  )
  const documentId = existing?.id ?? crypto.randomUUID()
  const nextVersion = intent.expectedDocumentVersion + 1
  const documentVersionId = crypto.randomUUID()
  const finalized = await runConstraintSafe(() => finalizeUploadIntent(context.db, {
      intent,
      stageKey: slotStageKey,
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
        metadata: { fieldKey: intent.fieldKey, version: nextVersion },
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
  /*
   * The slot is read off the document rather than taken from the caller.
   *
   * Removing an existing document names it by id, so there is no field key to
   * check — and inventing one from the request would let a caller nominate a
   * slot whose stage happens to be open in order to remove a document from one
   * that is not.
   */
  const document = await findApplicationDocumentById(
    context.db, application.id, input.documentId,
  )
  if (!document) return failure('The document was not found or its state changed.')
  const pinned = await findPinnedRulesForApplication(
    context.db,
    application.id,
    application.currentVersion,
  )
  if (!pinned) return failure('This application’s form is unavailable.')
  if (!(await canEditDocument(
    context, application.id, application.status, pinned.template, document.fieldKey,
  ))) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const slotStageKey = documentStageKey(pinned.template, document.fieldKey)
  if (slotStageKey === null) {
    return failure('Documents cannot be changed in the application’s current status.')
  }
  const now = new Date()
  const changed = await setDocumentDeleted(context.db, {
    applicationId: application.id,
    documentId: input.documentId,
    stageKey: slotStageKey,
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
  if (claimed.length === 0) return

  /*
   * One delete for the whole batch. The store takes an array, and fifty
   * objects previously meant fifty calls.
   *
   * **A failure falls back to deleting them one at a time**, and that is not a
   * refinement. The claim query has no ordering, so each run picks up the same
   * rows: a single object the bucket will never delete would hold up its fifty
   * companions not for an hour but for ever, and every intent queued behind
   * them with it. Isolating the failure costs fifty calls on the rare run that
   * needs it and keeps the ordinary run at one.
   *
   * Object keys are never logged: a storage identifier is sensitive.
   */
  let removed = claimed
  try {
    await objectRemover(context.env).remove(claimed.map((intent) => intent.objectKey))
  } catch {
    console.error('Document upload cleanup could not remove its objects in one call')
    const survivors = await Promise.all(
      claimed.map(async (intent) => {
        try {
          await objectRemover(context.env).remove([intent.objectKey])
          return intent
        } catch {
          return null
        }
      }),
    )
    removed = survivors.filter((intent) => intent !== null)
    if (removed.length === 0) return
  }

  // The objects are gone, so every claim can be closed in one statement. Only
  // the ones actually removed: a row whose object survives must stay claimable.
  await batch(context.db, (tx) =>
    removed.map((intent) =>
      closeUploadIntentStatement(tx, intent.id, intent.cleanupTargetStatus, now),
    ),
  )
}

