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
import {
  cloudinaryObjectStore,
  cloudinaryTransport,
  requireCloudinaryConfiguration,
} from './transports/cloudinary'
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
 * Which provider a deployed environment keeps documents in.
 *
 * Only consulted when the environment is deployed — a developer's machine keeps
 * documents in the Worker regardless. Unset means R2, because that is what was
 * here first and an environment already configured for it must not change store
 * by upgrading.
 */
const deployedTransport = (env: AppBindings): 'r2' | 'cloudinary' => {
  const named = (env.STORAGE_TRANSPORT ?? '').trim().toLowerCase()
  if (named === '' || named === 'r2') return 'r2'
  if (named === 'cloudinary') return 'cloudinary'
  throw new Error('STORAGE_TRANSPORT must be either "r2" or "cloudinary".')
}

/**
 * Whether the selected backend receives uploads through this Worker.
 *
 * R2 sends the browser to the bucket; the others relay. The storage route is
 * open exactly when this is true, which is the whole of its security boundary —
 * see [`route.ts`](route.ts).
 */
export const relaysThroughWorker = (env: AppBindings): boolean =>
  usesLocalStorage(env) || deployedTransport(env) === 'cloudinary'

/**
 * Where the relaying route puts and gets the bytes.
 *
 * Local keeps them in the `STORAGE` binding, which the development runtime
 * supplies without an account feature. Cloudinary keeps them at the provider.
 * Never called for R2, which is never relayed.
 */
export const objectStore = (env: AppBindings) =>
  usesLocalStorage(env)
    ? {
        put: async (key: string, body: ArrayBuffer, facts: { contentType: string }) => {
          await env.STORAGE.put(key, body, {
            sha256: await crypto.subtle.digest('SHA-256', body),
            httpMetadata: { contentType: facts.contentType },
          })
        },
        get: async (key: string) => {
          const object = await env.STORAGE.get(key)
          if (!object) return null
          /*
           * Carried as a header so both stores answer in the same shape, and
           * defaulted here rather than at the caller: an object stored without
           * a type is a real state, and the most inert type is the right answer
           * to it wherever it is served.
           */
          return new Response(object.body, {
            headers: {
              'content-type':
                object.httpMetadata?.contentType ?? 'application/octet-stream',
            },
          })
        },
      }
    : cloudinaryObjectStore(requireCloudinaryConfiguration(env))

/**
 * The backend for this environment.
 *
 * `requestUrl` is needed by every backend that relays, which addresses this
 * Worker back to itself.
 */
export const storage = (env: AppBindings, requestUrl: string): StorageBackend => {
  if (usesLocalStorage(env)) {
    return localTransport(new URL(requestUrl).origin, env.STORAGE)
  }
  return deployedTransport(env) === 'cloudinary'
    ? cloudinaryTransport(requireCloudinaryConfiguration(env), new URL(requestUrl).origin)
    : r2Transport(requireR2Configuration(env), env.STORAGE)
}
