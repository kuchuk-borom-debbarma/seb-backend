import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  CirclePlus,
  FilePenLine,
  FilePlus2,
  FileText,
} from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { applicantDashboardQuery } from '#/features/dashboard/dashboardQueries'
import { correcting, standingLabel } from '#/features/application/journey'
import { formatDateTime, formatRelative, humanize } from '#/lib/format'
import styles from '#/features/dashboard/Dashboard.module.css'

export const Route = createFileRoute('/_shell/_applicant/dashboard')({
  loader: ({ context }) => context.queryClient.ensureQueryData(applicantDashboardQuery),
  component: ApplicantDashboard,
})

function CycleLandscapeArtwork() {
  return (
    <svg
      viewBox="0 0 320 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={styles.cycleHeroArtwork}
      aria-hidden="true"
    >
      {/* Soft circular sun / highlight */}
      <circle cx="260" cy="48" r="16" fill="#93c5fd" fillOpacity="0.4" />

      {/* Background mountains */}
      <path
        d="M100 180 L160 105 L210 135 L270 80 L320 120 L320 180 Z"
        fill="#bfdbfe"
        fillOpacity="0.45"
      />

      {/* Mid-range rolling hills */}
      <path
        d="M140 180 L195 125 L245 145 L320 95 L320 180 Z"
        fill="#93c5fd"
        fillOpacity="0.35"
      />

      {/* Foreground slope */}
      <path
        d="M80 180 Q160 135 250 150 T320 155 L320 180 Z"
        fill="#dbeafe"
        fillOpacity="0.8"
      />

      {/* Torana / Monument Gate Silhouette */}
      <g transform="translate(240, 110) scale(0.65)" opacity="0.38" fill="#3b82f6">
        <path d="M-4 12 Q24 0 52 12 L48 17 Q24 8 0 17 Z" />
        <path d="M0 23 Q24 14 48 23 L45 28 Q24 21 3 28 Z" />
        <rect x="7" y="16" width="6" height="44" rx="1" />
        <rect x="35" y="16" width="6" height="44" rx="1" />
        <rect x="2" y="58" width="44" height="4" rx="1" />
        <rect x="-2" y="62" width="52" height="4" rx="1" />
      </g>
    </svg>
  )
}

function ApplicantDashboard() {
  const { data } = useQuery(applicantDashboardQuery)
  const applications = data?.applications.pageInfo.totalCount ?? 0
  const enterprises = data?.enterprises.pageInfo.totalCount ?? 0
  const cycles = data?.cycles ?? []
  /*
   * What the hero's one button should honestly say. An application already in
   * the cycle makes "Apply" a lie; no enterprise makes it a dead end. The
   * answer comes from the same single dashboard query, not another call.
   */
  const applicationInCycle = (cycleId: string) =>
    data?.applications.nodes.find(
      (application) => application.programmeCycleId === cycleId,
    ) ?? null
  /*
   * Drafts need the applicant; submitted files are listed separately, each
   * saying where it is in the words its pipeline gives the applicant.
   */
  const drafts = data?.drafts.nodes ?? []
  /*
   * A submitted file the office has handed back for corrections is the
   * applicant's move, exactly as a draft is: it belongs under "Needs your
   * attention", not under "Submitted" saying the office is still checking.
   */
  const inPipeline = data?.submitted.nodes ?? []
  const toCorrect = inPipeline.filter(correcting)
  const submitted = inPipeline.filter((application) => !correcting(application))
  const attention = [...toCorrect, ...drafts]
  const firstCycle = cycles[0]
  const firstEnterprise = data?.enterprises.nodes[0]
  const guide = new Map((data?.guide ?? []).map((entry) => [entry.status, entry]))

  const primaryAction = (() => {
    if (enterprises === 0) {
      return { to: '/enterprises/new', label: 'Register an enterprise' } as const
    }
    if (toCorrect[0]) {
      return {
        to: '/applications/$id',
        params: { id: toCorrect[0].id },
        label: 'Make the corrections',
      } as const
    }
    if (drafts[0]) {
      return {
        to: '/applications/$id/form',
        params: { id: drafts[0].id },
        label: 'Continue your application',
      } as const
    }
    const startable = cycles.find((cycle) => applicationInCycle(cycle.id) === null)
    if (startable && firstEnterprise) {
      return {
        to: '/applications/new',
        search: { cycleId: startable.id, enterpriseId: firstEnterprise.id },
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
            <CirclePlus size={15} aria-hidden="true" />
          </Link>
        }
      />

      <div className={styles.dashboard}>
        {/* Middle Section: Active Cycle Hero + Needs Your Attention */}
        <div className={styles.middleGrid}>
          {firstCycle ? (
            <section className={styles.cycleHero} aria-label="Active cycle">
              <CycleLandscapeArtwork />
              <div className={styles.cycleHeroContent}>
                <span className={styles.cycleHeroPill}>
                  {firstCycle.displayName} is open
                </span>
                <p className={styles.cycleHeroDates}>
                  {firstCycle.closesAt ? (
                    <>
                      Applications close {formatDateTime(firstCycle.closesAt)} ·{' '}
                      <span className={styles.cycleHeroRelative}>
                        {formatRelative(firstCycle.closesAt)}
                      </span>
                    </>
                  ) : (
                    'Open until closed by the office.'
                  )}
                </p>
              </div>
              {applicationInCycle(firstCycle.id) ? (
                <Link
                  to="/applications/$id"
                  params={{ id: applicationInCycle(firstCycle.id)!.id }}
                  className={styles.cycleHeroButton}
                >
                  {toCorrect.some((each) => each.id === applicationInCycle(firstCycle.id)!.id)
                    ? 'Make the corrections asked for'
                    : 'View your application'}
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              ) : enterprises > 0 ? (
                <Link
                  to="/applications/new"
                  search={{ cycleId: firstCycle.id }}
                  className={styles.cycleHeroButton}
                >
                  Apply in this cycle
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              ) : (
                /*
                 * An open cycle with no way into it read as a dead end. The
                 * first step is the enterprise, so the card says so and goes
                 * there.
                 */
                <Link to="/enterprises/new" className={styles.cycleHeroButton}>
                  Register your enterprise to apply
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              )}
            </section>
          ) : (
            <section className={styles.cycleHero} aria-label="Active cycle">
              <CycleLandscapeArtwork />
              <div className={styles.cycleHeroContent}>
                <span className={styles.cycleHeroPill}>No open cycle</span>
                <p className={styles.cycleHeroDates}>
                  No application windows are currently accepting submissions.
                </p>
              </div>
              <Link to="/cycles" className={styles.cycleHeroButton}>
                View programme cycles
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </section>
          )}

          <section className={styles.attentionCard} aria-label="Needs your attention">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Needs your attention</h2>
              <Link to="/applications" className={styles.cardLink}>
                View all
              </Link>
            </div>
            {attention.length === 0 && enterprises === 0 ? (
              /*
               * With no enterprise there is exactly one thing to do, and
               * "Nothing needs action" said the opposite.
               */
              <div className={styles.applicationList}>
                <Link to="/enterprises/new" className={styles.applicationRow}>
                  <Building2 className={styles.rowIcon} aria-hidden="true" />
                  <span className={styles.rowText}>
                    <strong>Register your enterprise</strong>
                    <small>
                      An application is made for an enterprise, so this comes first.
                    </small>
                  </span>
                  <span className="badge" data-tone="action">
                    First step
                  </span>
                </Link>
              </div>
            ) : attention.length === 0 ? (
              <div className={styles.attentionEmpty}>
                <div className={styles.checkBadge}>
                  <Check size={22} aria-hidden="true" />
                </div>
                <p className={styles.attentionEmptyText}>
                  Nothing needs action right now.
                </p>
                <p className={styles.attentionEmptySubtext}>
                  New drafts and requested revisions will appear here.
                </p>
              </div>
            ) : (
              <div className={styles.applicationList}>
                {attention.map((application) => {
                  const status = guide.get(application.status)
                  const asked = correcting(application)
                  return (
                    <Link
                      key={application.id}
                      // A correction opens the application's page first, where
                      // the office's notes say what to change in each section.
                      to={asked ? '/applications/$id' : '/applications/$id/form'}
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
                          {asked
                            ? 'The office asked for corrections. Make them and submit again.'
                            : (status?.nextAction ??
                              status?.label ??
                              humanize(application.status))}
                        </small>
                      </span>
                      <span className="badge" data-tone="action">
                        {asked
                          ? standingLabel(application)
                          : (status?.label ?? humanize(application.status))}
                      </span>
                    </Link>
                  )
                })}
              </div>
            )}
          </section>

          {submitted.length > 0 ? (
            <section className={styles.attentionCard} aria-label="Submitted applications">
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Submitted</h2>
                <Link to="/applications" className={styles.cardLink}>
                  View all
                </Link>
              </div>
              <div className={styles.applicationList}>
                {submitted.map((application) => (
                  <Link
                    key={application.id}
                    to="/applications/$id"
                    params={{ id: application.id }}
                    className={styles.applicationRow}
                  >
                    <FileText className={styles.rowIcon} aria-hidden="true" />
                    <span className={styles.rowText}>
                      <strong>{application.businessName}</strong>
                      <small>
                        {application.referenceNumber}
                        {application.journey?.stageExplanation
                          ? ` · ${application.journey.stageExplanation}`
                          : ''}
                      </small>
                    </span>
                    <span
                      className="badge"
                      data-tone={application.journey?.ended ? 'ok' : undefined}
                    >
                      {standingLabel(application)}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* Readiness Checklist Banners for Empty Data */}
        {enterprises === 0 || applications === 0 || cycles.length === 0 ? (
          <section className={styles.emptyStatesCard} aria-label="Account readiness">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Account readiness</h2>
            </div>
            <div className={styles.emptyStatesList}>
              {enterprises === 0 ? (
                <div className={styles.emptyStateItem}>
                  <div className={styles.emptyStateLeft}>
                    <div className={styles.emptyStateIconBadge} data-color="green">
                      <Building2 aria-hidden="true" />
                    </div>
                    <div className={styles.emptyStateText}>
                      <strong>No enterprises yet</strong>
                      <small>
                        Register an enterprise before starting an application.
                      </small>
                    </div>
                  </div>
                  <Link to="/enterprises/new" className={styles.emptyStateAction}>
                    Register enterprise
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>
                </div>
              ) : null}
              {applications === 0 ? (
                <div className={styles.emptyStateItem}>
                  <div className={styles.emptyStateLeft}>
                    <div className={styles.emptyStateIconBadge} data-color="blue">
                      <FileText aria-hidden="true" />
                    </div>
                    <div className={styles.emptyStateText}>
                      <strong>No applications yet</strong>
                      <small>
                        Your saved and submitted applications will appear here.
                      </small>
                    </div>
                  </div>
                  {enterprises > 0 ? (
                    <Link to="/applications/new" className={styles.emptyStateAction}>
                      Start application
                      <ChevronRight size={15} aria-hidden="true" />
                    </Link>
                  ) : (
                    // Offered only once it can work: an application needs
                    // an enterprise, and a button into a refusal is worse
                    // than saying what comes first.
                    <span className={styles.emptyStateHint}>After your enterprise</span>
                  )}
                </div>
              ) : null}
              {cycles.length === 0 ? (
                <div className={styles.emptyStateItem}>
                  <div className={styles.emptyStateLeft}>
                    <div className={styles.emptyStateIconBadge} data-color="purple">
                      <CalendarDays aria-hidden="true" />
                    </div>
                    <div className={styles.emptyStateText}>
                      <strong>No open programme cycles</strong>
                      <small>No cycle is accepting applications right now.</small>
                    </div>
                  </div>
                  <Link to="/cycles" className={styles.emptyStateAction}>
                    View cycles
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* Bottom Section: Get Started Action Grid — only once set up, since
            until then the readiness list above offers the same steps. */}
        {enterprises > 0 && applications > 0 ? (
          <section className={styles.getStartedCard} aria-label="Get started">
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Get started</h2>
              <Link to="/guide" className={styles.cardLink}>
                Full guide <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
            <div className={styles.getStartedGrid}>
              <Link to="/enterprises/new" className={styles.getStartedItem}>
                <div className={styles.getStartedItemLeft}>
                  <div className={styles.getStartedIconBadge} data-color="blue">
                    <Building2 aria-hidden="true" />
                  </div>
                  <span className={styles.getStartedLabel}>Register an enterprise</span>
                </div>
                <ChevronRight
                  className={styles.getStartedChevron}
                  size={16}
                  aria-hidden="true"
                />
              </Link>
              {cycles.some((cycle) => applicationInCycle(cycle.id) === null) &&
              enterprises > 0 ? (
                <Link to="/applications/new" className={styles.getStartedItem}>
                  <div className={styles.getStartedItemLeft}>
                    <div className={styles.getStartedIconBadge} data-color="green">
                      <FilePlus2 aria-hidden="true" />
                    </div>
                    <span className={styles.getStartedLabel}>Start an application</span>
                  </div>
                  <ChevronRight
                    className={styles.getStartedChevron}
                    size={16}
                    aria-hidden="true"
                  />
                </Link>
              ) : null}
              <Link to="/cycles" className={styles.getStartedItem}>
                <div className={styles.getStartedItemLeft}>
                  <div className={styles.getStartedIconBadge} data-color="purple">
                    <CalendarDays aria-hidden="true" />
                  </div>
                  <span className={styles.getStartedLabel}>Check programme cycles</span>
                </div>
                <ChevronRight
                  className={styles.getStartedChevron}
                  size={16}
                  aria-hidden="true"
                />
              </Link>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  )
}
