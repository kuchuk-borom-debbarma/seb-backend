import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Pager, SearchBox } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { AdminCyclesDocument } from '#/graphql/generated/operations'
import type { ProgrammeCycleStatus } from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

const PAGE_SIZE = 20

const STATUSES: ProgrammeCycleStatus[] = ['DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED']

type Search = {
  after?: string
  status?: ProgrammeCycleStatus
  cycleYear?: number
  search?: string
  includeDeleted?: boolean
}

const cyclesQuery = (search: Search) =>
  queryOptions({
    queryKey: ['admin-cycles', search],
    queryFn: async () => {
      const data = await gql(AdminCyclesDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        includeDeleted: search.includeDeleted ?? false,
        status: search.status ?? null,
        cycleYear: search.cycleYear ?? null,
        search: search.search ?? null,
      })
      return unwrap(data.admin.programmeCycle.list)
    },
    placeholderData: (previous) => previous,
  })

export const Route = createFileRoute('/_shell/admin/cycles/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    status: STATUSES.includes(search.status as ProgrammeCycleStatus)
      ? (search.status as ProgrammeCycleStatus)
      : undefined,
    // A year is four digits or it is not a year.
    cycleYear:
      typeof search.cycleYear === 'number' && Number.isInteger(search.cycleYear)
        ? search.cycleYear
        : undefined,
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
    includeDeleted: search.includeDeleted === true ? true : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(cyclesQuery(deps)),
  component: AdminCyclesPage,
})

function AdminCyclesPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(cyclesQuery(search))
  const mark = useMarker()

  const cycles = data?.nodes ?? []
  const filtered = Boolean(search.search || search.status || search.cycleYear)

  /** Any filter change invalidates the cursor: it points into another set. */
  const filter = (change: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })

  return (
    <main className="page">
      <PageHeader
        title="Programme cycles"
        description="A cycle is the policy an application is judged by. Its rules are frozen into every draft started while it is open."
        actions={
          <Link
            to="/admin/cycles/new"
            className="button"
            data-variant="primary"
            {...mark('cycle-list')}
          >
            Create a cycle
          </Link>
        }
      />

      <div className="filters">
        <SearchBox
          id="cycle-search"
          label="Code starts with"
          placeholder="SEP-2026"
          value={search.search}
          onChange={(value) => filter({ search: value })}
        />

        <div>
          <label className="field-label" htmlFor="cycle-status">
            State
          </label>
          <select
            id="cycle-status"
            className="select"
            value={search.status ?? ''}
            onChange={(event) =>
              filter({
                status: (event.target.value || undefined) as
                  ProgrammeCycleStatus | undefined,
              })
            }
          >
            <option value="">Any state</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {humanize(status)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="cycle-year">
            Programme year
          </label>
          <input
            id="cycle-year"
            className="input tabular"
            type="number"
            min={2000}
            max={2100}
            value={search.cycleYear ?? ''}
            onChange={(event) =>
              filter({
                cycleYear: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          />
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={search.includeDeleted ?? false}
            onChange={(event) =>
              filter({ includeDeleted: event.target.checked ? true : undefined })
            }
          />
          Include removed drafts
        </label>
      </div>

      {cycles.length === 0 ? (
        <div className="card">
          {filtered ? (
            <div className="empty">
              <h3>Nothing matches</h3>
              <p>No cycle matches these filters. Clearing one may bring some back.</p>
              <button
                type="button"
                className="button"
                style={{ marginTop: '1rem' }}
                onClick={() =>
                  filter({ search: undefined, status: undefined, cycleYear: undefined })
                }
              >
                Clear the filters
              </button>
            </div>
          ) : (
            <div className="empty">
              <h3>No cycles yet</h3>
              <p>Applicants cannot start an application until a cycle is open.</p>
              <Link
                to="/admin/cycles/new"
                className="button"
                data-variant="primary"
                style={{ marginTop: '1rem' }}
              >
                Create the first cycle
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Programme cycles</caption>
              <thead>
                <tr>
                  <th scope="col">Cycle</th>
                  <th scope="col">Year</th>
                  <th scope="col">State</th>
                  <th scope="col">Opens</th>
                  <th scope="col">Closes</th>
                  <th scope="col" className="numeric">
                    Version
                  </th>
                </tr>
              </thead>
              <tbody>
                {cycles.map((cycle) => (
                  <tr key={cycle.id}>
                    <td>
                      <Link
                        to="/admin/cycles/$id"
                        params={{ id: cycle.id }}
                        style={{ fontWeight: 500 }}
                      >
                        {cycle.displayName}
                      </Link>
                      <span className="muted tabular"> · {cycle.cycleCode}</span>
                    </td>
                    <td className="tabular">{cycle.cycleYear}</td>
                    <td>
                      <span
                        className="badge"
                        data-tone={
                          cycle.status === 'OPEN'
                            ? 'ok'
                            : cycle.status === 'DRAFT'
                              ? 'action'
                              : undefined
                        }
                      >
                        {humanize(cycle.status)}
                      </span>
                    </td>
                    <td>{formatDate(cycle.opensAt)}</td>
                    <td>{formatDate(cycle.closesAt)}</td>
                    <td className="numeric">{cycle.currentVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            shown={cycles.length}
            totalCount={data?.pageInfo.totalCount ?? 0}
            hasNextPage={data?.pageInfo.hasNextPage ?? false}
            atStart={!search.after}
            pageSize={PAGE_SIZE}
            onFirst={() =>
              navigate({ search: (previous) => ({ ...previous, after: undefined }) })
            }
            onNext={() =>
              navigate({
                search: (previous) => ({
                  ...previous,
                  after: data?.pageInfo.endCursor ?? undefined,
                }),
              })
            }
          />
        </div>
      )}
    </main>
  )
}
