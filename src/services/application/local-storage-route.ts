/**
 * The route that receives uploads when there is no bucket to send them to.
 *
 * On a developer's machine there are no R2 credentials, so nothing can sign a
 * URL addressed to the bucket. The `STORAGE` binding itself works locally
 * though — the development runtime provides it — so the bytes come here and
 * this writes them.
 *
 * **It refuses unless the local backend is the selected one.** A deployed
 * environment sends the browser to the bucket, and this path must not be a
 * second way in. That check is the whole security boundary of this file, so it
 * comes first and there is no way past it.
 *
 * Authorization for an accepted upload is possession of the upload id, exactly
 * as it is possession of a signed URL. The id is unguessable, and the retained
 * authorization is re-checked here — still issued, not expired, and matching on
 * type and size — before a single byte is written.
 */
import { eq } from 'drizzle-orm'
import { sebDocumentUploadIntent } from '../../db/schema'
import { LOCAL_STORAGE_PATH, usesLocalStorage } from './storage'
import type { ApplicationOperationContext } from './types'
import { MAX_DOCUMENT_BYTES } from './uploads'

const base64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const refuse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ success: false, message, response: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Handles a local storage request, or returns `null` when the path is not one.
 *
 * Returning `null` rather than a 404 lets the caller keep its own routing:
 * this only claims the requests that are actually its own.
 */
export const handleLocalStorageRequest = async (
  request: Request,
  context: ApplicationOperationContext,
): Promise<Response | null> => {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(`${LOCAL_STORAGE_PATH}/`)) return null

  // The boundary. Everything below assumes a developer's machine.
  if (!usesLocalStorage(context.env)) return refuse(404, 'Not found.')

  if (request.method === 'PUT') {
    const uploadId = url.pathname.slice(`${LOCAL_STORAGE_PATH}/uploads/`.length)
    return uploadId ? putObject(request, context, uploadId) : refuse(404, 'Not found.')
  }
  if (request.method === 'GET' && url.pathname === `${LOCAL_STORAGE_PATH}/objects`) {
    return getObject(context, url)
  }
  return refuse(405, 'Method not allowed.')
}

const putObject = async (
  request: Request,
  context: ApplicationOperationContext,
  uploadId: string,
): Promise<Response> => {
  const [intent] = await context.db
    .select()
    .from(sebDocumentUploadIntent)
    .where(eq(sebDocumentUploadIntent.id, uploadId))
    .limit(1)

  // A missing intent and a spent one are refused identically, so the path
  // cannot be used to discover which upload ids exist.
  if (!intent || intent.status !== 'ISSUED' || intent.expiresAt.getTime() <= Date.now()) {
    return refuse(403, 'This upload authorization is not usable.')
  }

  const body = await request.arrayBuffer()
  if (body.byteLength !== intent.sizeBytes || body.byteLength > MAX_DOCUMENT_BYTES) {
    return refuse(400, 'The uploaded file size does not match the authorization.')
  }
  if (request.headers.get('content-type') !== intent.contentType) {
    return refuse(400, 'The uploaded file type does not match the authorization.')
  }

  /*
   * The bucket refuses a payload whose checksum differs from the one the
   * applicant declared, and records the digest against the object. This does
   * the same, so what finalization checks afterwards is the same either way —
   * otherwise a document would verify locally and not in a deployed
   * environment, which is the worst kind of difference to have.
   */
  const digest = await crypto.subtle.digest('SHA-256', body)
  if (base64(digest) !== intent.checksumSha256) {
    return refuse(400, 'The uploaded file checksum does not match.')
  }

  await context.env.STORAGE.put(intent.objectKey, body, {
    sha256: digest,
    httpMetadata: {
      contentType: intent.contentType,
      contentDisposition: request.headers.get('content-disposition') ?? undefined,
    },
  })
  // Finalization stays where it is: this accepts bytes and records the digest.
  // The existing mutation is what checks the file's own signature and turns the
  // intent into an immutable document version.
  return new Response(null, { status: 200 })
}

const getObject = async (
  context: ApplicationOperationContext,
  url: URL,
): Promise<Response> => {
  const key = url.searchParams.get('key')
  const object = key ? await context.env.STORAGE.get(key) : null
  if (!object) return refuse(404, 'Not found.')

  const filename = url.searchParams.get('filename') ?? 'document'
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      // Attachment-only, matching what a signed download would force.
      'content-disposition': `attachment; filename="${
        filename.replace(/[^A-Za-z0-9._ -]/gu, '_')
      }"`,
    },
  })
}
