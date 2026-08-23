/**
 * How long an authorization lasts, and how an object is served.
 *
 * These are storage policy rather than programme policy: they describe the
 * shape of a signed URL and the disposition a browser is given, not what the
 * programme accepts as evidence.
 */

/** Long enough to upload a document on a poor connection, and no longer. */
export const UPLOAD_TTL_SECONDS = 10 * 60

/** Short: a download link is followed immediately or not at all. */
export const DOWNLOAD_TTL_SECONDS = 5 * 60

/** The path the local backend receives uploads and serves downloads on. */
export const LOCAL_STORAGE_PATH = '/internal/storage'

/**
 * Forces a download rather than letting a browser render the file.
 *
 * Every stored document is attachment-only. A PDF or an image rendered inline
 * is a script-execution surface on the portal's own origin, and an applicant's
 * evidence is the last thing that should be able to run there.
 *
 * The filename is reduced to characters that cannot terminate the quoted
 * value or inject another header parameter.
 */
export const attachmentHeader = (filename: string): string => {
  const ascii = filename.replace(/[^A-Za-z0-9._ -]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"`
}

export const base64FromBytes = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
