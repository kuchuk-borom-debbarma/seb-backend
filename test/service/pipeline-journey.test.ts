/**
 * One file worked through the example pipeline end to end, over the API.
 *
 * TTC → Industries & Commerce → the bank the applicant chose → completed, with
 * every backward move the office can make on the way: a correction the
 * applicant makes and resubmits, a bank sending the file back, and the file
 * then routed to the other bank. Then the two short journeys: a file that
 * asked for no loan, and a rejected one.
 *
 * What each step proves is the thing that would be wrong silently: that a
 * resubmission returns the file to the stage that asked rather than the start,
 * that a send-back walks the file's own trail, that presence flags follow the
 * file, that an amount over what was asked is refused and writes nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { completeAnswers } from '../support/form'
import { graphql, openCycle, signIn, submittedApplication } from '../support/api'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { act, advance, loanAnswers, officer, readStage } from './support/stage'

beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})

const setup = async (answers: Record<string, unknown>) => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const applicant = await signIn({ roles: ['APPLICANT'] })
  const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers })
  const ttc = await officer(['TTC'])
  const ic = await officer(['INDUSTRIES_COMMERCE'])
  const sbi = await officer(['SBI_BANK'])
  const tgb = await officer(['TGB_BANK'])
  return { admin, applicant, file, ttc, ic, sbi, tgb }
}

/** The applicant's own view of their file: versions to quote, and where it is. */
const applicantView = async (cookie: string, id: string) => {
  const body = await graphql<any>(`query($id: ID!) {
    seb { application { byId(id: $id) { success response {
      currentVersion statusVersion status editableStageKeys
      journey { stageLabel stageExplanation ended flags { key label } recordedValues { key label value } }
    } } } }
  }`, { id }, cookie)
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data.seb.application.byId.response
}

const countOf = async (table: string, applicationId: string) =>
  (await env.DB.prepare(`SELECT count(*)::int AS n FROM ${table} WHERE application_id = ?`)
    .bind(applicationId).first<{ n: number }>())!.n

describe('the example pipeline, forward and back', () => {
  it('works a grant-and-loan file through every stage, including every backward move', async () => {
    const { applicant, file, ttc, ic, sbi, tgb } = await setup(loanAnswers('SBI'))
    const id = file.applicationId

    // Submitted: at TTC, in review.
    let panel = await readStage(ttc.cookie, id)
    expect(panel.response.stage.key).toBe('TTC')
    expect(panel.response.flags.map((flag: any) => flag.key)).toEqual(['IN_REVIEW'])
    expect(panel.response.actions.map((action: any) => action.key)).toEqual(['ASK_REVISION', 'TO_INDUSTRIES_COMMERCE', 'REJECT'])
    expect(panel.response.actions.every((action: any) => action.permitted)).toBe(true)

    // TTC asks for a correction. The file stays at TTC, with the applicant.
    await advance(ttc.cookie, id, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'The grant asked for is more than the project needs.' }],
    })
    panel = await readStage(ttc.cookie, id)
    expect(panel.response.stage.key).toBe('TTC')
    expect(panel.response.awaitingApplicant).toBe(true)
    expect(panel.response.actions).toEqual([])
    expect(panel.response.flags.map((flag: any) => flag.key)).toEqual(['IN_REVIEW', 'REVISION_REQUIRED'])

    // The applicant corrects the named section and resubmits.
    let mine = await applicantView(applicant.cookie, id)
    expect(mine.editableStageKeys).toEqual(['FINANCIAL'])
    expect(mine.journey.flags.map((flag: any) => flag.key)).toContain('REVISION_REQUIRED')
    const saved = await graphql<any>(`mutation($input: SaveApplicationDraftInput!) {
      seb { application { saveDraft(input: $input) { success message response { currentVersion statusVersion } } } }
    }`, { input: {
      applicationId: id,
      expectedVersion: mine.currentVersion,
      expectedStatusVersion: mine.statusVersion,
      answers: { ...loanAnswers('SBI'), SEED_FUND_REQUESTED_PAISE: 9_000_000 },
    } }, applicant.cookie)
    expect(saved.data.seb.application.saveDraft).toMatchObject({ success: true })
    const resubmitted = await graphql<any>(`mutation($input: ApplicationVersionInput!) {
      seb { application { resubmit(input: $input) { success message } } }
    }`, { input: {
      applicationId: id,
      expectedVersion: saved.data.seb.application.saveDraft.response.currentVersion,
      expectedStatusVersion: saved.data.seb.application.saveDraft.response.statusVersion,
    } }, applicant.cookie)
    expect(resubmitted.data.seb.application.resubmit).toMatchObject({ success: true })

    // The office sees what the correction changed, in its own words.
    const changes = await graphql<any>(`query($id: ID!) {
      admin { intake { workspace(applicationId: $id) { success response { submissionChanges { stageKeys } } } } }
    }`, { id }, ttc.cookie)
    expect(changes.data.admin.intake.workspace.response.submissionChanges).toEqual([{ stageKeys: ['FINANCIAL'] }])

    // Back at TTC — the stage that asked, not the start of anything — with the office.
    panel = await readStage(ttc.cookie, id)
    expect(panel.response.stage.key).toBe('TTC')
    expect(panel.response.awaitingApplicant).toBe(false)
    expect(panel.response.flags.map((flag: any) => flag.key)).toEqual(['IN_REVIEW'])

    await advance(ttc.cookie, id, 'TO_INDUSTRIES_COMMERCE')
    panel = await readStage(ic.cookie, id)
    expect(panel.response.stage.key).toBe('INDUSTRIES_COMMERCE')
    expect(panel.response.trail.map((stage: any) => stage.key)).toEqual(['TTC'])
    const approve = panel.response.actions.find((action: any) => action.key === 'APPROVE_GRANT')
    // Pre-filled from the corrected request, which is what the applicant now asks.
    expect(approve.defaults).toEqual({ AMOUNT: 9_000_000 })
    const toBank = panel.response.actions.find((action: any) => action.key === 'SEND_TO_BANK')
    expect(toBank.defaults).toEqual({ BANK: 'SBI' })
    expect(panel.response.actions.map((action: any) => action.key)).not.toContain('COMPLETE_WITHOUT_LOAN')

    // More than was asked is refused on the input, and writes nothing.
    const actionsBefore = await countOf('seb_application_stage_action', id)
    const tooMuch = await act(ic.cookie, {
      applicationId: id,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'INDUSTRIES_COMMERCE',
      actionKey: 'APPROVE_GRANT',
      inputs: { AMOUNT: 9_000_001 },
    })
    expect(tooMuch).toMatchObject({ success: false, issues: [{ field: 'AMOUNT' }] })
    expect(await countOf('seb_application_stage_action', id)).toBe(actionsBefore)

    await advance(ic.cookie, id, 'APPROVE_GRANT', { inputs: { AMOUNT: 8_000_000 } })
    panel = await readStage(ic.cookie, id)
    expect(panel.response.stage.key).toBe('INDUSTRIES_COMMERCE')
    expect(panel.response.flags.map((flag: any) => flag.key)).toEqual(['IN_REVIEW', 'GRANT_APPROVED'])
    expect(panel.response.recordedValues).toEqual([
      { key: 'APPROVED_GRANT_PAISE', label: 'Grant approved', type: 'MONEY_PAISE', value: '8000000' },
    ])
    // Approved once; the action is no longer offered.
    expect(panel.response.actions.map((action: any) => action.key)).not.toContain('APPROVE_GRANT')

    // To the applicant's first choice. The TGB officer cannot see it.
    await advance(ic.cookie, id, 'SEND_TO_BANK', { inputs: { BANK: 'SBI' } })
    panel = await readStage(sbi.cookie, id)
    expect(panel.response.stage.key).toBe('SBI_BANK')
    expect(panel.response.flags.map((flag: any) => flag.key)).toContain('BANKING_STAGE')
    expect((await readStage(tgb.cookie, id)).success).toBe(false)

    // SBI sends it back: to Industries & Commerce, along the file's own trail,
    // and "at the bank" goes with it.
    await advance(sbi.cookie, id, 'SEND_BACK', { inputs: { NOTE: 'We do not lend in that block.' } })
    panel = await readStage(ic.cookie, id)
    expect(panel.response.stage.key).toBe('INDUSTRIES_COMMERCE')
    expect(panel.response.trail.map((stage: any) => stage.key)).toEqual(['TTC'])
    expect(panel.response.flags.map((flag: any) => flag.key)).not.toContain('BANKING_STAGE')
    // SBI keeps reading the file it acted on, and may no longer act on it.
    const sbiNow = await readStage(sbi.cookie, id)
    expect(sbiNow.success).toBe(true)
    expect(sbiNow.response.worksStage).toBe(false)
    expect(sbiNow.response.actions.every((action: any) => !action.permitted)).toBe(true)

    // Re-routed to the second choice.
    await advance(ic.cookie, id, 'SEND_TO_BANK', { inputs: { BANK: 'TGB' } })
    panel = await readStage(tgb.cookie, id)
    expect(panel.response.stage.key).toBe('TGB_BANK')
    expect(panel.response.trail.map((stage: any) => stage.key)).toEqual(['TTC', 'INDUSTRIES_COMMERCE'])

    await advance(tgb.cookie, id, 'FULFIL_LOAN', {
      inputs: { AMOUNT: 45_000_000, REFERENCE: 'TGB/2026/0042', SANCTION_DATE: '2026-01-15' },
    })
    panel = await readStage(tgb.cookie, id)
    expect(panel.response.stage).toBeNull()
    expect(panel.response.ended).toEqual({ key: 'COMPLETED', label: 'Completed' })
    expect(panel.response.actions).toEqual([])
    expect(panel.response.flags.map((flag: any) => flag.key).sort()).toEqual(['COMPLETED', 'GRANT_APPROVED', 'LOAN_APPROVED'])
    expect(panel.response.recordedValues.map((value: any) => value.key)).toEqual([
      'APPROVED_GRANT_PAISE', 'FULFILLED_LOAN_PAISE', 'LOAN_REFERENCE', 'LOAN_SANCTIONED_ON',
    ])
    expect(panel.response.history.map((entry: any) => entry.actionKey)).toEqual([
      'ASK_REVISION', 'TO_INDUSTRIES_COMMERCE', 'APPROVE_GRANT', 'SEND_TO_BANK', 'SEND_BACK', 'SEND_TO_BANK', 'FULFIL_LOAN',
    ])

    // The applicant reads the ending in their own words, on the file and in their list.
    mine = await applicantView(applicant.cookie, id)
    expect(mine.journey).toMatchObject({ stageLabel: null, ended: 'Completed' })
    const listed = await graphql<any>(
      'query { seb { application { mine { response { nodes { id journey { ended } } } } } } }', {}, applicant.cookie,
    )
    expect(listed.data.seb.application.mine.response.nodes).toEqual([{ id, journey: { ended: 'Completed' } }])
    expect(mine.journey.recordedValues.map((value: any) => value.key)).toContain('FULFILLED_LOAN_PAISE')

    // Every action recorded itself; the send-back kept its note for the office only.
    const audits = await env.DB.prepare(
      `SELECT count(*)::int AS n FROM core_audit_event WHERE application_id = ? AND action = 'SEB.STAGE_ACTION_TAKEN'`,
    ).bind(id).first<{ n: number }>()
    expect(audits!.n).toBe(7)
    const notes = await env.DB.prepare(
      'SELECT note FROM seb_application_internal_note WHERE application_id = ?',
    ).bind(id).all<{ note: string }>()
    expect(notes.results.map((row) => row.note)).toEqual(['We do not lend in that block.'])
    const noteInAudit = await env.DB.prepare(
      `SELECT count(*)::int AS n FROM core_audit_event WHERE application_id = ? AND payload::text LIKE '%lend in that block%'`,
    ).bind(id).first<{ n: number }>()
    expect(noteInAudit!.n).toBe(0)
  })

  it('completes a file that asked for no loan without a bank', async () => {
    const { file, ttc, ic } = await setup(completeAnswers())
    const id = file.applicationId
    await advance(ttc.cookie, id, 'TO_INDUSTRIES_COMMERCE')
    const panel = await readStage(ic.cookie, id)
    expect(panel.response.actions.map((action: any) => action.key)).toEqual(['SEND_BACK', 'APPROVE_GRANT', 'COMPLETE_WITHOUT_LOAN'])
    await advance(ic.cookie, id, 'APPROVE_GRANT', { inputs: { AMOUNT: 10_000_000 } })
    const done = await advance(ic.cookie, id, 'COMPLETE_WITHOUT_LOAN')
    expect(done).toMatchObject({ stageKey: null, ended: true })
    expect([...done.flags].sort()).toEqual(['COMPLETED', 'GRANT_APPROVED'])
  })

  it('rejects a file at TTC, keeping the reason for the office', async () => {
    const { applicant, file, ttc } = await setup(completeAnswers())
    const id = file.applicationId
    const done = await advance(ttc.cookie, id, 'REJECT', { inputs: { REASON: 'The enterprise is outside the scheme.' } })
    expect(done).toMatchObject({ stageKey: null, ended: true, flags: ['REJECTED'] })
    const mine = await applicantView(applicant.cookie, id)
    expect(mine.journey).toMatchObject({ ended: 'Not approved', stageLabel: null })
    // Nothing more may happen to a finished file.
    const panel = await readStage(ttc.cookie, id)
    expect(panel.response.actions).toEqual([])
  })

  it('withdraws a correction asked in error, handing the file back to the office', async () => {
    const { file, ttc, applicant } = await setup(completeAnswers())
    const id = file.applicationId
    await advance(ttc.cookie, id, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Please restate the grant.' }],
    })
    let panel = await readStage(ttc.cookie, id)
    expect(panel.response.canWithdrawRevision).toBe(true)
    const withdrawn = await graphql<any>(`mutation($input: WithdrawRevisionInput!) {
      admin { stage { withdrawRevision(input: $input) { success message response { openRevisionCount flags } } } }
    }`, { input: {
      applicationId: id,
      expectedStatusVersion: panel.response.statusVersion,
      revisionRequestId: panel.response.openRevisions[0].id,
      reason: 'Asked of the wrong section.',
    } }, ttc.cookie)
    expect(withdrawn.data.admin.stage.withdrawRevision).toMatchObject({
      success: true, response: { openRevisionCount: 0, flags: ['IN_REVIEW'] },
    })
    panel = await readStage(ttc.cookie, id)
    expect(panel.response.awaitingApplicant).toBe(false)
    expect(panel.response.actions.length).toBeGreaterThan(0)
    expect((await applicantView(applicant.cookie, id)).editableStageKeys).toEqual([])
  })

  it('refuses a revision naming no section, or one the form does not have', async () => {
    const { file, ttc } = await setup(completeAnswers())
    const panel = await readStage(ttc.cookie, file.applicationId)
    const base = {
      applicationId: file.applicationId,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'TTC',
      actionKey: 'ASK_REVISION',
    }
    expect(await act(ttc.cookie, base)).toMatchObject({ success: false })
    expect(await act(ttc.cookie, { ...base, revisionRequests: [{ stageKey: 'NOT_A_SECTION', note: 'x' }] }))
      .toMatchObject({ success: false })
    // Corrections on an action that asks for none are refused, not ignored.
    expect(await act(ttc.cookie, {
      ...base, actionKey: 'TO_INDUSTRIES_COMMERCE', revisionRequests: [{ stageKey: 'FINANCIAL', note: 'x' }],
    })).toMatchObject({ success: false })
  })
})

describe('telling the applicant', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const failedAudits = async (id: string, action: string) =>
    (await env.DB.prepare(
      `SELECT count(*)::int AS n FROM core_audit_event WHERE application_id = ? AND action = ? AND outcome = 'FAILURE'`,
    ).bind(id, action).first<{ n: number }>())!.n

  it('records an email it could not send, and keeps the action it followed', async () => {
    const { file, ttc, ic } = await setup(completeAnswers())
    const id = file.applicationId
    await advance(ttc.cookie, id, 'TO_INDUSTRIES_COMMERCE')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // The console transport is the test environment's mail: failing it once is
    // a provider refusing the one message this action sends.
    vi.spyOn(console, 'log').mockImplementationOnce(() => {
      throw new Error('notification unavailable')
    })
    const approved = await advance(ic.cookie, id, 'APPROVE_GRANT', { inputs: { AMOUNT: 5_000_000 } })
    expect(approved.flags).toContain('GRANT_APPROVED')
    expect(await failedAudits(id, 'SEB.STAGE_NOTIFICATION_FAILED')).toBe(1)
  })

  it('records a revision email it could not send as a revision notice', async () => {
    const { file, ttc } = await setup(completeAnswers())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementationOnce(() => {
      throw new Error('notification unavailable')
    })
    await advance(ttc.cookie, file.applicationId, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Restate the amount.' }],
    })
    expect(await failedAudits(file.applicationId, 'SEB.REVISION_NOTIFICATION_FAILED')).toBe(1)
  })
})
