/**
 * The intake analytics summary: one filtered set, grouped along each
 * dimension the office reports on.
 *
 * Everything here stands on the queue's own filter block and joins, imported
 * from `intake.ts` rather than respelled — the summary's claim is "of the
 * applications the queue would list under these filters, this many sit in
 * each bucket", and a second spelling of the filters is how that claim would
 * quietly stop being true.
 *
 * One grouped statement per dimension rather than one wide statement: each
 * grouping collapses the set differently, so folding them together would
 * either cross-join the dimensions or force window tricks nobody can read.
 */
import { asc, count, sql } from 'drizzle-orm'
import type { Database } from '../../../db'
import {
  sebApplication,
  sebApplicationSubmission,
  sebApplicationVersion,
  sebEnterpriseVersion,
  sebProgrammeCycle,
} from '../../../db/schema'
import {
  intakeQueueFilters,
  joinIntakeQueueTables,
  requestedAmountText,
  type IntakeQueueFilterInput,
} from './intake'

/**
 * Buckets arrive biggest first so a chart's legend reads in falling order;
 * equal counts fall back to the bucket's own value so the order is stable.
 * A key name rather than an extractor closure, so one comparator serves every
 * dimension instead of five single-use lambdas.
 */
const byCountThenValue = <TKey extends string, T extends { count: number } & {
  [key in TKey]: string | null
}>(rows: T[], key: TKey): T[] =>
  [...rows].sort((left, right) =>
    right.count - left.count || (left[key] ?? '~').localeCompare(right[key] ?? '~'))

export type IntakeAnalyticsSummary = {
  statuses: { status: string; count: number }[]
  categories: { category: string | null; count: number }[]
  sectors: { sector: string | null; count: number }[]
  districts: { district: string | null; count: number }[]
  cycles: { cycleId: string; cycleCode: string; count: number }[]
  requested: { count: number; totalPaise: number | null; averagePaise: number | null }
  monthly: { month: string; count: number }[]
}

/**
 * The requested-amount aggregates, guarded the same way the filter is.
 *
 * `CASE` rather than `FILTER`, so the `::bigint` cast is provably never
 * evaluated on a non-numeric row — one corrupt answer must cost one missing
 * term, not the whole summary.
 */
const numericRequested = sql`CASE
  WHEN ${requestedAmountText} ~ '^[0-9]+$' THEN (${requestedAmountText})::bigint
END`

export const intakeAnalyticsSummary = async (
  db: Database,
  input: IntakeQueueFilterInput,
): Promise<IntakeAnalyticsSummary> => {
  const filters = intakeQueueFilters(input)

  /*
   * The month is bucketed in UTC, matching how every instant in this API is
   * serialized — a report and the rows behind it must cut the month at the
   * same midnight.
   */
  const monthExpression = sql<string>`to_char(
    ${sebApplicationSubmission.submittedAt} AT TIME ZONE 'UTC', 'YYYY-MM'
  )`

  const [statuses, categories, sectors, districts, cycles, requestedRows, monthly] =
    await Promise.all([
      joinIntakeQueueTables(
        db.select({ status: sebApplication.status, count: count() })
          .from(sebApplication).$dynamic(),
      ).where(filters).groupBy(sebApplication.status),
      joinIntakeQueueTables(
        db.select({ category: sebApplicationVersion.applicationCategory, count: count() })
          .from(sebApplication).$dynamic(),
      ).where(filters).groupBy(sebApplicationVersion.applicationCategory),
      joinIntakeQueueTables(
        db.select({ sector: sebEnterpriseVersion.businessSector, count: count() })
          .from(sebApplication).$dynamic(),
      ).where(filters).groupBy(sebEnterpriseVersion.businessSector),
      joinIntakeQueueTables(
        db.select({ district: sebEnterpriseVersion.businessDistrict, count: count() })
          .from(sebApplication).$dynamic(),
      ).where(filters).groupBy(sebEnterpriseVersion.businessDistrict),
      joinIntakeQueueTables(
        db.select({
          cycleId: sebApplication.programmeCycleId,
          cycleCode: sebProgrammeCycle.cycleCode,
          count: count(),
        }).from(sebApplication).$dynamic(),
      ).where(filters)
        .groupBy(sebApplication.programmeCycleId, sebProgrammeCycle.cycleCode),
      joinIntakeQueueTables(
        db.select({
          count: sql<number>`count(${numericRequested})::int`,
          totalPaise: sql<string | null>`sum(${numericRequested})`,
          averagePaise: sql<string | null>`round(avg(${numericRequested}))`,
        }).from(sebApplication).$dynamic(),
      ).where(filters),
      joinIntakeQueueTables(
        db.select({ month: monthExpression, count: count() })
          .from(sebApplication).$dynamic(),
      ).where(filters).groupBy(monthExpression).orderBy(asc(monthExpression)),
    ])

  // An aggregate over zero rows still yields its one row of NULLs.
  const requested = requestedRows[0]!
  return {
    statuses: byCountThenValue(statuses, 'status'),
    categories: byCountThenValue(categories, 'category'),
    sectors: byCountThenValue(sectors, 'sector'),
    districts: byCountThenValue(districts, 'district'),
    cycles: byCountThenValue(cycles, 'cycleCode'),
    requested: {
      count: Number(requested.count),
      /*
       * Converted here because the driver returns bigint aggregates as text.
       * `Number` is exact to 2^53-1, the same ceiling every stored amount is
       * CHECKed against; a sum past it would already be beyond anything this
       * programme can represent end to end.
       */
      totalPaise: requested.totalPaise === null ? null : Number(requested.totalPaise),
      averagePaise: requested.averagePaise === null ? null : Number(requested.averagePaise),
    },
    // Chronological, unlike the sized dimensions: a time series reads left to
    // right, and the query already ordered it.
    monthly: monthly.map((row) => ({ month: row.month, count: Number(row.count) })),
  }
}
