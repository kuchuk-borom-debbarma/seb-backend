/**
 * The cycle's policy PDF: authorization, the opening gate, and fail-closed
 * reads.
 *
 * The PUT-and-finalize round trip belongs to the e2e suite, which runs real
 * storage. What this suite pins is everything around it: who may authorize an
 * upload and with what file, that a cycle cannot open without an ACCEPTED
 * document, and that neither an applicant nor an administrator can reach a
 * file the scanner has not cleared.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { env, SELF } from '../support/worker'
import {
  graphql,
  openCycle,
  seedPolicyDocument,
  signIn,
  testPolicy,
} from '../support/api'
import { cleanupExpiredCyclePolicyUploads } from '../../src/services/admin'
import { recordPolicyDocumentScanResult } from '../../src/services/admin/document-scanner'
import { scanPolicyDocumentVersion } from '../../src/services/document-scanner/consume'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const CHECKSUM = 'A'.repeat(43) + '='

const draftCycle = async (cookie: string): Promise<{ id: string }> => {
  const created = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
    admin { programmeCycle { create(input: $input) {
      success message response { head { id } }
    } } }
  }`, { input: {
    cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    displayName: 'Policy document test cycle',
    cycleYear: 2026,
    applicantGuidance: 'Guide.',
    partnerBankGuidance: 'Roster.',
    opensAt: new Date(Date.now() - 1_000).toISOString(),
    policy: testPolicy(),
  } }, cookie)
  const result = created.data.admin.programmeCycle.create
  expect(result.success, result.message ?? '').toBe(true)
  return { id: result.response.head.id as string }
}

const issue = (
  cookie: string,
  cycleId: string,
  override: Record<string, unknown> = {},
) => graphql<any>(`mutation($input: IssuePolicyDocumentUploadInput!) {
  admin { programmeCycle { issuePolicyDocumentUpload(input: $input) {
    success message response { uploadId uploadUrl }
  } } }
}`, { input: {
  cycleId,
  expectedDocumentVersion: 0,
  originalFilename: 'policy.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  checksumSha256: CHECKSUM,
  ...override,
} }, cookie)

const open = (cookie: string, cycleId: string, expectedVersion = 1) =>
  graphql<any>(`mutation($input: CycleTransitionInput!) {
    admin { programmeCycle { open(input: $input) { success message } } }
  }`, { input: { id: cycleId, expectedVersion, reason: 'Publish' } }, cookie)

/** Rewrites the seeded ACCEPTED verdict, exercising the non-clean states. */
const overwriteScan = async (
  cycleId: string,
  status: 'PENDING' | 'REJECTED' | 'ERROR',
): Promise<void> => {
  await env.DB.prepare(`UPDATE seb_cycle_policy_document_scan SET
      status = ?,
      scanned_at = CASE WHEN ? = 'PENDING' THEN NULL ELSE scanned_at END,
      scanner_reference = CASE WHEN ? = 'PENDING' THEN NULL ELSE scanner_reference END
    WHERE document_version_id IN (
      SELECT v.id FROM seb_cycle_policy_document_version v
      JOIN seb_cycle_policy_document d ON d.id = v.document_id
      WHERE d.programme_cycle_id = ?
    )`).bind(status, status, status, cycleId).run()
}

describe('cycle policy document', () => {
  it('authorizes only a plausible PDF from a cycle administrator', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)

    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ expectedDocumentVersion: -1 },
        'Expected document version must be a non-negative integer.'],
      [{ contentType: 'image/png', originalFilename: 'policy.png' },
        'The policy document must be a PDF.'],
      [{ originalFilename: 'policy.exe' },
        'The file name must end in .pdf, matching the file.'],
      [{ sizeBytes: 3 * 1024 * 1024 },
        'The policy document must contain 1 byte through 2 MB.'],
      [{ sizeBytes: 0 },
        'The policy document must contain 1 byte through 2 MB.'],
      [{ checksumSha256: 'not-a-checksum' },
        'Provide the base64-encoded SHA-256 checksum.'],
      [{ originalFilename: '   ' },
        'The original filename is invalid.'],
      [{ expectedDocumentVersion: 3 },
        'The policy document changed. Refresh it and try again.'],
    ]
    for (const [override, message] of refusals) {
      const refused = await issue(administrator.cookie, cycle.id, override)
      expect(refused.data.admin.programmeCycle.issuePolicyDocumentUpload)
        .toMatchObject({ success: false, message })
    }

    const issued = await issue(administrator.cookie, cycle.id)
    const result = issued.data.admin.programmeCycle.issuePolicyDocumentUpload
    expect(result.success, result.message ?? '').toBe(true)
    expect(result.response.uploadId).toBeTruthy()
    expect(result.response.uploadUrl).toBeTruthy()

    // A cycle that never existed reads the same as one that was removed.
    expect((await issue(administrator.cookie, crypto.randomUUID()))
      .data.admin.programmeCycle.issuePolicyDocumentUpload).toMatchObject({
        success: false, message: 'The programme cycle was not found.',
      })

    // A caseworker administers files, not the programme's own rulebook.
    const caseworker = await signIn(['ADMIN'])
    const denied = await issue(caseworker.cookie, cycle.id)
    expect(denied.data.admin.programmeCycle.issuePolicyDocumentUpload)
      .toMatchObject({ success: false, message: 'You do not have permission to do that.' })
  })

  it('leaves a closed cycle’s document as part of its record', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const closed = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { close(input: $input) { success message } } }
    }`, { input: { id: cycle.id, expectedVersion: 2, reason: 'The window ended.' } }, administrator.cookie)
    expect(closed.data.admin.programmeCycle.close.success,
      closed.data.admin.programmeCycle.close.message ?? '').toBe(true)
    expect((await issue(administrator.cookie, cycle.id, { expectedDocumentVersion: 1 }))
      .data.admin.programmeCycle.issuePolicyDocumentUpload).toMatchObject({
        success: false,
        message: 'A closed or archived cycle keeps its policy document as is.',
      })
  })

  it('refuses reads that have nothing to serve, and readers with no standing', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)

    // No document at all, and a version that never existed.
    const download = (variables: Record<string, unknown>, cookie?: string) =>
      graphql<any>(`query($cycleId: ID!, $version: Int) {
        admin { programmeCycle { policyDocumentDownloadUrl(cycleId: $cycleId, version: $version) {
          success message
        } } }
      }`, variables, cookie)
    expect((await download({ cycleId: cycle.id }, administrator.cookie))
      .data.admin.programmeCycle.policyDocumentDownloadUrl).toMatchObject({
        success: false, message: 'The policy document was not found.',
      })
    await seedPolicyDocument(cycle.id)
    expect((await download({ cycleId: cycle.id, version: 99 }, administrator.cookie))
      .data.admin.programmeCycle.policyDocumentDownloadUrl).toMatchObject({
        success: false, message: 'The policy document was not found.',
      })

    // No session at all, on both surfaces.
    expect((await download({ cycleId: cycle.id }))
      .data.admin.programmeCycle.policyDocumentDownloadUrl.success).toBe(false)
    const applicantSide = await graphql<any>(`query($cycleId: ID!) {
      seb { application { cyclePolicyDocumentDownloadUrl(cycleId: $cycleId) { success message } } }
    }`, { cycleId: cycle.id })
    expect(applicantSide.data.seb.application.cyclePolicyDocumentDownloadUrl.success)
      .toBe(false)

    // A draft cycle's document is invisible to applicants even when clean:
    // an applicant must not learn a cycle exists from its policy file.
    const applicant = await signIn(['APPLICANT'])
    expect((await graphql<any>(`query($cycleId: ID!) {
      seb { application { cyclePolicyDocumentDownloadUrl(cycleId: $cycleId) { success message } } }
    }`, { cycleId: cycle.id }, applicant.cookie))
      .data.seb.application.cyclePolicyDocumentDownloadUrl).toMatchObject({
        success: false, message: 'The policy document is not available.',
      })
  })

  it('refuses to finalize an authorization that was never issued', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const finalized = await graphql<any>(`mutation($input: FinalizePolicyDocumentUploadInput!) {
      admin { programmeCycle { finalizePolicyDocumentUpload(input: $input) { success message } } }
    }`, { input: { uploadId: crypto.randomUUID() } }, administrator.cookie)
    expect(finalized.data.admin.programmeCycle.finalizePolicyDocumentUpload)
      .toMatchObject({
        success: false,
        message: 'The upload authorization is invalid or already used.',
      })
  })

  it('gates opening on a document whose scan verdict is ACCEPTED', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])

    const missing = await draftCycle(administrator.cookie)
    const refusedMissing = await open(administrator.cookie, missing.id)
    expect(refusedMissing.data.admin.programmeCycle.open).toMatchObject({
      success: false,
      message: 'Before this cycle can open, fill in the policy document '
        + '(the order or circular this cycle implements).',
    })

    const pending = await draftCycle(administrator.cookie)
    await seedPolicyDocument(pending.id)
    await overwriteScan(pending.id, 'PENDING')
    expect((await open(administrator.cookie, pending.id)).data.admin.programmeCycle.open)
      .toMatchObject({
        success: false,
        message: 'The policy document is still being checked for malware. '
          + 'Try again in a moment.',
      })

    const rejected = await draftCycle(administrator.cookie)
    await seedPolicyDocument(rejected.id)
    await overwriteScan(rejected.id, 'REJECTED')
    expect((await open(administrator.cookie, rejected.id)).data.admin.programmeCycle.open)
      .toMatchObject({
        success: false,
        message: 'The policy document failed its malware check. '
          + 'Upload a clean copy before opening.',
      })

    const clean = await draftCycle(administrator.cookie)
    await seedPolicyDocument(clean.id)
    expect((await open(administrator.cookie, clean.id)).data.admin.programmeCycle.open)
      .toMatchObject({ success: true })
  })

  it('shows and serves the document to applicants only once ACCEPTED', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)

    const listed = await graphql<any>(`query {
      seb { application { availableProgrammeCycles { response {
        cycles { id policyDocument { version originalFilename sizeBytes } }
      } } } }
    }`, {}, administrator.cookie)
    const visible = listed.data.seb.application.availableProgrammeCycles.response.cycles
      .find((row: { id: string }) => row.id === cycle.id)
    expect(visible.policyDocument).toMatchObject({
      version: 1, originalFilename: 'policy.pdf', sizeBytes: 1024,
    })

    const download = await graphql<any>(`query($cycleId: ID!) {
      seb { application { cyclePolicyDocumentDownloadUrl(cycleId: $cycleId) {
        success message response { downloadUrl }
      } } }
    }`, { cycleId: cycle.id }, administrator.cookie)
    const served = download.data.seb.application.cyclePolicyDocumentDownloadUrl
    expect(served.success, served.message ?? '').toBe(true)
    expect(served.response.downloadUrl).toBeTruthy()

    // A replacement lands and is still being checked: the applicant surface
    // must fall shut again rather than advertise the unscanned file.
    await overwriteScan(cycle.id, 'PENDING')
    const relisted = await graphql<any>(`query {
      seb { application { availableProgrammeCycles { response {
        cycles { id policyDocument { version } }
      } } } }
    }`, {}, administrator.cookie)
    expect(relisted.data.seb.application.availableProgrammeCycles.response.cycles
      .find((row: { id: string }) => row.id === cycle.id).policyDocument).toBeNull()
    const refused = await graphql<any>(`query($cycleId: ID!) {
      seb { application { cyclePolicyDocumentDownloadUrl(cycleId: $cycleId) {
        success message
      } } }
    }`, { cycleId: cycle.id }, administrator.cookie)
    expect(refused.data.seb.application.cyclePolicyDocumentDownloadUrl).toMatchObject({
      success: false, message: 'The policy document is not available.',
    })

    // No trail at all is the same shut door as a running scan.
    await env.DB.prepare('DELETE FROM seb_cycle_policy_document_scan').run()
    const trailless = await graphql<any>(`query($cycleId: ID!) {
      seb { application { cyclePolicyDocumentDownloadUrl(cycleId: $cycleId) {
        success message
      } } }
    }`, { cycleId: cycle.id }, administrator.cookie)
    expect(trailless.data.seb.application.cyclePolicyDocumentDownloadUrl).toMatchObject({
      success: false, message: 'The policy document is not available.',
    })
  })

  it('fails the administrative download closed until the scan accepts', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    await seedPolicyDocument(cycle.id)
    await overwriteScan(cycle.id, 'PENDING')

    const pending = await graphql<any>(`query($cycleId: ID!) {
      admin { programmeCycle { policyDocumentDownloadUrl(cycleId: $cycleId) {
        success message
      } } }
    }`, { cycleId: cycle.id }, administrator.cookie)
    expect(pending.data.admin.programmeCycle.policyDocumentDownloadUrl).toMatchObject({
      success: false,
      message: 'The policy document has not passed its malware check yet.',
    })

    await env.DB.prepare(`UPDATE seb_cycle_policy_document_scan
      SET status = 'ACCEPTED', scanned_at = NOW(), scanner_reference = 'seed'
      WHERE scanner_reference IS NULL OR scanner_reference = 'seed'`).run()
    const accepted = await graphql<any>(`query($cycleId: ID!) {
      admin { programmeCycle { policyDocumentDownloadUrl(cycleId: $cycleId) {
        success message response { downloadUrl }
      } } }
    }`, { cycleId: cycle.id }, administrator.cookie)
    const result = accepted.data.admin.programmeCycle.policyDocumentDownloadUrl
    expect(result.success, result.message ?? '').toBe(true)
    expect(result.response.downloadUrl).toBeTruthy()
  })

  it('carries a PDF from authorization to a replaced, scanned, served version', async () => {
    /*
     * The whole life of the document, the way the office lives it locally:
     * authorize, PUT the bytes to the URL the authorization named, finalize,
     * let the queue consumer record the verdict, download, then replace — and
     * the first version stays in the history.
     */
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    const bytes = new TextEncoder().encode('%PDF-the-2026-order')
    const hash = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
    const checksum = btoa(String.fromCharCode(...new Uint8Array(hash)))

    const issued = await issue(administrator.cookie, cycle.id, {
      sizeBytes: bytes.length, checksumSha256: checksum,
    })
    const authorization = issued.data.admin.programmeCycle.issuePolicyDocumentUpload
    expect(authorization.success, authorization.message ?? '').toBe(true)
    expect(authorization.response.uploadUrl).toContain('/internal/storage/uploads/')
    const uploaded = await SELF.fetch(authorization.response.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    })
    expect(uploaded.status).toBe(200)

    const finalize = (uploadId: string) => graphql<any>(`mutation($input: FinalizePolicyDocumentUploadInput!) {
      admin { programmeCycle { finalizePolicyDocumentUpload(input: $input) {
        success message response { policyDocument {
          currentVersion scanStatus versions { version operation scanStatus }
        } }
      } } }
    }`, { input: { uploadId } }, administrator.cookie)
    // A caseworker cannot finalize what only CYCLE_ADMIN may publish.
    const caseworker = await signIn(['ADMIN'])
    expect((await graphql<any>(`mutation($input: FinalizePolicyDocumentUploadInput!) {
      admin { programmeCycle { finalizePolicyDocumentUpload(input: $input) { success message } } }
    }`, { input: { uploadId: authorization.response.uploadId } }, caseworker.cookie))
      .data.admin.programmeCycle.finalizePolicyDocumentUpload).toMatchObject({
        success: false, message: 'You do not have permission to do that.',
      })

    // The request context an audit row retains, exercised once end to end.
    const finalized = await graphql<any>(`mutation($input: FinalizePolicyDocumentUploadInput!) {
      admin { programmeCycle { finalizePolicyDocumentUpload(input: $input) {
        success message response { policyDocument {
          currentVersion scanStatus versions { version operation scanStatus }
        } }
      } } }
    }`, { input: { uploadId: authorization.response.uploadId } }, administrator.cookie, {
      'CF-Ray': 'test-ray-1234',
      'CF-Connecting-IP': '203.0.113.9',
      'User-Agent': 'cycle-policy-suite',
    })
    const first = finalized.data.admin.programmeCycle.finalizePolicyDocumentUpload
    expect(first.success, first.message ?? '').toBe(true)
    // Finalization queues the scan; nothing is readable until it concludes.
    expect(first.response.policyDocument).toMatchObject({
      currentVersion: 1, scanStatus: 'PENDING',
    })
    // A used authorization is spent.
    expect((await finalize(authorization.response.uploadId))
      .data.admin.programmeCycle.finalizePolicyDocumentUpload).toMatchObject({
        success: false,
        message: 'The upload authorization is invalid or already used.',
      })

    // What the queue consumer does when it reads the scan request.
    const versionRow = await env.DB.prepare(`SELECT v.id FROM seb_cycle_policy_document_version v
      JOIN seb_cycle_policy_document d ON d.id = v.document_id
      WHERE d.programme_cycle_id = ?`).bind(cycle.id).first<{ id: string }>()
    expect(await scanPolicyDocumentVersion(activeDatabase(), env, versionRow!.id))
      .toBe('RECORDED')

    const download = await graphql<any>(`query($cycleId: ID!) {
      admin { programmeCycle { policyDocumentDownloadUrl(cycleId: $cycleId, version: 1) {
        success message response { downloadUrl }
      } } }
    }`, { cycleId: cycle.id }, administrator.cookie)
    expect(download.data.admin.programmeCycle.policyDocumentDownloadUrl.response?.downloadUrl)
      .toContain('/internal/storage/objects?key=')

    // The replacement: same flow against the now-current version 1.
    const replacement = new TextEncoder().encode('%PDF-the-corrected-order')
    const replacementHash = await crypto.subtle.digest(
      'SHA-256', replacement.buffer as ArrayBuffer,
    )
    const reissued = await issue(administrator.cookie, cycle.id, {
      expectedDocumentVersion: 1,
      originalFilename: 'policy-corrected.pdf',
      sizeBytes: replacement.length,
      checksumSha256: btoa(String.fromCharCode(...new Uint8Array(replacementHash))),
    })
    const reauthorization = reissued.data.admin.programmeCycle.issuePolicyDocumentUpload
    expect(reauthorization.success, reauthorization.message ?? '').toBe(true)
    expect((await SELF.fetch(reauthorization.response.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: replacement,
    })).status).toBe(200)
    const replaced = await finalize(reauthorization.response.uploadId)
    expect(replaced.data.admin.programmeCycle.finalizePolicyDocumentUpload.response
      .policyDocument).toMatchObject({
        currentVersion: 2,
        versions: [
          { version: 2, operation: 'REPLACE', scanStatus: 'PENDING' },
          { version: 1, operation: 'UPLOAD', scanStatus: 'ACCEPTED' },
        ],
      })
  })

  it('settles a finalize whose object never arrived, and an expired one', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    const finalize = (uploadId: string) => graphql<any>(`mutation($input: FinalizePolicyDocumentUploadInput!) {
      admin { programmeCycle { finalizePolicyDocumentUpload(input: $input) { success message } } }
    }`, { input: { uploadId } }, administrator.cookie)

    // Authorized but never PUT: verification fails and the intent is closed
    // as REJECTED rather than left claimable.
    const neverStored = await issue(administrator.cookie, cycle.id)
    const neverStoredId = neverStored.data.admin.programmeCycle
      .issuePolicyDocumentUpload.response.uploadId as string
    const rejected = await finalize(neverStoredId)
    expect(rejected.data.admin.programmeCycle.finalizePolicyDocumentUpload.success)
      .toBe(false)
    expect(await env.DB.prepare(
      'SELECT status FROM seb_cycle_policy_upload_intent WHERE id = ?',
    ).bind(neverStoredId).first()).toEqual({ status: 'REJECTED' })

    // Authorized and left past its expiry: settled as EXPIRED.
    const stale = await issue(administrator.cookie, cycle.id)
    const staleId = stale.data.admin.programmeCycle
      .issuePolicyDocumentUpload.response.uploadId as string
    await env.DB.prepare(
      `UPDATE seb_cycle_policy_upload_intent SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ?`,
    ).bind(staleId).run()
    expect((await finalize(staleId)).data.admin.programmeCycle
      .finalizePolicyDocumentUpload).toMatchObject({
        success: false, message: 'The upload authorization expired.',
      })
    expect(await env.DB.prepare(
      'SELECT status FROM seb_cycle_policy_upload_intent WHERE id = ?',
    ).bind(staleId).first()).toEqual({ status: 'EXPIRED' })

    // An authorization whose bytes arrived but whose expectation the document
    // outran: the guarded write refuses rather than minting a second head.
    const raced = await issue(administrator.cookie, cycle.id)
    const racedAuthorization = raced.data.admin.programmeCycle
      .issuePolicyDocumentUpload.response
    const bytes = new TextEncoder().encode('%PDF-raced')
    await env.DB.prepare(
      'UPDATE seb_cycle_policy_upload_intent SET size_bytes = ?, checksum_sha256 = ? WHERE id = ?',
    ).bind(bytes.length, btoa(String.fromCharCode(...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer),
    ))), racedAuthorization.uploadId).run()
    expect((await SELF.fetch(racedAuthorization.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    })).status).toBe(200)
    await seedPolicyDocument(cycle.id)
    expect((await finalize(racedAuthorization.uploadId as string))
      .data.admin.programmeCycle.finalizePolicyDocumentUpload).toMatchObject({
        success: false,
        message: 'The policy document changed. Refresh it and try again.',
      })

    // A removed draft accepts neither a new authorization nor a finalize.
    // (Expected version 1: the raced case above seeded the document.)
    const doomed = await issue(administrator.cookie, cycle.id, {
      expectedDocumentVersion: 1,
    })
    const doomedId = doomed.data.admin.programmeCycle
      .issuePolicyDocumentUpload.response.uploadId as string
    await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { softDeleteDraft(input: $input) { success } } }
    }`, { input: { id: cycle.id, expectedVersion: 1, reason: 'Entered in error' } }, administrator.cookie)
    expect((await issue(administrator.cookie, cycle.id)).data.admin.programmeCycle
      .issuePolicyDocumentUpload).toMatchObject({
        success: false, message: 'The programme cycle was not found.',
      })
    expect((await finalize(doomedId)).data.admin.programmeCycle
      .finalizePolicyDocumentUpload).toMatchObject({
        success: false,
        message: 'A closed or archived cycle keeps its policy document as is.',
      })
  })

  it('sweeps expired authorizations on the scheduled cleanup', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    const ids: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const issued = await issue(administrator.cookie, cycle.id)
      ids.push(issued.data.admin.programmeCycle
        .issuePolicyDocumentUpload.response.uploadId as string)
    }
    await env.DB.prepare(
      `UPDATE seb_cycle_policy_upload_intent SET expires_at = NOW() - INTERVAL '1 hour'`,
    ).run()
    await cleanupExpiredCyclePolicyUploads({ db: activeDatabase(), env })
    for (const id of ids) {
      expect(await env.DB.prepare(
        'SELECT status FROM seb_cycle_policy_upload_intent WHERE id = ?',
      ).bind(id).first()).toEqual({ status: 'EXPIRED' })
    }
    // An idle run has nothing to claim and says nothing.
    await cleanupExpiredCyclePolicyUploads({ db: activeDatabase(), env })
  })

  it('keeps a claim it could not delete behind, and settles it next run', async () => {
    /*
     * Storage down mid-cleanup: the claim survives as CLEANUP_PENDING rather
     * than being closed over an object that still exists, and the next run —
     * with storage back — is what actually settles it.
     */
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    const issued = await issue(administrator.cookie, cycle.id)
    const uploadId = issued.data.admin.programmeCycle
      .issuePolicyDocumentUpload.response.uploadId as string
    await env.DB.prepare(
      `UPDATE seb_cycle_policy_upload_intent SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = ?`,
    ).bind(uploadId).run()

    const broken = {
      ...env,
      STORAGE: undefined,
      STORAGE_TRANSPORT: 'cloudinary',
      ENVIRONMENT: 'production',
    } as unknown as typeof env
    await cleanupExpiredCyclePolicyUploads({ db: activeDatabase(), env: broken })
    expect(await env.DB.prepare(
      'SELECT status FROM seb_cycle_policy_upload_intent WHERE id = ?',
    ).bind(uploadId).first()).toEqual({ status: 'CLEANUP_PENDING' })

    await cleanupExpiredCyclePolicyUploads({ db: activeDatabase(), env })
    expect(await env.DB.prepare(
      'SELECT status FROM seb_cycle_policy_upload_intent WHERE id = ?',
    ).bind(uploadId).first()).toEqual({ status: 'EXPIRED' })
  })

  it('isolates a batch delete failure to one call per object', async () => {
    /*
     * The batch delete refused but each object individually removable — the
     * fallback the cleanup carries so one stuck object cannot hold its whole
     * batch, and every intent behind it, forever.
     */
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    const ids: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const issued = await issue(administrator.cookie, cycle.id)
      ids.push(issued.data.admin.programmeCycle
        .issuePolicyDocumentUpload.response.uploadId as string)
    }
    await env.DB.prepare(
      `UPDATE seb_cycle_policy_upload_intent SET expires_at = NOW() - INTERVAL '1 hour'`,
    ).run()
    const batchRefusing = {
      ...env,
      STORAGE: {
        delete: async (keys: string | string[]) => {
          if (Array.isArray(keys) && keys.length > 1) throw new Error('batch refused')
        },
      },
    } as unknown as typeof env
    await cleanupExpiredCyclePolicyUploads({ db: activeDatabase(), env: batchRefusing })
    for (const id of ids) {
      expect(await env.DB.prepare(
        'SELECT status FROM seb_cycle_policy_upload_intent WHERE id = ?',
      ).bind(id).first()).toEqual({ status: 'EXPIRED' })
    }
  })

  it('settles scan requests the way the applicant twin does', async () => {
    // Deleted between queue and read: settled as GONE, never retried.
    expect(await scanPolicyDocumentVersion(activeDatabase(), env, crypto.randomUUID()))
      .toBe('GONE')

    // A version with no PENDING row to append after: deferred, not invented.
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    await seedPolicyDocument(cycle.id)
    await env.DB.prepare('DELETE FROM seb_cycle_policy_document_scan').run()
    const versionRow = await env.DB.prepare(
      'SELECT id FROM seb_cycle_policy_document_version LIMIT 1',
    ).first<{ id: string }>()
    expect(await scanPolicyDocumentVersion(activeDatabase(), env, versionRow!.id))
      .toBe('NOT_RECORDED')

    // An absent trail reads as PENDING — never more open than a running scan.
    const trailless = await graphql<any>(`query($id: ID!) {
      admin { programmeCycle { byId(id: $id) { response { policyDocument { scanStatus } } } } }
    }`, { id: cycle.id }, administrator.cookie)
    expect(trailless.data.admin.programmeCycle.byId.response.policyDocument)
      .toMatchObject({ scanStatus: 'PENDING' })

    // A verdict with no reference is not a verdict, and neither is one
    // carrying a time that is not a time.
    expect(await recordPolicyDocumentScanResult(activeDatabase(), {
      documentVersionId: versionRow!.id,
      status: 'ACCEPTED',
      scannerReference: '   ',
      scannedAt: new Date(),
    })).toBe(false)
    expect(await recordPolicyDocumentScanResult(activeDatabase(), {
      documentVersionId: versionRow!.id,
      status: 'ACCEPTED',
      scannerReference: 'seed',
      scannedAt: new Date(Number.NaN),
    })).toBe(false)
  })

  it('reports the document and its history on the admin aggregate', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(administrator.cookie)
    const before = await graphql<any>(`query($id: ID!) {
      admin { programmeCycle { byId(id: $id) { response { policyDocument { id } } } } }
    }`, { id: cycle.id }, administrator.cookie)
    expect(before.data.admin.programmeCycle.byId.response.policyDocument).toBeNull()

    await seedPolicyDocument(cycle.id)
    const after = await graphql<any>(`query($id: ID!) {
      admin { programmeCycle { byId(id: $id) { response { policyDocument {
        currentVersion originalFilename sizeBytes scanStatus
        versions { version operation scanStatus }
      } } } } }
    }`, { id: cycle.id }, administrator.cookie)
    expect(after.data.admin.programmeCycle.byId.response.policyDocument).toMatchObject({
      currentVersion: 1,
      originalFilename: 'policy.pdf',
      sizeBytes: 1024,
      scanStatus: 'ACCEPTED',
      versions: [{ version: 1, operation: 'UPLOAD', scanStatus: 'ACCEPTED' }],
    })
  })
})
