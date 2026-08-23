import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { cyclesQuery } from '#/features/application/queries'
import { formatDate, formatRelative, humanize } from '#/lib/format'

export const Route = createFileRoute('/_shell/_applicant/cycles')({
  loader: ({ context }) => context.queryClient.ensureQueryData(cyclesQuery),
  component: CyclesPage,
})

function CyclesPage() {
  const { data } = useQuery(cyclesQuery)
  const available = data?.available ?? []
  const openIds = new Set(available.map((cycle) => cycle.id))
  // History is everything with work in it that is not currently startable, so
  // a closed cycle appears here and never carries a "start" action.
  const history = (data?.mine ?? []).filter((cycle) => !openIds.has(cycle.id))

  return (
    <main className="page">
      <PageHeader
        title="Programme cycles"
        description="A cycle is a named application window, such as Mission SEP 2026. It sets the rules an application is judged by."
      />

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Open for new applications</h2>
        {available.length === 0 ? (
          <div className="card">
            <div className="empty">
              <h3>No cycle is open</h3>
              <p>
                New applications can be started when the programme office opens the next
                cycle.
              </p>
            </div>
          </div>
        ) : (
          <div className="stack">
            {available.map((cycle) => (
              <div className="card" key={cycle.id}>
                <div className="card-header">
                  <div>
                    <p className="eyebrow">{cycle.cycleCode}</p>
                    <h3 style={{ marginTop: '0.25rem' }}>{cycle.displayName}</h3>
                  </div>
                  <Link
                    to="/applications/new"
                    search={{ cycleId: cycle.id }}
                    className="button"
                    data-variant="primary"
                  >
                    Apply in this cycle
                  </Link>
                </div>
                <div className="card-body">
                  <div className="detail-grid">
                    <div>
                      <span className="field-label">Applications close</span>
                      <span>
                        {cycle.closesAt ? (
                          <>
                            {formatDate(cycle.closesAt)}{' '}
                            <span className="muted">
                              ({formatRelative(cycle.closesAt)})
                            </span>
                          </>
                        ) : (
                          'No closing date set'
                        )}
                      </span>
                    </div>
                    <div>
                      <span className="field-label">Policy reference</span>
                      <span>{cycle.policyReference ?? '—'}</span>
                    </div>
                    <div>
                      <span className="field-label">Programme year</span>
                      <span className="tabular">{cycle.cycleYear}</span>
                    </div>
                  </div>
                  {cycle.applicantGuidance ? (
                    <p className="notice" data-tone="ok" style={{ marginTop: '1rem' }}>
                      <span className="notice-title">Guidance for this cycle</span>
                      {cycle.applicantGuidance}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {history.length > 0 ? (
        <section>
          <h2 style={{ marginBottom: '0.75rem' }}>Cycles you have applied in</h2>
          <div className="card">
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Past programme cycles</caption>
                <thead>
                  <tr>
                    <th scope="col">Cycle</th>
                    <th scope="col">Year</th>
                    <th scope="col">State</th>
                    <th scope="col">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((cycle) => (
                    <tr key={cycle.id}>
                      <td>
                        {cycle.displayName}
                        <span className="muted"> · {cycle.cycleCode}</span>
                      </td>
                      <td className="tabular">{cycle.cycleYear}</td>
                      <td>
                        <span className="badge">{humanize(cycle.status)}</span>
                      </td>
                      <td>{formatDate(cycle.closesAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  )
}
