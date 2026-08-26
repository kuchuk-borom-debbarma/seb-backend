import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  Calendar,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronRight,
  FileCheck,
  FilePlus2,
  FileText,
  Folder,
  Landmark,
  RefreshCw,
  Search,
  UserPlus,
  Users,
  XCircle,
  type LucideIcon,
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

const QUEUE_ICONS: Record<
  AdminIntakeQueueKey,
  {
    icon: LucideIcon
    color: 'blue' | 'green' | 'amber' | 'teal' | 'purple' | 'green-circle' | 'red-circle'
  }
> = {
  NEW_SUBMISSIONS: { icon: FileText, color: 'blue' },
  REVISION_RESPONSES: { icon: RefreshCw, color: 'green' },
  DESK_REVIEW: { icon: Search, color: 'amber' },
  PARTNER_BANK_EVALUATION: { icon: Calendar, color: 'teal' },
  TTM_REVIEW: { icon: Users, color: 'purple' },
  APPROVED: { icon: CheckCircle2, color: 'green-circle' },
  REJECTED: { icon: XCircle, color: 'red-circle' },
  SANCTIONED: { icon: FileCheck, color: 'amber' },
  DISBURSED: { icon: Landmark, color: 'blue' },
}

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
          <Link to="/admin/queue" className={styles.headerPrimaryButton}>
            View applications
            <ChevronRight size={15} aria-hidden="true" />
          </Link>
        }
      />

      <div className={styles.adminDashboard}>
        {/* Top 3 Summary Metric Cards */}
        <section className={styles.metrics} aria-label="Casework summary">
          <Link to="/admin/queue" className={styles.metricCard}>
            <div className={styles.metricLeft}>
              <div className={styles.metricIconBadge} data-color="blue">
                <Folder aria-hidden="true" />
              </div>
              <div className={styles.metricInfo}>
                <span className={styles.metricLabel}>Waiting on the office</span>
                <strong className={styles.metricValue}>{waiting}</strong>
              </div>
            </div>
            <ChevronRight className={styles.metricChevron} size={18} aria-hidden="true" />
          </Link>

          <Link to="/admin/queue" className={styles.metricCard}>
            <div className={styles.metricLeft}>
              <div className={styles.metricIconBadge} data-color="green">
                <FileText aria-hidden="true" />
              </div>
              <div className={styles.metricInfo}>
                <span className={styles.metricLabel}>Submitted casework</span>
                <strong className={styles.metricValue}>{submittedCasework}</strong>
              </div>
            </div>
            <ChevronRight className={styles.metricChevron} size={18} aria-hidden="true" />
          </Link>

          <Link to="/admin/meetings" className={styles.metricCard}>
            <div className={styles.metricLeft}>
              <div className={styles.metricIconBadge} data-color="purple">
                <Users aria-hidden="true" />
              </div>
              <div className={styles.metricInfo}>
                <span className={styles.metricLabel}>Committee meetings</span>
                <strong className={styles.metricValue}>
                  {data?.meetings.pageInfo.totalCount ?? 0}
                </strong>
              </div>
            </div>
            <ChevronRight className={styles.metricChevron} size={18} aria-hidden="true" />
          </Link>
        </section>

        {/* Two-Column Responsive Main Grid */}
        <div className={styles.adminMainGrid}>
          {/* Left Column */}
          <div className={styles.adminCol}>
            {/* Card 1: Waiting on us */}
            <section className={styles.adminCard} aria-label="Waiting on us">
              <div className={styles.adminCardHeader}>
                <div className="label-row" style={{ margin: 0 }}>
                  <h2 className={styles.adminCardTitle}>Waiting on us</h2>
                  <Explain
                    label="these queues"
                    opener="Why new submissions and revision responses are counted apart"
                  >
                    {OFFICE_HELP.twoSubmittedQueues}
                  </Explain>
                </div>
              </div>
              <div className={styles.waitingQueueList} {...mark('waiting-on-us')}>
                {actionable.map((queue) => {
                  const Icon = QUEUE_ICONS[queue]?.icon ?? FileText
                  const color = QUEUE_ICONS[queue]?.color ?? 'blue'
                  return (
                    <Link
                      key={queue}
                      to="/admin/queue"
                      search={{ queue }}
                      className={styles.waitingQueueRow}
                    >
                      <div className={styles.waitingQueueLeft}>
                        <div className={styles.waitingIconBadge} data-color={color}>
                          <Icon size={18} aria-hidden="true" />
                        </div>
                        <div className={styles.waitingQueueText}>
                          <span className={styles.waitingQueueTitle}>
                            {QUEUE_TITLES[queue]}
                          </span>
                          <small className={styles.waitingQueueDesc}>
                            {QUEUE_DESCRIPTIONS[queue]}
                          </small>
                        </div>
                      </div>
                      <div className={styles.waitingQueueRight}>
                        <strong className={styles.waitingQueueCount}>{countOf(queue)}</strong>
                        <ChevronRight
                          className={styles.waitingQueueChevron}
                          size={16}
                          aria-hidden="true"
                        />
                      </div>
                    </Link>
                  )
                })}
              </div>
            </section>

            {/* Card 2: Find an application */}
            <section className={styles.adminCard} aria-label="Find an application">
              <h2 className={styles.adminCardTitle} style={{ marginBottom: '14px' }}>
                Find an application
              </h2>
              <ReferenceLookup variant="embedded" />
            </section>
          </div>

          {/* Right Column */}
          <div className={styles.adminCol}>
            {/* Card 1: Latest scheduled meetings */}
            <section className={styles.adminCard} aria-label="Latest scheduled meetings">
              <div className={styles.adminCardHeader}>
                <h2 className={styles.adminCardTitle}>Latest scheduled meetings</h2>
                <Link to="/admin/meetings" className={styles.viewAllLink}>
                  View all
                </Link>
              </div>
              {meetings.length === 0 ? (
                <div className={styles.meetingEmpty}>
                  <div className={styles.meetingEmptyIcon}>
                    <CalendarDays size={24} aria-hidden="true" />
                  </div>
                  <p className={styles.meetingEmptyText}>
                    No committee meetings have been scheduled.
                  </p>
                </div>
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

            {/* Card 2: Quick actions */}
            <section className={styles.adminCard} aria-label="Quick actions">
              <h2 className={styles.adminCardTitle} style={{ marginBottom: '14px' }}>
                Quick actions
              </h2>
              <div className={styles.quickActionsGrid}>
                <Link to="/admin/queue" className={styles.quickActionTile} data-color="blue">
                  <Search className={styles.quickActionIcon} aria-hidden="true" />
                  <span className={styles.quickActionLabel}>Find an application</span>
                </Link>
                {can(user, 'STAFF_WRITE') ? (
                  <Link
                    to="/admin/meetings"
                    search={{ create: true }}
                    className={styles.quickActionTile}
                    data-color="green"
                  >
                    <CalendarPlus className={styles.quickActionIcon} aria-hidden="true" />
                    <span className={styles.quickActionLabel}>Schedule a meeting</span>
                  </Link>
                ) : (
                  <Link
                    to="/admin/meetings"
                    className={styles.quickActionTile}
                    data-color="green"
                  >
                    <Users className={styles.quickActionIcon} aria-hidden="true" />
                    <span className={styles.quickActionLabel}>Committee meetings</span>
                  </Link>
                )}
                {can(user, 'STAFF_WRITE') ? (
                  <Link
                    to="/admin/cycles/new"
                    className={styles.quickActionTile}
                    data-color="amber"
                  >
                    <FilePlus2 className={styles.quickActionIcon} aria-hidden="true" />
                    <span className={styles.quickActionLabel}>
                      Create a programme cycle
                    </span>
                  </Link>
                ) : null}
                {can(user, 'ROLE_INVITE') ? (
                  <Link
                    to="/admin/invite"
                    className={styles.quickActionTile}
                    data-color="purple"
                  >
                    <UserPlus className={styles.quickActionIcon} aria-hidden="true" />
                    <span className={styles.quickActionLabel}>Invite a colleague</span>
                  </Link>
                ) : null}
              </div>
            </section>

            {/* Card 3: All queues */}
            <section className={styles.adminCard} aria-label="All queues">
              <h2 className={styles.adminCardTitle} style={{ marginBottom: '12px' }}>
                All queues
              </h2>
              <div className={styles.queuesTableWrap}>
                <table className={styles.queuesTable}>
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
                    {QUEUE_KEYS.map((queue) => {
                      const Icon = QUEUE_ICONS[queue]?.icon ?? FileText
                      const color = QUEUE_ICONS[queue]?.color ?? 'blue'
                      return (
                        <tr key={queue} className={styles.queuesTableRow}>
                          <td>
                            <Link
                              to="/admin/queue"
                              search={{ queue }}
                              className={styles.queueNameLink}
                            >
                              <div className={styles.queueIconBadge} data-color={color}>
                                <Icon size={14} aria-hidden="true" />
                              </div>
                              <span className={styles.queueTitleText}>
                                {QUEUE_TITLES[queue]}
                              </span>
                            </Link>
                          </td>
                          <td className={styles.queueDescText}>
                            {QUEUE_DESCRIPTIONS[queue]}
                          </td>
                          <td className={styles.queueCountCell}>
                            <Link
                              to="/admin/queue"
                              search={{ queue }}
                              className={styles.queueCountLink}
                            >
                              <span>{countOf(queue)}</span>
                              <ChevronRight size={14} aria-hidden="true" />
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}

