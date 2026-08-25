import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowRight,
  Building2,
  CalendarDays,
  ClipboardList,
  FilePenLine,
} from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { applicantDashboardQuery } from '#/features/dashboard/dashboardQueries'
import { formatDateTime, formatRelative, humanize } from '#/lib/format'
import styles from '#/features/dashboard/Dashboard.module.css'

export const Route = createFileRoute('/_shell/_applicant/dashboard')({
  loader: ({ context }) => context.queryClient.ensureQueryData(applicantDashboardQuery),
  component: ApplicantDashboard,
})

function ApplicantDashboard() {
  const { data } = useQuery(applicantDashboardQuery)
  const applications = data?.applications.pageInfo.totalCount ?? 0
  const enterprises = data?.enterprises.pageInfo.totalCount ?? 0
  const cycles = data?.cycles ?? []
  const revisions = data?.revisions.nodes ?? []
  const drafts = data?.drafts.nodes ?? []
  const attention = [...revisions, ...drafts]
  const firstCycle = cycles[0]
  const firstEnterprise = data?.enterprises.nodes[0]
  const guide = new Map((data?.guide ?? []).map((entry) => [entry.status, entry]))

  const primaryAction = (() => {
    if (enterprises === 0) {
      return { to: '/enterprises/new', label: 'Register an enterprise' } as const
    }
    if (revisions[0]) {
      return {
        to: '/applications/$id/form',
        params: { id: revisions[0].id },
        label: 'Continue requested changes',
      } as const
    }
    if (drafts[0]) {
      return {
        to: '/applications/$id/form',
        params: { id: drafts[0].id },
        label: 'Continue your application',
      } as const
    }
    if (firstCycle && firstEnterprise) {
      return {
        to: '/applications/new',
        search: { cycleId: firstCycle.id, enterpriseId: firstEnterprise.id },
        label: 'Start an application',
      } as const
    }
    return { to: '/applications', label: 'View applications' } as const
  })()

  return (
    <main className="page">
      <PageHeader
        title="Dashboard"
        description="Your Mission SEP applications, programme windows, and next actions in one place."
        actions={
          <Link {...primaryAction} className="button" data-variant="primary">
            {primaryAction.label}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        }
      />

      <div className="stack" style={{ gap: '1rem' }}>
        <section className={styles.metrics} aria-label="Account summary">
          <Link to="/applications" className={styles.metric}>
            <span className={styles.metricTop}>
              Applications <ClipboardList aria-hidden="true" />
            </span>
            <strong className={styles.metricValue}>{applications}</strong>
          </Link>
          <Link to="/enterprises" className={styles.metric}>
            <span className={styles.metricTop}>
              Enterprises <Building2 aria-hidden="true" />
            </span>
            <strong className={styles.metricValue}>{enterprises}</strong>
          </Link>
          <Link to="/cycles" className={styles.metric}>
            <span className={styles.metricTop}>
              Open cycles <CalendarDays aria-hidden="true" />
            </span>
            <strong className={styles.metricValue}>{cycles.length}</strong>
          </Link>
        </section>

        {firstCycle ? (
          <section className={styles.cycleCallout}>
            <div>
              <h2>{firstCycle.displayName} is open</h2>
              <p>
                Applications close {formatDateTime(firstCycle.closesAt)} ·{' '}
                {formatRelative(firstCycle.closesAt)}
              </p>
            </div>
            <Link
              to="/applications/new"
              search={{ cycleId: firstCycle.id }}
              className="button"
              data-variant="primary"
            >
              Apply in this cycle
            </Link>
          </section>
        ) : null}

        {enterprises === 0 || applications === 0 || cycles.length === 0 ? (
          <section className={styles.emptyStates} aria-label="Account readiness">
            {enterprises === 0 ? (
              <div className={styles.emptyState}>
                <Building2 aria-hidden="true" />
                <span>
                  <strong>No enterprises yet</strong>
                  <small>Register an enterprise before starting an application.</small>
                </span>
                <Link to="/enterprises/new">Register enterprise</Link>
              </div>
            ) : null}
            {applications === 0 ? (
              <div className={styles.emptyState}>
                <ClipboardList aria-hidden="true" />
                <span>
                  <strong>No applications yet</strong>
                  <small>Your saved and submitted applications will appear here.</small>
                </span>
                <Link to="/applications/new">Start application</Link>
              </div>
            ) : null}
            {cycles.length === 0 ? (
              <div className={styles.emptyState}>
                <CalendarDays aria-hidden="true" />
                <span>
                  <strong>No open programme cycles</strong>
                  <small>No cycle is accepting applications right now.</small>
                </span>
                <Link to="/cycles">View cycles</Link>
              </div>
            ) : null}
          </section>
        ) : null}

        <div className={styles.dashboardGrid}>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Needs your attention</h2>
              <Link to="/applications">View all</Link>
            </div>
            {attention.length === 0 ? (
              <p className={styles.empty}>
                Nothing needs action right now. New drafts and requested revisions will
                appear here.
              </p>
            ) : (
              <div className={styles.applicationList}>
                {attention.map((application) => {
                  const status = guide.get(application.status)
                  return (
                    <Link
                      key={application.id}
                      to="/applications/$id/form"
                      params={{ id: application.id }}
                      className={styles.applicationRow}
                    >
                      <FilePenLine className={styles.rowIcon} aria-hidden="true" />
                      <span className={styles.rowText}>
                        <strong>{application.businessName}</strong>
                        <small>
                          {application.referenceNumber ??
                            `Phase ${application.phaseNumber}`}
                          {' · '}
                          {status?.nextAction ??
                            status?.label ??
                            humanize(application.status)}
                        </small>
                      </span>
                      <span
                        className="badge"
                        data-tone={
                          application.status === 'REVISION_REQUIRED'
                            ? 'action'
                            : undefined
                        }
                      >
                        {status?.label ?? humanize(application.status)}
                      </span>
                    </Link>
                  )
                })}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Get started</h2>
              <Link to="/guide">Full guide</Link>
            </div>
            <div className={styles.quickActions}>
              <Link to="/enterprises/new" className={styles.quickAction}>
                <Building2 aria-hidden="true" /> Register an enterprise
              </Link>
              <Link to="/applications/new" className={styles.quickAction}>
                <ClipboardList aria-hidden="true" /> Start an application
              </Link>
              <Link to="/cycles" className={styles.quickAction}>
                <CalendarDays aria-hidden="true" /> Check programme cycles
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
