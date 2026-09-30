/**
 * Two officers acting on one file at once.
 *
 * The guard is the head update's `status_version` predicate inside the one
 * statement that writes everything, so a losing writer's update returns no
 * row and every other member of the statement — the action row, the notes,
 * the timeline, the audit — writes nothing. Proven twice: through the API,
 * where the loser is usually turned away by the context read, and straight at
 * the write with the same stale state, where only the SQL guard stands.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { findStageFile, writeStageAction } from '../../src/services/pipeline/queries/stage'
import { openCycle, signIn, submittedApplication } from '../support/api'
import { activeDatabase, closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { act, loanAnswers, officer, readStage } from './support/stage'

beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})

const rowsFor = async (applicationId: string) => {
  const count = async (sql: string) =>
    (await env.DB.prepare(sql).bind(applicationId).first<{ n: number }>())!.n
  return {
    actions: await count('SELECT count(*)::int AS n FROM seb_application_stage_action WHERE application_id = ?'),
    events: await count(`SELECT count(*)::int AS n FROM seb_application_event WHERE application_id = ? AND event_type = 'STAGE_ACTION'`),
    notes: await count('SELECT count(*)::int AS n FROM seb_application_internal_note WHERE application_id = ?'),
    audits: await count(`SELECT count(*)::int AS n FROM core_audit_event WHERE application_id = ? AND action = 'SEB.STAGE_ACTION_TAKEN'`),
  }
}

const fileAtTtc = async () => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const applicant = await signIn({ roles: ['APPLICANT'] })
  const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers() })
  return { file, ttc: await officer(['TTC']) }
}

describe('two actions on one version', () => {
  it('lets exactly one land through the API', async () => {
    const { file, ttc } = await fileAtTtc()
    const panel = await readStage(ttc.cookie, file.applicationId)
    const base = { applicationId: file.applicationId, expectedStatusVersion: panel.response.statusVersion, stageKey: 'TTC' }
    const results = await Promise.all([
      act(ttc.cookie, { ...base, actionKey: 'TO_INDUSTRIES_COMMERCE' }),
      act(ttc.cookie, { ...base, actionKey: 'REJECT', inputs: { REASON: 'Out of scope.' } }),
    ])
    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(results.find((result) => !result.success)?.message).toBe('The record changed. Reload and try again.')
    const rows = await rowsFor(file.applicationId)
    expect(rows.actions).toBe(1)
    expect(rows.events).toBe(1)
    expect(rows.audits).toBe(1)
    // The rejection's note exists only if the rejection won.
    expect(rows.notes).toBe(results[1]!.success ? 1 : 0)
  })

  it('writes nothing at all for the writer whose version is gone, at the SQL guard alone', async () => {
    const { file, ttc } = await fileAtTtc()
    const db = activeDatabase()
    const stale = await findStageFile(db, {
      applicationId: file.applicationId, callerUserId: ttc.userId, scope: { kind: 'OFFICE' },
    })
    if (!stale) throw new Error('file missing')
    const write = (actionKey: string, note: string | null) => writeStageAction(db, {
      file: stale,
      actionId: crypto.randomUUID(),
      actionKey,
      actorUserId: ttc.userId,
      now: new Date(),
      toStageKey: 'INDUSTRIES_COMMERCE',
      moved: true,
      trail: ['TTC'],
      flags: ['IN_REVIEW'],
      recorded: {},
      flagsAdded: [],
      flagsRemoved: [],
      inputs: {},
      revisions: [],
      notes: note ? [{ id: crypto.randomUUID(), note }] : [],
      selfReviewDisclosed: false,
      timelineMessage: null,
      audits: [],
    })
    expect(await write('TO_INDUSTRIES_COMMERCE', null)).toBe(true)
    // The same state, quoted again: the version has moved, so nothing lands.
    expect(await write('TO_INDUSTRIES_COMMERCE', 'A note that must not survive.')).toBe(false)
    const rows = await rowsFor(file.applicationId)
    expect(rows).toMatchObject({ actions: 1, events: 1, notes: 0 })
  })
})
