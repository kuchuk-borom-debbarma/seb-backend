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
  HelpCircle,
  Landmark,
  Lock,
  Megaphone,
  Paperclip,
  PlayCircle,
  Search,
  Sprout,
  Users,
} from 'lucide-react'
import {
  firstIncompleteStep,
  type ApplicationJourneyStep,
} from '#/features/application/ApplicationJourney'
import { FORM_SECTIONS, SECTION_TITLES } from '#/features/application/draft'
import { cyclesQuery, statusGuideQuery } from '#/features/application/queries'
import {
  applicationQuery,
  validationQuery,
} from '#/features/application/applicationQueries'
import type { ApplicationStatus } from '#/graphql/generated/schema'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import styles from '#/features/application/ApplicationDetails.module.css'

/** The statuses in which a sanction order can exist. */
const FUNDED_STATUSES = new Set<string>(['SANCTIONED', 'DISBURSED'])

/** 8 Stages in the Application Pipeline */
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
    description: 'Sent to partner bank for appraisal.',
    icon: Landmark,
  },
  {
    status: 'TTM_REVIEW',
    number: 5,
    label: 'Committee',
    description: 'Reviewed by the selection committee.',
    icon: Users,
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
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.fetchQuery(validationQuery(params.id)),
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
  const { data: validation } = useQuery(validationQuery(id))
  const { data: guide } = useQuery(statusGuideQuery)
  const { data: cycles } = useQuery(cyclesQuery)

  if (!application || !guide || !validation) return null

  const openRevisions = application.revisionRequests.filter(
    (request) => request.resolvedAt === null && request.cancelledAt === null,
  )

  const funded = FUNDED_STATUSES.has(application.status)
  const editableFormSections = FORM_SECTIONS.filter((section) =>
    application.editableSections.includes(section),
  )
  const continuationStep =
    application.status === 'REVISION_REQUIRED'
      ? (editableFormSections[0] ?? 'REVIEW')
      : firstIncompleteStep(validation.issues)

  const guideEntry = guide.find((c) => c.status === application.status)
  const cycleInfo = cycles?.mine?.find((c) => c.id === application.programmeCycleId)

  const railStatus =
    application.status === 'REVISION_REQUIRED' ? 'DESK_REVIEW' : application.status
  const reachedIndex = PIPELINE_STAGES.findIndex((s) => s.status === railStatus)

  return (
    <main className="page">
      <div className={styles.pageContainer}>
        <div className={styles.topNav}>
          <Link to="/applications" className={styles.backLink}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to applications
          </Link>
          <div className={styles.cycleBadge}>
            <Calendar size={14} aria-hidden="true" />
            {cycleInfo?.displayName ?? 'Mission SEP 2026'}
          </div>
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
            {funded ? (
              <Link
                to="/applications/$id/funding"
                params={{ id }}
                className={styles.primaryCta}
              >
                <Award size={15} aria-hidden="true" />
                Funding
              </Link>
            ) : application.editableSections.length > 0 ? (
              <ContinueApplicationLink
                id={id}
                step={continuationStep}
                revision={application.status === 'REVISION_REQUIRED'}
              />
            ) : null}
          </div>
        </div>

        <section
          className={styles.stepperCard}
          aria-label="Application progress pipeline"
        >
          <div className={styles.stepperTrack}>
            {PIPELINE_STAGES.map((stage, index) => {
              const isDone = index < reachedIndex
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

        {openRevisions.length > 0 ? (
          <div className="card">
            <div className="card-header">
              <p className="eyebrow">Changes requested</p>
            </div>
            <div className="card-body stack">
              {openRevisions.map((request) => (
                <div key={request.id} className="notice" data-tone="action">
                  <span className="notice-title">{SECTION_TITLES[request.section]}</span>
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
                <span className={styles.onTrackPill}>
                  <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                  On track
                </span>
              </div>

              <div className={styles.detailList}>
                <div className={styles.detailRow}>
                  <div className={styles.detailRowLeft}>
                    <div className={styles.detailIconBadge}>
                      <Calendar aria-hidden="true" />
                    </div>
                    <span className={styles.detailLabel}>Reference number</span>
                  </div>
                  <span className={styles.detailValue}>
                    {application.referenceNumber ?? (
                      <span className="muted">Issued at first submission</span>
                    )}
                  </span>
                </div>

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
                    <span className={styles.detailLabel}>Sections you can edit</span>
                  </div>
                  <span className={styles.detailValue}>
                    {editableFormSections.length === 0 ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        None — this application is read-only
                        <HelpCircle
                          size={13}
                          style={{ color: '#9ca3af' }}
                          aria-hidden="true"
                        />
                      </span>
                    ) : (
                      editableFormSections
                        .map((section) => SECTION_TITLES[section])
                        .join(', ')
                    )}
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
                    {application.documents.filter((doc) => !doc.deletedAt).length}
                  </Link>
                </div>
              </div>
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
                  const isDone = stageIndex < reachedIndex
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
                        {isDone || isCurrent ? <Check size={11} strokeWidth={3} /> : null}
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

/** One continuation action always lands at the first category that needs work. */
function ContinueApplicationLink({
  id,
  step,
  revision,
}: {
  id: string
  step: ApplicationJourneyStep
  revision: boolean
}) {
  const label = revision ? 'Make the corrections' : 'Continue application'
  if (step === 'ATTACH_EVIDENCE') {
    return (
      <Link
        to="/applications/$id/documents"
        params={{ id }}
        className={styles.primaryCta}
      >
        {label}
        <ArrowRight size={15} aria-hidden="true" />
      </Link>
    )
  }
  if (step === 'REVIEW') {
    return (
      <Link to="/applications/$id/review" params={{ id }} className={styles.primaryCta}>
        {label}
        <ArrowRight size={15} aria-hidden="true" />
      </Link>
    )
  }
  return (
    <Link
      to="/applications/$id/form"
      params={{ id }}
      search={{ section: step }}
      className={styles.primaryCta}
    >
      {label}
      <ArrowRight size={15} aria-hidden="true" />
    </Link>
  )
}
