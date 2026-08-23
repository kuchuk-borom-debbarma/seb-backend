import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { MyEnterprisesDocument } from '#/graphql/generated/operations'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

/** The server's page size. Kept small because these lists are browsed, not scanned. */
const PAGE_SIZE = 20

type Search = { after?: string; includeDeleted?: boolean }

const enterprisesQuery = (search: Search) =>
  queryOptions({
    // Keyed by the search parameters, so paging back to a page already seen is
    // served from cache instead of refetched.
    queryKey: ['enterprises', search.after ?? null, search.includeDeleted ?? false],
    queryFn: async () => {
      const data = await gql(MyEnterprisesDocument, {
        first: PAGE_SIZE,
        after: search.after ?? null,
        includeDeleted: search.includeDeleted ?? false,
      })
      return unwrap(data.seb.enterprise.mine)
    },
    // Keeps the current rows on screen while the next page or filter loads,
    // rather than blanking the table and shifting the layout.
    placeholderData: (previous) => previous,
  })

export const Route = createFileRoute('/_shell/app/enterprises/')({
  // Filters and the cursor live in the URL, so a page can be linked, shared and
  // returned to by the back button rather than living in component state.
  validateSearch: (search: Record<string, unknown>): Search => ({
    after: typeof search.after === 'string' ? search.after : undefined,
    includeDeleted: search.includeDeleted === true ? true : undefined,
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

  return (
    <main className="page">
      <PageHeader
        title="Enterprises"
        description="Each application is made on behalf of one enterprise. Register it here first."
        actions={
          <Link
            to="/app/enterprises/new"
            className="button"
            data-variant="primary"
            {...mark('enterprise-list')}
          >
            Register an enterprise
          </Link>
        }
      />

      <div className="filters">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={search.includeDeleted ?? false}
            onChange={(event) =>
              navigate({
                // Changing a filter invalidates the cursor: it points into a
                // differently-filtered result set.
                search: (previous) => ({
                  ...previous,
                  includeDeleted: event.target.checked ? true : undefined,
                  after: undefined,
                }),
              })
            }
          />
          Include removed enterprises
        </label>
      </div>

      {enterprises.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>No enterprises yet</h3>
            <p>
              Register the enterprise you are applying for, then start an application in
              an open programme cycle.
            </p>
            <Link
              to="/app/enterprises/new"
              className="button"
              data-variant="primary"
              style={{ marginTop: '1rem' }}
            >
              Register an enterprise
            </Link>
          </div>
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
                        to="/app/enterprises/$id"
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
          {data?.pageInfo.hasNextPage || search.after ? (
            <div className="pager">
              <button
                type="button"
                className="button"
                disabled={!search.after}
                onClick={() =>
                  navigate({ search: (previous) => ({ ...previous, after: undefined }) })
                }
              >
                Start again
              </button>
              <button
                type="button"
                className="button"
                disabled={!data?.pageInfo.hasNextPage}
                onClick={() =>
                  navigate({
                    search: (previous) => ({
                      ...previous,
                      after: data?.pageInfo.endCursor ?? undefined,
                    }),
                  })
                }
              >
                Next page
              </button>
            </div>
          ) : null}
        </div>
      )}
    </main>
  )
}
