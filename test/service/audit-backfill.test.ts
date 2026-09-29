/**
 * The migration and the row builder must agree about who and what an event
 * concerns.
 *
 * Two pieces of code decide `subject_user_id` and `application_id`: the row
 * builder, for every row written from now on, and `0002`'s backfill, for every
 * row written before it — and again for the rows the old Worker writes while a
 * deploy is under way, which is why the file is run a second time. If the two
 * disagreed, one person's history would be complete up to the day of the
 * deploy and quietly different after it, and no single row would look wrong.
 *
 * So this works a real file through the real mutations, erases what the
 * builder derived, runs the migration file, and asks for the same answers.
 */
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { activeDatabase, closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { workedFile } from './support/worked-file'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

type Derived = { id: string; action: string; subject_user_id: string | null; application_id: string | null }

const derived = async () =>
  (await activeDatabase().execute<Derived>(sql`
    SELECT id, action, subject_user_id, application_id FROM core_audit_event ORDER BY id`)).rows

it('derives, for every row the services wrote, exactly what the builder did', async () => {
  // Officer and applicant are different people, so "who acted" and "whose file"
  // cannot agree by coincidence.
  const file = await workedFile({ separateApplicant: true })
  expect(await file.decide(await file.live())).toMatchObject({ success: true })

  const written = await derived()
  // The flow is broad enough to mean something: cycle, enterprise, draft,
  // evidence, submission, review, bank and decision rows.
  expect(new Set(written.map((row) => row.action.split('.')[0]))).toEqual(new Set(['SEB']))
  expect(written.length).toBeGreaterThanOrEqual(10)
  expect(written.filter((row) => row.application_id !== null).length).toBeGreaterThanOrEqual(8)

  await activeDatabase().execute(sql`UPDATE core_audit_event SET subject_user_id = NULL, application_id = NULL`)
  // Statement by statement, split where drizzle's own migrator splits it.
  const statements = readFileSync('database/migrations/0002_audit_history.sql', 'utf8').split('--> statement-breakpoint')
  for (const statement of statements) await activeDatabase().execute(sql.raw(statement))

  const rederived = await derived()
  const disagreements = written
    .map((row, index) => ({ row, again: rederived[index] }))
    .filter(({ row, again }) =>
      row.subject_user_id !== again?.subject_user_id || row.application_id !== again?.application_id)
    .map(({ row, again }) => `${row.action}: builder ${row.subject_user_id}/${row.application_id}, migration ${again?.subject_user_id}/${again?.application_id}`)
  expect(disagreements, disagreements.join('\n')).toEqual([])
})
