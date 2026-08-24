/**
 * Choosing what examines an applicant's documents.
 *
 * The same shape as the notification, storage and queue seams: an agnostic
 * interface, one file per implementation, and a factory that picks by
 * environment. Built per call rather than cached, for the reason `src/index.ts`
 * gives for its own configuration.
 *
 * ## What exists and what does not
 *
 * No scanner has been chosen. That is an open decision, and this file is where
 * the consequence is contained rather than spread across the codebase:
 *
 * - Locally and on `develop`, documents are accepted without being examined,
 *   and the scan history says so in as many words. Without this, no
 *   administrator could open any document, because download fails closed until
 *   an `ACCEPTED` result exists — so the entire review workflow would be
 *   undemonstrable.
 * - In `production` this **refuses to be constructed**. Nothing in that
 *   environment may accept an unexamined file, and failing at construction is
 *   what stops the permissive one shipping unnoticed. The failure is loud and
 *   immediate rather than a document quietly becoming readable.
 */
import type { AppBindings } from '../../bindings'
import { permissiveScanner } from './transports/permissive'
import type { DocumentScanner } from './types'

export { NO_SCANNER_REFERENCE } from './transports/permissive'
export type * from './types'

/**
 * Where an unexamined document must never be opened.
 *
 * Only production. `develop` is deliberately not on this list: it is a
 * demonstration environment holding no real applicant's evidence, and being
 * unable to open a document there costs more than it protects.
 */
const SCANNING_REQUIRED_ENVIRONMENTS = new Set(['production'])

export const documentScanner = (env: AppBindings): DocumentScanner => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  if (SCANNING_REQUIRED_ENVIRONMENTS.has(environment)) {
    throw new Error(
      `No malware scanner is configured for the ${environment} environment.`,
    )
  }
  return permissiveScanner()
}
