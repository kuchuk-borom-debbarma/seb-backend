/**
 * Where documents are kept, stated as what the programme needs.
 *
 * Three things: authorize an upload the browser performs itself, authorize a
 * download, and answer questions about an object that arrived. That is the
 * whole interface, and it names no vendor — S3, R2, Azure and Google all
 * satisfy it, and so does this Worker.
 *
 * It also names no *domain*. Nothing here knows what a programme document is,
 * which content types are acceptable, or how large one may be: those are the
 * application service's rules and they stay there. Keeping this ignorant is
 * what makes the dependency run one way. A storage service that imported the
 * application's content-type union would put the two back in a cycle, which is
 * exactly the shape this extraction exists to remove.
 */

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
  /** A MIME type. Which ones are acceptable is not this service's business. */
  contentType: string
  sizeBytes: number
  checksumSha256: string
  expiresAt: Date
}

/**
 * What an object turned out to be, as stored.
 *
 * Returned rather than compared, because deciding whether these match what was
 * promised is a programme rule and the answer belongs where that rule lives.
 * `null` means no such object.
 */
export type ObjectFacts = {
  sizeBytes: number
  contentType: string | null
  /** Base64, or `null` when the backend recorded no checksum. */
  checksumSha256: string | null
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
  /** What the stored object is, or `null` when there is none. */
  describe(objectKey: string): Promise<ObjectFacts | null>
  /**
   * The first bytes of an object, for a caller that needs to look inside.
   *
   * Exists so the application can check a file's signature without being
   * handed a bucket. `null` when the object is absent or unreadable.
   */
  readPrefix(objectKey: string, byteCount: number): Promise<Uint8Array | null>
}
