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
import { PageHeader } from '#/components/PageHeader'
import { AssignmentControls } from '#/features/admin/AssignmentControls'
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
import {
  AddInternalNoteDocument,
  AdminDocumentDownloadUrlDocument,
  CancelRevisionDocument,
  CompleteDeskReviewDocument,
  StartDeskReviewDocument,
} from '#/graphql/generated/operations'
import type { DocumentType } from '#/graphql/generated/schema'
import { formatDateTime, humanize } from '#/lib/format'
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
    <main className="page">
      <PageHeader
        title={application.referenceNumber ?? 'Unreferenced application'}
        meta={`${workspace.enterpriseName ?? 'Unknown enterprise'} · ${workspace.cycleDisplayName ?? workspace.cycleCode ?? ''}`}
        description={OFFICE_LEDES.workspace}
        actions={
          <>
            <span className="badge" data-tone={statusTone(application.status)}>
              {humanize(application.status)}
            </span>
            {/* Money outlives the review, so the funding screen is offered
                from the moment a sanction order can exist. */}
            {FUNDED_STATUSES.has(application.status) ? (
              <Link
                to="/admin/applications/$id/funding"
                params={{ id }}
                className="button"
              >
                Funding
              </Link>
            ) : null}
            <Link to="/admin/queue" className="button">
              Back to the queue
            </Link>
          </>
        }
      />

      <div className="stack">
        <AssignmentControls
          applicationId={id}
          assignedToUserId={application.assignedToUserId ?? null}
          assignedTo={application.assignedTo ?? null}
          assignedAt={application.assignedAt ?? null}
          assignmentVersion={application.assignmentVersion}
          reasons={reasons}
          onChanged={refresh}
        />

        <NextStep
          applicationId={id}
          status={application.status}
          statusVersion={application.statusVersion}
          reasons={reasons}
          hasReview={workspace.reviews.length > 0}
          onChanged={refresh}
        />

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

        <CommitteeStage
          applicationId={id}
          status={application.status}
          statusVersion={application.statusVersion}
          latestSubmissionId={latestSubmission?.id}
          latestBankOutcomeId={workspace.bankOutcomes.at(-1)?.id}
          agenda={workspace.agenda}
          decisions={workspace.decisions}
          reasons={reasons}
          onChanged={refresh}
        />

        {openRevisions.length > 0 ? (
          <OpenRevisions
            applicationId={id}
            statusVersion={application.statusVersion}
            revisions={openRevisions}
            onChanged={refresh}
          />
        ) : null}

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Submissions</p>
            <span className="muted">
              {workspace.submissions.length}{' '}
              {workspace.submissions.length === 1 ? 'submission' : 'submissions'}
            </span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">
                Submissions of this application
              </caption>
              <thead>
                <tr>
                  <th scope="col">No.</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">What changed</th>
                </tr>
              </thead>
              <tbody>
                {workspace.submissions.map((submission) => {
                  const change = workspace.submissionChanges.find(
                    (entry) => entry.toSubmissionNumber === submission.submissionNumber,
                  )
                  return (
                    <tr key={submission.id}>
                      <td className="tabular">{submission.submissionNumber}</td>
                      <td>{formatDateTime(submission.submittedAt)}</td>
                      <td>
                        {change ? (
                          change.sections
                            .map((section) => SECTION_TITLES[section])
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

        <InternalNotes applicationId={id} notes={workspace.notes} onChanged={refresh} />

        {workspace.reviews.length > 0 ? (
          <section className="card">
            <div className="card-header">
              <p className="eyebrow">Desk reviews</p>
            </div>
            <div className="table-wrap">
              <table className="table">
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
                    <tr key={review.id}>
                      <td>{humanize(review.outcome)}</td>
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

        <section className="card">
          <div className="card-header">
            <p className="eyebrow">Who has held this</p>
          </div>
          {workspace.assignments.length === 0 ? (
            <div className="card-body">
              <p className="muted">
                Nobody has claimed this application yet. Claiming records who holds the
                next decision — until somebody does, nothing on it can be actioned.
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
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
                    <tr key={event.id}>
                      <td>{formatDateTime(event.createdAt)}</td>
                      <td>
                        {humanize(event.eventType)}
                        {event.conflictAcknowledged ? (
                          <span className="field-hint">
                            Taken from somebody else, acknowledged
                          </span>
                        ) : null}
                      </td>
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
  hasReview,
  onChanged,
}: {
  applicationId: string
  status: string
  statusVersion: number
  reasons: Parameters<typeof DeskReviewForm>[0]['reasons']
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
      <section className="card" {...mark('next-step')}>
        <div className="card-header">
          <div>
            <p className="eyebrow">Next</p>
            <h3>Start the desk review</h3>
          </div>
          <button
            type="button"
            className="button"
            data-variant="primary"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? 'Starting…' : 'Start desk review'}
          </button>
        </div>
        <div className="card-body">
          <p className="muted">
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
      <section className="card" {...mark('next-step')}>
        <div className="card-header">
          <div>
            <p className="eyebrow">Next</p>
            <h3>{hasReview ? 'Record another review' : 'Complete the desk review'}</h3>
          </div>
        </div>
        <div className="card-body">
          <p className="muted" style={{ marginBottom: '0.75rem' }}>
            The nine checks and the outcome are recorded together, in one write — so a
            review cannot be left half-saved. Closing this leaves the application exactly
            where it is.
          </p>
          <DeskReviewForm
            reasons={reasons}
            pending={complete.isPending}
            error={error}
            onSubmit={(draft) => complete.mutate(draft)}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="card">
      <div className="card-body">
        <p className="muted">
          Nothing to do here at the moment — this application is{' '}
          {humanize(status).toLowerCase()}.
        </p>
      </div>
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
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">Waiting on the applicant</p>
      </div>
      <div className="card-body">
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
      </div>
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

  // Documents from earlier submissions are kept, but the ones being reviewed
  // now are the ones frozen into the latest submission.
  const current = documents.filter(
    (document) => document.submissionId === latestSubmissionId,
  )

  return (
    <section className="card">
      <div className="card-header">
        <div className="label-row">
          <p className="eyebrow">Documents</p>
          <Explain label="documents" opener="Which documents a review reads">
            {OFFICE_HELP.frozenEvidence}
          </Explain>
        </div>
      </div>
      {current.length === 0 ? (
        <div className="card-body">
          {/* Two different facts. Saying "none" when earlier submissions carry
              documents would report the filter as if it were the application. */}
          <p className="muted">
            {documents.length === 0
              ? 'Nothing has been attached to this application.'
              : `The latest submission carries no documents. ${documents.length} from earlier ` +
                'submissions are kept, but a review reads only what its own submission froze.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Documents in this submission</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {current.map((document) => (
                <tr key={document.id}>
                  <td>
                    {DOCUMENT_TITLES[document.documentType]}
                    {document.documentVersion > 1 ? (
                      <span className="field-hint">
                        version {document.documentVersion}
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular">{document.originalFilename}</td>
                  <td className="tabular">{formatBytes(document.sizeBytes)}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
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
        <div className="card-body">
          <p className="notice" data-tone="error" role="alert">
            {error}
          </p>
        </div>
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
    <section className="card" {...mark('internal-notes')}>
      <div className="card-header">
        <p className="eyebrow">Internal notes</p>
        <span className="muted">Never shown to the applicant</span>
      </div>
      <div className="card-body">
        {notes.length === 0 ? (
          <p className="muted">
            No notes yet. Notes stay inside the office and are never shown to the
            applicant; once written, one can only be corrected by another that points at
            it.
          </p>
        ) : (
          <div className="stack">
            {notes.map((note) => (
              <div
                key={note.id}
                className={corrections.has(note.id) ? 'muted' : undefined}
              >
                <p style={{ whiteSpace: 'pre-wrap' }}>{note.note}</p>
                <span className="field-hint">
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
                  >
                    Correct this note
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <form
          style={{ marginTop: '1rem' }}
          onSubmit={(event) => {
            event.preventDefault()
            add.mutate()
          }}
        >
          <label className="field-label" htmlFor="note">
            {correcting ? 'Correction' : 'Add a note'}
          </label>
          <textarea
            id="note"
            className="textarea"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="row" style={{ marginTop: '0.5rem' }}>
            <button
              type="submit"
              className="button"
              disabled={!text.trim() || add.isPending}
            >
              {add.isPending
                ? 'Saving…'
                : correcting
                  ? 'Save the correction'
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
          </div>
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
      </div>
    </section>
  )
}
