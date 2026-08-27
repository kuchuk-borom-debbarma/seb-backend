import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Calendar,
  CirclePlus,
  ExternalLink,
  FileText,
} from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { applicantDashboardQuery } from '#/features/dashboard/dashboardQueries'
import { cyclesQuery } from '#/features/application/queries'
import { formatDate, formatRelative, humanize } from '#/lib/format'
import styles from '#/features/application/Cycles.module.css'

export const Route = createFileRoute('/_shell/_applicant/cycles')({
  loader: ({ context }) => context.queryClient.ensureQueryData(cyclesQuery),
  component: CyclesPage,
})

function CycleIllustration() {
  return (
    <div className={styles.artworkContainer} aria-hidden="true">
      <svg
        viewBox="0 0 380 240"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={styles.artworkSvg}
      >
        {/* Soft Sun */}
        <circle cx="254" cy="92" r="16" fill="#fef08a" fillOpacity="0.75" />

        {/* Distant Mountains */}
        <path
          d="M0 160 L60 110 L130 145 L200 95 L270 135 L340 85 L380 115 L380 240 L0 240 Z"
          fill="#dbeafe"
          fillOpacity="0.6"
        />
        <path
          d="M40 170 L110 120 L180 155 L250 105 L330 150 L380 120 L380 240 L40 240 Z"
          fill="#bfdbfe"
          fillOpacity="0.45"
        />

        {/* Soft Ground Slope */}
        <path
          d="M0 155 Q190 140 380 155 L380 240 L0 240 Z"
          fill="#dcfce7"
          fillOpacity="0.8"
        />

        {/* Background Foliage Trees on Right */}
        <g opacity="0.85">
          <circle cx="348" cy="132" r="16" fill="#86efac" />
          <rect x="346" y="142" width="4" height="20" rx="2" fill="#65a30d" />
          <ellipse cx="334" cy="142" rx="10" ry="14" fill="#4ade80" />
          <rect x="332" y="150" width="4" height="15" rx="2" fill="#65a30d" />
          <ellipse cx="358" cy="148" rx="12" ry="10" fill="#22c55e" />
        </g>

        {/* Potted Plant on Left */}
        <g transform="translate(18, 110)">
          {/* Stem & Leaves */}
          <path d="M50 48 Q40 30 32 32 Q36 44 48 50 Z" fill="#86efac" />
          <path d="M52 45 Q62 25 70 28 Q64 42 54 48 Z" fill="#4ade80" />
          <path d="M51 38 Q50 14 58 14 Q60 30 52 42 Z" fill="#22c55e" />
          <path
            d="M50 40 L50 60"
            stroke="#16a34a"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          {/* Pot */}
          <path d="M38 56 L62 56 L58 72 L42 72 Z" fill="#93c5fd" fillOpacity="0.75" />
          <rect x="36" y="53" width="28" height="4" rx="2" fill="#60a5fa" />
        </g>

        {/* Desktop Flip Calendar in Center/Right */}
        <g transform="translate(110, 80)">
          {/* Calendar Stand Shadow & Backing */}
          <polygon points="148,46 172,108 152,108 132,46" fill="#1e293b" opacity="0.85" />

          {/* Calendar Body */}
          <rect x="8" y="18" width="132" height="90" rx="8" fill="#1e293b" />

          {/* Calendar Page (White) */}
          <rect
            x="14"
            y="30"
            width="120"
            height="74"
            rx="4"
            fill="#ffffff"
            filter="drop-shadow(0 2px 4px rgba(0,0,0,0.08))"
          />

          {/* Binder Rings */}
          {[28, 48, 68, 88, 108, 120].map((rx, idx) => (
            <g key={idx}>
              <rect x={rx} y="13" width="5" height="12" rx="2.5" fill="#334155" />
              <rect x={rx + 1} y="14" width="3" height="10" rx="1.5" fill="#94a3b8" />
            </g>
          ))}

          {/* Calendar Grid Boxes */}
          <g fill="#f1f5f9">
            {/* Row 1 */}
            <rect x="22" y="38" width="10" height="8" rx="2" />
            <rect x="36" y="38" width="10" height="8" rx="2" />
            <rect x="50" y="38" width="10" height="8" rx="2" />
            <rect x="64" y="38" width="10" height="8" rx="2" />
            <rect x="78" y="38" width="10" height="8" rx="2" fill="#e2e8f0" />
            <rect x="92" y="38" width="10" height="8" rx="2" />
            <rect x="106" y="38" width="10" height="8" rx="2" />

            {/* Row 2 */}
            <rect x="22" y="50" width="10" height="8" rx="2" />
            <rect x="36" y="50" width="10" height="8" rx="2" />
            <rect x="50" y="50" width="10" height="8" rx="2" />
            <rect x="64" y="50" width="10" height="8" rx="2" />
            <rect x="78" y="50" width="10" height="8" rx="2" />
            <rect x="92" y="50" width="10" height="8" rx="2" />
            <rect x="106" y="50" width="10" height="8" rx="2" />

            {/* Row 3 */}
            <rect x="22" y="62" width="10" height="8" rx="2" />
            <rect x="36" y="62" width="10" height="8" rx="2" />
            <rect x="50" y="62" width="10" height="8" rx="2" fill="#e2e8f0" />
            <rect x="64" y="62" width="10" height="8" rx="2" />
            <rect x="78" y="62" width="10" height="8" rx="2" />
            <rect x="92" y="62" width="10" height="8" rx="2" />
            <rect x="106" y="62" width="10" height="8" rx="2" />

            {/* Row 4 */}
            <rect x="22" y="74" width="10" height="8" rx="2" />
            <rect x="36" y="74" width="10" height="8" rx="2" />
            <rect x="50" y="74" width="10" height="8" rx="2" />
            <rect x="64" y="74" width="10" height="8" rx="2" />
            <rect x="78" y="74" width="10" height="8" rx="2" />
            <rect x="92" y="74" width="10" height="8" rx="2" />
          </g>

          {/* Active Checked Date */}
          <g transform="translate(80, 60)">
            <circle
              cx="7"
              cy="6"
              r="6.5"
              fill="#ffffff"
              stroke="#1e293b"
              strokeWidth="1.5"
            />
            <path
              d="M4.5 6 L6.5 8 L9.5 4.5"
              stroke="#1e293b"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </g>
      </svg>
    </div>
  )
}

function CyclesPage() {
  const { data } = useQuery(cyclesQuery)
  /*
   * Same single dashboard query the dashboard itself uses — shared cache, so
   * navigating here usually costs no request — read for what the one honest
   * button per cycle is: already applied, able to apply, or nothing.
   */
  const { data: mine } = useQuery(applicantDashboardQuery)
  const applicationInCycle = (cycleId: string) =>
    mine?.applications.nodes.find(
      (application) => application.programmeCycleId === cycleId,
    ) ?? null
  const holdsEnterprise = (mine?.enterprises.pageInfo.totalCount ?? 0) > 0
  const available = data?.available ?? []
  const openIds = new Set(available.map((cycle) => cycle.id))
  // History is everything with work in it that is not currently startable, so
  // a closed cycle appears here and never carries a "start" action.
  const history = (data?.mine ?? []).filter((cycle) => !openIds.has(cycle.id))
  // Which cycle's guidance is unfolded, so two open cycles toggle separately.
  const [guidanceFor, setGuidanceFor] = useState<string | null>(null)

  return (
    <main className="page">
      <PageHeader
        title="Programme cycles"
        description="A cycle is a named application window, such as Mission SEP 2026. It sets the rules an application is judged by."
        actions={
          <Link to="/enterprises/new" className="button" data-variant="primary">
            <CirclePlus size={15} aria-hidden="true" />
            Register an enterprise
          </Link>
        }
      />

      <div className={styles.pageContainer}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Open for new applications</h2>

          {available.length === 0 ? (
            <div className={styles.emptyCard}>
              <h3 className={styles.emptyTitle}>No cycle is open</h3>
              <p className={styles.emptyText}>
                New applications can be started when the programme office opens the next
                cycle.
              </p>
            </div>
          ) : (
            available.map((cycle) => (
              <div className={styles.cycleCard} key={cycle.id}>
                {/* Left Content Column */}
                <div className={styles.cycleLeft}>
                  <span className={styles.pillTag}>{cycle.cycleCode}</span>
                  <h3 className={styles.cycleTitle}>{cycle.displayName}</h3>

                  {applicationInCycle(cycle.id) ? (
                    <Link
                      to="/applications/$id"
                      params={{ id: applicationInCycle(cycle.id)!.id }}
                      className={styles.applyBtn}
                    >
                      View your application
                      <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                  ) : holdsEnterprise ? (
                    <Link
                      to="/applications/new"
                      search={{ cycleId: cycle.id }}
                      className={styles.applyBtn}
                    >
                      Apply in this cycle
                      <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                  ) : null}

                  <div className={styles.infoList}>
                    <div className={styles.infoRow}>
                      <div className={styles.infoRowLeft}>
                        <div className={styles.infoIconBadge} data-color="green">
                          <Calendar aria-hidden="true" />
                        </div>
                        <span className={styles.infoLabel}>Applications close</span>
                      </div>
                      <span className={styles.infoValue}>
                        {cycle.closesAt ? (
                          <>
                            {formatDate(cycle.closesAt)}{' '}
                            <span className={styles.relativeTime}>
                              ({formatRelative(cycle.closesAt)})
                            </span>
                          </>
                        ) : (
                          'No closing date set'
                        )}
                      </span>
                    </div>

                    <div className={styles.infoRow}>
                      <div className={styles.infoRowLeft}>
                        <div className={styles.infoIconBadge} data-color="purple">
                          <FileText aria-hidden="true" />
                        </div>
                        <span className={styles.infoLabel}>Policy reference</span>
                      </div>
                      <span className={styles.infoValue}>
                        {cycle.policyReference ?? '—'}
                      </span>
                    </div>

                    <div className={styles.infoRow}>
                      <div className={styles.infoRowLeft}>
                        <div className={styles.infoIconBadge} data-color="blue">
                          <BarChart3 aria-hidden="true" />
                        </div>
                        <span className={styles.infoLabel}>Programme year</span>
                      </div>
                      <span className={styles.infoValue}>{cycle.cycleYear}</span>
                    </div>

                    <div className={styles.infoRow}>
                      <div className={styles.infoRowLeft}>
                        <div className={styles.infoIconBadge} data-color="amber">
                          <BookOpen aria-hidden="true" />
                        </div>
                        <span className={styles.infoLabel}>Guidance for this cycle</span>
                      </div>
                      <span className={styles.infoValue}>
                        {cycle.applicantGuidance ? (
                          <button
                            type="button"
                            className={styles.guidanceLink}
                            onClick={() =>
                              setGuidanceFor(
                                guidanceFor === cycle.id ? null : cycle.id,
                              )
                            }
                          >
                            {guidanceFor === cycle.id
                              ? 'Hide guidance'
                              : 'View guidance'}
                            <ExternalLink size={13} aria-hidden="true" />
                          </button>
                        ) : (
                          '—'
                        )}
                      </span>
                    </div>
                  </div>

                  {guidanceFor === cycle.id && cycle.applicantGuidance ? (
                    <div
                      className="notice"
                      data-tone="action"
                      style={{ marginTop: '16px' }}
                    >
                      <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5 }}>
                        {cycle.applicantGuidance}
                      </p>
                    </div>
                  ) : null}
                </div>

                {/* Right Illustration Column */}
                <CycleIllustration />
              </div>
            ))
          )}
        </section>

        {/* Past Cycles History */}
        {history.length > 0 ? (
          <section className={styles.section} style={{ marginTop: '12px' }}>
            <h2 className={styles.sectionTitle}>Cycles you have applied in</h2>
            <div className={styles.historyCard}>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="visually-hidden">Past programme cycles</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={styles.th}>
                        Cycle
                      </th>
                      <th scope="col" className={styles.th}>
                        Year
                      </th>
                      <th scope="col" className={styles.th}>
                        State
                      </th>
                      <th scope="col" className={styles.th}>
                        Closed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((cycle) => (
                      <tr key={cycle.id} className={styles.tr}>
                        <td className={styles.td}>
                          <strong>{cycle.displayName}</strong>
                          <span style={{ color: '#6b7280', marginLeft: '6px' }}>
                            · {cycle.cycleCode}
                          </span>
                        </td>
                        <td className={styles.td}>{cycle.cycleYear}</td>
                        <td className={styles.td}>
                          <span className="badge">{humanize(cycle.status)}</span>
                        </td>
                        <td className={styles.td}>{formatDate(cycle.closesAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  )
}
