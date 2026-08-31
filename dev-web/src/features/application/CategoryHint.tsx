/**
 * Which way the establishment date points, before submission stamps it.
 *
 * Advisory by design: the server computes the real category at the moment of
 * submission, from the same date against the cycle's own threshold. The
 * threshold is per-cycle policy, so no number of months may be hardcoded here.
 * Silent when the cycle sets no threshold or the enterprise has no
 * establishment date — there is no category to point at yet.
 */
import { queryOptions, useQuery } from '@tanstack/react-query'
import { cyclesQuery } from '#/features/application/queries'
import { EnterpriseByIdDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

// The same key the enterprise screen uses, so both read one cached record.
const enterpriseQuery = (id: string) =>
  queryOptions({
    queryKey: ['enterprise', id],
    queryFn: async () => {
      const data = await gql(EnterpriseByIdDocument, { id })
      return unwrap(data.seb.enterprise.byId)
    },
  })

/**
 * Whether the threshold of whole calendar months has passed since the date.
 *
 * Mirrors the server's `addUtcCalendarMonths` end-of-month clamping (a month
 * on from 31 January is the last day of February), so the hint and the
 * stamped category cannot disagree at a month boundary.
 */
const thresholdReached = (establishmentDate: string, months: number): boolean => {
  const [year, month, day] = establishmentDate.split('-').map(Number)
  if (!year || !month || !day) return false
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate()
  return Date.UTC(year, month - 1 + months, Math.min(day, lastDay)) <= Date.now()
}

export function CategoryHint({
  enterpriseId,
  programmeCycleId,
}: {
  enterpriseId: string
  programmeCycleId: string
}) {
  const { data: cycles } = useQuery(cyclesQuery)
  const { data: enterprise } = useQuery(enterpriseQuery(enterpriseId))

  // Both lists are searched, for the same reason ClosingNotice searches both.
  const cycle =
    cycles?.mine.find((entry) => entry.id === programmeCycleId) ??
    cycles?.available.find((entry) => entry.id === programmeCycleId)

  const threshold = cycle?.categoryAMaximumMonths ?? null
  const establishmentDate = enterprise?.establishmentDate ?? null
  if (threshold === null || establishmentDate === null) return null

  const established = thresholdReached(establishmentDate, threshold)
  return (
    <p className="notice" style={{ marginBottom: '1rem' }}>
      <span className="notice-title">
        {established
          ? `Category A — trading ${threshold}+ months`
          : `Category B — newer than ${threshold} months`}
      </span>
      Based on your enterprise&apos;s establishment date. The category is determined
      automatically when you submit — it is never something you choose.
    </p>
  )
}
