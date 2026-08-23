/**
 * Choosing where documents are kept.
 *
 * The rest of the programme asks for a backend and uses it. It does not know
 * which one it got, and nothing outside `transports/` names a vendor.
 *
 * Built per call rather than cached, for the reason `src/index.ts` gives for
 * its own configuration: parsed on demand "so tests and local Wrangler
 * overrides can supply different bindings without global mutable
 * configuration". The suite runs `singleWorker: true`, so a cached backend
 * would be shared by every test in the run.
 */
import type { AppBindings } from '../../bindings'
import { localTransport } from './transports/local'
import { r2Transport, requireR2Configuration } from './transports/r2'
import type { StorageBackend } from './types'

// Only what a caller outside this service needs. The rest of `policy.ts` is
// how an object is served, which is this service's business alone.
export { UPLOAD_TTL_SECONDS } from './policy'
export type * from './types'

/**
 * Whether this environment keeps documents in the Worker itself.
 *
 * Unset means local, because an unconfigured machine is a developer's — a
 * deployed environment is always told what it is.
 *
 * Separate from `storage` because a caller often needs the answer without
 * needing a backend. Asking `storage(env).name === 'local'` would build one to
 * read a label, and in a deployed environment building the R2 backend
 * validates configuration and throws — so a question would become a failure.
 */
export const usesLocalStorage = (env: AppBindings): boolean => {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  return environment === '' || environment === 'local'
}

/**
 * The backend for this environment.
 *
 * `requestUrl` is needed only by the local backend, which addresses this Worker
 * back to itself.
 */
export const storage = (env: AppBindings, requestUrl: string): StorageBackend =>
  usesLocalStorage(env)
    ? localTransport(new URL(requestUrl).origin, env.STORAGE)
    : r2Transport(requireR2Configuration(env), env.STORAGE)
