/**
 * One application, as the programme office works on it.
 *
 * The screen is ordered by what a reviewer does, not by how the data is stored:
 * who holds this application, what to do next, what was submitted, what has
 * been said about it, and then the record of everything that has happened.
 *
 * Every write here carries a version read from this same workspace, so two
 * reviewers acting at once produce a refusal rather than a silent overwrite.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ArrowLeft,
  ClipboardList,
  FileText,
  Lock,
  Play,
  Plus,
  User,
  X,
} from 'lucide-react'
import { WhoIsOnThis } from '#/features/admin/WhoIsOnThis'
import { BankStage } from '#/features/admin/BankStage'
import { DecisionStage } from '#/features/admin/DecisionStage'
import {
  DeskReviewForm,
  DeskReviewModal,
  checkTitle,
  type DeskReviewDraft,
} from '#/features/admin/DeskReviewForm'
import { statusTone } from '#/features/admin/queues'
import { cycleReasonsQuery, workspaceQuery } from '#/features/admin/workspaceQueries'
import { formatBytes } from '#/features/application/documents'
import { fieldLabel, stageTitle } from '#/features/application/draft'
import styles from '#/features/admin/Workspace.module.css'
import {
  AddInternalNoteDocument,
  AdminDocumentDownloadUrlDocument,
  CancelRevisionDocument,
  CompleteDeskReviewDocument,
  StartDeskReviewDocument,
} from '#/graphql/generated/operations'
import { formatDateTime, humanize } from '#/lib/format'
import { can } from '#/lib/session'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { useMarker } from '#/features/guide/GuideContext'

/** The statuses in which a sanction order can exist. */
const FUNDED_STATUSES = new Set<string>(['APPROVED', 'SANCTIONED', 'DISBURSED'])

export const Route = createFileRoute('/_shell/admin/applications/$id/')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(workspaceQuery(params.id)),
  component: WorkspacePage,
})

function WorkspacePage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  // Loaded by the shell for every signed-in screen, so reading it here costs
  // nothing — it is only needed to tell "you were here last" from somebody else.
  const { user: viewer } = Route.useRouteContext()
  /*
   * A reviewer may read every one of these screens and change nothing on them.
   * Drawing the action cards anyway offers a whole desk-review form that the
   * API refuses on submit — the work is done before the refusal arrives, which
   * is the worst possible moment to learn a role cannot do something.
   *
   * `can` decides what to draw and never what is permitted; every operation is
   * re-checked by the API, which is what actually refuses.
   */
  const mayWrite = can(viewer, 'STAFF_WRITE')
  const mayDecide = can(viewer, 'DECIDE')
  const { data: workspace } = useQuery(workspaceQuery(id))
  const { data: reasons } = useQuery(cycleReasonsQuery(workspace?.cycleCode))

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workspace', id] })

  if (!workspace?.application) return null
  const application = workspace.application
  /*
   * Which stages exist is this application's cycle's decision, so every control
   * that names one reads them from here. Empty only where the cycle's rows have
   * been edited by hand, in which case a reviewer is offered no stage rather
   * than a wrong one.
   */
  const stages = workspace.formTemplate?.stages ?? []

  const openRevisions = workspace.revisions.filter(
    (revision) => !revision.resolvedAt && !revision.cancelledAt,
  )
  const latestSubmission = workspace.submissions.at(-1)

  return (
    <main className={styles.pageWrap}>
      {/* Header Section */}
      <div className={styles.headerWrap}>
        <div className={styles.headerTopRow}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIconBadge}>
              <ClipboardList size={24} aria-hidden="true" />
            </div>
            <div className={styles.headerTextGroup}>
              <h1 className={styles.refTitle}>
                {application.referenceNumber ?? 'Unreferenced application'}
              </h1>
              <p className={styles.metaSubtitle}>
                {workspace.enterpriseName ?? 'Unknown enterprise'} ·{' '}
                {workspace.cycleDisplayName ?? workspace.cycleCode ?? ''}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Money outlives the review, so the funding screen is offered
                from the moment a sanction order can exist. */}
            {FUNDED_STATUSES.has(application.status) ? (
              <Link
                to="/admin/applications/$id/funding"
                params={{ id }}
                className={styles.backButton}
              >
                Funding
              </Link>
            ) : null}
            <Link to="/admin/queue" className={styles.backButton}>
              <ArrowLeft size={15} aria-hidden="true" />
              Back to the queue
            </Link>
          </div>
        </div>

        <span className={styles.statusPill} data-tone={statusTone(application.status)}>
          {humanize(application.status)}
        </span>
      </div>

      {/* Redesigned Top Internal Notes Card */}
      <InternalNotes applicationId={id} notes={workspace.notes} onChanged={refresh} />

      {/* Main 2-Column Grid */}
      <div className={styles.mainGrid}>
        {/* Left Column: Who is on this + Next Step + Stages */}
        <div className={styles.colStack}>
          <WhoIsOnThis
            assignedTo={application.assignedTo ?? null}
            assignedAt={application.assignedAt ?? null}
            lastActivityAt={application.updatedAt ?? null}
            viewerUserId={viewer?.id}
          />

          {mayWrite ? (
            <NextStep
              applicationId={id}
              status={application.status}
              statusVersion={application.statusVersion}
              reasons={reasons}
              stages={stages}
              rules={workspace.identifierRules}
              reviewingOwnApplication={application.applicantUserId === viewer?.id}
              hasReview={workspace.reviews.length > 0}
              onChanged={refresh}
            />
          ) : null}

          {mayWrite ? (
            <BankStage
              applicationId={id}
              status={application.status}
              statusVersion={application.statusVersion}
              latestSubmissionId={latestSubmission?.id}
              latestDeskReviewId={workspace.reviews.at(-1)?.id}
              referrals={workspace.referrals}
              outcomes={workspace.bankOutcomes}
              reasons={reasons}
              stages={stages}
              onChanged={refresh}
            />
          ) : null}

          {mayWrite || mayDecide ? (
            <DecisionStage
              applicationId={id}
              status={application.status}
              statusVersion={application.statusVersion}
              latestBankOutcomeId={workspace.bankOutcomes.at(-1)?.id}
              decisions={workspace.decisions}
              reasons={reasons}
              stages={stages}
              decidingOwnApplication={application.applicantUserId === viewer?.id}
              onChanged={refresh}
            />
          ) : null}

          {mayWrite && openRevisions.length > 0 ? (
            <OpenRevisions
              applicationId={id}
              statusVersion={application.statusVersion}
              revisions={openRevisions}
              onChanged={refresh}
            />
          ) : null}
        </div>

        {/* Right Column: Submissions + Documents + Desk Reviews */}
        <div className={styles.colStack}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Submissions</h2>
              <span className={styles.headerMeta}>
                {workspace.submissions.length}{' '}
                {workspace.submissions.length === 1 ? 'submission' : 'submissions'}
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">
                  Submissions of this application
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: '56px' }}>
                      No.
                    </th>
                    <th scope="col" style={{ width: '220px' }}>
                      Submitted
                    </th>
                    <th scope="col">What changed</th>
                  </tr>
                </thead>
                <tbody>
                  {workspace.submissions.map((submission) => {
                    const change = workspace.submissionChanges.find(
                      (entry) => entry.toSubmissionNumber === submission.submissionNumber,
                    )
                    return (
                      <tr key={submission.id} className={styles.tableRow}>
                        <td
                          className="tabular"
                          style={{ fontWeight: 600, color: '#111827' }}
                        >
                          {submission.submissionNumber}
                        </td>
                        <td style={{ color: '#334155' }}>
                          {formatDateTime(submission.submittedAt)}
                        </td>
                        <td>
                          {change ? (
                            change.stageKeys
                              .map((stageKey) => stageTitle(stageKey))
                              .join(', ')
                          ) : (
                            // The first submission changed everything by
                            // definition, so there is nothing to compare it to.
                            <span className="muted">First submission</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <Documents
            applicationId={id}
            documents={workspace.documents}
            latestSubmissionId={latestSubmission?.id}
          />

          {workspace.reviews.length > 0 ? (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>Desk reviews</h2>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className="visually-hidden">Completed desk reviews</caption>
                  <thead>
                    <tr>
                      <th scope="col">Outcome</th>
                      <th scope="col">Reviewed</th>
                      <th scope="col">Checks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspace.reviews.map((review) => (
                      <tr key={review.id} className={styles.tableRow}>
                        <td>
                          <span
                            className={styles.statusPill}
                            data-tone={
                              review.outcome === 'ADVANCE_TO_BANK'
                                ? 'ok'
                                : review.outcome === 'REJECT'
                                  ? 'error'
                                  : 'action'
                            }
                          >
                            {humanize(review.outcome)}
                          </span>
                          {/* A review an officer carried out on their own
                              application is allowed, and is exactly what a reader
                              of this record needs to see beside the outcome. */}
                          {review.conflictAcknowledged ? (
                            <span className="field-hint">
                              Reviewed by the applicant, declared
                            </span>
                          ) : null}
                        </td>
                        <td>{formatDateTime(review.reviewedAt)}</td>
                        <td>
                          {workspace.reviewChecks
                            .filter((check) => check.deskReviewId === review.id)
                            .map((check) => (
                              <span key={check.id} className="field-hint">
                                {checkTitle(check.checkType)}: {humanize(check.result)}
                                {check.internalNote ? ` — ${check.internalNote}` : ''}
                              </span>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* Bottom Row: Who has held this */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Who has held this</h2>
        </div>
        {workspace.assignments.length === 0 ? (
          <div className={styles.whoHeldEmpty}>
            <div className={styles.whoHeldIconCircle}>
              <User size={20} aria-hidden="true" />
            </div>
            <div className={styles.whoHeldTextGroup}>
              <p className={styles.whoHeldTitle}>
                Nobody has claimed this application yet.
              </p>
              <p className={styles.whoHeldDesc}>
                Claiming records who holds the next decision — until somebody does,
                nothing on it can be actioned.
              </p>
            </div>
          </div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="visually-hidden">Assignment history</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What happened</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {workspace.assignments.map((event) => (
                  <tr key={event.id} className={styles.tableRow}>
                    <td>{formatDateTime(event.createdAt)}</td>
                    <td>{humanize(event.eventType)}</td>
                    <td className="muted">{event.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

/**
 * The one thing to do next, given where the application is.
 *
 * Only the transitions the API will actually accept from this status are
 * offered. A button that exists to be refused teaches people to distrust the
 * screen.
 */
function NextStep({
  applicationId,
  status,
  statusVersion,
  reasons,
  stages,
  rules,
  reviewingOwnApplication,
  hasReview,
  onChanged,
}: {
  applicationId: string
  status: string
  statusVersion: number
  reasons: Parameters<typeof DeskReviewForm>[0]['reasons']
  /** This application's own stages; see the workspace comment above. */
  stages: Parameters<typeof DeskReviewForm>[0]['stages']
  rules: Parameters<typeof DeskReviewForm>[0]['rules']
  reviewingOwnApplication: boolean
  hasReview: boolean
  onChanged: () => Promise<unknown>
}) {
  /*
   * Marked on every branch. Only one renders, so the "exactly one bracket on
   * the page" property holds — and the step lands on whatever this application
   * actually offers rather than on a stage it happens not to be at.
   */
  const mark = useMarker()
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const start = useMutation({
    mutationFn: async () => {
      const data = await gql(StartDeskReviewDocument, {
        input: { applicationId, expectedStatusVersion: statusVersion },
      })
      unwrap(data.admin.intake.startDeskReview)
    },
    onMutate: () => setError(null),
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  const complete = useMutation({
    mutationFn: async (draft: DeskReviewDraft) => {
      const data = await gql(CompleteDeskReviewDocument, {
        input: {
          applicationId,
          expectedStatusVersion: statusVersion,
          ...draft,
        },
      })
      unwrap(data.admin.intake.completeDeskReview)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setModalOpen(false)
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  if (status === 'SUBMITTED') {
    return (
      <section className={styles.card} {...mark('next-step')}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Next</h2>
        </div>
        <div className={styles.nextActionBox}>
          <div className={styles.nextActionHeader}>
            <div className={styles.nextActionIconBadge}>
              <Play size={16} fill="#2563eb" color="#2563eb" aria-hidden="true" />
            </div>
            <h3 className={styles.nextActionTitle}>Start the desk review</h3>
          </div>
          <button
            type="button"
            className={styles.primaryActionButton}
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? 'Starting…' : 'Start desk review'}
          </button>
          <p className={styles.nextActionDesc}>
            Starting the review takes the application out of the submissions queue and
            puts it in yours.
          </p>
          {error ? (
            <p
              className="notice"
              data-tone="error"
              role="alert"
              style={{ marginTop: '0.75rem' }}
            >
              {error}
            </p>
          ) : null}
        </div>
      </section>
    )
  }

  if (status === 'DESK_REVIEW') {
    return (
      <>
        <section className={styles.card} {...mark('next-step')}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Next</h2>
          </div>
          <div className={styles.nextActionBox}>
            <div className={styles.nextActionHeader}>
              <div className={styles.nextActionIconBadge}>
                <ClipboardList size={16} color="#2563eb" aria-hidden="true" />
              </div>
              <h3 className={styles.nextActionTitle}>
                {hasReview ? 'Record another review' : 'Complete the desk review'}
              </h3>
            </div>
            <button
              type="button"
              className={styles.primaryActionButton}
              onClick={() => setModalOpen(true)}
            >
              {hasReview ? 'Open review form' : 'Open desk review'}
            </button>
            {error ? (
              <p
                className="notice"
                data-tone="error"
                role="alert"
                style={{ marginTop: '0.75rem' }}
              >
                {error}
              </p>
            ) : null}
          </div>
        </section>

        <DeskReviewModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          hasReview={hasReview}
          reasons={reasons}
          stages={stages}
          rules={rules}
          reviewingOwnApplication={reviewingOwnApplication}
          pending={complete.isPending}
          error={error}
          onSubmit={(draft) => complete.mutate(draft)}
        />
      </>
    )
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Next</h2>
      </div>
      <p className="muted" style={{ fontSize: '13px', margin: 0 }}>
        Nothing to do here at the moment — this application is{' '}
        {humanize(status).toLowerCase()}.
      </p>
    </section>
  )
}

/**
 * Correction requests the applicant has not yet answered.
 *
 * Cancelling one withdraws it: the section locks again and the applicant is no
 * longer waiting on it. That is a real decision, so it needs a reason.
 */
function OpenRevisions({
  applicationId,
  statusVersion,
  revisions,
  onChanged,
}: {
  applicationId: string
  statusVersion: number
  revisions: {
    id: string
    stageKey: string
    note: string
    requestedAt: string
  }[]
  onChanged: () => Promise<unknown>
}) {
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const cancel = useMutation({
    mutationFn: async (revisionRequestId: string) => {
      const data = await gql(CancelRevisionDocument, {
        input: {
          applicationId,
          revisionRequestId,
          expectedStatusVersion: statusVersion,
          reason: reason.trim(),
        },
      })
      unwrap(data.admin.intake.cancelRevision)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setCancelling(null)
      setReason('')
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Waiting on the applicant</h2>
      </div>
      <div className="stack">
        {revisions.map((revision) => (
          <div key={revision.id}>
            <p className="notice" data-tone="action">
              <span className="notice-title">{stageTitle(revision.stageKey)}</span>
              {revision.note}
            </p>
            {cancelling === revision.id ? (
              <div className="row" style={{ marginTop: '0.5rem', alignItems: 'end' }}>
                <div style={{ flex: '1 1 20rem' }}>
                  <label className="field-label" htmlFor={`cancel-${revision.id}`}>
                    Why withdraw this request?
                  </label>
                  <input
                    id={`cancel-${revision.id}`}
                    className="input"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="button"
                  data-variant="danger"
                  disabled={!reason.trim() || cancel.isPending}
                  onClick={() => cancel.mutate(revision.id)}
                >
                  {cancel.isPending ? 'Withdrawing…' : 'Withdraw it'}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setCancelling(null)
                    setReason('')
                  }}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button"
                style={{ marginTop: '0.5rem' }}
                onClick={() => setCancelling(revision.id)}
              >
                Withdraw this request
              </button>
            )}
          </div>
        ))}
      </div>
      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.75rem' }}
        >
          {error}
        </p>
      ) : null}
    </section>
  )
}

/** The documents frozen into each submission, newest submission first. */
function Documents({
  applicationId,
  documents,
  latestSubmissionId,
}: {
  applicationId: string
  documents: {
    id: string
    submissionId: string
    fieldKey: string
    documentVersion: number
    originalFilename: string
    sizeBytes: number
  }[]
  latestSubmissionId: string | undefined
}) {
  const [error, setError] = useState<string | null>(null)

  const open = useMutation({
    mutationFn: async (submissionDocumentId: string) => {
      const data = await gql(AdminDocumentDownloadUrlDocument, {
        applicationId,
        submissionDocumentId,
      })
      return unwrap(data.admin.intake.documentDownloadUrl).downloadUrl
    },
    onMutate: () => setError(null),
    onSuccess: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    onError: (cause) => setError(messageFor(cause)),
  })

  // Documents from earlier submissions are kept, but the ones being reviewed
  // now are the ones frozen into the latest submission.
  const current = documents.filter(
    (document) => document.submissionId === latestSubmissionId,
  )

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Documents</h2>
        <Explain label="documents" opener="Which documents a review reads">
          {OFFICE_HELP.frozenEvidence}
        </Explain>
      </div>
      {current.length === 0 ? (
        // Two different facts. Saying "none" when earlier submissions carry
        // documents would report the filter as if it were the application.
        <p className="muted">
          {documents.length === 0
            ? 'Nothing has been attached to this application.'
            : `The latest submission carries no documents. ${documents.length} from earlier ` +
              'submissions are kept, but a review reads only what its own submission froze.'}
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Documents in this submission</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">File</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Size
                </th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {current.map((document) => (
                <tr key={document.id} className={styles.tableRow}>
                  <td>
                    <div className={styles.docTitleCell}>
                      <FileText size={16} className={styles.docIcon} aria-hidden="true" />
                      <span>{fieldLabel(document.fieldKey)}</span>
                      {document.documentVersion > 1 ? (
                        <span className="field-hint">v{document.documentVersion}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className={styles.filenameCell} title={document.originalFilename}>
                    {document.originalFilename}
                  </td>
                  <td className={styles.sizeCell}>{formatBytes(document.sizeBytes)}</td>
                  <td className={styles.actionCell}>
                    <button
                      type="button"
                      className={styles.openDocButton}
                      disabled={open.isPending}
                      onClick={() => open.mutate(document.id)}
                    >
                      {open.isPending ? 'Opening…' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '10px' }}
        >
          {error}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Notes kept inside the programme office.
 *
 * A note cannot be edited or deleted — a correction is a new note that points
 * at the one it corrects, so the record of what was thought at the time
 * survives. The interface shows that relationship rather than hiding the
 * superseded note.
 */
function InternalNotes({
  applicationId,
  notes,
  onChanged,
}: {
  applicationId: string
  notes: {
    id: string
    correctionOfNoteId?: string | null
    note: string
    createdAt: string
  }[]
  onChanged: () => Promise<unknown>
}) {
  const mark = useMarker()
  const [modalOpen, setModalOpen] = useState(false)
  const [text, setText] = useState('')
  const [correctingNoteId, setCorrectingNoteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: async () => {
      const data = await gql(AddInternalNoteDocument, {
        input: {
          applicationId,
          note: text.trim(),
          correctionOfNoteId: correctingNoteId,
        },
      })
      unwrap(data.admin.intake.addInternalNote)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setText('')
      setCorrectingNoteId(null)
      setModalOpen(false)
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  const corrections = new Set(
    notes.map((note) => note.correctionOfNoteId).filter(Boolean) as string[],
  )

  const correctingNote = notes.find((note) => note.id === correctingNoteId)

  const openAddModal = () => {
    setCorrectingNoteId(null)
    setText('')
    setError(null)
    setModalOpen(true)
  }

  const openCorrectModal = (noteId: string) => {
    setCorrectingNoteId(noteId)
    setText('')
    setError(null)
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setCorrectingNoteId(null)
    setText('')
    setError(null)
  }

  return (
    <section className={styles.topNotesCard} {...mark('internal-notes')}>
      <div className={styles.topNotesHeader}>
        <div className={styles.topNotesHeaderLeft}>
          <div className={styles.notesLockBadge}>
            <Lock size={13} aria-hidden="true" />
          </div>
          <span className={styles.notesCardTitle}>Internal notes</span>
          <span className={styles.confidentialTag}>Never shown to applicant</span>
          {notes.length > 0 ? (
            <span className={styles.notesCountPill}>
              {notes.length} {notes.length === 1 ? 'note' : 'notes'}
            </span>
          ) : null}
        </div>

        <button
          type="button"
          className={styles.addNoteTriggerButton}
          onClick={openAddModal}
        >
          <Plus size={14} aria-hidden="true" />
          Add note
        </button>
      </div>

      {notes.length === 0 ? (
        <p className={styles.notesEmptyHint}>
          No notes yet. Notes stay inside the office and are never shown to the applicant;
          once written, one can only be corrected by another that points at it.
        </p>
      ) : (
        <div className={styles.notesList}>
          {notes.map((note) => (
            <div key={note.id} className={styles.noteItem}>
              <p className={styles.noteContent}>{note.note}</p>
              <div className={styles.noteMetaRow}>
                <span className={styles.noteMeta}>
                  {formatDateTime(note.createdAt)}
                  {note.correctionOfNoteId ? ' · corrects an earlier note' : ''}
                  {corrections.has(note.id) ? ' · corrected later' : ''}
                </span>
                {!note.correctionOfNoteId && !corrections.has(note.id) ? (
                  <button
                    type="button"
                    className={styles.correctNoteBtn}
                    onClick={() => openCorrectModal(note.id)}
                  >
                    Correct note
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Correct Internal Note Modal */}
      {modalOpen ? (
        <div
          className={styles.noteModalOverlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeModal()
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="internal-note-modal-title"
        >
          <div className={styles.noteModalDialog}>
            <div className={styles.noteModalHeader}>
              <div className={styles.noteModalHeaderLeft}>
                <div className={styles.noteModalHeaderIcon}>
                  <Lock size={16} aria-hidden="true" />
                </div>
                <div>
                  <h3 id="internal-note-modal-title" className={styles.noteModalTitle}>
                    {correctingNote ? 'Correct internal note' : 'Add internal note'}
                  </h3>
                  <p className={styles.noteModalSubtitle}>
                    Stored permanently. Never visible to the applicant.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className={styles.noteModalCloseButton}
                onClick={closeModal}
                aria-label="Close modal"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (text.trim()) add.mutate()
              }}
            >
              <div className={styles.noteModalBody}>
                {correctingNote ? (
                  <div className={styles.earlierNoteQuote}>
                    <div className={styles.earlierNoteQuoteTitle}>
                      Correcting note from {formatDateTime(correctingNote.createdAt)}:
                    </div>
                    <div>"{correctingNote.note}"</div>
                  </div>
                ) : null}

                <div>
                  <label className="field-label" htmlFor="internal-note-input">
                    {correctingNote ? 'Correction note' : 'Note'}
                  </label>
                  <textarea
                    id="internal-note-input"
                    className="textarea"
                    rows={4}
                    placeholder={
                      correctingNote
                        ? 'State the correction and why it supersedes the earlier note…'
                        : 'Write a note for caseworkers and reviewers…'
                    }
                    value={text}
                    autoFocus
                    onChange={(event) => setText(event.target.value)}
                  />
                  <p className="field-hint">
                    Notes stay inside the programme office. Once saved, a note cannot be
                    deleted.
                  </p>
                </div>

                {error ? (
                  <p
                    className="notice"
                    data-tone="error"
                    role="alert"
                    style={{ margin: 0 }}
                  >
                    {error}
                  </p>
                ) : null}
              </div>

              <div className={styles.noteModalFooter}>
                <button
                  type="button"
                  className="button"
                  onClick={closeModal}
                  disabled={add.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={styles.primaryActionButton}
                  disabled={!text.trim() || add.isPending}
                >
                  {add.isPending
                    ? 'Saving…'
                    : correctingNote
                      ? 'Save correction'
                      : 'Save note'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  )
}
