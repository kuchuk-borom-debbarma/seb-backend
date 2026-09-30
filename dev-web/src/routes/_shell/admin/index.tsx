/**
 * The office dashboard.
 *
 * The question this screen answers is "what needs me today?": the stages this
 * person works and how many files wait at each, how much submitted casework
 * there is, and the files that have waited longest.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronRight, FilePlus2, FileText, Folder, Search, UserPlus } from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { AnalyticsPanel } from '#/features/admin/AnalyticsPanel'
import { Explain } from '#/features/guide/Explain'
import { ReferenceLookup } from '#/features/admin/ReferenceLookup'
import { useMarker } from '#/features/guide/GuideContext'
import { waitingFor } from '#/features/admin/queues'
import { officeDashboardQuery } from '#/features/dashboard/dashboardQueries'
import { MyStageCards } from '#/features/stage/MyStageCards'
import { myStagesQuery } from '#/features/stage/stageQueries'
import { can } from '#/lib/session'
import styles from '#/features/dashboard/Dashboard.module.css'

export const Route = createFileRoute('/_shell/admin/')({
  /*
   * Loaded only by somebody who may read casework.
   *
   * `officeDashboardQuery` unwraps an intake read the API guards with
   * `application`/`read`. Sign-in sends every member of staff here, so for a
   * role composed without it the refusal came out of the loader as an
   * unhandled error — the first screen after signing in was a broken one, with
   * no way back to the screen they do hold.
   */
  loader: ({ context }) =>
    Promise.all([
      can(context.user, 'application', 'read')
        ? context.queryClient.ensureQueryData(officeDashboardQuery)
        : undefined,
      can(context.user, 'stage', 'read')
        ? context.queryClient.ensureQueryData(myStagesQuery)
        : undefined,
    ]),
  component: OfficeDashboard,
})

function OfficeDashboard() {
  const { user } = Route.useRouteContext()
  const mayReadCasework = can(user, 'application', 'read')

  return (
    <main className="page">
      <PageHeader
        title="Dashboard"
        description={
          mayReadCasework
            ? 'The programme office’s live casework and fastest routes into today’s work.'
            : 'The parts of the programme office this account works in.'
        }
        actions={
          mayReadCasework ? (
            <Link to="/admin/queue" className={styles.headerPrimaryButton}>
              View applications
              <ChevronRight size={15} aria-hidden="true" />
            </Link>
          ) : undefined
        }
      />

      <div className={styles.adminDashboard}>
        {/* The stages this person works come first: they are today's work. */}
        {can(user, 'stage', 'read') ? <WorkedStages /> : null}

        {/*
          * Everything below counts or lists casework, so none of it is drawn
          * for a role composed without it. Zeros would read as "no work today"
          * rather than "not yours to see", which is a worse answer than an
          * absent panel — and the navigation still offers whatever they do
          * hold.
          */}
        {mayReadCasework ? <CaseworkMetrics /> : null}

        {/* The reporting panel, for the people who steer the programme. Gated
            on the pair the API itself guards this read with — `analytics`/`read`
            — because counts and totals name no applicant and are handed out
            separately from the files. This decides only what is drawn. */}
        {can(user, 'analytics', 'read') ? <AnalyticsPanel /> : null}

        {mayReadCasework ? <CaseworkQueues /> : null}
      </div>
    </main>
  )
}

/** The "My stages" cards, from the cache the loader primed. */
function WorkedStages() {
  const { data } = useQuery(myStagesQuery)
  return (
    <section className={styles.adminCard} aria-label="My stages">
      <div className={styles.adminCardHeader}>
        <h2 className={styles.adminCardTitle}>
          My stages{' '}
          {/*
            The one explanation on the console: which stages somebody sees is
            decided by stage ownership, not by their permissions, and nobody
            meeting the product guesses that.
          */}
          <Explain label="my stages" opener="Why these stages are yours">
            A stage is listed here when one of your roles owns it. Two officers can hold the same permissions and still work different stages — a State Bank of India officer never sees the files waiting at the Tripura Gramin Bank.
          </Explain>
        </h2>
        <Link to="/admin/stages" className={styles.viewAllLink}>
          Open
        </Link>
      </div>
      <MyStageCards stages={data ?? []} />
    </section>
  )
}

/**
 * The headline count, and what it links to.
 *
 * A component rather than a branch inside the page, so the permission that
 * decides whether casework is drawn at all is one word at one call site. It
 * reads the dashboard from the cache the route loader primed; nothing renders
 * it unless the caller holds `application`/`read`.
 */
function CaseworkMetrics() {
  const { data } = useQuery(officeDashboardQuery)
  const submittedCasework = data?.waiting.pageInfo.totalCount ?? 0

  return (
    <section className={styles.metrics} aria-label="Casework summary">
      <Link to="/admin/queue" className={styles.metricCard}>
        <div className={styles.metricLeft}>
          <div className={styles.metricIconBadge} data-color="blue">
            <Folder aria-hidden="true" />
          </div>
          <div className={styles.metricInfo}>
            <span className={styles.metricLabel}>Submitted casework</span>
            <strong className={styles.metricValue}>{submittedCasework}</strong>
          </div>
        </div>
        <ChevronRight className={styles.metricChevron} size={18} aria-hidden="true" />
      </Link>
    </section>
  )
}

/**
 * The working half of the dashboard: the lookup, the files waiting longest,
 * and every quick action.
 *
 * Same read as `CaseworkMetrics` — one query key, so react-query serves both
 * from one request and the two halves can never show counts from two moments.
 */
function CaseworkQueues() {
  const { data } = useQuery(officeDashboardQuery)
  const { user } = Route.useRouteContext()
  const mark = useMarker()
  const waiting = data?.waiting.nodes ?? []

  return (
    <div className={styles.adminMainGrid}>
      {/* Left Column */}
      <div className={styles.adminCol}>
        <section className={styles.adminCard} aria-label="Find an application">
          <h2 className={styles.adminCardTitle} style={{ marginBottom: '14px' }}>
            Find an application
          </h2>
          <ReferenceLookup />
        </section>
      </div>

      {/* Right Column */}
      <div className={styles.adminCol}>
        <section className={styles.adminCard} aria-label="Waiting longest" {...mark('waiting-on-us')}>
          <div className={styles.adminCardHeader}>
            <h2 className={styles.adminCardTitle}>Waiting longest</h2>
            <Link to="/admin/queue" className={styles.viewAllLink}>
              View all
            </Link>
          </div>
          {waiting.length === 0 ? (
            <div className={styles.meetingEmpty}>
              <div className={styles.meetingEmptyIcon}>
                <FileText size={24} aria-hidden="true" />
              </div>
              <p className={styles.meetingEmptyText}>
                Nothing has been submitted yet.
              </p>
            </div>
          ) : (
            <div className={styles.meetingList}>
              {waiting.map((application) => (
                <Link
                  key={application.id}
                  to="/admin/applications/$id"
                  params={{ id: application.id }}
                  className={styles.meetingRow}
                >
                  <FileText className={styles.rowIcon} aria-hidden="true" />
                  <span className={styles.rowText}>
                    <strong>{application.enterpriseName}</strong>
                    <small>
                      {application.referenceNumber} · {application.cycleCode}
                    </small>
                  </span>
                  <span className="badge">{waitingFor(application.submittedAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className={styles.adminCard} aria-label="Quick actions">
          <h2 className={styles.adminCardTitle} style={{ marginBottom: '14px' }}>
            Quick actions
          </h2>
          <div className={styles.quickActionsGrid}>
            <Link to="/admin/queue" className={styles.quickActionTile} data-color="blue">
              <Search className={styles.quickActionIcon} aria-hidden="true" />
              <span className={styles.quickActionLabel}>Find an application</span>
            </Link>
            {can(user, 'programme_cycle', 'create') ? (
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
            {can(user, 'role', 'invite') && can(user, 'user', 'read') ? (
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
      </div>
    </div>
  )
}
