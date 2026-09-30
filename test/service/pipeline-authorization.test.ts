/**
 * Who may see and act on a file at a stage.
 *
 * Two halves decide it, and each is tested without the other: **ownership**,
 * which is the only thing separating a State Bank of India officer from a
 * Tripura Gramin Bank officer who hold identical permissions, and the
 * **permissions the action's effects need**, which no author can make cheaper
 * by naming an action something else. And the stage panel's `permitted` must
 * say exactly what `takeAction` will decide, or the screen offers refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { completeAnswers } from '../support/form'
import {
  createEnterprise,
  graphql,
  openCycle,
  signIn,
  startApplication,
  submittedApplication,
  type FixturePermission,
} from '../support/api'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { TEST_PIPELINE_ID } from '../support/pipeline'
import { env } from '../support/worker'
import { act, advance, loanAnswers, officer, ownStages, readStage, STAGE_OFFICER } from './support/stage'

beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})

const NOT_PERMITTED = 'You do not have permission to do that.'
const NOT_FOUND = 'That could not be found.'

/** Two files, one routed to each bank. */
const twoBankFiles = async () => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const files: Record<'SBI' | 'TGB', string> = { SBI: '', TGB: '' }
  for (const bank of ['SBI', 'TGB'] as const) {
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers(bank) })
    await advance(admin.cookie, file.applicationId, 'TO_INDUSTRIES_COMMERCE')
    await advance(admin.cookie, file.applicationId, 'SEND_TO_BANK', { inputs: { BANK: bank } })
    files[bank] = file.applicationId
  }
  return { admin, cycle, files }
}

const intakeIds = async (cookie: string) => {
  const body = await graphql<any>(`query {
    admin { intake { queue(input: { first: 100 }) { success message response { nodes { id } pageInfo { totalCount } } } } }
  }`, {}, cookie)
  return body.data.admin.intake.queue
}

const stageQueue = async (cookie: string, stageKey: string) => {
  const body = await graphql<any>(`query($input: AdminStageQueueInput!) {
    admin { stage { queue(input: $input) { success message response { nodes { id } pageInfo { totalCount } } } } }
  }`, { input: { pipelineId: TEST_PIPELINE_ID, stageKey } }, cookie)
  return body.data.admin.stage.queue
}

const workspace = async (cookie: string, applicationId: string) => {
  const body = await graphql<any>(`query($id: ID!) {
    admin { intake { workspace(applicationId: $id) { success message } } }
  }`, { id: applicationId }, cookie)
  return body.data.admin.intake.workspace
}

describe('stage ownership', () => {
  it('keeps one bank’s officer out of the other bank’s files, whatever they hold', async () => {
    const { files } = await twoBankFiles()
    const sbi = await officer(['SBI_BANK'])
    const tgb = await officer(['TGB_BANK'])

    // Identical permissions; different stages; different files.
    expect((await readStage(sbi.cookie, files.SBI)).success).toBe(true)
    expect(await readStage(sbi.cookie, files.TGB)).toMatchObject({ success: false, message: NOT_FOUND })
    expect(await workspace(sbi.cookie, files.TGB)).toMatchObject({ success: false })
    expect(await workspace(sbi.cookie, files.SBI)).toMatchObject({ success: true })

    const listed = await intakeIds(sbi.cookie)
    expect(listed.response.nodes.map((node: any) => node.id)).toEqual([files.SBI])
    // The count counts what the reader may see, not the office's whole queue.
    expect(listed.response.pageInfo.totalCount).toBe(1)

    expect(await stageQueue(sbi.cookie, 'TGB_BANK')).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect((await stageQueue(sbi.cookie, 'SBI_BANK')).response.nodes.map((node: any) => node.id)).toEqual([files.SBI])

    // Acting on the other bank's file reads as a file that is not there.
    const refused = await act(sbi.cookie, {
      applicationId: files.TGB, expectedStatusVersion: 4, stageKey: 'TGB_BANK', actionKey: 'SEND_BACK',
      inputs: { NOTE: 'Not ours.' },
    })
    expect(refused).toMatchObject({ success: false, message: NOT_FOUND })
    expect((await readStage(tgb.cookie, files.TGB)).success).toBe(true)
  })

  it('lets an office-wide reader see every file and act on none', async () => {
    const { files } = await twoBankFiles()
    const reader = await signIn({ permissions: [['application', 'read'], ...STAGE_OFFICER] })
    const panel = await readStage(reader.cookie, files.TGB)
    expect(panel.response.worksStage).toBe(false)
    expect(panel.response.actions.length).toBeGreaterThan(0)
    expect(panel.response.actions.every((action: any) => action.permitted === false)).toBe(true)
    const refused = await act(reader.cookie, {
      applicationId: files.TGB, expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'TGB_BANK', actionKey: 'SEND_BACK', inputs: { NOTE: 'x' },
    })
    expect(refused).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect((await intakeIds(reader.cookie)).response.pageInfo.totalCount).toBe(2)
  })

  it('refuses a reader with no read permission at all', async () => {
    const { files } = await twoBankFiles()
    const nobody = await signIn({ permissions: [['announcement', 'read']] })
    expect(await readStage(nobody.cookie, files.SBI)).toMatchObject({ success: false, message: NOT_PERMITTED })
    expect(await intakeIds(nobody.cookie)).toMatchObject({ success: false })
    const worked = await graphql<any>('query { admin { stage { myStages { success message } } } }', {}, nobody.cookie)
    expect(worked.data.admin.stage.myStages).toMatchObject({ success: false })
  })

  it('lists the stages a person works, with what waits at each', async () => {
    const { admin } = await twoBankFiles()
    const sbi = await officer(['SBI_BANK'])
    const body = await graphql<any>(
      'query { admin { stage { myStages { success response { stageKey stageName waiting } } } } }', {}, sbi.cookie,
    )
    expect(body.data.admin.stage.myStages.response).toEqual([
      { stageKey: 'SBI_BANK', stageName: 'State Bank of India', waiting: 1 },
    ])
    const all = await graphql<any>(
      'query { admin { stage { myStages { success response { stageKey waiting } } } } }', {}, admin.cookie,
    )
    expect(all.data.admin.stage.myStages.response).toEqual([
      { stageKey: 'TTC', waiting: 0 },
      { stageKey: 'INDUSTRIES_COMMERCE', waiting: 0 },
      { stageKey: 'SBI_BANK', waiting: 1 },
      { stageKey: 'TGB_BANK', waiting: 1 },
    ])
  })
})

describe('the permissions an action’s effects need', () => {
  /** A file at Industries & Commerce, which offers a return, a decision and a move. */
  const atIndustries = async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers('SBI') })
    await advance(admin.cookie, file.applicationId, 'TO_INDUSTRIES_COMMERCE')
    return file.applicationId
  }

  const matrix: { name: string; permissions: FixturePermission[]; permitted: Record<string, boolean> }[] = [
    {
      name: 'every stage permission',
      permissions: STAGE_OFFICER,
      permitted: { SEND_BACK: true, APPROVE_GRANT: true, SEND_TO_BANK: true },
    },
    {
      // Approving is a decision: an OUTCOME flag and a recorded amount.
      name: 'no authority to decide',
      permissions: STAGE_OFFICER.filter(([, action]) => action !== 'decide'),
      permitted: { SEND_BACK: true, APPROVE_GRANT: false, SEND_TO_BANK: true },
    },
    {
      // A send-back keeps its note, which is writing a staff note.
      name: 'no authority to write notes',
      permissions: STAGE_OFFICER.filter(([resource]) => resource !== 'application'),
      permitted: { SEND_BACK: false, APPROVE_GRANT: true, SEND_TO_BANK: true },
    },
    {
      name: 'reading only',
      permissions: [['stage', 'read']],
      permitted: { SEND_BACK: false, APPROVE_GRANT: false, SEND_TO_BANK: false },
    },
  ]

  it.each(matrix)('with $name, the panel and takeAction agree', async ({ permissions, permitted }) => {
    const id = await atIndustries()
    const who = await officer(['INDUSTRIES_COMMERCE'], permissions)
    const panel = await readStage(who.cookie, id)
    const offered = Object.fromEntries(panel.response.actions.map((action: any) => [action.key, action.permitted]))
    expect(offered).toEqual(permitted)
    for (const [actionKey, allowed] of Object.entries(permitted)) {
      // Empty inputs: a permitted action gets past the permission check and is
      // refused on its form instead, so nothing is written either way.
      const result = await act(who.cookie, {
        applicationId: id, expectedStatusVersion: panel.response.statusVersion,
        stageKey: 'INDUSTRIES_COMMERCE', actionKey, inputs: {},
      })
      expect(result.success).toBe(false)
      if (allowed) {
        expect(result.message).not.toBe(NOT_PERMITTED)
        expect(result.issues.length).toBeGreaterThan(0)
      } else {
        expect(result.message).toBe(NOT_PERMITTED)
      }
    }
  })

  it('refuses the permissions without the stage', async () => {
    const id = await atIndustries()
    const elsewhere = await signIn({ permissions: [['application', 'read'], ...STAGE_OFFICER] })
    await ownStages(elsewhere.roleId, ['TTC'], elsewhere.userId)
    const panel = await readStage(elsewhere.cookie, id)
    expect(panel.response.actions.every((action: any) => !action.permitted)).toBe(true)
    expect(await act(elsewhere.cookie, {
      applicationId: id, expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'INDUSTRIES_COMMERCE', actionKey: 'SEND_TO_BANK', inputs: { BANK: 'SBI' },
    })).toMatchObject({ success: false, message: NOT_PERMITTED })
  })

  it('refuses a withdrawal by somebody who does not work the stage', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: completeAnswers() })
    await advance(admin.cookie, file.applicationId, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Restate it.' }],
    })
    const reader = await signIn({ permissions: [['application', 'read'], ...STAGE_OFFICER] })
    const panel = await readStage(reader.cookie, file.applicationId)
    expect(panel.response.canWithdrawRevision).toBe(false)
    const body = await graphql<any>(`mutation($input: WithdrawRevisionInput!) {
      admin { stage { withdrawRevision(input: $input) { success message } } }
    }`, { input: {
      applicationId: file.applicationId, expectedStatusVersion: panel.response.statusVersion,
      revisionRequestId: panel.response.openRevisions[0].id, reason: 'Not mine to withdraw.',
    } }, reader.cookie)
    expect(body.data.admin.stage.withdrawRevision).toMatchObject({ success: false, message: NOT_PERMITTED })
  })
})

describe('acting on one’s own application', () => {
  it('is allowed only when said, and the saying is recorded', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const both = await signIn({ roles: ['APPLICANT'], permissions: STAGE_OFFICER })
    await ownStages(both.roleId, ['TTC'], both.userId)
    const file = await submittedApplication(both.cookie, both.userId, cycle.id, { answers: completeAnswers() })
    const panel = await readStage(both.cookie, file.applicationId)
    expect(panel.response.applicantUserId).toBe(both.userId)
    const base = {
      applicationId: file.applicationId, expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'TTC', actionKey: 'TO_INDUSTRIES_COMMERCE',
    }
    expect(await act(both.cookie, base)).toMatchObject({ success: false })
    expect(await act(both.cookie, { ...base, selfReviewDisclosed: true })).toMatchObject({ success: true })
    const disclosed = await env.DB.prepare(
      `SELECT count(*)::int AS n FROM core_audit_event
        WHERE application_id = ? AND action = 'SEB.SELF_REVIEW_DISCLOSED' AND subject_user_id = ?`,
    ).bind(file.applicationId, both.userId).first<{ n: number }>()
    expect(disclosed!.n).toBe(1)
    const row = await env.DB.prepare(
      'SELECT self_review_disclosed AS "disclosed" FROM seb_application_stage_action WHERE application_id = ?',
    ).bind(file.applicationId).first<{ disclosed: boolean }>()
    expect(row!.disclosed).toBe(true)
  })
})

describe('the office’s own reads, in the same scope', () => {
  const referenceOf = async (applicationId: string) =>
    (await env.DB.prepare('SELECT reference_number AS "referenceNumber" FROM seb_application WHERE id = ?')
      .bind(applicationId).first<{ referenceNumber: string }>())!.referenceNumber

  const byReference = async (cookie: string, referenceNumber: string) => {
    const body = await graphql<any>(`query($ref: String!) {
      admin { intake { byReference(referenceNumber: $ref) { success message response { id } } } }
    }`, { ref: referenceNumber }, cookie)
    return body.data.admin.intake.byReference
  }

  const note = async (cookie: string, applicationId: string, text: string) => {
    const body = await graphql<any>(`mutation($input: InternalNoteInput!) {
      admin { intake { addInternalNote(input: $input) { success message response { notes { note } } } } }
    }`, { input: { applicationId, note: text } }, cookie)
    return body.data.admin.intake.addInternalNote
  }

  const queue = async (cookie: string, input: Record<string, unknown>) => {
    const body = await graphql<any>(`query($input: AdminIntakeQueueInput) {
      admin { intake { queue(input: $input) { success message response { nodes { id } } } } }
    }`, { input }, cookie)
    return body.data.admin.intake.queue
  }

  it('finds by reference, notes and downloads only within the reader’s files', async () => {
    const { files } = await twoBankFiles()
    const sbi = await officer(['SBI_BANK'])
    expect(await byReference(sbi.cookie, await referenceOf(files.SBI))).toMatchObject({ success: true, response: { id: files.SBI } })
    expect(await byReference(sbi.cookie, await referenceOf(files.TGB))).toMatchObject({ success: false })
    expect(await byReference(sbi.cookie, '   ')).toMatchObject({ success: false })

    const written = await note(sbi.cookie, files.SBI, 'Branch visit booked.')
    expect(written.success).toBe(true)
    expect(written.response.notes.map((each: any) => each.note)).toEqual(['Branch visit booked.'])
    // The insert's own guard repeats the scope: nothing lands on the other bank's file.
    expect(await note(sbi.cookie, files.TGB, 'Not ours.')).toMatchObject({ success: false })
    const stray = await env.DB.prepare(
      'SELECT count(*)::int AS n FROM seb_application_internal_note WHERE application_id = ?',
    ).bind(files.TGB).first<{ n: number }>()
    expect(stray!.n).toBe(0)

    const download = await graphql<any>(`query($id: ID!, $doc: ID!) {
      admin { intake { documentDownloadUrl(applicationId: $id, submissionDocumentId: $doc) { success message } } }
    }`, { id: files.TGB, doc: 'anything' }, sbi.cookie)
    expect(download.data.admin.intake.documentDownloadUrl).toMatchObject({ success: false, message: 'The application was not found.' })
  })

  it('refuses a draft’s documents as though it did not exist', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const draftId = await startApplication(applicant.cookie, await createEnterprise(applicant.cookie), cycle.id)
    const download = await graphql<any>(`query($id: ID!, $doc: ID!) {
      admin { intake { documentDownloadUrl(applicationId: $id, submissionDocumentId: $doc) { success message } } }
    }`, { id: draftId, doc: 'anything' }, admin.cookie)
    expect(download.data.admin.intake.documentDownloadUrl).toMatchObject({ success: false, message: 'The application was not found.' })
  })

  it('filters the office list by pipeline, stage, flags and the loan asked for', async () => {
    const { admin, files } = await twoBankFiles()
    const ids = async (input: Record<string, unknown>) =>
      (await queue(admin.cookie, input)).response.nodes.map((node: any) => node.id).sort()
    expect(await ids({ pipelineId: TEST_PIPELINE_ID, stageKeys: ['SBI_BANK'] })).toEqual([files.SBI])
    expect(await ids({ flags: ['BANKING_STAGE', 'IN_REVIEW'] })).toEqual([files.SBI, files.TGB].sort())
    expect(await ids({ flags: ['GRANT_APPROVED'] })).toEqual([])
    expect(await ids({ loanRequestedMinPaise: 50_000_000, loanRequestedMaxPaise: 50_000_000 })).toEqual([files.SBI, files.TGB].sort())
    expect(await ids({ loanRequestedMinPaise: 50_000_001 })).toEqual([])
    expect(await queue(admin.cookie, { loanRequestedMinPaise: 2, loanRequestedMaxPaise: 1 }))
      .toMatchObject({ success: false, message: 'The requested loan range is invalid.' })
    expect(await queue(admin.cookie, { stageKeys: ['SBI_BANK'] }))
      .toMatchObject({ success: false, message: 'Choose the pipeline the stages belong to.' })
    expect(await queue(admin.cookie, { flags: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'] }))
      .toMatchObject({ success: false })
  })
})

describe('refusals, each in its own words', () => {
  const fileAtTtc = async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(admin.cookie)
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: completeAnswers() })
    return { admin, id: file.applicationId }
  }

  it('acts with ownership and the effect’s permission alone, reading permission or not', async () => {
    const { id } = await fileAtTtc()
    // Moving a file needs `stage:advance` and the stage; nothing else.
    const mover = await officer(['TTC'], [['stage', 'advance']])
    expect(await act(mover.cookie, {
      applicationId: id, expectedStatusVersion: 2, stageKey: 'TTC', actionKey: 'TO_INDUSTRIES_COMMERCE',
    })).toMatchObject({ success: true })
  })

  it('refuses a stale screen, an unknown action and a malformed correction', async () => {
    const { admin, id } = await fileAtTtc()
    const panel = await readStage(admin.cookie, id)
    const base = { applicationId: id, expectedStatusVersion: panel.response.statusVersion, stageKey: 'TTC' }
    expect(await act(admin.cookie, { ...base, expectedStatusVersion: 99, actionKey: 'TO_INDUSTRIES_COMMERCE' }))
      .toMatchObject({ success: false, message: 'The record changed. Reload and try again.' })
    expect(await act(admin.cookie, { ...base, stageKey: 'SBI_BANK', actionKey: 'FULFIL_LOAN' }))
      .toMatchObject({ success: false, message: 'The record changed. Reload and try again.' })
    expect(await act(admin.cookie, { ...base, actionKey: 'NO_SUCH_ACTION' }))
      .toMatchObject({ success: false, message: 'That action is not offered at this stage.' })
    expect(await act(admin.cookie, { ...base, actionKey: 'ASK_REVISION', revisionRequests: [
      { stageKey: 'FINANCIAL', note: 'One.' }, { stageKey: 'FINANCIAL', note: 'Two.' },
    ] })).toMatchObject({ success: false, message: 'Name each section for correction once.' })
    expect(await act(admin.cookie, { ...base, actionKey: 'ASK_REVISION', revisionRequests: [
      { stageKey: 'FINANCIAL', note: '   ' },
    ] })).toMatchObject({ success: false })
    expect(await act(admin.cookie, { applicationId: 'missing', expectedStatusVersion: 2, stageKey: 'TTC', actionKey: 'REJECT' }))
      .toMatchObject({ success: false, message: NOT_FOUND })
  })

  it('refuses a withdrawal that is stale, of nothing open, or without a reason', async () => {
    const { admin, id } = await fileAtTtc()
    await advance(admin.cookie, id, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'One.' }, { stageKey: 'OWNERS', note: 'Two.' }],
    })
    const panel = await readStage(admin.cookie, id)
    const withdraw = async (input: Record<string, unknown>) => (await graphql<any>(`mutation($input: WithdrawRevisionInput!) {
      admin { stage { withdrawRevision(input: $input) { success message response { openRevisionCount flags } } } }
    }`, { input: {
      applicationId: id, expectedStatusVersion: panel.response.statusVersion,
      revisionRequestId: panel.response.openRevisions[0].id, reason: 'Asked in error.', ...input,
    } }, admin.cookie)).data.admin.stage.withdrawRevision
    expect(await withdraw({ expectedStatusVersion: 99 })).toMatchObject({ success: false, message: 'The record changed. Reload and try again.' })
    expect(await withdraw({ revisionRequestId: 'nothing' })).toMatchObject({ success: false, message: 'That correction request is not open.' })
    expect(await withdraw({ reason: ' ' })).toMatchObject({ success: false })
    expect(await withdraw({ applicationId: 'missing' })).toMatchObject({ success: false, message: NOT_FOUND })
    // One of two withdrawn: the other is still open, so the file stays with the applicant.
    expect(await withdraw({})).toMatchObject({
      success: true, response: { openRevisionCount: 1, flags: ['IN_REVIEW', 'REVISION_REQUIRED'] },
    })
  })

  it('refuses a queue page it cannot read', async () => {
    const { admin } = await fileAtTtc()
    const page = async (input: Record<string, unknown>) => (await graphql<any>(`query($input: AdminStageQueueInput!) {
      admin { stage { queue(input: $input) { success message } } }
    }`, { input: { pipelineId: TEST_PIPELINE_ID, stageKey: 'TTC', ...input } }, admin.cookie)).data.admin.stage.queue
    expect(await page({ after: 'not-a-cursor' })).toMatchObject({ success: false, message: 'Invalid pagination arguments.' })
    expect(await page({ flags: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'] })).toMatchObject({ success: false })
    expect(await page({ flags: ['IN_REVIEW'] })).toMatchObject({ success: true })
  })
})
