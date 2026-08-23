import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Pager, SearchBox } from '#/components/ListControls'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { MyEnterprisesDocument } from '#/graphql/generated/operations'
import type { BusinessSector, EnterpriseStatus } from '#/graphql/generated/schema'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

/** The server's page size. Kept small because these lists are browsed, not scanned. */
const PAGE_SIZE = 20

type Search = {
  after?: string
  includeDeleted?: boolean
  search?: string
  status?: EnterpriseStatus
  sector?: BusinessSector
}

const STATUSES: EnterpriseStatus[] = ['PROPOSED', 'ACTIVE', 'INACTIVE']

const SECTORS: BusinessSector[] = [
  'AGRICULTURE_AND_ALLIED',
  'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  'FOOD_PROCESSING',
  'TOURISM_AND_HOSPITALITY',
  'INFORMATION_TECHNOLOGY',
  'MANUFACTURING_AND_SERVICES',
  'OTHER',
]

const oneOf = <TValue extends string>(
  allowed: readonly TValue[],
  value: unknown,
): TValue | undefined =>
  allowed.includes(value as TValue) ? (value as TValue) : undefined

const enterprisesQuery = (search: Search) =>
  queryOptions({
    // Keyed by the search parameters, so paging back to a page already seen is
    // served from cache instead of refetched.
    queryKey: ['enterprises', search],
    queryFn: async () => {
      const data = await gql(MyEnterprisesDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        includeDeleted: search.includeDeleted ?? false,
        search: search.search ?? null,
        status: search.status ?? null,
        sector: search.sector ?? null,
      })
      return unwrap(data.seb.enterprise.mine)
    },
    // Keeps the current rows on screen while the next page or filter loads,
    // rather than blanking the table and shifting the layout.
    placeholderData: (previous) => previous,
  })

export const Route = createFileRoute('/_shell/_applicant/enterprises/')({
  // Filters and the cursor live in the URL, so a page can be linked, shared and
  // returned to by the back button rather than living in component state.
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    includeDeleted: search.includeDeleted === true ? true : undefined,
    search:
      typeof search.search === 'string' && search.search ? search.search : undefined,
    status: oneOf(STATUSES, search.status),
    sector: oneOf(SECTORS, search.sector),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(enterprisesQuery(deps)),
  component: EnterprisesPage,
})

function EnterprisesPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data } = useQuery(enterprisesQuery(search))
  const mark = useMarker()

  const enterprises = data?.nodes ?? []
  const filtered = Boolean(search.search || search.status || search.sector)

  /** Any filter change invalidates the cursor: it points into another set. */
  const filter = (change: Partial<Search>) =>
    navigate({ search: (previous) => ({ ...previous, ...change, after: undefined }) })

  return (
    <main className="page">
      <PageHeader
        title="Enterprises"
        description="Each application is made on behalf of one enterprise. Register it here first."
        actions={
          <Link
            to="/enterprises/new"
            className="button"
            data-variant="primary"
            {...mark('enterprise-list')}
          >
            Register an enterprise
          </Link>
        }
      />

      <div className="filters">
        <SearchBox
          id="enterprise-search"
          label="Name starts with"
          placeholder="Khumulwng"
          value={search.search}
          onChange={(value) => filter({ search: value })}
        />

        <div>
          <label className="field-label" htmlFor="enterprise-status">
            State
          </label>
          <select
            id="enterprise-status"
            className="select"
            value={search.status ?? ''}
            onChange={(event) =>
              filter({
                status: (event.target.value || undefined) as EnterpriseStatus | undefined,
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
          <label className="field-label" htmlFor="enterprise-sector">
            Sector
          </label>
          <select
            id="enterprise-sector"
            className="select"
            value={search.sector ?? ''}
            onChange={(event) =>
              filter({
                sector: (event.target.value || undefined) as BusinessSector | undefined,
              })
            }
          >
            <option value="">Any sector</option>
            {SECTORS.map((sector) => (
              <option key={sector} value={sector}>
                {humanize(sector)}
              </option>
            ))}
          </select>
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={search.includeDeleted ?? false}
            onChange={(event) =>
              filter({ includeDeleted: event.target.checked ? true : undefined })
            }
          />
          Include removed enterprises
        </label>
      </div>

      {enterprises.length === 0 ? (
        <div className="card">
          {/* Two different facts, and telling them apart is the point of
              knowing the total: nothing matched, or there is nothing here. */}
          {filtered ? (
            <div className="empty">
              <h3>Nothing matches</h3>
              <p>
                No enterprise matches these filters. Clearing one may bring some back.
              </p>
              <button
                type="button"
                className="button"
                style={{ marginTop: '1rem' }}
                onClick={() =>
                  filter({ search: undefined, status: undefined, sector: undefined })
                }
              >
                Clear the filters
              </button>
            </div>
          ) : (
            <div className="empty">
              <h3>No enterprises yet</h3>
              <p>
                Register the enterprise you are applying for, then start an application in
                an open programme cycle.
              </p>
              <Link
                to="/enterprises/new"
                className="button"
                data-variant="primary"
                style={{ marginTop: '1rem' }}
              >
                Register an enterprise
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Your enterprises</caption>
              <thead>
                <tr>
                  <th scope="col">Enterprise</th>
                  <th scope="col">Sector</th>
                  <th scope="col">Where</th>
                  <th scope="col">Established</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {enterprises.map((enterprise) => (
                  <tr key={enterprise.id}>
                    <td>
                      <Link
                        to="/enterprises/$id"
                        params={{ id: enterprise.id }}
                        style={{ fontWeight: 500 }}
                      >
                        {enterprise.name}
                      </Link>
                    </td>
                    <td>
                      {enterprise.businessSector
                        ? enterprise.businessSector === 'OTHER'
                          ? (enterprise.otherBusinessSector ?? 'Other')
                          : humanize(enterprise.businessSector)
                        : '—'}
                    </td>
                    <td>
                      {[enterprise.businessBlockOrVillage, enterprise.businessDistrict]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </td>
                    <td>{formatDate(enterprise.establishmentDate)}</td>
                    <td>
                      {enterprise.deletedAt ? (
                        <span className="badge" data-tone="error">
                          Removed
                        </span>
                      ) : (
                        <span className="badge">{humanize(enterprise.status)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/*
            Cursor paging only ever moves forward, because that is what the API
            provides. "Start again" replaces a back button that could not be
            made correct.
          */}
          <Pager
            shown={enterprises.length}
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
