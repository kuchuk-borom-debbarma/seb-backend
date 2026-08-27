/**
 * Documents are kept in Cloudinary, and this Worker relays them.
 *
 * The only file that knows Cloudinary exists.
 *
 * ## Why the bytes come through the Worker
 *
 * R2 hands the browser a signed `PUT` and never sees the file. Cloudinary
 * cannot be driven that way: its upload API takes a multipart `POST` with
 * signed *form fields*, not a signed URL with headers, so a direct-to-provider
 * grant would change the shape of `UploadGrant` and every client that follows
 * it. Relaying instead keeps one upload contract for every backend, which is
 * the same trade the local transport already makes.
 *
 * The cost is real and bounded: a document is held in memory once, and the
 * programme caps a document at 2 MB.
 *
 * ## Why uploads are `authenticated`
 *
 * A default Cloudinary upload is served to anyone who knows its URL. Applicant
 * evidence includes identity and bank documents, so assets are stored as
 * `authenticated`, which is unreachable without a signature. Downloads are
 * relayed too, so no Cloudinary URL — signed or otherwise — ever reaches a
 * browser.
 */
import type { AppBindings } from '../../../bindings'
import {
  attachmentHeader,
  base64FromBytes,
  DOWNLOAD_TTL_SECONDS,
  LOCAL_STORAGE_PATH,
} from '../policy'
import type { ObjectFacts, StorageBackend } from '../types'

export type CloudinaryConfiguration = {
  cloudName: string
  apiKey: string
  apiSecret: string
}

/**
 * Reads the three values, refusing when any is absent.
 *
 * A deployed environment that cannot reach its store must say so rather than
 * quietly accepting documents it cannot durably keep.
 */
export const requireCloudinaryConfiguration = (
  env: AppBindings,
): CloudinaryConfiguration => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary configuration is required.')
  }
  return {
    cloudName: CLOUDINARY_CLOUD_NAME,
    apiKey: CLOUDINARY_API_KEY,
    apiSecret: CLOUDINARY_API_SECRET,
  }
}

const hex = (value: ArrayBuffer): string =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const sha1 = async (value: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest('SHA-1', new TextEncoder().encode(value))

/**
 * Cloudinary's upload signature: the signed parameters, sorted by name and
 * joined as a query string, with the API secret appended and SHA-1 applied.
 *
 * `file`, `api_key` and `resource_type` are excluded by the provider's own
 * rule — `resource_type` travels in the path rather than the body.
 */
const signUpload = async (
  parameters: Record<string, string>,
  apiSecret: string,
): Promise<string> => {
  const signable = Object.keys(parameters)
    .sort()
    .map((name) => `${name}=${parameters[name]}`)
    .join('&')
  return hex(await sha1(`${signable}${apiSecret}`))
}

/**
 * A delivery URL for an `authenticated` asset.
 *
 * The signature covers the public id alone, because no transformation is
 * applied — the file is served exactly as it arrived. Used only by this Worker,
 * never handed out.
 */
const signedDeliveryUrl = async (
  configuration: CloudinaryConfiguration,
  objectKey: string,
): Promise<string> => {
  const digest = await sha1(`${objectKey}${configuration.apiSecret}`)
  const signature = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .slice(0, 8)
  return `https://res.cloudinary.com/${configuration.cloudName}/raw/authenticated/s--${signature}--/${objectKey}`
}

/**
 * Stores one object, and reads one back.
 *
 * Not part of `StorageBackend`: that interface describes authorizing a
 * transfer, and these are the transfer itself. Only the relaying route uses
 * them.
 */
export const cloudinaryObjectStore = (configuration: CloudinaryConfiguration) => ({
  put: async (
    objectKey: string,
    body: ArrayBuffer,
    facts: { contentType: string },
  ): Promise<void> => {
    // Seconds, as the provider's signature requires.
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signed = {
      public_id: objectKey,
      timestamp,
      type: 'authenticated',
    }
    const form = new FormData()
    form.set('file', new Blob([body], { type: facts.contentType }))
    form.set('api_key', configuration.apiKey)
    for (const [name, value] of Object.entries(signed)) form.set(name, value)
    form.set('signature', await signUpload(signed, configuration.apiSecret))

    /*
     * `raw` rather than `auto`, so the stored public id is exactly the key this
     * programme chose. `auto` classifies by content and rewrites the delivery
     * path per resource type, which would make the key alone insufficient to
     * find the object again.
     */
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${configuration.cloudName}/raw/upload`,
      { method: 'POST', body: form },
    )
    if (!response.ok) {
      // Never the body: a provider error can quote the request, and the request
      // carries a signature.
      throw new Error(`Cloudinary refused the upload (${response.status}).`)
    }
  },

  get: async (objectKey: string): Promise<Response | null> => {
    const response = await fetch(await signedDeliveryUrl(configuration, objectKey))
    return response.ok ? response : null
  },

  /*
   * Removing objects the programme has abandoned — an upload authorization
   * that expired or whose bytes were refused.
   *
   * The provider takes one public id per call, so the caller's batch becomes
   * one request each. That is the cost of not being a bucket, and the caller
   * already falls back to one call per object.
   *
   * **A missing asset is a success.** Cloudinary answers `not found` with
   * `200` and a result of `"not found"`, and the caller's contract is "the
   * object is gone" — which it is. Treating it as a failure would leave the
   * intent row claimable for ever, retried on every cleanup run against an
   * object that will never come back.
   */
  remove: async (objectKeys: string[]): Promise<void> => {
    for (const objectKey of objectKeys) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signed = { public_id: objectKey, timestamp, type: 'authenticated' }
      const form = new FormData()
      form.set('api_key', configuration.apiKey)
      for (const [name, value] of Object.entries(signed)) form.set(name, value)
      form.set('signature', await signUpload(signed, configuration.apiSecret))

      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${configuration.cloudName}/raw/destroy`,
        { method: 'POST', body: form },
      )
      // Never the body, for the reason `put` gives: it can quote the signature.
      if (!response.ok) {
        throw new Error(`Cloudinary refused the deletion (${response.status}).`)
      }
    }
  },
})

export const cloudinaryTransport = (
  configuration: CloudinaryConfiguration,
  origin: string,
): StorageBackend => {
  const store = cloudinaryObjectStore(configuration)

  return {
    name: 'cloudinary',

    /*
     * The same grant the local transport returns, addressed at this Worker.
     * The headers are re-checked on arrival, so an upload is validated exactly
     * as a direct-to-bucket one is rather than being waved through.
     */
    authorizeUpload: async (request) => ({
      uploadUrl: `${origin}${LOCAL_STORAGE_PATH}/uploads/${request.uploadId}`,
      expiresAt: request.expiresAt,
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

    describe: async (objectKey): Promise<ObjectFacts | null> => {
      const object = await store.get(objectKey)
      if (!object) return null
      const body = await object.arrayBuffer()
      return {
        sizeBytes: body.byteLength,
        /*
         * Null, not what delivery echoes. A `raw` asset is served as
         * `application/octet-stream` whatever was uploaded, so reporting the
         * header would claim every document is the wrong type. The interface
         * already allows "the backend recorded none", and the file-signature
         * check the caller runs next is the stronger evidence anyway.
         */
        contentType: null,
        // Cloudinary records no SHA-256, so it is computed from what came back.
        // Finalization compares this against the applicant's declaration, and a
        // null would make that check silently pass.
        checksumSha256: base64FromBytes(await crypto.subtle.digest('SHA-256', body)),
      }
    },

    readPrefix: async (objectKey, byteCount) => {
      const object = await store.get(objectKey)
      if (!object) return null
      return new Uint8Array((await object.arrayBuffer()).slice(0, byteCount))
    },
  }
}
