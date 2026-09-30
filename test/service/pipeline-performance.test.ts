/**
 * What working a stage costs, measured rather than reasoned about.
 *
 * Round trips are counted at the driver, so a read added three calls down is
 * counted like any other. The budgets are the pipeline plan's:
 *
 * | Operation            | Statements | Which                                          |
 * | -------------------- | ---------- | ---------------------------------------------- |
 * | `takeAction`         | 3          | session, folded context, one-statement write   |
 * | `application`        | 3          | session, folded context, history               |
 * | `myStages`           | 3          | session, stages with counts, definitions       |
 * | `queue`              | 4          | session, page, count, definitions              |
 *
 * `takeAction` stays at three **whatever the number of effects** — the example
 * bank fulfilment fires seven — because every effect is a member of one `WITH`.
 *
 * And the queue's plan is asserted against a large table: the page must seek
 * the stage-queue index and never sort, which is the difference between a page
 * costing the same at a thousand files and at a hundred thousand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { stageQueuePage } from '../../src/services/pipeline/queries/stage'
import { graphql, openCycle, signIn, submittedApplication } from '../support/api'
import {
  activeDatabase,
  activeDriverHandle,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { TEST_PIPELINE_ID } from '../support/pipeline'
import { countRoundTrips } from '../support/round-trips'
import { advance, loanAnswers, officer, readStage } from './support/stage'

beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] }

/** Every node of an `EXPLAIN (FORMAT JSON)` plan, depth first. */
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)]

type Raw = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

const fileAtBank = async () => {
  const admin = await signIn({ roles: ['SUPER_ADMIN'] })
  const cycle = await openCycle(admin.cookie)
  const applicant = await signIn({ roles: ['APPLICANT'] })
  const file = await submittedApplication(applicant.cookie, applicant.userId, cycle.id, { answers: loanAnswers('SBI') })
  await advance(admin.cookie, file.applicationId, 'TO_INDUSTRIES_COMMERCE')
  await advance(admin.cookie, file.applicationId, 'SEND_TO_BANK', { inputs: { BANK: 'SBI' } })
  return { admin, id: file.applicationId, sbi: await officer(['SBI_BANK']) }
}

/*
 * Against a real Postgres (`npm run test:neon`) each request takes its own pool
 * connection, which the counter — patched onto the harness's driver handle —
 * cannot see, so every HTTP-driven count reads zero there.
 */
describe.skipIf(Boolean(process.env.TEST_DATABASE_URL))('round trips', () => {
  it('takes an action in three statements, whatever it does', async () => {
    const { id, sbi } = await fileAtBank()
    const panel = await readStage(sbi.cookie, id)
    const trips = countRoundTrips(activeDriverHandle() as never)
    trips.reset()
    const body = await graphql<any>(`mutation($input: TakeStageActionInput!) {
      admin { stage { takeAction(input: $input) { success message } } }
    }`, { input: {
      applicationId: id,
      expectedStatusVersion: panel.response.statusVersion,
      stageKey: 'SBI_BANK',
      actionKey: 'FULFIL_LOAN',
      inputs: { AMOUNT: 40_000_000, REFERENCE: 'SBI/1', SANCTION_DATE: '2026-01-10' },
    } }, sbi.cookie)
    expect(body.data.admin.stage.takeAction).toMatchObject({ success: true })
    expect(trips.count(), trips.statements().join('\n---\n')).toBe(3)
  })

  it('reads the stage panel in three, my stages in three and a queue page in four', async () => {
    const { id, sbi } = await fileAtBank()
    const trips = countRoundTrips(activeDriverHandle() as never)
    trips.reset()
    expect((await readStage(sbi.cookie, id)).success).toBe(true)
    expect(trips.count(), trips.statements().join('\n---\n')).toBe(3)

    trips.reset()
    const stages = await graphql<any>('query { admin { stage { myStages { success } } } }', {}, sbi.cookie)
    expect(stages.data.admin.stage.myStages.success).toBe(true)
    expect(trips.count(), trips.statements().join('\n---\n')).toBe(3)

    trips.reset()
    const queue = await graphql<any>(`query($input: AdminStageQueueInput!) {
      admin { stage { queue(input: $input) { success response { nodes { id flags { label } } } } } }
    }`, { input: { pipelineId: TEST_PIPELINE_ID, stageKey: 'SBI_BANK' } }, sbi.cookie)
    expect(queue.data.admin.stage.queue.response.nodes).toHaveLength(1)
    expect(trips.count(), trips.statements().join('\n---\n')).toBe(4)
  })
})

describe('the stage queue at scale', () => {
  it('seeks the stage-queue index and never sorts', async () => {
    const { id } = await fileAtBank()
    const raw = activeDriverHandle() as unknown as Raw
    const copies = 20_000
    // Clones of one real file, spread over the four stages and a year of
    // arrival times: enough rows that a sequential scan and a sort would be
    // the planner's choice if the index did not serve the query.
    await raw.query(`CREATE TEMP TABLE clone AS
      SELECT application.*, n FROM seb_application AS application, generate_series(1, ${copies}) AS n
      WHERE application.id = $1`, [id])
    await raw.query(`UPDATE clone SET
      id = 'perf-' || n,
      reference_number = 'PERF-' || n,
      phase_number = n + 1,
      current_stage_key = (ARRAY['TTC', 'INDUSTRIES_COMMERCE', 'SBI_BANK', 'TGB_BANK'])[1 + n % 4],
      stage_entered_at = now() - (n || ' minutes')::interval`)
    await raw.query('ALTER TABLE clone DROP COLUMN n')
    await raw.query('INSERT INTO seb_application SELECT * FROM clone')
    await raw.query('DROP TABLE clone')
    await raw.query('ANALYZE seb_application')

    const page = stageQueuePage(activeDatabase(), {
      pipelineId: TEST_PIPELINE_ID, stageKey: 'SBI_BANK', flags: [], first: 20, after: null,
    }).toSQL()
    const explained = await raw.query(`EXPLAIN (FORMAT JSON) ${page.sql}`, page.params as unknown[])
    const nodes = planNodes((explained.rows[0]!['QUERY PLAN'] as { Plan: PlanNode }[])[0]!.Plan)
    expect(nodes.some((node) => node['Index Name'] === 'seb_application_stage_queue_idx')).toBe(true)
    expect(nodes.filter((node) => node['Node Type'] === 'Sort')).toEqual([])
    expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'seb_application')).toEqual([])

    // And the page is the right page: the oldest arrivals at the stage, in order.
    const rows = await stageQueuePage(activeDatabase(), {
      pipelineId: TEST_PIPELINE_ID, stageKey: 'SBI_BANK', flags: [], first: 20, after: null,
    })
    expect(rows).toHaveLength(21)
    const times = rows.map((row) => (row.stageEnteredAt as Date).getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
})
