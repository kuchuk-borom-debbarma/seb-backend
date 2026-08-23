/**
 * Where an applicant's documents are kept, and who receives the bytes.
 *
 * The programme needs three things from storage: authorize an upload the
 * browser performs itself, authorize a download, and check what arrived. That
 * is the whole interface. It names no vendor — S3, R2, Azure and Google all
 * satisfy it, and so does this Worker.
 *
 * ## Two implementations, differing in one thing
 *
 * | | Receives the upload |
 * | --- | --- |
 * | `r2`    | the bucket, straight from the browser, via a signed URL |
 * | `local` | this Worker, which writes to the `STORAGE` binding |
 *
 * The local one exists because uploads have to work on a developer's machine.
 * Signing addresses `r2.cloudflarestorage.com` for real, so it needs real
 * credentials and a bucket that exists — but the `STORAGE` binding itself works
 * locally, provided by the development runtime with no account feature and no
 * keys. So locally the bytes come here and this writes them; deployed, the
 * browser talks to the bucket and this is never in the path.
 *
 * Both return the same grant shape, so the client cannot tell which it is
 * talking to. Only the host in the URL differs.
 */
import { AwsClient } from 'aws4fetch'
import type { ApplicationOperationContext } from './types'
import {
  DOWNLOAD_TTL_SECONDS,
  UPLOAD_TTL_SECONDS,
  attachmentHeader,
  type AllowedContentType,
} from './uploads'

/** A header the caller must send with the upload, exactly as given. */
export type RequiredHeader = { name: string; value: string }

export type UploadGrant = {
  uploadUrl: string
  expiresAt: Date
  requiredHeaders: RequiredHeader[]
}

export type DownloadGrant = { downloadUrl: string; expiresAt: Date }

export type UploadRequest = {
  /** Identifies the retained authorization, and addresses the local route. */
  uploadId: string
  objectKey: string
  originalFilename: string
  contentType: AllowedContentType
  sizeBytes: number
  checksumSha256: string
  expiresAt: Date
}

export type StorageBackend = {
  /** Which backend this is, for diagnostics and for the local route's guard. */
  readonly name: string
  authorizeUpload(request: UploadRequest): Promise<UploadGrant>
  authorizeDownload(
    objectKey: string,
    originalFilename: string,
    now: Date,
  ): Promise<DownloadGrant>
}

/** The path the local backend receives uploads and serves downloads on. */
export const LOCAL_STORAGE_PATH = '/internal/storage'

const requireR2Configuration = (context: ApplicationOperationContext) => {
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } =
    context.env
  if (!R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 signing configuration is required.')
  }
  return { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY }
}

const objectUrl = (accountId: string, bucket: string, objectKey: string): URL => {
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  return new URL(
    `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`,
  )
}

/** The browser sends the bytes to the bucket; this Worker never sees them. */
const r2Backend = (context: ApplicationOperationContext): StorageBackend => {
  const configuration = requireR2Configuration(context)
  const client = new AwsClient({
    service: 's3',
    region: 'auto',
    accessKeyId: configuration.R2_ACCESS_KEY_ID,
    secretAccessKey: configuration.R2_SECRET_ACCESS_KEY,
  })

  return {
    name: 'r2',
    authorizeUpload: async (request) => {
      const url = objectUrl(
        configuration.R2_ACCOUNT_ID,
        configuration.R2_BUCKET_NAME,
        request.objectKey,
      )
      url.searchParams.set('X-Amz-Expires', String(UPLOAD_TTL_SECONDS))
      const requiredHeaders: RequiredHeader[] = [
        { name: 'Content-Type', value: request.contentType },
        {
          name: 'Content-Disposition',
          value: attachmentHeader(request.originalFilename),
        },
        // Binding Content-Length makes R2 reject a payload that differs from
        // the applicant's validated declaration. Browsers generate this
        // forbidden request header from the Blob/body; callers must send a body
        // of exactly this size rather than trying to set the header.
        { name: 'Content-Length', value: String(request.sizeBytes) },
        { name: 'If-None-Match', value: '*' },
        { name: 'x-amz-checksum-sha256', value: request.checksumSha256 },
      ]
      const signed = await client.sign(
        new Request(url, {
          method: 'PUT',
          headers: Object.fromEntries(
            requiredHeaders.map((header) => [header.name, header.value]),
          ),
        }),
        // aws4fetch excludes Content-Length and Content-Type by default.
        // allHeaders is required because these are security constraints, not
        // optional request metadata.
        { aws: { signQuery: true, allHeaders: true } },
      )
      return { uploadUrl: signed.url, expiresAt: request.expiresAt, requiredHeaders }
    },

    authorizeDownload: async (objectKey, originalFilename, now) => {
      const url = objectUrl(
        configuration.R2_ACCOUNT_ID,
        configuration.R2_BUCKET_NAME,
        objectKey,
      )
      url.searchParams.set('X-Amz-Expires', String(DOWNLOAD_TTL_SECONDS))
      // Override object metadata on every signed GET so even objects lacking
      // stored disposition metadata stay attachment-only in browsers.
      url.searchParams.set(
        'response-content-disposition',
        attachmentHeader(originalFilename),
      )
      const signed = await client.sign(new Request(url), { aws: { signQuery: true } })
      return {
        downloadUrl: signed.url,
        expiresAt: new Date(now.getTime() + DOWNLOAD_TTL_SECONDS * 1000),
      }
    },
  }
}

/**
 * The bytes come to this Worker, which writes them to the `STORAGE` binding.
 *
 * Authorization is possession of the URL, exactly as with a signed one: the
 * upload id is unguessable, and the route re-checks the retained authorization
 * — still issued, unexpired, and matching on size and type — before accepting
 * anything. The route additionally refuses unless this backend is the selected
 * one, so the path cannot accept bytes in a deployed environment.
 */
const localBackend = (context: ApplicationOperationContext): StorageBackend => {
  const origin = new URL(context.requestUrl).origin

  return {
    name: 'local',
    authorizeUpload: async (request) => ({
      uploadUrl: `${origin}${LOCAL_STORAGE_PATH}/uploads/${request.uploadId}`,
      expiresAt: request.expiresAt,
      /*
       * The same headers the bucket would be given. They are re-checked on
       * arrival, so a developer's upload is validated the same way a real one
       * is rather than being waved through.
       */
      requiredHeaders: [
        { name: 'Content-Type', value: request.contentType },
        {
          name: 'Content-Disposition',
          value: attachmentHeader(request.originalFilename),
        },
        { name: 'Content-Length', value: String(request.sizeBytes) },
      ],
    }),

    authorizeDownload: async (objectKey, originalFilename, now) => {
      const url = new URL(`${origin}${LOCAL_STORAGE_PATH}/objects`)
      url.searchParams.set('key', objectKey)
      url.searchParams.set('filename', originalFilename)
      return {
        downloadUrl: url.toString(),
        expiresAt: new Date(now.getTime() + DOWNLOAD_TTL_SECONDS * 1000),
      }
    },
  }
}

/**
 * The backend for this environment.
 *
 * Unset means local, because an unconfigured machine is a developer's — a
 * deployed environment is always told what it is. Anything else means the bytes
 * must go to the real bucket, and a missing configuration refuses rather than
 * quietly accepting documents this Worker cannot durably keep.
 *
 * Built per call, like every other configuration in this codebase.
 */
export const storage = (context: ApplicationOperationContext): StorageBackend => {
  const environment = (context.env.ENVIRONMENT ?? '').trim().toLowerCase()
  return environment === '' || environment === 'local'
    ? localBackend(context)
    : r2Backend(context)
}

/**
 * Authorizes one upload through whichever backend this environment uses.
 *
 * These two live here rather than beside the signing helpers so that the
 * dependency runs one way: storage knows about the shared constants, and
 * nothing in `uploads.ts` needs to know a backend exists.
 */
export const createUploadAuthorization = async (
  context: ApplicationOperationContext,
  input: UploadRequest,
): Promise<UploadGrant> => storage(context).authorizeUpload(input)

export const createDownloadAuthorization = async (
  context: ApplicationOperationContext,
  objectKey: string,
  originalFilename: string,
  now: Date,
): Promise<DownloadGrant> =>
  storage(context).authorizeDownload(objectKey, originalFilename, now)
