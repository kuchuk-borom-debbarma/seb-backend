import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  CalendarDays,
  ClipboardList,
  Clock3,
  Search,
  UserPlus,
  Users,
} from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { ReferenceLookup } from '#/features/admin/ReferenceLookup'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { Explain } from '#/features/guide/Explain'
import { useMarker } from '#/features/guide/GuideContext'
import {
  ACTIONABLE_QUEUES,
  QUEUE_DESCRIPTIONS,
  QUEUE_KEYS,
  QUEUE_TITLES,
} from '#/features/admin/queues'
import { MEETING_TITLES } from '#/features/admin/states'
import { officeDashboardQuery } from '#/features/dashboard/dashboardQueries'
import type { AdminIntakeQueueKey } from '#/graphql/generated/schema'
import { can } from '#/lib/session'
import { formatDateTime, humanize } from '#/lib/format'
import styles from '#/features/dashboard/Dashboard.module.css'

export const Route = createFileRoute('/_shell/admin/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(officeDashboardQuery),
  component: OfficeDashboard,
})

function OfficeDashboard() {
  const { data } = useQuery(officeDashboardQuery)
  const { user } = Route.useRouteContext()
  const mark = useMarker()
  const queues = data?.queues ?? []
  const meetings = data?.meetings.nodes ?? []
  const countOf = (queue: AdminIntakeQueueKey) =>
    queues.find((entry) => entry.queue === queue)?.count ?? 0
  const actionable = QUEUE_KEYS.filter((queue) => ACTIONABLE_QUEUES.has(queue))
  const waiting = actionable.reduce((total, queue) => total + countOf(queue), 0)
  const submittedCasework = queues.reduce((total, entry) => total + entry.count, 0)

  return (
    <main className="page">
      <PageHeader
        title="Dashboard"
        description="The programme office’s live casework, meetings, and fastest routes into today’s work."
        actions={
          <Link to="/admin/queue" className="button" data-variant="primary">
            <ClipboardList size={15} aria-hidden="true" />
            View applications
          </Link>
        }
      />

      <div className="stack" style={{ gap: '1rem' }}>
        <section className={styles.metrics} aria-label="Casework summary">
          <Link to="/admin/queue" className={styles.metric}>
            <span className={styles.metricTop}>
              Waiting on the office <Clock3 aria-hidden="true" />
            </span>
            <strong className={styles.metricValue}>{waiting}</strong>
          </Link>
          <Link to="/admin/queue" className={styles.metric}>
            <span className={styles.metricTop}>
              Submitted casework <ClipboardList aria-hidden="true" />
            </span>
            <strong className={styles.metricValue}>{submittedCasework}</strong>
          </Link>
          <Link to="/admin/meetings" className={styles.metric}>
            <span className={styles.metricTop}>
              Committee meetings <Users aria-hidden="true" />
            </span>
            <strong className={styles.metricValue}>
              {data?.meetings.pageInfo.totalCount ?? 0}
            </strong>
          </Link>
        </section>

        <section>
          <div className="label-row">
            <h2 className="section-title">Waiting on us</h2>
            <Explain
              label="these queues"
              opener="Why new submissions and revision responses are counted apart"
            >
              {OFFICE_HELP.twoSubmittedQueues}
            </Explain>
          </div>
          <div className={styles.queueSummary} {...mark('waiting-on-us')}>
            {actionable.map((queue) => (
              <Link
                key={queue}
                to="/admin/queue"
                search={{ queue }}
                className={styles.queueCard}
              >
                <span>{QUEUE_TITLES[queue]}</span>
                <small>{QUEUE_DESCRIPTIONS[queue]}</small>
                <strong>{countOf(queue)}</strong>
              </Link>
            ))}
          </div>
        </section>

        <div className={styles.dashboardGrid}>
          <section className={styles.section} aria-label="Latest scheduled meetings">
            <div className={styles.sectionHeader}>
              <h2>Latest scheduled meetings</h2>
              <Link to="/admin/meetings">View all</Link>
            </div>
            {meetings.length === 0 ? (
              <p className={styles.empty}>No committee meetings have been scheduled.</p>
            ) : (
              <div className={styles.meetingList}>
                {meetings.map((meeting) => (
                  <Link
                    key={meeting.id}
                    to="/admin/meetings/$meetingId"
                    params={{ meetingId: meeting.id }}
                    className={styles.meetingRow}
                  >
                    <CalendarDays className={styles.rowIcon} aria-hidden="true" />
                    <span className={styles.rowText}>
                      <strong>{meeting.meetingReference}</strong>
                      <small>
                        {formatDateTime(meeting.scheduledAt)} · {meeting.venue}
                      </small>
                    </span>
                    <span className="badge">
                      {MEETING_TITLES[meeting.status] ?? humanize(meeting.status)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Quick actions</h2>
            </div>
            <div className={styles.quickActions}>
              <Link to="/admin/queue" className={styles.quickAction}>
                <Search aria-hidden="true" /> Find an application
              </Link>
              {can(user, 'STAFF_WRITE') ? (
                <Link
                  to="/admin/meetings"
                  search={{ create: true }}
                  className={styles.quickAction}
                >
                  <CalendarDays aria-hidden="true" /> Schedule a meeting
                </Link>
              ) : (
                <Link to="/admin/meetings" className={styles.quickAction}>
                  <Users aria-hidden="true" /> Committee meetings
                </Link>
              )}
              {can(user, 'STAFF_WRITE') ? (
                <Link to="/admin/cycles/new" className={styles.quickAction}>
                  <CalendarDays aria-hidden="true" /> Create a programme cycle
                </Link>
              ) : null}
              {can(user, 'ROLE_INVITE') ? (
                <Link to="/admin/invite" className={styles.quickAction}>
                  <UserPlus aria-hidden="true" /> Invite a colleague
                </Link>
              ) : null}
            </div>
          </section>
        </div>

        <section>
          <h2 className="section-title">Find an application</h2>
          <ReferenceLookup />
        </section>

        <section>
          <h2 className="section-title">All queues</h2>
          <div className="card">
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Every administrative queue</caption>
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
                  {QUEUE_KEYS.map((queue) => (
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
      </div>
    </main>
  )
}
