/**
 * The intake console.
 *
 * The question this screen answers is "what needs me today?", so the three
 * queues that are genuinely waiting on the programme office lead, and the rest
 * — which are waiting on a bank, a committee or a payment — follow as a plain
 * count.
 *
 * Every queue is shown even when empty. A chip that disappears when it reaches
 * zero moves everything beside it, and staff who work this screen daily learn
 * where their queue sits.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { useMarker } from '#/features/guide/GuideContext'
import { queueSummaryQuery } from '#/features/admin/intakeQueries'
import {
  ACTIONABLE_QUEUES,
  QUEUE_DESCRIPTIONS,
  QUEUE_KEYS,
  QUEUE_TITLES,
} from '#/features/admin/queues'
import { ReferenceLookup } from '#/features/admin/ReferenceLookup'
import type { AdminIntakeQueueKey } from '#/graphql/generated/schema'

export const Route = createFileRoute('/_shell/admin/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(queueSummaryQuery()),
  component: IntakeConsole,
})

function IntakeConsole() {
  const { data: queues } = useQuery(queueSummaryQuery())
  const mark = useMarker()

  const countOf = (queue: AdminIntakeQueueKey) =>
    queues?.find((entry) => entry.queue === queue)?.count ?? 0

  const waiting = QUEUE_KEYS.filter((queue) => ACTIONABLE_QUEUES.has(queue))
  const elsewhere = QUEUE_KEYS.filter((queue) => !ACTIONABLE_QUEUES.has(queue))

  return (
    <main className="page">
      <PageHeader
        title="Intake"
        description="Applications waiting on the programme office, and where everything else has got to."
      />

      <div className="stack">
        <section>
          <h2 className="section-title">Waiting on us</h2>
          <div className="queue-grid" {...mark('waiting-on-us')}>
            {waiting.map((queue) => (
              <Link
                key={queue}
                to="/admin/queue"
                search={{ queue }}
                className="queue-card"
                data-empty={countOf(queue) === 0 ? 'true' : undefined}
              >
                <span className="queue-count tabular">{countOf(queue)}</span>
                <span className="queue-name">{QUEUE_TITLES[queue]}</span>
                <span className="queue-note">{QUEUE_DESCRIPTIONS[queue]}</span>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h2 className="section-title">Elsewhere</h2>
          <div className="card">
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">
                  Applications waiting on somebody outside the programme office
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Queue</th>
                    <th scope="col">Waiting on</th>
                    <th scope="col" data-numeric>
                      Applications
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {elsewhere.map((queue) => (
                    <tr key={queue}>
                      <td>
                        <Link to="/admin/queue" search={{ queue }}>
                          {QUEUE_TITLES[queue]}
                        </Link>
                      </td>
                      <td className="muted">{QUEUE_DESCRIPTIONS[queue]}</td>
                      <td data-numeric>{countOf(queue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section>
          <h2 className="section-title">Find an application</h2>
          <ReferenceLookup />
        </section>
      </div>
    </main>
  )
}
