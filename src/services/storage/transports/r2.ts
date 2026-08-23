/**
 * The bucket receives the upload; this Worker never sees the bytes.
 *
 * The browser is given a URL signed for `r2.cloudflarestorage.com` and puts the
 * file there directly. The only file that knows R2 exists.
 */
import { AwsClient } from 'aws4fetch'
import type { AppBindings } from '../../../bindings'
import {
  attachmentHeader,
  base64FromBytes,
  DOWNLOAD_TTL_SECONDS,
  UPLOAD_TTL_SECONDS,
} from '../policy'
import type {
  ObjectFacts,
  RequiredHeader,
  StorageBackend,
} from '../types'

export type R2Configuration = {
  accountId: string
  bucketName: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Reads the four values, refusing when any is absent.
 *
 * A deployed environment that cannot reach its bucket must say so rather than
 * quietly accepting documents it cannot durably keep.
 */
export const requireR2Configuration = (env: AppBindings): R2Configuration => {
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env
  if (!R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 signing configuration is required.')
  }
  return {
    accountId: R2_ACCOUNT_ID,
    bucketName: R2_BUCKET_NAME,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  }
}

const objectUrl = (configuration: R2Configuration, objectKey: string): URL => {
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  return new URL(
    `https://${configuration.accountId}.r2.cloudflarestorage.com/${
      encodeURIComponent(configuration.bucketName)
    }/${encodedKey}`,
  )
}

/**
 * `bucket` is the binding, used only for reading an object back.
 *
 * Signing addresses the bucket over the network; describing an object that has
 * already arrived goes through the binding, which is cheaper and needs no
 * signature.
 */
export const r2Transport = (
  configuration: R2Configuration,
  bucket: R2Bucket,
): StorageBackend => {
  const client = new AwsClient({
    service: 's3',
    region: 'auto',
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey,
  })

  return {
    name: 'r2',

    authorizeUpload: async (request) => {
      const url = objectUrl(configuration, request.objectKey)
      url.searchParams.set('X-Amz-Expires', String(UPLOAD_TTL_SECONDS))
      const requiredHeaders: RequiredHeader[] = [
        { name: 'Content-Type', value: request.contentType },
        {
          name: 'Content-Disposition',
          value: attachmentHeader(request.originalFilename),
        },
        // Binding Content-Length makes the bucket reject a payload that differs
        // from the applicant's validated declaration. Browsers generate this
        // forbidden request header from the body, so a caller sends a body of
        // exactly this size rather than trying to set the header.
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
      const url = objectUrl(configuration, objectKey)
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

    describe: async (objectKey): Promise<ObjectFacts | null> => {
      const object = await bucket.head(objectKey)
      if (!object) return null
      return {
        sizeBytes: object.size,
        contentType: object.httpMetadata?.contentType ?? null,
        checksumSha256: object.checksums.sha256
          ? base64FromBytes(object.checksums.sha256)
          : null,
      }
    },

    readPrefix: async (objectKey, byteCount) => {
      const prefix = await bucket.get(objectKey, {
        range: { offset: 0, length: byteCount },
      })
      if (!prefix || !('body' in prefix)) return null
      return new Uint8Array(await prefix.arrayBuffer())
    },
  }
}
