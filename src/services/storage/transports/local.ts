/**
 * This Worker receives the upload and writes it to the `STORAGE` binding.
 *
 * Exists because uploads have to work on a developer's machine. Signing
 * addresses `r2.cloudflarestorage.com` for real, so the direct-to-bucket path
 * needs credentials and a bucket that exists — but the binding itself does not:
 * the development runtime provides it with no account feature and no keys.
 *
 * The grant it returns has the same shape the bucket's would, so the client
 * cannot tell which it is talking to. Only the host in the URL differs.
 */
import { attachmentHeader, base64FromBytes, DOWNLOAD_TTL_SECONDS, LOCAL_STORAGE_PATH } from '../policy'
import type { ObjectFacts, StorageBackend } from '../types'

export const localTransport = (origin: string, bucket: R2Bucket): StorageBackend => ({
  name: 'local',

  authorizeUpload: async (request) => ({
    uploadUrl: `${origin}${LOCAL_STORAGE_PATH}/uploads/${request.uploadId}`,
    expiresAt: request.expiresAt,
    /*
     * The same headers the bucket would be given. They are re-checked on
     * arrival, so a developer's upload is validated the same way a real one is
     * rather than being waved through.
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
})
