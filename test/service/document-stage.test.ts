/**
 * A cycle that does not call its evidence stage `DOCUMENTS`.
 *
 * The stage a document belongs to is the stage of its own `FILE` question, and
 * a revision reopens stages by name. Both facts are the cycle's to decide, so
 * nothing may assume a particular name — and the write's own guard did, long
 * after the controller stopped.
 *
 * The consequence was not a wrong answer but a dead end: during a revision the
 * applicant was told "The application or document changed. Refresh it and try
 * again." on every upload, replacement and removal, forever, because nothing
 * had changed and refreshing could not help.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { graphql, openCycle, signIn, submittedApplication } from '../support/api'
import { defaultTemplate } from '../support/form'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

/** The fixture form, with its evidence stage renamed and nothing else moved. */
const EVIDENCE = 'SUPPORTING_PAPERS'

const renamedEvidenceStage = () => defaultTemplate((template) => ({
  ...template,
  stages: template.stages.map((stage) =>
    stage.stageKey === 'DOCUMENTS' ? { ...stage, stageKey: EVIDENCE } : stage),
  fields: template.fields.map((field) =>
    field.stageKey === 'DOCUMENTS' ? { ...field, stageKey: EVIDENCE } : field),
}))

/**
 * A submitted application put back for correction on one named stage.
 *
 * Submitted first because a revision request points at the submission it was
 * raised against — there is no such thing as a correction to something nobody
 * has sent.
 */
const underRevisionOn = async (
  applicant: { cookie: string; userId: string },
  administrator: { cookie: string; userId: string },
  cycleId: string,
  stageKey: string,
  note: string,
) => {
  const submitted = await submittedApplication(applicant.cookie, applicant.userId, cycleId)
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE seb_application SET status = 'REVISION_REQUIRED',
        status_version = status_version + 1, status_changed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(now, now, submitted.applicationId),
    env.DB.prepare(
      `INSERT INTO seb_revision_request (
        id, application_id, submission_id, stage_key, requested_by_user_id, note, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), submitted.applicationId, submitted.submissionId,
      stageKey, administrator.userId, note, now,
    ),
  ])
  return submitted
}

describe('a cycle that names its evidence stage something else', () => {
  it('lets the applicant attach a document while the stage is open for revision', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const applicant = await signIn(['APPLICANT'])
    const cycle = await openCycle(administrator.cookie, {
      formTemplate: renamedEvidenceStage(),
    })
    const { applicationId } = await underRevisionOn(
      applicant, administrator, cycle.id, EVIDENCE, 'Please attach a clearer copy.',
    )

    const issued = await graphql<any>(`mutation($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) {
        success message response { uploadId }
      } } }
    }`, { input: {
      applicationId,
      fieldKey: 'DPR',
      expectedDocumentVersion: 1,
      originalFilename: 'clearer-copy.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    } }, applicant.cookie)

    const result = issued.data.seb.application.issueDocumentUpload
    expect(result.success, result.message ?? '').toBe(true)
    expect(result.response.uploadId).toBeTruthy()
  })

  it('still refuses when the stage the document belongs to is not the one reopened', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const applicant = await signIn(['APPLICANT'])
    const cycle = await openCycle(administrator.cookie, {
      formTemplate: renamedEvidenceStage(),
    })
    // A different stage entirely, so the evidence must stay shut.
    const { applicationId } = await underRevisionOn(
      applicant, administrator, cycle.id, 'FINANCIAL', 'Clarify the amount.',
    )

    const issued = await graphql<any>(`mutation($input: IssueDocumentUploadInput!) {
      seb { application { issueDocumentUpload(input: $input) { success message } } }
    }`, { input: {
      applicationId,
      fieldKey: 'DPR',
      expectedDocumentVersion: 1,
      originalFilename: 'not-asked-for.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksumSha256: 'A'.repeat(43) + '=',
    } }, applicant.cookie)

    expect(issued.data.seb.application.issueDocumentUpload).toMatchObject({
      success: false,
      message: 'Documents cannot be changed in the application’s current status.',
    })
  })
})
