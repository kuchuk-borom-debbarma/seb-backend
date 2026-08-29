import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Award,
  Calendar,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Coins,
  FileCheck,
  FilePenLine,
  FileText,
  Landmark,
  Layers,
  Lock,
  Megaphone,
  Paperclip,
  PlayCircle,
  Scale,
  Search,
  Sprout,
} from 'lucide-react'
import { stageTitle } from '#/features/application/draft'
import { cyclesQuery, statusGuideQuery } from '#/features/application/queries'
import {
  applicationQuery,
  formTemplateQuery,
  timelineQuery,
} from '#/features/application/applicationQueries'
import type {
  ApplicationCategory,
  ApplicationStatus,
} from '#/graphql/generated/schema'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import styles from '#/features/application/ApplicationDetails.module.css'

/*
 * The overview is the index route beneath `$id`, not `$id` itself.
 *
 * In flat file routing a `$id.tsx` alongside `$id.form.tsx` becomes a layout
 * wrapping the form, so the overview would have had to render an outlet and
 * would have shown above every child screen. Naming it `.index` makes it a
 * sibling instead, which is what it actually is.
 */
/** The statuses in which a sanction order can exist. */
const FUNDED_STATUSES = new Set<string>(['SANCTIONED', 'DISBURSED'])

/** Stamped by the server at submission; shown here, never chosen. */
const CATEGORY_LABELS: Record<ApplicationCategory, string> = {
  CATEGORY_A: 'Category A',
  CATEGORY_B: 'Category B',
}

/** The happy-path stages of the pipeline, in workflow order. */
const PIPELINE_STAGES: Array<{
  status: ApplicationStatus
  number: number
  label: string
  description: string
  icon: typeof FileText
}> = [
  {
    status: 'DRAFT',
    number: 1,
    label: 'Draft',
    description: 'Application being drafted by applicant.',
    icon: FilePenLine,
  },
  {
    status: 'SUBMITTED',
    number: 2,
    label: 'Submitted',
    description: 'Application received by the programme office.',
    icon: FileText,
  },
  {
    status: 'DESK_REVIEW',
    number: 3,
    label: 'Desk review',
    description: 'Initial review by the programme team.',
    icon: Search,
  },
  {
    status: 'PARTNER_BANK_EVALUATION',
    number: 4,
    label: 'Bank',
    description: 'Sent to a partner bank for appraisal.',
    icon: Landmark,
  },
  {
    status: 'AWAITING_DECISION',
    number: 5,
    label: 'Decision',
    description: 'Awaiting the programme’s funding decision.',
    icon: Scale,
  },
  {
    status: 'APPROVED',
    number: 6,
    label: 'Approved',
    description: 'Funding award approved.',
    icon: CheckCircle2,
  },
  {
    status: 'SANCTIONED',
    number: 7,
    label: 'Sanctioned',
    description: 'Funds sanctioned.',
    icon: FileCheck,
  },
  {
    status: 'DISBURSED',
    number: 8,
    label: 'Funds released',
    description: 'Support disbursed to your enterprise.',
    icon: Coins,
  },
]

export const Route = createFileRoute('/_shell/_applicant/applications/$id/')({
  // All of these start together: one round of requests, no waterfall.
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(timelineQuery(params.id)),
      context.queryClient.ensureQueryData(statusGuideQuery),
      context.queryClient.ensureQueryData(cyclesQuery),
    ])
  },
  component: ApplicationPage,
})

function HeroBannerArtwork() {
  return (
    <div className={styles.heroArtwork} aria-hidden="true">
      <svg
        viewBox="0 0 320 130"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={styles.heroSvg}
      >
        <path
          d="M0 100 Q80 70 160 95 T320 85 L320 130 L0 130 Z"
          fill="#dbeafe"
          fillOpacity="0.5"
        />
        <path
          d="M40 105 Q140 85 240 100 T320 95 L320 130 L40 130 Z"
          fill="#bfdbfe"
          fillOpacity="0.35"
        />
        <g transform="translate(15, 25)">
          <rect
            x="0"
            y="20"
            width="76"
            height="52"
            rx="6"
            fill="#f59e0b"
            fillOpacity="0.9"
          />
          <rect
            x="8"
            y="4"
            width="60"
            height="42"
            rx="4"
            fill="#ffffff"
            filter="drop-shadow(0 2px 4px rgba(0,0,0,0.06))"
          />
          <line
            x1="16"
            y1="14"
            x2="48"
            y2="14"
            stroke="#2563eb"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <line
            x1="16"
            y1="22"
            x2="56"
            y2="22"
            stroke="#93c5fd"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="16"
            y1="28"
            x2="44"
            y2="28"
            stroke="#93c5fd"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <polygon points="0,72 38,44 76,72" fill="#fbbf24" />
          <polygon points="0,20 38,48 0,72" fill="#f59e0b" />
          <polygon points="76,20 38,48 76,72" fill="#d97706" />
          <circle cx="38" cy="46" r="11" fill="#16a34a" />
          <path
            d="M33 46 L36.5 49.5 L43 43"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        <g transform="translate(195, 20)">
          <polygon points="95,25 110,85 96,85 82,25" fill="#1e293b" opacity="0.8" />
          <rect x="0" y="8" width="94" height="74" rx="6" fill="#1e293b" />
          <rect x="4" y="16" width="86" height="62" rx="4" fill="#ffffff" />
          {[14, 28, 42, 56, 70, 80].map((rx, idx) => (
            <rect key={idx} x={rx} y="5" width="4" height="8" rx="2" fill="#64748b" />
          ))}
          <g fill="#f1f5f9">
            <rect x="10" y="24" width="8" height="6" rx="1.5" />
            <rect x="22" y="24" width="8" height="6" rx="1.5" />
            <rect x="34" y="24" width="8" height="6" rx="1.5" />
            <rect x="46" y="24" width="8" height="6" rx="1.5" />
            <rect x="58" y="24" width="8" height="6" rx="1.5" fill="#e2e8f0" />
            <rect x="70" y="24" width="8" height="6" rx="1.5" />
            <rect x="10" y="34" width="8" height="6" rx="1.5" />
            <rect x="22" y="34" width="8" height="6" rx="1.5" />
            <rect x="34" y="34" width="8" height="6" rx="1.5" />
            <rect x="46" y="34" width="8" height="6" rx="1.5" />
            <rect x="58" y="34" width="8" height="6" rx="1.5" />
            <rect x="70" y="34" width="8" height="6" rx="1.5" />
            <rect x="10" y="44" width="8" height="6" rx="1.5" />
            <rect x="22" y="44" width="8" height="6" rx="1.5" />
            <rect x="34" y="44" width="8" height="6" rx="1.5" fill="#e2e8f0" />
            <rect x="46" y="44" width="8" height="6" rx="1.5" />
            <rect x="58" y="44" width="8" height="6" rx="1.5" />
            <rect x="70" y="44" width="8" height="6" rx="1.5" />
          </g>
          <g transform="translate(48, 40)">
            <circle
              cx="6"
              cy="6"
              r="5.5"
              fill="#ffffff"
              stroke="#1e293b"
              strokeWidth="1.2"
            />
            <path
              d="M4 6 L5.5 7.5 L8 4.5"
              stroke="#1e293b"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </g>
        <g opacity="0.85" transform="translate(285, 45)">
          <ellipse cx="14" cy="24" rx="10" ry="14" fill="#86efac" />
          <rect x="12" y="34" width="4" height="20" rx="2" fill="#16a34a" />
          <ellipse cx="24" cy="30" rx="8" ry="12" fill="#4ade80" />
        </g>
      </svg>
    </div>
  )
}

function ApplicationPage() {
  const { id } = Route.useParams()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: timeline } = useQuery(timelineQuery(id))
  const { data: guide } = useQuery(statusGuideQuery)
  const { data: cycles } = useQuery(cyclesQuery)
  const { data: template } = useQuery(formTemplateQuery(id))

  if (!application || !guide) return null

  const openRevisions = application.revisionRequests.filter(
    (request) => request.resolvedAt === null && request.cancelledAt === null,
  )

  /*
   * An award exists only once the application has been sanctioned, and it
   * survives everything after that. Before then the funding screen would have
   * nothing to say, so it is not offered.
   */
  const funded = FUNDED_STATUSES.has(application.status)

  /*
   * Named from the template where it is to hand, so an applicant reads the
   * cycle's own heading rather than a key. The list itself is the API's: it
   * derives it from the same rule the draft-save path enforces, so it can never
   * invite an edit the write would refuse.
   */
  const editableStages = application.editableStageKeys

  const guideEntry = guide.find((entry) => entry.status === application.status)
  const cycleInfo = cycles?.mine.find(
    (cycle) => cycle.id === application.programmeCycleId,
  )

  // Revision required means the application is back on the reviewer's desk
  // once corrected, so the rail holds at desk review. Rejected and cancelled
  // applications match no pipeline stage; the hero carries the outcome.
  const railStatus =
    application.status === 'REVISION_REQUIRED' ? 'DESK_REVIEW' : application.status
  const reachedIndex = PIPELINE_STAGES.findIndex(
    (stage) => stage.status === railStatus,
  )
  const onTrack = reachedIndex >= 0 && application.status !== 'REVISION_REQUIRED'

  return (
    <main className="page">
      <div className={styles.pageContainer}>
        <div className={styles.topNav}>
          <Link to="/applications" className={styles.backLink}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to applications
          </Link>
          {cycleInfo ? (
            <div className={styles.cycleBadge}>
              <Calendar size={14} aria-hidden="true" />
              {cycleInfo.displayName}
            </div>
          ) : null}
        </div>

        <div className={styles.headerRow}>
          <div className={styles.titleGroup}>
            <h1 className={styles.appTitle}>
              {application.referenceNumber ?? 'Unsubmitted draft'}
            </h1>
            <span className={styles.typeBadge}>
              <Sprout size={13} aria-hidden="true" />
              {application.applicationType === 'EXPANSION'
                ? `Expansion application, phase ${application.phaseNumber}`
                : 'Initial application'}
            </span>
          </div>

          <div className={styles.headerActions}>
            {/* Offered only while something can actually be changed or sent.
                Money is separate: it outlives editing, and appears the moment
                a sanction order can exist. */}
            {funded ? (
              <Link
                to="/applications/$id/funding"
                params={{ id }}
                className={styles.primaryCta}
              >
                <Award size={15} aria-hidden="true" />
                Funding
              </Link>
            ) : editableStages.length > 0 ? (
              <>
                {application.firstSubmittedAt ? (
                  <Link
                    to="/applications/$id/submitted"
                    params={{ id }}
                    className="button"
                  >
                    View submitted application
                  </Link>
                ) : null}
                <Link
                  to="/applications/$id/documents"
                  params={{ id }}
                  className="button"
                >
                  Evidence
                </Link>
                <Link to="/applications/$id/review" params={{ id }} className="button">
                  Check and submit
                </Link>
                <Link
                  to="/applications/$id/form"
                  params={{ id }}
                  className={styles.primaryCta}
                >
                  {application.status === 'REVISION_REQUIRED'
                    ? 'Make the corrections'
                    : 'Fill in the form'}
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </>
            ) : application.firstSubmittedAt ? (
              /*
               * Read-only after submission is not invisible: the copy the
               * office sees stays one obvious click away, with the documents
               * beside it — not hidden behind a document icon.
               */
              <Link
                to="/applications/$id/submitted"
                params={{ id }}
                className={styles.primaryCta}
              >
                View submitted application
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </div>

        <section
          className={styles.stepperCard}
          aria-label="Application progress pipeline"
        >
          <div className={styles.stepperTrack}>
            {PIPELINE_STAGES.map((stage, index) => {
              const isDone = reachedIndex >= 0 && index < reachedIndex
              const isCurrent = index === reachedIndex

              return (
                <div key={stage.status} style={{ display: 'contents' }}>
                  <div className={styles.stepNodeWrap}>
                    <div
                      className={`${styles.stepCircle} ${
                        isDone
                          ? styles.stepCircleDone
                          : isCurrent
                            ? styles.stepCircleCurrent
                            : styles.stepCircleAhead
                      }`}
                    >
                      {isDone ? <Check size={14} strokeWidth={2.5} /> : stage.number}
                    </div>
                    <span
                      className={`${styles.stepLabel} ${
                        isCurrent
                          ? styles.stepLabelCurrent
                          : isDone
                            ? styles.stepLabelDone
                            : ''
                      }`}
                    >
                      {stage.label}
                    </span>
                  </div>

                  {index < PIPELINE_STAGES.length - 1 && (
                    <div
                      className={`${styles.stepConnector} ${
                        index < reachedIndex ? styles.stepConnectorDone : ''
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <section className={styles.heroBanner} aria-label="Current application status">
          <div className={styles.heroLeft}>
            <div className={styles.heroBadges}>
              <span className={styles.statusBadge}>
                {guideEntry?.label ?? humanize(application.status)}
              </span>
              <span className={styles.actorBadge}>
                <Landmark size={13} aria-hidden="true" />
                {guideEntry?.nextActor === 'APPLICANT'
                  ? 'Your turn'
                  : guideEntry?.nextActor === 'PROGRAMME_OFFICE'
                    ? 'With the programme office'
                    : 'No further action'}
              </span>
            </div>
            <h2 className={styles.heroTitle}>
              {guideEntry?.explanation ??
                'Your application has been received and is progressing through the review stages.'}
            </h2>
          </div>
          <HeroBannerArtwork />
        </section>

        {/*
          While revision is required, the requests are the most important thing
          on the page: they are the exact work the applicant has to do.
        */}
        {openRevisions.length > 0 ? (
          <div className="card">
            <div className="card-header">
              <p className="eyebrow">Changes requested</p>
            </div>
            <div className="card-body stack">
              {openRevisions.map((request) => (
                <div key={request.id} className="notice" data-tone="action">
                  <span className="notice-title">
                    {stageTitle(request.stageKey, template?.stages)}
                  </span>
                  {request.note}
                  <p
                    className="muted"
                    style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}
                  >
                    Requested {formatDateTime(request.requestedAt)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.mainGrid}>
          <div className={styles.leftColumn}>
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                  <ClipboardList className={styles.cardIcon} aria-hidden="true" />
                  <h3 className={styles.cardTitle}>Application</h3>
                </div>
                {onTrack ? (
                  <span className={styles.onTrackPill}>
                    <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                    On track
                  </span>
                ) : null}
              </div>

              <div className={styles.detailList}>
                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <FileText aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>Reference number</span>
                  </div>
                  <span className={styles.detailValue}>
                    {application.referenceNumber ?? (
                      // Set apart from a real reference: this is what will
                      // happen, not a value anyone can quote.
                      <span className="muted">Issued at first submission</span>
                    )}
                  </span>
                </div>

                {/* Absent until a submission on a sorting cycle stamps it, so
                    a draft never shows a category it does not have yet. */}
                {application.snapshot.applicationCategory ? (
                  <div className={styles.detailRow}>
                    <div className={styles.detailRowLeft}>
                      <div className={styles.detailIconBadge}>
                        <Layers aria-hidden="true" />
                      </div>
                      <span className={styles.detailLabel}>Funding category</span>
                    </div>
                    <span className={styles.detailValue}>
                      {CATEGORY_LABELS[application.snapshot.applicationCategory]}
                    </span>
                  </div>
                ) : null}

                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <Calendar aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>First submitted</span>
                  </div>
                  <span className={styles.detailValue}>
                    {application.firstSubmittedAt
                      ? formatDate(application.firstSubmittedAt)
                      : '—'}
                  </span>
                </div>

                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <PlayCircle aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>Started</span>
                  </div>
                  <span className={styles.detailValue}>
                    {formatDate(application.createdAt)}
                  </span>
                </div>

                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <Clock aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>Last changed</span>
                  </div>
                  <span className={styles.detailValue}>
                    {formatDateTime(application.updatedAt)}
                  </span>
                </div>

                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <Lock aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>Stages you can edit</span>
                  </div>
                  <span className={styles.detailValue}>
                    {editableStages.length === 0
                      ? 'None — this application is read-only'
                      : editableStages
                          .map((stageKey) => stageTitle(stageKey, template?.stages))
                          .join(', ')}
                  </span>
                </div>

                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <Paperclip aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>Documents attached</span>
                  </div>
                  <Link
                    to="/applications/$id/documents"
                    params={{ id }}
                    className={styles.docsPill}
                  >
                    <FileText size={13} aria-hidden="true" />
                    {application.documents.filter((document) => !document.deletedAt)
                      .length}
                  </Link>
                </div>
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardTitleGroup}>
                  <Clock className={styles.cardIcon} aria-hidden="true" />
                  <h3 className={styles.cardTitle}>History</h3>
                </div>
              </div>
              {timeline && timeline.length > 0 ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <caption className="visually-hidden">Application history</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={styles.th}>
                          When
                        </th>
                        <th scope="col" className={styles.th}>
                          What happened
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.map((event) => (
                        <tr key={event.id} className={styles.tr}>
                          <td className={styles.td} style={{ whiteSpace: 'nowrap' }}>
                            {formatDateTime(event.createdAt)}
                          </td>
                          <td className={styles.td}>
                            <span style={{ fontWeight: 500 }}>
                              {humanize(event.eventType)}
                            </span>
                            {event.message ? (
                              <p className="muted" style={{ marginTop: '0.25rem' }}>
                                {event.message}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">
                  <p>
                    Nothing has happened yet. Events appear here as your application
                    moves.
                  </p>
                </div>
              )}
            </div>

            <div className={styles.statusNotice}>
              <div className={styles.noticeIconBadge}>
                <Sprout size={16} aria-hidden="true" />
              </div>
              <p className={styles.noticeText}>
                We&apos;ll keep you updated as your application moves to the next stage.
                You can check this page anytime for the latest status.
              </p>
            </div>
          </div>

          <div className={styles.rightColumn}>
            <div className={styles.timelineCard}>
              <div className={styles.timelineHeader}>
                <div className={styles.timelineHeaderIcon}>
                  <Megaphone size={18} aria-hidden="true" />
                </div>
                <h3 className={styles.timelineHeaderTitle}>What happens next?</h3>
              </div>
              <p className={styles.timelineSub}>
                Your application will progress through the following stages:
              </p>

              <div className={styles.timelineTrack}>
                {PIPELINE_STAGES.slice(1).map((stage, idx) => {
                  const stageIndex = idx + 1
                  const isCurrent = stageIndex === reachedIndex
                  const isDone = reachedIndex >= 0 && stageIndex < reachedIndex
                  const StageIcon = stage.icon

                  return (
                    <div
                      key={stage.status}
                      className={`${styles.timelineItem} ${
                        isCurrent ? styles.timelineItemActive : ''
                      }`}
                    >
                      <div
                        className={`${styles.timelineNode} ${
                          isDone || isCurrent ? styles.timelineNodeDone : ''
                        }`}
                      >
                        {isDone || isCurrent ? (
                          <Check size={11} strokeWidth={3} />
                        ) : null}
                      </div>

                      <div
                        className={`${styles.timelineIconContainer} ${
                          isCurrent ? styles.timelineIconContainerActive : ''
                        }`}
                      >
                        <StageIcon size={16} aria-hidden="true" />
                      </div>

                      <div className={styles.timelineContent}>
                        <div className={styles.timelineItemTop}>
                          <span className={styles.timelineStageName}>{stage.label}</span>
                          {isCurrent && (
                            <span className={styles.currentBadge}>Current stage</span>
                          )}
                        </div>
                        <p className={styles.timelineStageDesc}>{stage.description}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
