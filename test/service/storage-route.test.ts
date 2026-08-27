/**
 * The route that receives an upload when there is no bucket to send it to.
 *
 * Its own security boundary, and the one nothing in this suite was reaching.
 * Everything about it is a decision — is the local backend the selected one,
 * is this authorization still usable, do the bytes match what it fixed — and
 * none of that needs workerd. What genuinely does is R2 itself, and
 * `test/runtime/storage.test.ts` keeps that.
 *
 * The assertions that matter are the refusals. **A missing authorization and a
 * spent one are refused identically**, so the path cannot be used to discover
 * which upload ids exist, and the size is checked against the declared header
 * before a byte is buffered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { activeDatabase, closeDatabase, freshDatabase, resetDatabase, testEnv } from '../support/harness'
import { handleLocalStorageRequest } from '../../src/services/storage/route'
import { sebDocumentUploadIntent } from '../../src/db/schema'
import { base64FromBytes, LOCAL_STORAGE_PATH } from '../../src/services/storage/policy'
import { createEnterprise, openCycle, signIn, startApplication } from '../support/api'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const BYTES = new TextEncoder().encode('%PDF-1.7 a small document').buffer as ArrayBuffer

const checksumOf = async (body: ArrayBuffer): Promise<string> =>
  base64FromBytes(await crypto.subtle.digest('SHA-256', body))

/**
 * An issued authorization, written directly.
 *
 * The mutation that issues one is exercised elsewhere; what this file is about
 * is the route that redeems it, so the row is the input rather than the
 * subject. It still hangs off a real application, because the intent's foreign
 * keys are real.
 */
const issuedIntent = async (overrides: Partial<typeof sebDocumentUploadIntent.$inferInsert> = {}) => {
  const officer = await signIn(['SUPER_ADMIN'])
  const cycle = await openCycle(officer.cookie)
  const applicant = await signIn(['APPLICANT'])
  const enterpriseId = await createEnterprise(applicant.cookie)
  const applicationId = await startApplication(applicant.cookie, enterpriseId, cycle.id)

  const now = new Date()
  const id = crypto.randomUUID()
  const row = {
    id,
    applicationId,
    applicantUserId: applicant.userId,
    fieldKey: 'DPR',
    expectedDocumentVersion: 0,
    objectKey: `applications/${applicationId}/documents/DPR/${crypto.randomUUID()}`,
    originalFilename: 'plan.pdf',
    contentType: 'application/pdf',
    sizeBytes: BYTES.byteLength,
    checksumSha256: await checksumOf(BYTES),
    status: 'ISSUED' as const,
    expiresAt: new Date(now.getTime() + 900_000),
    finalizedDocumentVersionId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  await activeDatabase().insert(sebDocumentUploadIntent).values(row)
  return row
}

const put = (
  uploadId: string,
  body: ArrayBuffer,
  headers: Record<string, string>,
  env = testEnv(),
) => handleLocalStorageRequest(
  new Request(`https://api.example.test${LOCAL_STORAGE_PATH}/uploads/${uploadId}`, {
    method: 'PUT',
    body,
    headers,
  }),
  { db: activeDatabase(), env },
)

const ok = (contentType: string, sizeBytes: number) => ({
  'content-type': contentType,
  'content-length': String(sizeBytes),
})

describe('the route that receives a relayed upload', () => {
  it('claims nothing that is not its own path', async () => {
    /*
     * `null` rather than a 404, so the caller keeps its own routing. A 404
     * here would swallow every unmatched request in the Worker.
     */
    expect(await handleLocalStorageRequest(
      new Request('https://api.example.test/graphql'),
      { db: activeDatabase(), env: testEnv() },
    )).toBeNull()
  })

  /**
   * The whole security boundary of this file.
   *
   * A deployed R2 environment sends the browser to the bucket, and this path
   * must not be a second way in — so it answers as though it does not exist.
   */
  it('does not exist at all where the backend does not relay', async () => {
    const intent = await issuedIntent()
    const deployed = testEnv({ ENVIRONMENT: 'production', STORAGE_TRANSPORT: 'r2' } as never)
    const response = await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength), deployed)
    expect(response?.status).toBe(404)
  })

  it('accepts bytes that match the authorization exactly', async () => {
    const intent = await issuedIntent()
    const env = testEnv()
    const response = await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength), env)
    expect(response?.status).toBe(200)
    expect(await env.STORAGE!.head(intent.objectKey)).not.toBeNull()
  })

  it('refuses an upload id that names nothing', async () => {
    expect((await put(crypto.randomUUID(), BYTES, ok('application/pdf', BYTES.byteLength)))?.status)
      .toBe(403)
  })

  /*
   * The same refusal, deliberately. A spent authorization answering
   * differently from an unknown one would turn this path into a way of asking
   * which upload ids exist.
   */
  it('refuses a spent authorization exactly as it refuses an unknown one', async () => {
    const spent = await issuedIntent({ status: 'REJECTED' })
    const unknown = await put(crypto.randomUUID(), BYTES, ok('application/pdf', BYTES.byteLength))
    const used = await put(spent.id, BYTES, ok('application/pdf', BYTES.byteLength))
    expect(used?.status).toBe(unknown?.status)
    expect(await used!.text()).toBe(await unknown!.text())
  })

  it('refuses an expired authorization', async () => {
    const expired = await issuedIntent({ expiresAt: new Date(Date.now() - 1_000) })
    expect((await put(expired.id, BYTES, ok('application/pdf', BYTES.byteLength)))?.status)
      .toBe(403)
  })

  /*
   * Checked before the body is read. The authorization fixes the exact size,
   * so a request declaring anything else is refused without this Worker
   * holding a single byte of it.
   */
  it('refuses a declared length that is not the one authorized', async () => {
    const intent = await issuedIntent()
    const response = await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength + 1))
    expect(response?.status).toBe(400)
    expect(await response!.json()).toMatchObject({
      message: 'The uploaded file size does not match the authorization.',
    })
  })

  it('refuses a body that is not the length authorized, with no header to go on', async () => {
    const intent = await issuedIntent({ sizeBytes: BYTES.byteLength + 10 })
    const response = await put(intent.id, BYTES, { 'content-type': 'application/pdf' })
    expect(response?.status).toBe(400)
  })

  it('refuses a type that is not the one authorized', async () => {
    const intent = await issuedIntent()
    const response = await put(intent.id, BYTES, ok('image/png', BYTES.byteLength))
    expect(response?.status).toBe(400)
    expect(await response!.json()).toMatchObject({
      message: 'The uploaded file type does not match the authorization.',
    })
  })

  /*
   * The bucket checks this in a deployed environment and records the digest,
   * so this does too — otherwise a document would verify locally and not in
   * production, which is the worst kind of difference to have.
   */
  it('refuses bytes whose checksum is not the one declared', async () => {
    const intent = await issuedIntent({ checksumSha256: `${'A'.repeat(43)}=` })
    const response = await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength))
    expect(response?.status).toBe(400)
    expect(await response!.json()).toMatchObject({
      message: 'The uploaded file checksum does not match.',
    })
  })

  it('refuses a PUT with no upload id', async () => {
    expect((await handleLocalStorageRequest(
      new Request(`https://api.example.test${LOCAL_STORAGE_PATH}/uploads/`, {
        method: 'PUT', body: BYTES,
      }),
      { db: activeDatabase(), env: testEnv() },
    ))?.status).toBe(404)
  })

  it('refuses a method it does not offer', async () => {
    expect((await handleLocalStorageRequest(
      new Request(`https://api.example.test${LOCAL_STORAGE_PATH}/objects`, { method: 'DELETE' }),
      { db: activeDatabase(), env: testEnv() },
    ))?.status).toBe(405)
  })
})

describe('the route that serves a relayed download', () => {
  const get = (query: string, env = testEnv()) => handleLocalStorageRequest(
    new Request(`https://api.example.test${LOCAL_STORAGE_PATH}/objects${query}`),
    { db: activeDatabase(), env },
  )

  it('serves a stored object as an attachment under the name asked for', async () => {
    const intent = await issuedIntent()
    const env = testEnv()
    await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength), env)

    const response = await get(
      `?key=${encodeURIComponent(intent.objectKey)}&filename=plan.pdf`, env,
    )
    expect(response?.status).toBe(200)
    // Attachment-only, matching what a signed download would force.
    expect(response!.headers.get('content-disposition'))
      .toBe('attachment; filename="plan.pdf"')
    expect(response!.headers.get('content-type')).toBe('application/pdf')
    // The bytes themselves, not only the headers about them.
    expect(await response!.arrayBuffer()).toEqual(BYTES)
  })

  /*
   * A name is chosen by whoever uploaded, so it reaches a header somebody
   * else's browser reads. Everything outside a small set becomes `_` rather
   * than being trusted to be quoted correctly — the quote that would end the
   * value early, and the carriage return and newline that would start a header
   * of the attacker's own.
   */
  it('strips a filename that could break out of its own header', async () => {
    const intent = await issuedIntent()
    const env = testEnv()
    await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength), env)

    const response = await get(
      `?key=${encodeURIComponent(intent.objectKey)}&filename=${
        encodeURIComponent('a"; x=y\r\nSet-Cookie: b.pdf')}`,
      env,
    )
    const disposition = response!.headers.get('content-disposition')!
    // No quote to close the value early and no line break to open a header.
    expect(disposition).not.toMatch(/[\r\n"]/u.source.replace('"', '"') === '' ? /x/u : /[\r\n]/u)
    expect(disposition.slice('attachment; filename="'.length, -1)).not.toContain('"')
    expect(disposition).toBe('attachment; filename="a__ x_y__Set-Cookie_ b.pdf"')
  })

  it('names it document where no name was asked for', async () => {
    const intent = await issuedIntent()
    const env = testEnv()
    await put(intent.id, BYTES, ok('application/pdf', BYTES.byteLength), env)
    const response = await get(`?key=${encodeURIComponent(intent.objectKey)}`, env)
    expect(response!.headers.get('content-disposition'))
      .toBe('attachment; filename="document"')
  })

  it('refuses a key that names nothing', async () => {
    expect((await get('?key=applications/nobody/documents/DPR/missing'))?.status).toBe(404)
  })

  it('refuses a request naming no key at all', async () => {
    expect((await get(''))?.status).toBe(404)
  })
})
