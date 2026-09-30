/**
 * One application, as the programme office works on it.
 *
 * The screen is ordered by what an officer does, not by how the data is stored:
 * where the file is in its pipeline, what was submitted, what has been said
 * about it, and then the record of everything that has happened.
 *
 * What may be done next is the pipeline's: the actions the file's current
 * stage offers, to the roles that own it, drawn by the stage panel from the
 * file's own stage view.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ArrowLeft,
  ClipboardList,
  FileText,
  Lock,
  Plus,
  X,
} from 'lucide-react'
import { AuditTimeline } from '#/features/audit/AuditTimeline'
import { auditEventsQuery } from '#/features/audit/auditEvents'
import { statusTone } from '#/features/admin/queues'
import { workspaceQuery } from '#/features/admin/workspaceQueries'
import { formatBytes } from '#/features/application/documents'
import { fieldLabel, stageTitle } from '#/features/application/draft'
import styles from '#/features/admin/Workspace.module.css'
import {
  AddInternalNoteDocument,
  AdminDocumentDownloadUrlDocument,
} from '#/graphql/generated/operations'
import { Dialog } from '#/components/Dialog'
import { formatDateTime, humanize } from '#/lib/format'
import { can, useCurrentUser } from '#/lib/session'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { useMarker } from '#/features/guide/GuideContext'
import { StagePanel } from '#/features/stage/StagePanel'
import { stageApplicationQuery } from '#/features/stage/stageQueries'
import { AnswerSummary } from '#/features/application/AnswerSummary'
import { resolveTemplate } from '#/features/application/formTemplate'
import type { AnswerMap } from '#/features/application/answers'

export const Route = createFileRoute('/_shell/admin/applications/$id/')({
  /*
   * The stage view is asked for alongside the workspace, not after it: the
   * panel that reads it only mounts once the workspace is in, so fetching it
   * there put a second full round trip in front of the actions an officer
   * came to take. A refusal (a draft, a file this officer cannot see) is left
   * for the panel to show, so it must not fail the page.
   */
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceQuery(params.id)),
      context.queryClient.prefetchQuery(stageApplicationQuery(params.id)),
      // The activity slice, for the reader of the history it is drawn for,
      // with the same arguments the timeline asks with.
      can(context.user, 'audit', 'read')
        ? context.queryClient.prefetchQuery(
            auditEventsQuery({
              first: 10,
              after: null,
              oldest: false,
              filter: { applicationId: params.id },
            }),
          )
        : undefined,
    ])
  },
  component: WorkspacePage,
})

function WorkspacePage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  // Loaded by the shell for every signed-in screen; it decides only whether
  // the activity history is drawn, which the API guards on its own.
  const { user: viewer } = Route.useRouteContext()
  const { data: workspace } = useQuery(workspaceQuery(id))
  const mark = useMarker()

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workspace', id] })
  /*
   * After a stage action, everything the page shows may have changed: the
   * stage view, the workspace's flags and revisions, and any list the file
   * sits in. The lists are marked stale rather than refetched now.
   */
  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['stage-application', id] }),
      refresh(),
      queryClient.invalidateQueries({ queryKey: ['stage-queue'] }),
      queryClient.invalidateQueries({ queryKey: ['my-stages'] }),
      queryClient.invalidateQueries({ queryKey: ['intake-queue'] }),
    ])

  if (!workspace?.application) return null
  const application = workspace.application

  const openRevisions = workspace.revisions.filter(
    (revision) => !revision.resolvedAt && !revision.cancelledAt,
  )
  const latestSubmission = workspace.submissions.at(-1)
  const sections = (workspace.formTemplate?.stages ?? []).map((stage) => ({
    key: stage.key,
    title: stage.title,
  }))
  /*
   * Names from the pinned form, not from a table of keys in this client: a
   * cycle's author chooses them, and "ST certificate" for a question the form
   * calls "Scheduled Tribe certificate" makes the officer translate.
   */
  const fieldLabels = new Map(
    (workspace.formTemplate?.fields ?? []).map((field) => [field.key, field.label]),
  )
  const documentLabel = (fieldKey: string) => fieldLabels.get(fieldKey) ?? fieldLabel(fieldKey)
  const sectionTitle = (stageKey: string) =>
    sections.find((section) => section.key === stageKey)?.title ?? stageTitle(stageKey)
  // A stage officer may work files without reading the office-wide list.
  const mayReadList = can(viewer, 'application', 'read')

  /*
   * The submitted form: the snapshot the latest submission froze, read against
   * the same pinned template. Null when either is missing.
   */
  const submittedView = (() => {
    if (!workspace.formTemplate || !latestSubmission) return null
    const snapshot = workspace.snapshots.find(
      (each) => each.version === latestSubmission.applicationVersion,
    )
    if (!snapshot) return null
    const resolved = resolveTemplate(workspace.formTemplate)
    // The sections sent back to the applicant, marked where they are read.
    const reopened = new Set(openRevisions.map((revision) => revision.stageKey))
    return (
      <AnswerSummary
        template={resolved}
        answers={snapshot.answers as AnswerMap}
        stageAction={(stageKey) =>
          reopened.has(stageKey) ? (
            <span className="badge" data-tone="warn">
              Correction asked
            </span>
          ) : null
        }
      />
    )
  })()

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
            {mayReadList ? (
              <Link to="/admin/queue" className={styles.backButton}>
                <ArrowLeft size={15} aria-hidden="true" />
                All applications
              </Link>
            ) : (
              <Link to="/admin/stages" className={styles.backButton}>
                <ArrowLeft size={15} aria-hidden="true" />
                My stages
              </Link>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {/* Where a submitted file stands is the stage panel's to say, in the
              pipeline's own words; "In pipeline" here only repeated it. */}
          {application.status === 'DRAFT' ? (
            <span className={styles.statusPill} data-tone={statusTone(application.status)}>
              Draft
            </span>
          ) : null}
          <span className={styles.statusPill}>
            {humanize(application.applicationKind)}
          </span>
        </div>
      </div>

      {/*
        Two columns, ordered by what an officer does. The wide one is the file
        itself — the answers and the documents, which are what a decision is
        made on. The narrow one is what to do about it: the stage and its
        actions, the office's notes, and the file's history. Below the
        breakpoint the side column comes first, so the actions are not buried
        under the whole form.
      */}
      <div className={styles.mainGrid}>
        <div className={styles.mainColumn}>
          {submittedView ? (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>What was submitted</h2>
                {latestSubmission ? (
                  <span className={styles.headerMeta}>
                    Submission {latestSubmission.submissionNumber} ·{' '}
                    {formatDateTime(latestSubmission.submittedAt)}
                  </span>
                ) : null}
              </div>
              {submittedView}
            </section>
          ) : null}

          <Documents
            applicationId={id}
            documents={workspace.documents}
            latestSubmissionId={latestSubmission?.id}
            labelOf={documentLabel}
          />
        </div>

        <div className={styles.sideColumn}>
          {/*
            Where the file stands in its pipeline and what may be done next:
            its stage, flags, recorded values, the corrections it waits on,
            its stage history and the actions offered to this caller.
          */}
          {application.status === 'DRAFT' ? null : (
            <div {...mark('next-step')}>
              <StagePanel
                applicationId={id}
                sections={sections}
                revisions={openRevisions}
                onChanged={refreshAll}
              />
            </div>
          )}

          <InternalNotes applicationId={id} notes={workspace.notes} onChanged={refresh} />

          {/*
            Where this attempt sits in the enterprise's journey. The programme
            funds an enterprise one phase at a time, and a reviewer placing a
            file needs to see at a glance whether it is a first try, a retry
            after a rejection, or a later phase after funding.
          */}
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Enterprise journey</h2>
              <span className={styles.headerMeta}>
                {workspace.caseHistory.length}{' '}
                {workspace.caseHistory.length === 1 ? 'attempt' : 'attempts'}
              </span>
            </div>
            <div className="stack" style={{ gap: '0.5rem' }}>
              {workspace.caseHistory.map((attempt) => {
                const current = attempt.id === application.id
                return (
                  <div
                    key={attempt.id}
                    className="row"
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      // Several flags make a long badge; in the side column it
                      // wraps under the attempt rather than running off the card.
                      flexWrap: 'wrap',
                      gap: '0.35rem 0.5rem',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '8px',
                      border: current ? '1px solid #b7cdea' : '1px solid transparent',
                      background: current ? '#eef4fc' : 'transparent',
                      fontSize: '13px',
                    }}
                  >
                    <span>
                      <strong>
                        Phase {attempt.phaseNumber} · {humanize(attempt.applicationKind)}
                      </strong>{' '}
                      <span className="muted">
                        {attempt.referenceNumber ?? 'unsubmitted draft'} · cycle{' '}
                        {attempt.cycleCode}
                        {current ? ' · this file' : ''}
                      </span>
                    </span>
                    <span
                      className="badge"
                      data-tone={statusTone(attempt.status)}
                      style={{ whiteSpace: 'normal', maxWidth: '100%' }}
                    >
                      {attempt.statusFlags.length > 0
                        ? attempt.statusFlags.map(humanize).join(', ')
                        : humanize(attempt.status)}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

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
                              .map((stageKey) => sectionTitle(stageKey))
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

        </div>
      </div>

      {/*
        Everything that happened to this file — its documents, notes and stage
        actions as well as the application itself — from the history. Drawn only for a reader of the history, who is the only
        person the API would answer.
      */}
      {can(viewer, 'audit', 'read') ? (
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Activity</h2>
          </div>
          <div className="card-body">
            <AuditTimeline filter={{ applicationId: id }} link={{ application: id }} />
          </div>
        </section>
      ) : null}
    </main>
  )
}

/** The documents frozen into each submission, newest submission first. */
function Documents({
  applicationId,
  documents,
  latestSubmissionId,
  labelOf,
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
  /** The form's own name for the question a document answers. */
  labelOf: (fieldKey: string) => string
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
                      <span>{labelOf(document.fieldKey)}</span>
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
  /*
   * Reading casework and writing on it are separate permissions. The notes are
   * part of the workspace `application`/`read` opens, so a role composed to
   * read one was offered "Add note" and a correction on every note, and the
   * API refused both.
   */
  const mayNote = can(useCurrentUser(), 'application', 'note')

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

        {mayNote ? (
          <button
            type="button"
            className={styles.addNoteTriggerButton}
            onClick={openAddModal}
          >
            <Plus size={14} aria-hidden="true" />
            Add note
          </button>
        ) : null}
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
                {mayNote && !note.correctionOfNoteId && !corrections.has(note.id) ? (
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
        <Dialog open onClose={closeModal}>
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
        </Dialog>
      ) : null}
    </section>
  )
}
