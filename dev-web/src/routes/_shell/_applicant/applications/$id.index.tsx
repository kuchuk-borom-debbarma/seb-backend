import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ClipboardList,
  Clock,
  CircleCheck,
  FilePenLine,
  FileText,
  Landmark,
  Layers,
  Lock,
  Megaphone,
  Paperclip,
  PlayCircle,
  RotateCcw,
  Sprout,
  Trash2,
} from 'lucide-react'
import { stageTitle } from '#/features/application/draft'
import { awaitingCorrection } from '#/features/application/revision'
import {
  JourneyFlags,
  journeyValueText,
  nextActorOf,
  standingExplanation,
  standingLabel,
  type Journey,
} from '#/features/application/journey'
import { cyclesQuery, statusGuideQuery } from '#/features/application/queries'
import {
  applicationKindsQuery,
  applicationQuery,
  formTemplateQuery,
  liveEnterprisesQuery,
  validationQuery,
} from '#/features/application/applicationQueries'
import { resolveTemplate } from '#/features/application/formTemplate'
import {
  journeySteps,
  issuesForStep,
  REVIEW,
} from '#/features/application/ApplicationJourney'
import type { ApplicationCategory } from '#/graphql/generated/schema'
import {
  RemoveApplicationDraftDocument,
  RestoreApplicationDraftDocument,
} from '#/graphql/generated/operations'
import { formatDate, formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import styles from '#/features/application/ApplicationDetails.module.css'

/*
 * The overview is the index route beneath `$id`, not `$id` itself.
 *
 * In flat file routing a `$id.tsx` alongside `$id.form.tsx` becomes a layout
 * wrapping the form, so the overview would have had to render an outlet and
 * would have shown above every child screen. Naming it `.index` makes it a
 * sibling instead, which is what it actually is.
 */
/** Stamped by the server at submission; shown here, never chosen. */
const CATEGORY_LABELS: Record<ApplicationCategory, string> = {
  CATEGORY_A: 'Category A',
  CATEGORY_B: 'Category B',
}

/**
 * The steps an application's rail shows, in order.
 *
 * The first two are the same for everybody: drafting, then sending. After
 * that the route is the cycle's pipeline, and the third step says where the
 * file is in the words the pipeline gives the applicant — the stage's label
 * while it is being worked, or how the journey ended. The office's own stage
 * names are never shown here.
 */
type StandingStep = { key: string; label: string; description: string; icon: typeof FileText }

const standingSteps = (application: { journey?: Journey | null }): StandingStep[] => [
  {
    key: 'DRAFT',
    label: 'Draft',
    description: 'Application being drafted by applicant.',
    icon: FilePenLine,
  },
  {
    key: 'SUBMITTED',
    label: 'Submitted',
    description: 'Received by the programme office.',
    icon: FileText,
  },
  application.journey?.ended
    ? {
        key: 'ENDED',
        label: application.journey.ended,
        description: 'The programme office has finished with this application.',
        icon: CircleCheck,
      }
    : {
        key: 'WORKED',
        label: application.journey?.stageLabel ?? 'Under review',
        description:
          application.journey?.stageExplanation ??
          'Being worked by the programme office, one stage at a time.',
        icon: Landmark,
      },
]

export const Route = createFileRoute('/_shell/_applicant/applications/$id/')({
  // All of these start together: one round of requests, no waterfall.
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(statusGuideQuery),
      context.queryClient.ensureQueryData(cyclesQuery),
      // The title is the enterprise's name; fetched with the rest so the page
      // does not open on the reference number and then change its heading.
      context.queryClient.ensureQueryData(liveEnterprisesQuery),
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
  const router = useRouter()
  const queryClient = useQueryClient()
  const [removalError, setRemovalError] = useState<string | null>(null)
  const { data: application } = useQuery(applicationQuery(id))
  const { data: guide } = useQuery(statusGuideQuery)
  const { data: cycles } = useQuery(cyclesQuery)
  const { data: rawTemplate } = useQuery(formTemplateQuery(id))
  const { data: validation } = useQuery(validationQuery(id))
  // For the page's own words: whose application this is, and what kind.
  const { data: enterprises } = useQuery(liveEnterprisesQuery)
  const { data: kinds } = useQuery({
    ...applicationKindsQuery(application?.enterpriseId ?? '', application?.programmeCycleId ?? ''),
    enabled: Boolean(application),
  })

  const template = useMemo(
    () => (rawTemplate ? resolveTemplate(rawTemplate) : null),
    [rawTemplate],
  )

  const draftProgress = useMemo(() => {
    if (!template || !validation) return null
    const order = journeySteps(template)
    const totalSteps = order.length
    const completedCount = order.filter((step) => {
      if (step === REVIEW) {
        return order.every(
          (s) => s === REVIEW || issuesForStep(template, validation.issues, s).length === 0,
        )
      }
      return issuesForStep(template, validation.issues, step).length === 0
    }).length
    return { completedCount, totalSteps }
  }, [template, validation])

  if (!application || !guide) return null

  const openRevisions = application.revisionRequests.filter(
    (request) => request.resolvedAt === null && request.cancelledAt === null,
  )

  /*
   * Named from the template where it is to hand, so an applicant reads the
   * cycle's own heading rather than a key. The list itself is the API's: it
   * derives it from the same rule the draft-save path enforces, so it can never
   * invite an edit the write would refuse.
   */
  const editableStages = application.editableStageKeys

  /*
   * Removing a draft nobody wants, and putting it back.
   *
   * The same soft delete an enterprise and a document already have here:
   * nothing is destroyed, the row stays under "Include removed drafts" on the
   * list, and restoring is one click. Without it an abandoned draft sat in the
   * applicant's list for ever, and the only way to be rid of one was to ask
   * the office.
   *
   * Both quote the form version *and* the workflow version, because a draft is
   * edited and moved through the workflow independently — the API refuses on
   * either being stale, which is what makes a removal safe to offer.
   */
  const removed = application.deletedAt !== null

  const remove = useMutation({
    mutationFn: async () =>
      unwrap(
        (await gql(RemoveApplicationDraftDocument, {
          input: {
            applicationId: id,
            expectedVersion: application.currentVersion,
            expectedStatusVersion: application.statusVersion,
            reason: null,
          },
        })).seb.application.softDeleteDraft,
      ),
    onMutate: () => setRemovalError(null),
    onSuccess: async () => {
      // Marked stale; the list's own loader fetches it on arrival.
      void queryClient.invalidateQueries({ queryKey: ['applications'] })
      await router.navigate({ to: '/applications' })
    },
    onError: (cause) => setRemovalError(messageFor(cause)),
  })

  const restore = useMutation({
    mutationFn: async () =>
      unwrap(
        (await gql(RestoreApplicationDraftDocument, {
          input: {
            applicationId: id,
            expectedVersion: application.currentVersion,
            expectedStatusVersion: application.statusVersion,
          },
        })).seb.application.restoreDraft,
      ),
    onMutate: () => setRemovalError(null),
    onSuccess: async () => {
      void queryClient.invalidateQueries({ queryKey: ['applications'] })
      await queryClient.invalidateQueries({ queryKey: ['application', id] })
    },
    onError: (cause) => setRemovalError(messageFor(cause)),
  })

  const guideEntry = guide.find((entry) => entry.status === application.status)
  const cycleInfo = cycles?.mine.find(
    (cycle) => cycle.id === application.programmeCycleId,
  )

  // A correction request holds the file with the applicant; it is not on track
  // until they resubmit.
  const correcting = awaitingCorrection(application)
  // A finished journey is told in the past tense: nothing is "so far" or "next".
  const finished = Boolean(application.journey?.ended)
  /*
   * Named for the enterprise, which is what the applicant knows it by; the
   * reference number follows once submission issues one.
   */
  const title =
    enterprises?.find((each) => each.id === application.enterpriseId)?.name ??
    application.referenceNumber ??
    'Your application'
  const steps = standingSteps(application)
  /*
   * A draft is at the first step; a file being worked is at the third; a
   * finished one has passed every step, which is one past the last.
   */
  const reachedIndex =
    application.status === 'DRAFT' ? 0 : application.journey?.ended ? steps.length : 2
  const onTrack = application.status !== 'DRAFT' && !correcting && !application.journey?.ended
  const actor = nextActorOf(application)
  const journey = application.journey ?? null

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
            {/* "Unsubmitted draft" told them neither whose it was nor what. */}
            <h1 className={styles.appTitle}>{title}</h1>
            {/* Beside the title only when the title is not already it. */}
            {title !== application.referenceNumber ? (
              <span className={styles.appSubtitle}>
                {application.referenceNumber ?? 'Draft — not submitted yet'}
              </span>
            ) : null}
            <span className={styles.typeBadge}>
              <Sprout size={13} aria-hidden="true" />
              {kinds?.find((each) => each.kindKey === application.applicationKind)?.label ??
                humanize(application.applicationKind)}
              {application.phaseNumber > 1 ? `, phase ${application.phaseNumber}` : ''}
            </span>
          </div>

          <div className={styles.headerActions}>
            {/* Offered only while something can actually be changed or sent. */}
            {editableStages.length > 0 ? (
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
                {/* The documents and the final check are steps of the form's own
                    rail; offering them here too made four buttons of one path. */}
                <Link
                  to="/applications/$id/form"
                  params={{ id }}
                  className={styles.primaryCta}
                >
                  {correcting
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

            {/*
              A draft and nothing else, which is exactly what the API accepts —
              how much of the form has been filled in makes no difference to it,
              so it makes none here either. Offering this on a submitted
              application would be offering a refusal.
            */}
            {removed ? (
              <button
                type="button"
                className="button"
                disabled={restore.isPending}
                onClick={() => restore.mutate()}
              >
                <RotateCcw size={15} aria-hidden="true" />
                {restore.isPending ? 'Restoring…' : 'Restore this draft'}
              </button>
            ) : application.status === 'DRAFT' ? (
              <button
                type="button"
                className="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                <Trash2 size={15} aria-hidden="true" />
                {remove.isPending ? 'Removing…' : 'Remove this draft'}
              </button>
            ) : null}
          </div>
        </div>

        {removalError ? (
          <p className="notice" data-tone="error" role="alert">
            {removalError}
          </p>
        ) : null}

        <section
          className={styles.stepperCard}
          aria-label="Application progress pipeline"
        >
          <div className={styles.stepperTrack}>
            {steps.map((stage, index) => {
              const isDone = reachedIndex >= 0 && index < reachedIndex
              const isCurrent = index === reachedIndex

              return (
                <div key={stage.key} style={{ display: 'contents' }}>
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
                      {isDone ? <Check size={14} strokeWidth={2.5} /> : index + 1}
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

                  {index < steps.length - 1 && (
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
              <span className={styles.statusBadge}>{standingLabel(application)}</span>
              {application.status === 'DRAFT' && draftProgress ? (
                <span
                  className={styles.actorBadge}
                  style={{
                    background: 'transparent',
                    color: '#a88d15',
                    borderColor: '#E2C43A',
                  }}
                >
                  <FilePenLine size={13} aria-hidden="true" />
                  {draftProgress.completedCount} of {draftProgress.totalSteps} steps complete
                </span>
              ) : null}
              <span className={styles.actorBadge}>
                <Landmark size={13} aria-hidden="true" />
                {actor === 'APPLICANT'
                  ? 'Your turn'
                  : actor === 'PROGRAMME_OFFICE'
                    ? 'With the programme office'
                    : 'No further action'}
              </span>
            </div>
            <h2 className={styles.heroTitle}>
              {standingExplanation(application) ??
                guideEntry?.explanation ??
                'Your application has been received and is progressing through the review stages.'}
            </h2>
            <JourneyFlags journey={journey} />
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
              <p className="eyebrow">What the office asked you to change</p>
            </div>
            <div className="card-body stack">
              <p className="muted" style={{ margin: 0 }}>
                Only {openRevisions.length === 1 ? 'this section opens' : 'these sections open'}{' '}
                for editing. Change what is asked, then check your application and submit it
                again; it goes back to the same reviewers.
              </p>
              {openRevisions.map((request) => (
                <div key={request.id} className="notice" data-tone="action">
                  <span className="notice-title">
                    {stageTitle(request.stageKey, template?.stages)}
                  </span>
                  {request.note}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                      marginTop: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                      Requested {formatDateTime(request.requestedAt)}
                    </span>
                    {/* Straight to the section named, not to the form's start. */}
                    <Link
                      to="/applications/$id/form"
                      params={{ id }}
                      search={{ stage: request.stageKey }}
                      className="button"
                      style={{ minHeight: '2rem' }}
                    >
                      Change {stageTitle(request.stageKey, template?.stages)}
                      <ArrowRight size={14} aria-hidden="true" />
                    </Link>
                  </div>
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

            {journey && journey.recordedValues.length > 0 ? (
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitleGroup}>
                    <Landmark className={styles.cardIcon} aria-hidden="true" />
                    <h3 className={styles.cardTitle}>
                      {finished ? 'What was decided' : 'Decided so far'}
                    </h3>
                  </div>
                </div>
                <div className={styles.detailList}>
                  {journey.recordedValues.map((value) => (
                    <div key={value.key} className={styles.detailRow}>
                      <div className={styles.detailRowLeft}>
                        <span className={styles.detailLabel}>{value.label}</span>
                      </div>
                      <span className={styles.detailValue}>{journeyValueText(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Only once there is a journey to be updated about. */}
            {application.status === 'DRAFT' ? null : (
              <div className={styles.statusNotice}>
                <div className={styles.noticeIconBadge}>
                  <Sprout size={16} aria-hidden="true" />
                </div>
                <p className={styles.noticeText}>
                  {finished
                    ? 'Your application’s journey is finished. Keep the reference number for anything you write to the programme office about it.'
                    : correcting
                    ? 'Once you submit your corrections, the application goes back to the reviewers who asked for them, and this page shows where it is.'
                    : 'We’ll keep you updated as your application moves to the next stage. You can check this page anytime for the latest status.'}
                </p>
              </div>
            )}
          </div>

          <div className={styles.rightColumn}>
            <div className={styles.timelineCard}>
              <div className={styles.timelineHeader}>
                <div className={styles.timelineHeaderIcon}>
                  <Megaphone size={18} aria-hidden="true" />
                </div>
                <h3 className={styles.timelineHeaderTitle}>
                  {finished ? 'How it went' : 'What happens next?'}
                </h3>
              </div>
              <p className={styles.timelineSub}>
                {finished
                  ? 'The stages your application went through:'
                  : 'Your application will progress through the following stages:'}
              </p>

              <div className={styles.timelineTrack}>
                {steps.slice(1).map((stage, idx) => {
                  const stageIndex = idx + 1
                  const isCurrent = stageIndex === reachedIndex
                  const isDone = reachedIndex >= 0 && stageIndex < reachedIndex
                  const StageIcon = stage.icon

                  return (
                    <div
                      key={stage.key}
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
                            <span className={styles.currentBadge}>
                              {correcting ? 'Waiting on you' : 'Current stage'}
                            </span>
                          )}
                        </div>
                        <p className={styles.timelineStageDesc}>
                          {/* Held here, but it is the applicant's move, not the office's. */}
                          {isCurrent && correcting
                            ? 'Paused until you submit the corrections asked for above.'
                            : stage.description}
                        </p>
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
