import { queryOptions, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { AdminCyclesDocument } from '#/graphql/generated/operations'
import { formatDate, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { unwrap } from '#/lib/result'

const cyclesQuery = queryOptions({
  queryKey: ['admin-cycles'],
  queryFn: async () => {
    const data = await gql(AdminCyclesDocument, {
      first: 50,
      after: null,
      includeDeleted: false,
    })
    return unwrap(data.admin.programmeCycle.list).nodes
  },
})

export const Route = createFileRoute('/_shell/admin/cycles/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(cyclesQuery),
  component: AdminCyclesPage,
})

function AdminCyclesPage() {
  const { data: cycles } = useQuery(cyclesQuery)
  const mark = useMarker()

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

      {cycles?.length === 0 ? (
        <div className="card">
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
                {cycles?.map((cycle) => (
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
        </div>
      )}
    </main>
  )
}
