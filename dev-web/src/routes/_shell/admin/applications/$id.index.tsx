import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ArrowLeft,
  ClipboardList,
  FileText,
  Lock,
  Play,
  User,
} from 'lucide-react'
import { WhoIsOnThis } from '#/features/admin/WhoIsOnThis'
import { BankStage } from '#/features/admin/BankStage'
import { CommitteeStage } from '#/features/admin/CommitteeStage'
import {
  DeskReviewForm,
  checkTitle,
  type DeskReviewDraft,
} from '#/features/admin/DeskReviewForm'
import { statusTone } from '#/features/admin/queues'
import { cycleReasonsQuery, workspaceQuery } from '#/features/admin/workspaceQueries'
import { DOCUMENT_TITLES, formatBytes } from '#/features/application/documents'
import { SECTION_TITLES, sectionTitle } from '#/features/application/draft'
import styles from '#/features/admin/Workspace.module.css'
import {
  AddInternalNoteDocument,
  AdminDocumentDownloadUrlDocument,
  CancelRevisionDocument,
  CompleteDeskReviewDocument,
  StartDeskReviewDocument,
} from '#/graphql/generated/operations'
import type { DocumentType } from '#/graphql/generated/schema'
import { formatDateTime, humanize } from '#/lib/format'
import { can } from '#/lib/session'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { OFFICE_LEDES } from '#/features/admin/officeGuidance'
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
  const { user: viewer } = Route.useRouteContext()
  const mayWrite = can(viewer, 'STAFF_WRITE')
  const mayDecide = can(viewer, 'DECIDE')
  const { data: workspace } = useQuery(workspaceQuery(id))
  const { data: reasons } = useQuery(cycleReasonsQuery(workspace?.cycleCode))

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workspace', id] })

  if (!workspace?.application) return null
  const application = workspace.application

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
              <p className={styles.ledeDescription}>{OFFICE_LEDES.workspace}</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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

      {/* Main 2-Column Grid */}
      <div
        className={styles.mainGrid}
        data-reviewing={
          (application.status as string) === 'DESK_REVIEW' ||
          application.status === 'PARTNER_BANK_EVALUATION' ||
          application.status === 'TTM_REVIEW'
            ? 'true'
            : undefined
        }
      >
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
              onChanged={refresh}
            />
          ) : null}

          {mayWrite || mayDecide ? (
            <CommitteeStage
              applicationId={id}
              status={application.status}
              statusVersion={application.statusVersion}
              latestSubmissionId={latestSubmission?.id}
              latestBankOutcomeId={workspace.bankOutcomes.at(-1)?.id}
              agenda={workspace.agenda}
              decisions={workspace.decisions}
              reasons={reasons}
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
                    <th scope="col" style={{ width: '56px' }}>No.</th>
                    <th scope="col" style={{ width: '220px' }}>Submitted</th>
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
                        <td className="tabular" style={{ fontWeight: 600, color: '#111827' }}>
                          {submission.submissionNumber}
                        </td>
                        <td style={{ color: '#334155' }}>
                          {formatDateTime(submission.submittedAt)}
                        </td>
                        <td>
                          {change ? (
                            change.sections
                              .map((section) => SECTION_TITLES[section])
                              .join(', ')
                          ) : (
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
                          {humanize(review.outcome)}
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

      {/* Bottom 2-Column Grid: Internal Notes + Who has held this */}
      <div className={styles.bottomGrid}>
        <InternalNotes applicationId={id} notes={workspace.notes} onChanged={refresh} />

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
      </div>
    </main>
  )
}

/**
 * The one thing to do next, given where the application is.
 */
function NextStep({
  applicationId,
  status,
  statusVersion,
  reasons,
  rules,
  reviewingOwnApplication,
  hasReview,
  onChanged,
}: {
  applicationId: string
  status: string
  statusVersion: number
  reasons: Parameters<typeof DeskReviewForm>[0]['reasons']
  rules: Parameters<typeof DeskReviewForm>[0]['rules']
  reviewingOwnApplication: boolean
  hasReview: boolean
  onChanged: () => Promise<unknown>
}) {
  const mark = useMarker()
  const [error, setError] = useState<string | null>(null)

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
    onSuccess: onChanged,
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
      <section className={styles.card} {...mark('next-step')}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>
            {hasReview ? 'Record another review' : 'Complete the desk review'}
          </h2>
        </div>
        <div>
          <p className="muted" style={{ marginBottom: '0.75rem', fontSize: '13px' }}>
            The nine checks and the outcome are recorded together, in one write — so a
            review cannot be left half-saved. Closing this leaves the application exactly
            where it is.
          </p>
          <DeskReviewForm
            reasons={reasons}
            rules={rules}
            reviewingOwnApplication={reviewingOwnApplication}
            pending={complete.isPending}
            error={error}
            onSubmit={(draft) => complete.mutate(draft)}
          />
        </div>
      </section>
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
    section: string
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
              <span className="notice-title">{sectionTitle(revision.section)}</span>
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
    documentType: DocumentType
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
                <th scope="col" style={{ textAlign: 'right' }}>Size</th>
                <th scope="col" style={{ textAlign: 'right' }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {current.map((document) => (
                <tr key={document.id} className={styles.tableRow}>
                  <td>
                    <div className={styles.docTitleCell}>
                      <FileText size={16} className={styles.docIcon} aria-hidden="true" />
                      <span>{DOCUMENT_TITLES[document.documentType]}</span>
                      {document.documentVersion > 1 ? (
                        <span className="field-hint">
                          v{document.documentVersion}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className={styles.filenameCell} title={document.originalFilename}>
                    {document.originalFilename}
                  </td>
                  <td className={styles.sizeCell}>
                    {formatBytes(document.sizeBytes)}
                  </td>
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
        <p className="notice" data-tone="error" role="alert" style={{ marginTop: '10px' }}>
          {error}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Notes kept inside the programme office.
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
  const [text, setText] = useState('')
  const [correcting, setCorrecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: async () => {
      const data = await gql(AddInternalNoteDocument, {
        input: {
          applicationId,
          note: text.trim(),
          correctionOfNoteId: correcting,
        },
      })
      unwrap(data.admin.intake.addInternalNote)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setText('')
      setCorrecting(null)
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  const corrections = new Set(
    notes.map((note) => note.correctionOfNoteId).filter(Boolean) as string[],
  )

  return (
    <section className={styles.card} {...mark('internal-notes')}>
      <div className={styles.cardHeader}>
        <div className={styles.cardHeaderTitleGroup}>
          <h2 className={styles.cardTitle}>Internal notes</h2>
          <Lock size={14} className="muted" aria-hidden="true" />
        </div>
        <span className={styles.cardSubtitle}>Never shown to the applicant</span>
      </div>

      {notes.length === 0 ? (
        <div className={styles.notesCallout}>
          <FileText size={18} className={styles.notesCalloutIcon} aria-hidden="true" />
          <p className={styles.notesCalloutText}>
            No notes yet. Notes stay inside the office and are never shown to the
            applicant; once written, one can only be corrected by another that points at
            it.
          </p>
        </div>
      ) : (
        <div className="stack">
          {notes.map((note) => (
            <div key={note.id} className={styles.noteItem}>
              <p className={styles.noteContent}>{note.note}</p>
              <span className={styles.noteMeta}>
                {formatDateTime(note.createdAt)}
                {note.correctionOfNoteId ? ' · corrects an earlier note' : ''}
                {corrections.has(note.id) ? ' · corrected later' : ''}
              </span>
              {!note.correctionOfNoteId && !corrections.has(note.id) ? (
                <button
                  type="button"
                  className="button"
                  data-variant="ghost"
                  onClick={() => setCorrecting(note.id)}
                  style={{ alignSelf: 'flex-start', marginTop: '4px' }}
                >
                  Correct this note
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <form
        className={styles.noteForm}
        onSubmit={(event) => {
          event.preventDefault()
          add.mutate()
        }}
      >
        <input
          type="text"
          className={styles.noteInput}
          placeholder={correcting ? 'Correction note' : 'Add a note'}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className={styles.addNoteButton}
          disabled={!text.trim() || add.isPending}
        >
          {add.isPending
            ? 'Saving…'
            : correcting
              ? 'Save correction'
              : 'Add the note'}
        </button>
        {correcting ? (
          <button
            type="button"
            className="button"
            onClick={() => setCorrecting(null)}
          >
            Cancel
          </button>
        ) : null}
      </form>

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

