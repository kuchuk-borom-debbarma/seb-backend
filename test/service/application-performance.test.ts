/**
 * What each applicant operation costs, in database round trips.
 *
 * A statement is a network hop, and a request's statements travel one at a
 * time on its one connection, so the count below is the latency floor of the
 * operation (docs/rules/performance.md). Each number is a budget: the test
 * fails when an operation grows past it, and raising one is a reviewed decision
 * with the reason written beside it.
 *
 * Only the count is asserted, never the statements' text, so an operation can
 * be restructured freely as long as its cost holds. The statements are printed
 * on failure to say which one is new.
 *
 * Skipped against a real Postgres (`npm run test:neon`): there each request
 * takes its own pool connection, which the counter, patched onto the harness's
 * driver handle, cannot see.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  attachEvidence,
  createEnterprise,
  graphql,
  openCycle,
  saveAnswers,
  signIn,
  startApplication,
  submitApplication,
} from '../support/api'
import { activeDriverHandle, closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { countRoundTrips, type RoundTripCounter } from '../support/round-trips'
import { advance, loanAnswers } from './support/stage'
import { env, SELF } from '../support/worker'

const onRealPostgres = Boolean(process.env.TEST_DATABASE_URL)

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

let trips: RoundTripCounter
const counted = async <T>(run: () => Promise<T>): Promise<{ result: T; count: number; statements: string }> => {
  trips ??= countRoundTrips(activeDriverHandle() as never)
  trips.reset()
  const result = await run()
  return { result, count: trips.count(), statements: trips.statements().join('\n---\n') }
}

/** An applicant with an enterprise and a fresh draft in an open cycle. */
const draft = async () => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const applicant = await signIn({ roles: ['APPLICANT'] })
  const enterpriseId = await createEnterprise(applicant.cookie)
  const id = await startApplication(applicant.cookie, enterpriseId, cycle.id)
  return { admin, cycle, applicant, enterpriseId, id }
}

/** A draft with every answer saved and every document attached. */
const readyToSubmit = async () => {
  const setup = await draft()
  const saved = await saveAnswers(setup.applicant.cookie, setup.id, loanAnswers('SBI'))
  await attachEvidence(setup.id, setup.applicant.userId)
  return { ...setup, saved }
}

const byIdQuery = `query($id: ID!) { seb { application { byId(id: $id) { success response {
  id currentVersion statusVersion status editableStageKeys answers
  journey { stageLabel } revisionRequests { id } documents { id } } } } } }`

describe.skipIf(onRealPostgres)('an applicant operation costs its budget in round trips', () => {
  /*
   * The shared shape: the session (1), the application with its current
   * version, documents, revision requests and answers (1), and its pinned form
   * (1). A write adds one statement; eligibility, where it is judged, adds one.
   */

  it('reads an application in three', async () => {
    const { applicant, id } = await draft()
    const { result, count, statements } = await counted(() => graphql<any>(byIdQuery, { id }, applicant.cookie))
    expect(result.data.seb.application.byId.success).toBe(true)
    // Session, application, form. A draft has no journey, so no pipeline read.
    expect(count, statements).toBe(3)
  })

  it('validates an application in three', async () => {
    const { applicant, id } = await draft()
    const { result, count, statements } = await counted(() => graphql<any>(`query($id: ID!) {
      seb { application { validate(applicationId: $id) { success response { valid } } } } }`, { id }, applicant.cookie))
    expect(result.data.seb.application.validate.success).toBe(true)
    // Session, application (with the enterprise's establishment date), form.
    expect(count, statements).toBe(3)
  })

  it('reads the pinned form in three', async () => {
    const { applicant, id } = await draft()
    const { result, count, statements } = await counted(() => graphql<any>(`query($id: ID!) {
      seb { application { formTemplate(applicationId: $id) { success response { stages { key } } } } } }`, { id }, applicant.cookie))
    expect(result.data.seb.application.formTemplate.success).toBe(true)
    // Session, the head with its pin, the form.
    expect(count, statements).toBe(3)
  })

  it('saves a draft in four', async () => {
    const { applicant, id } = await draft()
    const { count, statements } = await counted(() => saveAnswers(applicant.cookie, id, loanAnswers('SBI')))
    // Session, application, form, one guarded write — the response is built
    // from what was read and what the write returned, not reloaded.
    expect(count, statements).toBe(4)
  })

  it('declines to save an unchanged draft in three', async () => {
    const { applicant, id } = await draft()
    const saved = await saveAnswers(applicant.cookie, id, loanAnswers('SBI'))
    const { count, statements } = await counted(() => saveAnswers(applicant.cookie, id, loanAnswers('SBI'),
      { version: saved.currentVersion, statusVersion: saved.statusVersion }))
    // Nothing changed, so nothing is written.
    expect(count, statements).toBe(3)
  })

  it('starts an application in five', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const enterpriseId = await createEnterprise(applicant.cookie)
    const { count, statements } = await counted(() => startApplication(applicant.cookie, enterpriseId, cycle.id))
    // Session; the enterprise, owned and with an open funding case; the open
    // cycle with its kinds and the enterprise's history; the form; one
    // guarded write. The ownership read stays its own: eligibility reads an
    // enterprise's history, and is only asked once the caller owns it.
    expect(count, statements).toBe(5)
  })

  it('submits in five', async () => {
    const { applicant, id, saved } = await readyToSubmit()
    const { count, statements } = await counted(() => submitApplication(applicant.cookie, id, {
      version: saved.currentVersion, statusVersion: saved.statusVersion,
    }))
    // Session, application, form, eligibility, one guarded write. The
    // confirmation email goes after the response; it sends nothing to the
    // database unless it fails.
    expect(count, statements).toBe(5)
  })

  it('saves a correction and resubmits in four each', async () => {
    const { admin, applicant, id, saved } = await readyToSubmit()
    await submitApplication(applicant.cookie, id, { version: saved.currentVersion, statusVersion: saved.statusVersion })
    await advance(admin.cookie, id, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Please restate the amount.' }],
    })
    const mine = (await graphql<any>(byIdQuery, { id }, applicant.cookie)).data.seb.application.byId.response

    const correction = await counted(() => saveAnswers(applicant.cookie, id,
      { ...loanAnswers('SBI'), SEED_FUND_REQUESTED_PAISE: 8_000_000 },
      { version: mine.currentVersion, statusVersion: mine.statusVersion }))
    // The submitted answers the scope is checked against come with the
    // application, so a correction costs what a draft save costs.
    expect(correction.count, correction.statements).toBe(4)

    const resubmit = await counted(() => graphql<any>(`mutation($input: ApplicationVersionInput!) {
      seb { application { resubmit(input: $input) { success message } } } }`, { input: {
      applicationId: id,
      expectedVersion: correction.result.currentVersion,
      expectedStatusVersion: correction.result.statusVersion,
    } }, applicant.cookie))
    expect(resubmit.result.data.seb.application.resubmit.success, resubmit.result.data.seb.application.resubmit.message).toBe(true)
    // Session, application, form, one guarded write. No eligibility: a
    // resubmission is the same application.
    expect(resubmit.count, resubmit.statements).toBe(4)
  })

  it('puts a draft away in four and brings it back in five', async () => {
    const { applicant, id } = await draft()
    const removed = await counted(() => graphql<any>(`mutation($input: ApplicationDeletionInput!) {
      seb { application { softDeleteDraft(input: $input) { success message response { currentVersion statusVersion } } } } }`,
    { input: { applicationId: id, expectedVersion: 1, expectedStatusVersion: 1, reason: 'Started by mistake.' } }, applicant.cookie))
    expect(removed.result.data.seb.application.softDeleteDraft.success).toBe(true)
    // Session, application, form, one guarded write.
    expect(removed.count, removed.statements).toBe(4)

    const restored = await counted(() => graphql<any>(`mutation($input: ApplicationVersionInput!) {
      seb { application { restoreDraft(input: $input) { success message } } } }`,
    { input: { applicationId: id, expectedVersion: 1, expectedStatusVersion: 1 } }, applicant.cookie))
    expect(restored.result.data.seb.application.restoreDraft.success, restored.result.data.seb.application.restoreDraft.message).toBe(true)
    // As above, plus whether the kind is still open to this enterprise.
    expect(restored.count, restored.statements).toBe(5)
  })

  it('authorises a document upload in four', async () => {
    const { applicant, id } = await draft()
    const { result, count, statements } = await counted(() => graphql<any>(`mutation($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) { success message } } } }`, { input: {
      applicationId: id, fieldKey: 'DPR', expectedDocumentVersion: 0, originalFilename: 'dpr.pdf',
      contentType: 'application/pdf', sizeBytes: 10, checksumSha256: 'A'.repeat(43) + '=',
    } }, applicant.cookie))
    expect(result.data.seb.application.issueDocumentUpload.success, result.data.seb.application.issueDocumentUpload.message).toBe(true)
    // Session; the head with its pin, open revision stages and documents;
    // the form; one write.
    expect(count, statements).toBe(4)
  })

  it('answers a screen\'s queries sent together in one request, reading the session and the form once', async () => {
    const { applicant, id } = await draft()
    const { result, count, statements } = await counted(async () => {
      const response = await SELF.fetch('https://api.example.test/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://app.example.test', cookie: applicant.cookie },
        body: JSON.stringify([
          { query: byIdQuery, variables: { id } },
          { query: `query($id: ID!) { seb { application { formTemplate(applicationId: $id) { success } } } }`, variables: { id } },
          { query: `query($id: ID!) { seb { application { validate(applicationId: $id) { success } } } }`, variables: { id } },
        ]),
      })
      return (await response.json()) as any[]
    })
    expect(result.map((each) => Object.values(each.data.seb.application)[0])).toEqual([
      expect.objectContaining({ success: true }), { success: true }, { success: true },
    ])
    // Sent one at a time these are nine. Together: the session once; the
    // application for the read; the form once, through the request's loader;
    // the head and pin for the form query; the application for validation.
    expect(count, statements).toBe(5)
  })

  /*
   * Finalizing an upload has no budget test here: it verifies the object in
   * storage, and the service suite has no bucket. Its write is the same
   * shape — one statement — and is exercised directly in application.test.ts.
   */
  it('removes a document in four', async () => {
    const { applicant, id } = await draft()
    const [document] = await attachEvidence(id, applicant.userId, ['DPR'])
    const { result, count, statements } = await counted(() => graphql<any>(`mutation($input: ApplicationDocumentVersionInput!) {
      seb { application { softDeleteDocument(input: $input) { success message } } } }`, { input: {
      applicationId: id, documentId: document.documentId, expectedVersion: 1,
    } }, applicant.cookie))
    expect(result.data.seb.application.softDeleteDocument.success, result.data.seb.application.softDeleteDocument.message).toBe(true)
    // As the upload: session, the application with its documents, the form,
    // one write.
    expect(count, statements).toBe(4)
  })
})

/*
 * A write builds its response from what it loaded and what it wrote rather
 * than reading the application back. These hold that response to what a read
 * made straight afterwards returns, field for field — including the answers,
 * which pass through storage's own shape (a blank reads as null, a multiple
 * choice in the form's order).
 */
const applicationFields = `id enterpriseId programmeCycleId applicationKind phaseNumber
  referenceNumber currentVersion status statusVersion firstSubmittedAt createdAt updatedAt deletedAt
  editableStageKeys answers journey { stageLabel ended flags { key } }
  snapshot { version answers programmeCycleVersion applicationKind phaseNumber changeType
    declarationAcceptedAt applicationCategory createdAt }
  documents { id fieldKey currentVersion originalFilename contentType sizeBytes createdAt deletedAt }
  revisionRequests { id stageKey note requestedAt resolvedAt cancelledAt }`

const readBack = async (cookie: string, id: string) =>
  (await graphql<any>(`query($id: ID!) { seb { application { byId(id: $id) { response { ${applicationFields} } } } } }`,
    { id }, cookie)).data.seb.application.byId.response

describe('a write answers with what a read would return', () => {
  it('after starting an application', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const enterpriseId = await createEnterprise(applicant.cookie)
    const body = await graphql<any>(`mutation($input: StartApplicationInput!) {
      seb { application { start(input: $input) { success message response { ${applicationFields} } } } } }`, { input: {
      enterpriseId, programmeCycleId: cycle.id, applicationKind: 'INITIAL',
    } }, applicant.cookie)
    expect(body.data.seb.application.start.success, body.data.seb.application.start.message).toBe(true)
    const started = body.data.seb.application.start.response
    expect(started).toEqual(await readBack(applicant.cookie, started.id))
  })

  it('after saving a draft', async () => {
    const { applicant, id } = await draft()
    const body = await graphql<any>(`mutation($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success message response { ${applicationFields} } } } } }`, { input: {
      applicationId: id, expectedVersion: 1, expectedStatusVersion: 1,
      answers: loanAnswers('SBI'),
    } }, applicant.cookie)
    expect(body.data.seb.application.saveDraft.success, body.data.seb.application.saveDraft.message).toBe(true)
    expect(body.data.seb.application.saveDraft.response).toEqual(await readBack(applicant.cookie, id))
  })
  it('after putting a draft away and bringing it back', async () => {
    const { applicant, id } = await draft()
    const removed = await graphql<any>(`mutation($input: ApplicationDeletionInput!) {
      seb { application { softDeleteDraft(input: $input) { success message response { ${applicationFields} } } } } }`,
    { input: { applicationId: id, expectedVersion: 1, expectedStatusVersion: 1, reason: 'Started by mistake.' } }, applicant.cookie)
    expect(removed.data.seb.application.softDeleteDraft.success, removed.data.seb.application.softDeleteDraft.message).toBe(true)
    expect(removed.data.seb.application.softDeleteDraft.response).toEqual(await readBack(applicant.cookie, id))

    const restored = await graphql<any>(`mutation($input: ApplicationVersionInput!) {
      seb { application { restoreDraft(input: $input) { success message response { ${applicationFields} } } } } }`,
    { input: { applicationId: id, expectedVersion: 1, expectedStatusVersion: 1 } }, applicant.cookie)
    expect(restored.data.seb.application.restoreDraft.success, restored.data.seb.application.restoreDraft.message).toBe(true)
    expect(restored.data.seb.application.restoreDraft.response).toEqual(await readBack(applicant.cookie, id))
  })

  it('after submitting, and after resubmitting a correction', async () => {
    const { admin, applicant, id, saved } = await readyToSubmit()
    const submit = await graphql<any>(`mutation($input: ApplicationVersionInput!) {
      seb { application { submit(input: $input) { success message response { ${applicationFields} } } } } }`, { input: {
      applicationId: id, expectedVersion: saved.currentVersion, expectedStatusVersion: saved.statusVersion,
    } }, applicant.cookie)
    expect(submit.data.seb.application.submit.success, submit.data.seb.application.submit.message).toBe(true)
    expect(submit.data.seb.application.submit.response).toEqual(await readBack(applicant.cookie, id))

    await advance(admin.cookie, id, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Please restate the amount.' }],
    })
    const mine = await readBack(applicant.cookie, id)
    const corrected = await saveAnswers(applicant.cookie, id,
      { ...loanAnswers('SBI'), SEED_FUND_REQUESTED_PAISE: 8_000_000 },
      { version: mine.currentVersion, statusVersion: mine.statusVersion })
    const resubmit = await graphql<any>(`mutation($input: ApplicationVersionInput!) {
      seb { application { resubmit(input: $input) { success message response { ${applicationFields} } } } } }`, { input: {
      applicationId: id, expectedVersion: corrected.currentVersion, expectedStatusVersion: corrected.statusVersion,
    } }, applicant.cookie)
    expect(resubmit.data.seb.application.resubmit.success, resubmit.data.seb.application.resubmit.message).toBe(true)
    expect(resubmit.data.seb.application.resubmit.response).toEqual(await readBack(applicant.cookie, id))
  })
})

describe('a submission', () => {
  /*
   * The office's queue sorts by when a file last changed state. Submitting is
   * the change that puts it in the queue, and it once left the column at the
   * draft's creation time, so a new submission sorted as if it were old.
   */
  it('stamps when the application changed state', async () => {
    const { applicant, id, saved } = await readyToSubmit()
    const before = Date.now()
    await submitApplication(applicant.cookie, id, { version: saved.currentVersion, statusVersion: saved.statusVersion })
    const row = await env.DB.prepare('SELECT status_changed_at AS "changedAt" FROM seb_application WHERE id = ?')
      .bind(id).first<{ changedAt: string | Date }>()
    expect(new Date(row!.changedAt).getTime()).toBeGreaterThanOrEqual(before)
  })
})
