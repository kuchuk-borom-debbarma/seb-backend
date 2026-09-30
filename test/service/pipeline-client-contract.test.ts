/**
 * What the stage and queue screens rely on the API to say, so they never have
 * to guess.
 *
 * Each of these was once a guess on the client: a hidden input it had to send
 * as null or have the action refused, a stale refusal it recognised by matching
 * words in a sentence, a queue row whose amounts and names it could not show,
 * an applicant's list row that could not say "changes requested", and a
 * pipeline document refused by the transport with no word about why.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { graphql, openCycle, signIn, submittedApplication } from '../support/api'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { examplePipeline } from '../../src/services/pipeline/example'
import { validateActionInputs } from '../../src/services/pipeline/inputs'
import { env } from '../support/worker'
import { act, advance, loanAnswers, officer, readStage } from './support/stage'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const atTtc = async () => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const applicant = await signIn({ roles: ['APPLICANT'] })
  const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers('SBI') })
  return { admin, applicant, id: file.applicationId }
}

describe('taking an action', () => {
  it('reads an input the dialog never sent as unanswered, not as a broken form', async () => {
    const { id } = await atTtc()
    const ttc = await officer(['TTC'])
    await advance(ttc.cookie, id, 'TO_INDUSTRIES_COMMERCE')
    const ic = await officer(['INDUSTRIES_COMMERCE'])
    const panel = await readStage(ic.cookie, id)

    // SEND_BACK asks for a note; sending no inputs at all is a missing note.
    const result = await act(ic.cookie, {
      applicationId: id,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'INDUSTRIES_COMMERCE',
      actionKey: 'SEND_BACK',
    })
    expect(result.success).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(['REQUIRED'])
  })

  it('says a refusal is stale, so a screen offers to reload rather than retry', async () => {
    const { id } = await atTtc()
    const ttc = await officer(['TTC'])
    const panel = await readStage(ttc.cookie, id)
    const quote = {
      applicationId: id,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'TTC',
      actionKey: 'TO_INDUSTRIES_COMMERCE',
    }
    const stale = (input: typeof quote) => graphql<any>(`mutation($input: TakeStageActionInput!) {
      admin { stage { takeAction(input: $input) { success stale } } }
    }`, { input }, ttc.cookie)

    const first = await stale(quote)
    expect(first.data.admin.stage.takeAction).toEqual({ success: true, stale: false })
    const second = await stale(quote)
    expect(second.data.admin.stage.takeAction).toEqual({ success: false, stale: true })
    // Any other refusal is not stale: quote the file as it now is, and ask for
    // an action its new stage does not offer.
    const now = await readStage(ttc.cookie, id)
    const unknown = await stale({
      ...quote,
      expectedStatusVersion: now.response.statusVersion,
      stageKey: now.response.stage.key,
      actionKey: 'NOT_AN_ACTION',
    })
    expect(unknown.data.admin.stage.takeAction.stale).toBe(false)
  })
})

describe('the actions a stage offers', () => {
  it('says which close the application or send it back, so a screen can weigh them', async () => {
    const { id } = await atTtc()
    const ttc = await officer(['TTC'])
    const panel = await readStage(ttc.cookie, id)
    const weights = Object.fromEntries(panel.response.actions.map((action: any) =>
      [action.key, [action.closesApplication, action.requestsRevision, action.returnsFile]]))
    // [closes, asks for a revision, returns the file]
    expect(weights).toEqual({
      TO_INDUSTRIES_COMMERCE: [false, false, false],
      ASK_REVISION: [false, true, false],
      REJECT: [true, false, false],
    })

    await advance(ttc.cookie, id, 'TO_INDUSTRIES_COMMERCE')
    const ic = await officer(['INDUSTRIES_COMMERCE'])
    const atIc = await readStage(ic.cookie, id)
    const sendBack = atIc.response.actions.find((action: any) => action.key === 'SEND_BACK')
    expect([sendBack.closesApplication, sendBack.requestsRevision, sendBack.returnsFile])
      .toEqual([false, false, true])
  })
})

describe('the office queue', () => {
  it('shows each row’s stage and flags by name, and what was asked for', async () => {
    const { admin } = await atTtc()
    const body = await graphql<any>(`query {
      admin { intake { queue { success response { nodes {
        currentStageKey stageName flags { key label } requestedGrantPaise requestedLoanPaise
      } } } } }
    }`, {}, admin.cookie)
    const [row] = body.data.admin.intake.queue.response.nodes
    const ttc = examplePipeline.stages.find((stage) => stage.key === 'TTC')!
    const inReview = examplePipeline.statusFlags.find((flag) => flag.key === 'IN_REVIEW')!
    expect(row).toEqual({
      currentStageKey: 'TTC',
      stageName: ttc.name,
      flags: [{ key: 'IN_REVIEW', label: inReview.label }],
      requestedGrantPaise: String(loanAnswers('SBI').SEED_FUND_REQUESTED_PAISE),
      requestedLoanPaise: String(loanAnswers('SBI').LOAN_AMOUNT_REQUESTED_PAISE),
    })
  })
})

describe('the office queue’s names, when there is nothing to name', () => {
  const rows = async (cookie: string) => (await graphql<any>(`query {
    admin { intake { queue { success response { nodes { currentStageKey stageName flags { key label } } } } } }
  }`, {}, cookie)).data.admin.intake.queue.response.nodes

  it('shows no stage once the journey has ended, and a flag its version does not declare by key', async () => {
    const { admin, id } = await atTtc()
    const ttc = await officer(['TTC'])
    await advance(ttc.cookie, id, 'REJECT', { inputs: { REASON: 'Outside the programme area.' } })
    await env.DB.prepare(`UPDATE seb_application SET status_flags = array_append(status_flags, 'NOT_DECLARED') WHERE id = ?`)
      .bind(id).run()
    const [row] = await rows(admin.cookie)
    expect(row.currentStageKey).toBeNull()
    expect(row.stageName).toBeNull()
    expect(row.flags.at(-1)).toEqual({ key: 'NOT_DECLARED', label: 'NOT_DECLARED' })
  })

  it('falls back to keys when the version the file is worked in can no longer be read', async () => {
    const { admin, id } = await atTtc()
    await env.DB.prepare(`UPDATE seb_pipeline_version SET definition = '{"schema": 1}'::jsonb
      WHERE (pipeline_id, version) = (SELECT pipeline_id, pipeline_version FROM seb_application WHERE id = ?)`)
      .bind(id).run()
    const [row] = await rows(admin.cookie)
    expect(row.currentStageKey).toBe('TTC')
    expect(row.stageName).toBeNull()
    expect(row.flags).toEqual([{ key: 'IN_REVIEW', label: 'IN_REVIEW' }])
  })
})

describe('an action’s inputs, as the dialog sends them', () => {
  const sendBack = examplePipeline.stages
    .flatMap((stage) => stage.actions)
    .find((action) => action.key === 'SEND_BACK')!
  const now = new Date('2026-09-30T00:00:00Z')

  it('keeps what was sent and reads only what was left out as unanswered', () => {
    expect(validateActionInputs(sendBack, { NOTE: 'Please look again.' }, now))
      .toEqual({ ok: true, values: { NOTE: 'Please look again.' } })
  })

  it('leaves a value that is not an object for the form engine to refuse', () => {
    const result = validateActionInputs(sendBack, ['NOTE'], now)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toEqual(['MALFORMED_ANSWERS'])
  })
})

describe('the applicant’s list', () => {
  it('says when a correction is waiting on the applicant, and stops once it is withdrawn', async () => {
    const { applicant, id } = await atTtc()
    const ttc = await officer(['TTC'])
    const listed = async () => {
      const body = await graphql<any>(`query {
        seb { application { mine { success response { nodes { id awaitingCorrection } } } } }
      }`, {}, applicant.cookie)
      return body.data.seb.application.mine.response.nodes.find((node: any) => node.id === id).awaitingCorrection
    }
    expect(await listed()).toBe(false)

    await advance(ttc.cookie, id, 'ASK_REVISION', {
      revisionRequests: [{ stageKey: 'FINANCIAL', note: 'Please restate the amount.' }],
    })
    expect(await listed()).toBe(true)

    const panel = await readStage(ttc.cookie, id)
    const [open] = panel.response.openRevisions
    const withdrawn = await graphql<any>(`mutation($input: WithdrawRevisionInput!) {
      admin { stage { withdrawRevision(input: $input) { success stale } } }
    }`, {
      input: { applicationId: id, expectedStatusVersion: panel.response.statusVersion, revisionRequestId: open.id, reason: 'Asked in error.' },
    }, ttc.cookie)
    expect(withdrawn.data.admin.stage.withdrawRevision).toEqual({ success: true, stale: false })
    expect(await listed()).toBe(false)
  })
})

describe('saving a pipeline draft', () => {
  it('refuses a document over 48 KB by name, rather than leaving it to the transport', async () => {
    const admin = await signIn({ roles: ['SUPER_ADMIN'] })
    const created = await graphql<any>(`mutation($input: CreatePipelineInput!) {
      admin { pipeline { create(input: $input) { success response { id } } } }
    }`, { input: { key: 'LARGE', name: 'Large route' } }, admin.cookie)
    // About 51 KB: over the API's bound, and still under the 64 KB request
    // limit, so it is the service's refusal this reaches and not the transport's.
    const padded = { ...structuredClone(examplePipeline), padding: 'x'.repeat(38 * 1024) }
    const saved = await graphql<any>(`mutation($input: SavePipelineDraftInput!) {
      admin { pipeline { saveDraft(input: $input) { success message } } }
    }`, {
      input: { pipelineId: created.data.admin.pipeline.create.response.id, expectedRevision: 1, definition: JSON.stringify(padded) },
    }, admin.cookie)
    expect(saved.errors).toBeUndefined()
    expect(saved.data.admin.pipeline.saveDraft.success).toBe(false)
    expect(saved.data.admin.pipeline.saveDraft.message).toContain('48 KB')
  })
})
