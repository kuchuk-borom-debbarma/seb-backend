/**
 * Which store this environment keeps documents in, and what happens when it is
 * told something it cannot do.
 *
 * Every branch here is a configuration decision, so none of it needs workerd.
 * What does — signing a URL R2 will honour, and what a bucket really does with
 * an object — stays in `test/runtime/storage.test.ts`.
 *
 * The refusals matter as much as the choices: a deployed environment that
 * cannot reach its store has to **say so** rather than quietly accepting
 * documents it cannot durably keep.
 */
import { describe, expect, it } from 'vitest'
import { testEnv } from '../support/harness'
import {
  objectReader,
  objectRemover,
  objectStore,
  relaysThroughWorker,
  storage,
  usesLocalStorage,
} from '../../src/services/storage'
import type { AppBindings } from '../../src/bindings'

const env = (overrides: Record<string, unknown> = {}): AppBindings =>
  testEnv(overrides as never)

const URL_HERE = 'https://api.example.test/graphql'

const CLOUDINARY = {
  ENVIRONMENT: 'production',
  STORAGE_TRANSPORT: 'cloudinary',
  CLOUDINARY_CLOUD_NAME: 'a-cloud',
  CLOUDINARY_API_KEY: 'a-key',
  CLOUDINARY_API_SECRET: 'a-secret',
  STORAGE: undefined,
}

describe('which store an environment keeps documents in', () => {
  it('keeps them in the Worker where nothing says otherwise', () => {
    // An unconfigured machine is a developer's; a deployed one is always told.
    expect(usesLocalStorage(env())).toBe(true)
    expect(usesLocalStorage(env({ ENVIRONMENT: '  LOCAL ' }))).toBe(true)
    expect(usesLocalStorage(env({ ENVIRONMENT: 'production' }))).toBe(false)
  })

  it('defaults a deployed environment to R2, which was here first', () => {
    expect(storage(env({ ENVIRONMENT: 'production' }), URL_HERE).name).toBe('r2')
    expect(storage(env({ ENVIRONMENT: 'production', STORAGE_TRANSPORT: ' R2 ' }), URL_HERE).name)
      .toBe('r2')
  })

  it('builds the local backend where documents stay in the Worker', () => {
    expect(storage(env(), URL_HERE).name).toBe('local')
  })

  it('builds Cloudinary where it is named', () => {
    expect(storage(env(CLOUDINARY), URL_HERE).name).toBe('cloudinary')
  })

  it('refuses a transport it does not have', () => {
    expect(() => storage(env({ ENVIRONMENT: 'production', STORAGE_TRANSPORT: 's3' }), URL_HERE))
      .toThrow('STORAGE_TRANSPORT must be either "r2" or "cloudinary".')
  })

  /*
   * R2 sends the browser to the bucket; the others relay. The storage route is
   * open exactly when this is true, which is the whole of its boundary.
   */
  it('knows which backends put the bytes through this Worker', () => {
    expect(relaysThroughWorker(env())).toBe(true)
    expect(relaysThroughWorker(env(CLOUDINARY))).toBe(true)
    expect(relaysThroughWorker(env({ ENVIRONMENT: 'production' }))).toBe(false)
  })
})

describe('reaching the bytes themselves', () => {
  /**
   * Reader and remover branch identically, and both must work under Cloudinary.
   *
   * `objectRemover` replaced a helper that returned the `STORAGE` binding
   * directly — and the deployed Cloudinary configuration declares no such
   * binding, so every cleanup path threw there instead of removing anything.
   */
  it('reaches a Cloudinary object without a bucket binding', () => {
    expect(() => objectReader(env(CLOUDINARY))).not.toThrow()
    expect(() => objectRemover(env(CLOUDINARY))).not.toThrow()
    expect(() => objectStore(env(CLOUDINARY))).not.toThrow()
  })

  it('reaches an R2 object through the binding', async () => {
    const deployed = env({ ENVIRONMENT: 'production' })
    await deployed.STORAGE!.put('a/key', new TextEncoder().encode('bytes'))
    expect(await objectReader(deployed).get('a/key')).not.toBeNull()
  })

  it('says which binding is missing rather than asserting it away', () => {
    const unbound = env({ STORAGE: undefined })
    const message = 'Local document storage is selected but no STORAGE binding is configured.'
    expect(() => objectReader(unbound)).toThrow(message)
    expect(() => objectRemover(unbound)).toThrow(message)
    expect(() => objectStore(unbound)).toThrow(message)
    expect(() => storage(unbound, URL_HERE)).toThrow(message)
  })

  it('says which Cloudinary values are missing', () => {
    expect(() => objectReader(env({ ...CLOUDINARY, CLOUDINARY_API_SECRET: '' })))
      .toThrow('Cloudinary configuration is required.')
  })

  it('round-trips an object through the binding store, type and all', async () => {
    const store = objectStore(env())
    const bytes = new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer
    await store.put('a/key', bytes, { contentType: 'application/pdf' })

    const read = await store.get('a/key')
    expect(read?.headers.get('content-type')).toBe('application/pdf')
    expect(await read!.text()).toBe('%PDF-1.7')
  })

  /*
   * An object stored without a type is a real state, and the most inert type is
   * the right answer to it — decided here rather than at each caller.
   */
  it('serves an object stored with no type as the inert one', async () => {
    const local = env()
    await local.STORAGE!.put('typeless/key', new TextEncoder().encode('bytes'))
    const read = await objectStore(local).get('typeless/key')
    expect(read?.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('answers null for an object that is not there', async () => {
    expect(await objectStore(env()).get('missing/key')).toBeNull()
  })

  it('removes a whole batch in one call', async () => {
    const local = env()
    await local.STORAGE!.put('one', new TextEncoder().encode('a'))
    await local.STORAGE!.put('two', new TextEncoder().encode('b'))
    await objectRemover(local).remove(['one', 'two'])
    expect(await local.STORAGE!.head('one')).toBeNull()
    expect(await local.STORAGE!.head('two')).toBeNull()
  })
})
