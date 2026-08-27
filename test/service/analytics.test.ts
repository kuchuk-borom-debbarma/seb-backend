/**
 * The intake analytics summary: one filtered set, counted along every
 * dimension the office reports on.
 *
 * The summary reuses the queue's own filter block, so what these tests pin is
 * agreement: the counts must describe exactly the set the queue would list
 * under the same filters, dimension by dimension, and the money aggregate must
 * read the requested amount by the one canonical spelling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { count, sql } from 'drizzle-orm'
import { env } from '../support/worker'
import { graphql, openCycle, signIn } from '../support/api'
import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { seededDecision, submittedProfile } from './support/intake-fixtures'
import { sebApplication } from '../../src/db/schema'

beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})

const SUMMARY_QUERY = `query($input: AdminIntakeAnalyticsInput) {
  admin { analytics { summary(input: $input) {
    success message
    response {
      statuses { status count }
      categories { category count }
      sectors { sector count }
      districts { district count }
      cycles { cycleId cycleCode count }
      requested { count totalPaise averagePaise }
      monthly { month count }
    }
  } } }
}`

const summary = async (cookie: string, input: Record<string, unknown> = {}) => {
  const body = await graphql<any>(SUMMARY_QUERY, { input }, cookie)
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
  return body.data.admin.analytics.summary
}

/** The seeded spread every summary assertion below reads against. */
const seedSpread = async (administrator: { cookie: string; userId: string }) => {
  const cycleOne = await openCycle(administrator.cookie)
  const cycleTwo = await openCycle(administrator.cookie)
  // Established 2020 → over the 24-month threshold → CATEGORY_A.
  const established = await submittedProfile({
    cycleId: cycleOne.id,
    enterprise: { establishmentDate: '2020-01-01', businessSector: 'INFORMATION_TECHNOLOGY',
      businessDistrict: 'DHALAI' },
    requestedPaise: 5_000_000,
  })
  const young = await submittedProfile({
    cycleId: cycleOne.id,
    enterprise: { businessSector: 'FOOD_PROCESSING', businessDistrict: 'WEST_TRIPURA' },
    requestedPaise: 10_000_000,
  })
  const otherCycle = await submittedProfile({
    cycleId: cycleTwo.id,
    enterprise: { businessSector: 'FOOD_PROCESSING', businessDistrict: 'GOMATI' },
    requestedPaise: 20_000_000,
  })
  return { cycleOne, cycleTwo, established, young, otherCycle }
}

describe('the intake analytics summary', () => {
  it('counts one seeded set along every dimension, and sums what was asked for', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const { cycleOne, cycleTwo, established } = await seedSpread(administrator)

    const whole = await summary(administrator.cookie)
    expect(whole.success).toBe(true)
    expect(whole.response.statuses).toEqual([{ status: 'SUBMITTED', count: 3 }])
    expect(new Map(whole.response.categories.map(
      (entry: any) => [entry.category, entry.count],
    ))).toEqual(new Map([['CATEGORY_A', 1], ['CATEGORY_B', 2]]))
    expect(new Map(whole.response.sectors.map(
      (entry: any) => [entry.sector, entry.count],
    ))).toEqual(new Map([['FOOD_PROCESSING', 2], ['INFORMATION_TECHNOLOGY', 1]]))
    expect(new Map(whole.response.districts.map(
      (entry: any) => [entry.district, entry.count],
    ))).toEqual(new Map([['DHALAI', 1], ['WEST_TRIPURA', 1], ['GOMATI', 1]]))
    expect(new Map(whole.response.cycles.map(
      (entry: any) => [entry.cycleId, entry.count],
    ))).toEqual(new Map([[cycleOne.id, 2], [cycleTwo.id, 1]]))
    // The cycle slice names the cycle by code, so a chart needs no second query.
    for (const slice of whole.response.cycles) {
      expect(typeof slice.cycleCode).toBe('string')
      expect(slice.cycleCode.length).toBeGreaterThan(0)
    }
    // 5,000,000 + 10,000,000 + 20,000,000, and Money serializes as a string.
    expect(whole.response.requested).toEqual({
      count: 3, totalPaise: '35000000', averagePaise: String(Math.round(35_000_000 / 3)),
    })
    // Everything was submitted just now, so one bucket carries this month.
    const thisMonth = new Date().toISOString().slice(0, 7)
    expect(whole.response.monthly).toEqual([{ month: thisMonth, count: 3 }])

    // The same filters the queue applies narrow the summary the same way.
    const filtered = await summary(administrator.cookie, {
      cycleIds: [cycleOne.id], sectors: ['INFORMATION_TECHNOLOGY'],
    })
    expect(filtered.response.statuses).toEqual([{ status: 'SUBMITTED', count: 1 }])
    expect(filtered.response.categories).toEqual([{ category: 'CATEGORY_A', count: 1 }])
    expect(filtered.response.districts).toEqual([{ district: 'DHALAI', count: 1 }])
    expect(filtered.response.requested).toEqual({
      count: 1, totalPaise: '5000000', averagePaise: '5000000',
    })

    // The decided range reaches the summary too: decide one, then ask for it.
    await seededDecision({
      applicationId: established.applicationId,
      submissionId: established.submissionId,
      recordedByUserId: administrator.userId,
      decidedAt: new Date(),
    })
    const decided = await summary(administrator.cookie, {
      decidedFrom: new Date(Date.now() - 60_000).toISOString(),
      decidedTo: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(decided.response.statuses).toEqual([{ status: 'SUBMITTED', count: 1 }])
    const decidedElsewhen = await summary(administrator.cookie, {
      decidedFrom: '2030-01-01T00:00:00Z',
    })
    expect(decidedElsewhen.response.statuses).toEqual([])
  })

  it('answers with no input argument at all, defaulting to no filters', async () => {
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    // The argument itself is optional, not only its fields.
    const body = await graphql<any>(
      'query { admin { analytics { summary { success response { statuses { status count } } } } } }',
      {}, administrator.cookie,
    )
    expect(body.errors).toBeUndefined()
    expect(body.data.admin.analytics.summary.success).toBe(true)
  })

  it('answers an empty programme with empty dimensions rather than an error', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    const empty = await summary(administrator.cookie)
    expect(empty.success).toBe(true)
    expect(empty.response).toEqual({
      statuses: [], categories: [], sectors: [], districts: [], cycles: [],
      requested: { count: 0, totalPaise: null, averagePaise: null },
      monthly: [],
    })
  })

  it('refuses the ranges that cannot match anything, naming which one', async () => {
    const administrator = await signIn(['SUPER_ADMIN'])
    for (const [input, message] of [
      [{ requestedMinPaise: 200, requestedMaxPaise: 100 },
        'The requested amount range is invalid.'],
      [{ decidedFrom: '2026-02-01T00:00:00Z', decidedTo: '2026-01-01T00:00:00Z' },
        'The decision date range is invalid.'],
      [{ submittedFrom: '2026-02-01T00:00:00Z', submittedTo: '2026-01-01T00:00:00Z' },
        'The submission date range is invalid.'],
      [{ queue: 'NEW_SUBMISSIONS', status: 'SUBMITTED' },
        'Filter by queue or by status, not both.'],
      [{ queue: 'NEW_SUBMISSIONS', statuses: ['SUBMITTED'] },
        'Filter by queue or by status, not both.'],
      [{ phaseNumber: 0 }, 'Phase number must be positive.'],
    ] as const) {
      const refused = await summary(administrator.cookie, input as Record<string, unknown>)
      expect(refused, JSON.stringify(input)).toMatchObject({ success: false, message })
    }
  })

  it('opens to anybody holding STAFF_READ and to nobody else', async () => {
    // A reviewer changes nothing and reads everything; the summary is a read.
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    await seedSpread(administrator)
    const reviewer = await signIn(['REVIEWER'])
    const allowed = await summary(reviewer.cookie)
    expect(allowed.success).toBe(true)
    expect(allowed.response.statuses).toEqual([{ status: 'SUBMITTED', count: 3 }])

    const applicant = await signIn(['APPLICANT'])
    const refused = await summary(applicant.cookie)
    expect(refused.success).toBe(false)
    expect(refused.response).toBeNull()
  })
})

describe('the analytic predicates against a populated plan', () => {
  it('EXPLAINs the category, sector and amount-range predicates over ~200 applications', async () => {
    /*
     * What this pins is that the predicates are *valid SQL over the real
     * schema* and spelled the way the indexes are — the shared filter builder
     * is embedded unchanged inside an EXPLAIN. The rows are seeded directly
     * because two hundred full submissions would cost minutes to prove a
     * planner accepts a WHERE clause; no business rule is asserted against
     * them.
     */
    const administrator = await signIn(['APPLICANT', 'SUPER_ADMIN'])
    const cycle = await openCycle(administrator.cookie)
    const seeded = await submittedProfile({ cycleId: cycle.id, requestedPaise: 7_500_000 })
    const db = activeDatabase()
    await db.execute(sql`
      INSERT INTO seb_enterprise (
        id, portal_owner_user_id, current_name, registration_type,
        registration_number, gstin, status, current_version, created_at, updated_at
      )
      SELECT 'ent-' || n, ${administrator.userId}, 'Seeded Enterprise ' || n,
        'SOLE_PROPRIETORSHIP', NULL, NULL, 'ACTIVE', 1, now(), now()
      FROM generate_series(1, 200) AS n
    `)
    await db.execute(sql`
      INSERT INTO seb_enterprise_version (
        id, enterprise_id, version, change_type, change_reason,
        changed_by_user_id, created_at, name, establishment_date,
        registration_type, registration_number, gstin, business_sector,
        other_business_sector, business_block_or_village, business_district,
        business_pin_code, contact_number, contact_email, status
      )
      SELECT 'entv-' || n, 'ent-' || n, 1, 'CREATED', NULL,
        ${administrator.userId}, now(), 'Seeded Enterprise ' || n, '2020-01-01',
        'SOLE_PROPRIETORSHIP', NULL, NULL,
        CASE WHEN n % 2 = 0 THEN 'FOOD_PROCESSING' ELSE 'INFORMATION_TECHNOLOGY' END,
        NULL, 'Khumulwng',
        CASE WHEN n % 2 = 0 THEN 'WEST_TRIPURA' ELSE 'DHALAI' END,
        '799045', '+919876543210', 'seeded@example.test', 'ACTIVE'
      FROM generate_series(1, 200) AS n
    `)
    await db.execute(sql`
      INSERT INTO seb_funding_case (id, enterprise_id, status, current_version, created_at, updated_at)
      SELECT 'case-' || n, 'ent-' || n, 'OPEN', 1, now(), now()
      FROM generate_series(1, 200) AS n
    `)
    await db.execute(sql`
      INSERT INTO seb_application (
        id, applicant_user_id, enterprise_id, funding_case_id, programme_cycle_id,
        application_type, phase_number, reference_number, current_version,
        created_at, updated_at, status, status_version, status_changed_at,
        assignment_version
      )
      SELECT 'app-' || n, ${administrator.userId}, 'ent-' || n, 'case-' || n,
        ${cycle.id}, 'INITIAL', 1, 'SEP-SEED-' || n, 1, now(), now(),
        'SUBMITTED', 2, now(), 0
      FROM generate_series(1, 200) AS n
    `)
    await db.execute(sql`
      INSERT INTO seb_application_version (
        id, application_id, version, programme_cycle_id, programme_cycle_version,
        application_type, phase_number, change_type, change_reason,
        changed_by_user_id, created_at, application_category
      )
      SELECT 'appv-' || n, 'app-' || n, 1, ${cycle.id}, 2, 'INITIAL', 1,
        'SUBMISSION', NULL, ${administrator.userId}, now(),
        CASE WHEN n % 2 = 0 THEN 'CATEGORY_A' ELSE 'CATEGORY_B' END
      FROM generate_series(1, 200) AS n
    `)
    await db.execute(sql`
      INSERT INTO seb_application_submission (
        id, application_id, submission_number, application_version,
        submitted_by_user_id, submitted_at
      )
      SELECT 'sub-' || n, 'app-' || n, 1, 1, ${administrator.userId}, now()
      FROM generate_series(1, 200) AS n
    `)
    await db.execute(sql`
      INSERT INTO seb_application_version_answer (
        id, application_version_id, programme_cycle_id, programme_cycle_version,
        field_key, entry_index, value_ordinal, value_text, created_at
      )
      SELECT 'ans-' || n, 'appv-' || n, ${cycle.id}, 2,
        'SEED_FUND_REQUESTED_PAISE', 0, 0, (n * 100000)::text, now()
      FROM generate_series(1, 200) AS n
    `)

    /*
     * The queue and the summary must both accept the same filter set over this
     * population — the one real submission proves the seeded rows sit beside a
     * product-made one without tripping a constraint.
     */
    const { intakeQueueFilters, joinIntakeQueueTables, listIntakeQueue } =
      await import('../../src/services/admin/queries/intake')
    // Even n carries CATEGORY_A and FOOD_PROCESSING; the amount bound keeps
    // n <= 100, so exactly the even half of 1..100 matches.
    const page = await listIntakeQueue(db, {
      first: 5,
      after: null,
      categories: ['CATEGORY_A'],
      sectors: ['FOOD_PROCESSING'],
      requestedMinPaise: 100_000,
      requestedMaxPaise: 10_000_000,
    })
    expect(page.pageInfo.totalCount).toBe(50)
    const filtered = joinIntakeQueueTables(
      db.select({ value: count() }).from(sebApplication).$dynamic(),
    ).where(intakeQueueFilters({
      categories: ['CATEGORY_A'],
      sectors: ['FOOD_PROCESSING'],
      requestedMinPaise: 100_000,
      requestedMaxPaise: 10_000_000,
    }))
    const plan = await db.execute<{ 'QUERY PLAN': string }>(
      sql`EXPLAIN (ANALYZE, BUFFERS) ${filtered.getSQL()}`,
    )
    const lines = plan.rows.map((row) => Object.values(row)[0]).join('\n')
    /*
     * Recorded so a failure — or a future plan regression being investigated —
     * shows what the planner actually did. With two hundred rows the planner
     * may well scan; what must hold is that every predicate is plannable and
     * the filter spelling matches the indexed expressions.
     */
    console.info(`intake analytic filter plan:\n${lines}`)
    expect(lines).toContain('Execution Time')

    // The seeded population reaches the summary through the same filter block.
    const summarized = await summary(administrator.cookie, {
      categories: ['CATEGORY_A', 'CATEGORY_B'],
      requestedMinPaise: 100_000,
    })
    expect(summarized.success).toBe(true)
    const total = summarized.response.statuses.reduce(
      (sum: number, entry: any) => sum + entry.count, 0,
    )
    expect(total).toBe(201)
    expect(seeded.applicationId).toBeTruthy()
  })
})
