/**
 * Choosing what examines an applicant's documents.
 *
 * The same shape as the notification, storage and queue seams: an agnostic
 * interface, one file per implementation, and a factory that picks by
 * environment. Built per call rather than cached, for the reason `src/index.ts`
 * gives for its own configuration.
 *
 * ## What exists
 *
 * `SCANNER_TRANSPORT` picks, exactly as `STORAGE_TRANSPORT` does:
 *
 * - `cloudmersive` really examines the file. It needs `CLOUDMERSIVE_API_KEY`,
 *   and its free tier caps a file at 2.5 MB — which is why the programme caps a
 *   document below that, in `services/application/uploads.ts`. That cap and
 *   this transport move together.
 * - `none`, or unset, accepts documents without examining them, and the scan
 *   history says so in as many words. Without this, no administrator could open
 *   any document on a developer's machine, because download fails closed until
 *   an `ACCEPTED` result exists — so the review workflow would be untestable.
 *
 * In `production`, `none` **refuses to be constructed**. Nothing in that
 * environment may accept an unexamined file, and failing at construction is
 * what stops the permissive one shipping unnoticed: the failure is loud and
 * immediate rather than a document quietly becoming readable.
 */
import type { AppBindings } from '../../bindings'
import { objectReader } from '../storage'
import { cloudmersiveScanner } from './transports/cloudmersive'
import { permissiveScanner } from './transports/permissive'
import type { DocumentScanner } from './types'

export { NO_SCANNER_REFERENCE } from './transports/permissive'
export { SCAN_REFERENCE as CLOUDMERSIVE_SCAN_REFERENCE } from './transports/cloudmersive'
export type * from './types'

/**
 * Where an unexamined document must never be opened.
 *
 * Only production. `develop` is deliberately not on this list: it is a
 * demonstration environment holding no real applicant's evidence, and being
 * unable to open a document there costs more than it protects.
 */
const SCANNING_REQUIRED_ENVIRONMENTS = new Set(['production'])

/**
 * The key the configured scanner needs, or a refusal naming what is missing.
 *
 * At construction rather than at scan time, matching the environment check
 * below: a deployment whose credential is absent should fail immediately, not
 * on the first document somebody uploads.
 */
const requireCloudmersiveKey = (env: AppBindings): string => {
  const apiKey = (env.CLOUDMERSIVE_API_KEY ?? '').trim()
  if (apiKey === '') {
    throw new Error('CLOUDMERSIVE_API_KEY is required when SCANNER_TRANSPORT is "cloudmersive".')
  }
  return apiKey
}

export const documentScanner = (env: AppBindings): DocumentScanner => {
  const named = (env.SCANNER_TRANSPORT ?? '').trim().toLowerCase()

  if (named === 'cloudmersive') {
    return cloudmersiveScanner(requireCloudmersiveKey(env), (objectKey) =>
      objectReader(env).get(objectKey))
  }
  if (named !== '' && named !== 'none') {
    throw new Error('SCANNER_TRANSPORT must be either "none" or "cloudmersive".')
  }

  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  if (SCANNING_REQUIRED_ENVIRONMENTS.has(environment)) {
    throw new Error(
      `No malware scanner is configured for the ${environment} environment.`,
    )
  }
  return permissiveScanner()
}
