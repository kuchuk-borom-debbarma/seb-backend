/**
 * Cycle policy PDF authorization, finalization, download, and lifecycle.
 *
 * The office's twin of the applicant document flow: issue a signed upload,
 * verify the arrived bytes, record an immutable version, queue the malware
 * scan, and fail every read closed until the scan is ACCEPTED. Only PDF is
 * accepted — the policy document is the order or circular the cycle
 * implements, and it is served to every applicant.
 */
import { auditActions } from '../../../db/schema'
import { failure, success } from '../../envelope'
import {
  afterSuccessfulClaim,
  runConstraintSafe,
} from '../../application/support'
import type {
  DownloadAuthorization,
  UploadAuthorization,
} from '../../application/types'
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_MEGABYTES,
  extensionMatchesContentType,
  sanitizeFilename,
  validSha256Base64,
  verifyUploadedObject,
} from '../../application/uploads'
import { queue, sendBestEffort } from '../../queue'
import {
  objectRemover,
  storage,
  UPLOAD_TTL_SECONDS,
} from '../../storage'
import {
  claimExpiredPolicyUploadIntents,
  claimPolicyUploadIntentForCleanup,
  closePolicyUploadIntentStatement,
  finalizePolicyUploadIntent,
  findCyclePolicyDocument,
  findCyclePolicyDocumentVersion,
  findPolicyUploadIntent,
  insertPolicyUploadIntent,
} from '../queries/policy-document'
import { loadProgrammeCycle } from '../queries/programme-cycle'
import { ADMIN_REQUIRED_MESSAGE, adminAudit, currentStaff } from '../support'
import type { AdminOperationContext, AdminResult } from '../types'
import { batch } from '../../../db'

/**
 * Where a cycle may still change its published policy: while it is a draft or
 * live. A closed or archived cycle's document is part of its record.
 */
const cycleAcceptsPolicyUpload = (status: string): boolean =>
  status === 'DRAFT' || status === 'OPEN'

export const issueCyclePolicyUpload = async (
  input: {
    cycleId: string
    expectedDocumentVersion: number
    originalFilename: string
    contentType: string
    sizeBytes: number
    checksumSha256: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<UploadAuthorization>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  if (!Number.isInteger(input.expectedDocumentVersion) || input.expectedDocumentVersion < 0) {
    return failure('Expected document version must be a non-negative integer.')
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_DOCUMENT_BYTES
  ) return failure(`The policy document must contain 1 byte through ${MAX_DOCUMENT_MEGABYTES} MB.`)
  if (input.contentType !== 'application/pdf') {
    return failure('The policy document must be a PDF.')
  }
  if (!validSha256Base64(input.checksumSha256)) {
    return failure('Provide the base64-encoded SHA-256 checksum.')
  }
  const originalFilename = sanitizeFilename(input.originalFilename)
  if (!originalFilename) return failure('The original filename is invalid.')
  if (!extensionMatchesContentType(originalFilename, 'application/pdf')) {
    return failure('The file name must end in .pdf, matching the file.')
  }
  const cycle = await loadProgrammeCycle(context.db, input.cycleId)
  if (!cycle || cycle.head.deletedAt !== null) {
    return failure('The programme cycle was not found.')
  }
  if (!cycleAcceptsPolicyUpload(cycle.head.status)) {
    return failure('A closed or archived cycle keeps its policy document as is.')
  }
  const current = await findCyclePolicyDocument(context.db, input.cycleId)
  if ((current?.head.currentVersion ?? 0) !== input.expectedDocumentVersion) {
    return failure('The policy document changed. Refresh it and try again.')
  }

  const now = new Date()
  const uploadId = crypto.randomUUID()
  const objectKey = `cycles/${input.cycleId}/policy/${crypto.randomUUID()}`
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000)
  const authorization = await storage(context.env, context.requestUrl).authorizeUpload({
    uploadId,
    objectKey,
    originalFilename,
    contentType: 'application/pdf',
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
    expiresAt,
  })
  await insertPolicyUploadIntent(
    context.db,
    {
      id: uploadId,
      programmeCycleId: input.cycleId,
      issuedByUserId: administrator.id,
      expectedDocumentVersion: input.expectedDocumentVersion,
      objectKey,
      originalFilename,
      contentType: 'application/pdf',
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      status: 'ISSUED',
      cleanupTargetStatus: null,
      expiresAt,
      finalizedDocumentVersionId: null,
      createdAt: now,
      updatedAt: now,
    },
    adminAudit(context, {
      actorUserId: administrator.id,
      action: auditActions.cyclePolicyUploadIssued,
      entityType: 'SEB_CYCLE_POLICY_UPLOAD_INTENT',
      entityId: uploadId,
      metadata: { cycleId: input.cycleId },
      now,
    }),
  )
  return success({ uploadId, ...authorization })
}

export const finalizeCyclePolicyUpload = async (
  uploadId: string,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const intent = await findPolicyUploadIntent(context.db, uploadId)
  if (!intent || intent.status !== 'ISSUED') {
    return failure('The upload authorization is invalid or already used.')
  }
  const now = new Date()
  if (intent.expiresAt.getTime() <= now.getTime()) {
    const claimed = await claimPolicyUploadIntentForCleanup(context.db, intent.id, now, 'EXPIRED')
    await afterSuccessfulClaim(claimed, async () => {
      await objectRemover(context.env).remove([intent.objectKey])
      await closePolicyUploadIntentStatement(context.db, intent.id, 'EXPIRED', now)
    })
    return failure('The upload authorization expired.')
  }
  const cycle = await loadProgrammeCycle(context.db, intent.programmeCycleId)
  if (!cycle || cycle.head.deletedAt !== null || !cycleAcceptsPolicyUpload(cycle.head.status)) {
    return failure('A closed or archived cycle keeps its policy document as is.')
  }
  const verification = await verifyUploadedObject(storage(context.env, context.requestUrl), {
    objectKey: intent.objectKey,
    contentType: 'application/pdf',
    sizeBytes: intent.sizeBytes,
    checksumSha256: intent.checksumSha256,
  })
  if (!verification.valid) {
    const claimed = await claimPolicyUploadIntentForCleanup(context.db, intent.id, now, 'REJECTED')
    await afterSuccessfulClaim(claimed, async () => {
      await objectRemover(context.env).remove([intent.objectKey])
      await closePolicyUploadIntentStatement(context.db, intent.id, 'REJECTED', now)
    })
    return failure(verification.message)
  }
  const existing = await findCyclePolicyDocument(context.db, intent.programmeCycleId)
  const documentId = existing?.head.id ?? crypto.randomUUID()
  const nextVersion = intent.expectedDocumentVersion + 1
  const documentVersionId = crypto.randomUUID()
  const finalized = await runConstraintSafe(() => finalizePolicyUploadIntent(context.db, {
    intent,
    documentId,
    documentVersionId,
    nextVersion,
    userId: administrator.id,
    now,
    audit: adminAudit(context, {
      actorUserId: administrator.id,
      action: auditActions.cyclePolicyFinalized,
      entityType: 'SEB_CYCLE_POLICY_DOCUMENT',
      entityId: documentId,
      metadata: { cycleId: intent.programmeCycleId, version: nextVersion },
      now,
    }),
  }))
  if (!finalized) return failure('The policy document changed. Refresh it and try again.')

  // Queued rather than scanned here, and a failure to queue is swallowed, for
  // the same reasons as the applicant flow: the upload genuinely succeeded,
  // and an unscanned document cannot be read or opened against — the lost
  // message costs availability, never safety.
  await sendBestEffort(
    queue(context.env),
    { kind: 'POLICY_DOCUMENT_SCAN_REQUESTED', policyDocumentVersionId: documentVersionId },
    'The policy document scan',
  )
  // The whole aggregate back, like every other cycle mutation, so the screen
  // repaints from one answer rather than refetching.
  return success((await loadProgrammeCycle(context.db, intent.programmeCycleId))!)
}

/**
 * A short-lived download URL for one version of the cycle's policy PDF.
 *
 * Staff-facing. Fails closed unless the named version's latest scan verdict
 * is ACCEPTED, exactly like applicant documents: no environment flag makes an
 * unscanned file readable.
 */
export const cyclePolicyDownloadUrl = async (
  input: { cycleId: string; version?: number | null },
  context: AdminOperationContext,
): Promise<AdminResult<DownloadAuthorization>> => {
  const administrator = await currentStaff(context, 'STAFF_READ')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const record = input.version == null
    ? await findCyclePolicyDocument(context.db, input.cycleId)
    : await findCyclePolicyDocumentVersion(context.db, input.cycleId, input.version)
  if (!record) return failure('The policy document was not found.')
  if (record.scanStatus !== 'ACCEPTED') {
    return failure('The policy document has not passed its malware check yet.')
  }
  return success(
    await storage(context.env, context.requestUrl).authorizeDownload(
      record.version.r2ObjectKey,
      record.version.originalFilename,
      new Date(),
    ),
  )
}

/** Claims at most 50 objects per scheduled run, like the applicant cleanup. */
export const cleanupExpiredCyclePolicyUploads = async (
  context: Pick<AdminOperationContext, 'db' | 'env'>,
  now = new Date(),
): Promise<void> => {
  const claimed = await claimExpiredPolicyUploadIntents(context.db, now, 50)
  if (claimed.length === 0) return

  // One delete for the batch, isolating a stuck object on failure — the same
  // rationale, spelled out in full, as `cleanupExpiredDocumentUploads`.
  let removed = claimed
  try {
    await objectRemover(context.env).remove(claimed.map((intent) => intent.objectKey))
  } catch {
    console.error('Policy upload cleanup could not remove its objects in one call')
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

  await batch(context.db, (tx) =>
    removed.map((intent) =>
      closePolicyUploadIntentStatement(tx, intent.id, intent.cleanupTargetStatus, now),
    ),
  )
}
