/**
 * Where a file stands in its pipeline, and what may be done to it next.
 *
 * Everything here is read from the file's stage view in one call: its stage
 * (or how its journey ended), its flags and recorded values, the trail it came
 * along, the corrections it waits on, its stage history, and the actions its
 * stage offers. Whether the caller may take each action is the API's answer —
 * the same check `takeAction` runs — so a button is offered only when the next
 * request would accept it, and one that would not says why instead of failing.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowRightLeft,
  CircleCheck,
  Clock,
  History,
  Undo2,
  UserRound,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Dialog } from '#/components/Dialog'
import { OFFICE_HELP } from '#/features/admin/officeGuidance'
import { waitingFor } from '#/features/admin/queues'
import { Explain } from '#/features/guide/Explain'
import workspace from '#/features/admin/Workspace.module.css'
import { WithdrawRevisionDocument } from '#/graphql/generated/operations'
import { formatDateTime, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { useCurrentUser } from '#/lib/session'
import { ActionDialog } from './ActionDialog'
import { FlagChips, Trail, ValueList } from './StageBits'
import { stageApplicationQuery, type StageAction, type StageFile } from './stageQueries'
import styles from './Stage.module.css'

type Revision = { id: string; stageKey: string; note: string; requestedAt: string }

export function StagePanel({
  applicationId,
  sections,
  revisions,
  onChanged,
}: {
  applicationId: string
  /** The file's own form sections, for naming corrections. */
  sections: readonly { key: string; title: string }[]
  /** The workspace's open revision requests, which carry the officer's notes. */
  revisions: readonly Revision[]
  /** Re-reads everything the page shows after a write. */
  onChanged: () => Promise<unknown>
}) {
  const user = useCurrentUser()
  const { data: file, error } = useQuery(stageApplicationQuery(applicationId))
  const [acting, setActing] = useState<StageAction | null>(null)
  const [withdrawing, setWithdrawing] = useState<Revision | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (error) {
    return (
      <section className={workspace.card}>
        <div className={workspace.cardHeader}>
          <h2 className={workspace.cardTitle}>Stage</h2>
        </div>
        <p className="notice" data-tone="error">
          {messageFor(error)}
        </p>
      </section>
    )
  }
  if (!file) return null

  const sectionTitle = (key: string) =>
    sections.find((section) => section.key === key)?.title ?? humanize(key)
  const ownApplication = Boolean(user && user.id === file.applicantUserId)
  const openRevisions = revisions.filter((revision) =>
    file.openRevisions.some((open) => open.id === revision.id),
  )

  const finish = async (message: string) => {
    setActing(null)
    setWithdrawing(null)
    setDone(message || null)
    await onChanged()
  }

  return (
    <section className={workspace.card} aria-labelledby="stage-panel-title">
      <div className={workspace.cardHeader}>
        <h2 id="stage-panel-title" className={workspace.cardTitle}>
          {file.ended ? 'Journey finished' : 'Stage'}
        </h2>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <span className={workspace.headerMeta}>
            Pipeline version {file.pipelineVersion}
          </span>
          <Explain label="stage actions" opener="How stage actions work">
            {OFFICE_HELP.stageActions}
          </Explain>
        </span>
      </div>

      <div className={styles.standing} data-ended={file.ended ? 'true' : undefined}>
        {file.ended ? (
          <>
            <CircleCheck size={20} aria-hidden="true" className={styles.standingIcon} />
            <div>
              <p className={styles.standingTitle}>Ended as {file.ended.label}</p>
              <p className={styles.standingText}>
                No stage holds this file any more, and no action is offered.
              </p>
            </div>
          </>
        ) : file.stage ? (
          <>
            <ArrowRightLeft
              size={20}
              aria-hidden="true"
              className={styles.standingIcon}
            />
            <div>
              <p className={styles.standingTitle}>At {file.stage.name}</p>
              <p className={styles.standingText}>
                {file.stageEnteredAt
                  ? `Arrived ${formatDateTime(file.stageEnteredAt)} · waiting ${waitingFor(file.stageEnteredAt).toLowerCase()}`
                  : null}
                {file.stage.description ? (
                  <>
                    <br />
                    {file.stage.description}
                  </>
                ) : null}
              </p>
              <p className={styles.standingText}>
                The applicant is told: <q>{file.stage.applicantLabel}</q>
              </p>
            </div>
          </>
        ) : null}
      </div>

      <Trail trail={file.trail} current={file.stage?.name ?? null} />

      <div className={styles.panelBlock}>
        <h3 className={styles.blockTitle}>Status</h3>
        <FlagChips flags={file.flags} empty="No status flags yet." />
      </div>

      {file.recordedValues.length > 0 ? (
        <div className={styles.panelBlock}>
          <h3 className={styles.blockTitle}>Recorded</h3>
          <ValueList values={file.recordedValues} />
        </div>
      ) : null}

      {file.awaitingApplicant ? (
        <div className={styles.panelBlock}>
          <h3 className={styles.blockTitle}>Waiting on the applicant</h3>
          <p className="field-hint">
            No action is offered while the applicant is correcting the file. It comes back
            to {file.stage?.name ?? 'this stage'} when they resubmit.
          </p>
          <ul className={styles.revisionList}>
            {openRevisions.map((revision) => (
              <li key={revision.id} className={styles.revisionItem}>
                <div>
                  <strong>{sectionTitle(revision.stageKey)}</strong>
                  <p>{revision.note}</p>
                  <span className="field-hint">
                    Requested {formatDateTime(revision.requestedAt)}
                  </span>
                </div>
                {file.canWithdrawRevision ? (
                  <button
                    type="button"
                    className="button"
                    onClick={() => setWithdrawing(revision)}
                  >
                    <Undo2 size={14} aria-hidden="true" /> Withdraw
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {done ? (
        <p className="notice" data-tone="ok" role="status">
          {done}
        </p>
      ) : null}

      {!file.ended && !file.awaitingApplicant ? (
        <div className={styles.panelBlock}>
          <h3 className={styles.blockTitle}>Actions</h3>
          {file.actions.length === 0 ? (
            <p className="muted">
              Nothing is offered at this stage for this file right now.
            </p>
          ) : (
            <div className={styles.actionGrid}>
              {file.actions.map((action) => (
                <div key={action.key} className={styles.actionCard}>
                  <button
                    type="button"
                    className={
                      action.permitted ? workspace.primaryActionButton : 'button'
                    }
                    disabled={!action.permitted}
                    aria-describedby={action.permitted ? undefined : `why-${action.key}`}
                    onClick={() => {
                      setDone(null)
                      setActing(action)
                    }}
                  >
                    {action.label}
                  </button>
                  {action.description ? (
                    <span className="field-hint">{action.description}</span>
                  ) : null}
                  {action.permitted ? null : (
                    <span id={`why-${action.key}`} className="field-hint">
                      {file.worksStage
                        ? 'Your roles do not carry every permission this action needs.'
                        : `Taken by the roles that work ${file.stage?.name ?? 'this stage'}.`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <StageHistory history={file.history} sectionTitle={sectionTitle} />

      {acting ? (
        <ActionDialog
          file={file}
          action={acting}
          sections={sections}
          ownApplication={ownApplication}
          onClose={() => setActing(null)}
          onDone={finish}
        />
      ) : null}
      {withdrawing ? (
        <WithdrawDialog
          file={file}
          revision={withdrawing}
          sectionTitle={sectionTitle(withdrawing.stageKey)}
          onClose={() => setWithdrawing(null)}
          onDone={finish}
        />
      ) : null}
    </section>
  )
}

/** Every action taken on this file, newest first, with what each did. */
function StageHistory({
  history,
  sectionTitle,
}: {
  history: StageFile['history']
  sectionTitle: (key: string) => string
}) {
  if (history.length === 0) return null
  const newestFirst = [...history].reverse()
  return (
    <div className={styles.panelBlock}>
      <h3 className={styles.blockTitle}>
        <History size={14} aria-hidden="true" /> Stage history
      </h3>
      <ol className={styles.history}>
        {newestFirst.map((entry) => (
          <li key={entry.id} className={styles.historyItem}>
            <div className={styles.historyHead}>
              <strong>{entry.actionLabel}</strong>
              <span className="muted">
                {' '}
                at {entry.stageName ?? humanize(entry.stageKey)}
              </span>
              {entry.toStageName ? (
                <span className="muted"> → {entry.toStageName}</span>
              ) : null}
            </div>
            <div className={styles.historyMeta}>
              <UserRound size={12} aria-hidden="true" /> {entry.actor.email}
              <Clock size={12} aria-hidden="true" /> {formatDateTime(entry.createdAt)}
              {entry.selfReviewDisclosed ? (
                <span className={styles.chip} data-tone="outcome">
                  Own application, disclosed
                </span>
              ) : null}
            </div>
            {entry.flagsAdded.length > 0 || entry.flagsRemoved.length > 0 ? (
              <p className={styles.historyLine}>
                {entry.flagsAdded.length > 0 ? (
                  <>Added {entry.flagsAdded.join(', ')}. </>
                ) : null}
                {entry.flagsRemoved.length > 0 ? (
                  <>Removed {entry.flagsRemoved.join(', ')}.</>
                ) : null}
              </p>
            ) : null}
            {entry.revisionStageKeys.length > 0 ? (
              <p className={styles.historyLine}>
                Asked for corrections to{' '}
                {entry.revisionStageKeys.map(sectionTitle).join(', ')}.
              </p>
            ) : null}
            <ValueList values={entry.inputs} />
            {entry.recorded.length > 0 ? (
              <>
                <p className={styles.historyLine}>Recorded on the file:</p>
                <ValueList values={entry.recorded} />
              </>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * Withdrawing a correction asked for in error. A reason is required, because
 * the applicant was told about it and the history must say why it went away.
 */
function WithdrawDialog({
  file,
  revision,
  sectionTitle,
  onClose,
  onDone,
}: {
  file: StageFile
  revision: Revision
  sectionTitle: string
  onClose: () => void
  onDone: (message: string) => Promise<unknown>
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const withdraw = useMutation({
    mutationFn: async () => {
      const data = await gql(WithdrawRevisionDocument, {
        input: {
          applicationId: file.id,
          expectedStatusVersion: file.statusVersion,
          revisionRequestId: revision.id,
          reason: reason.trim(),
        },
      })
      return unwrap(data.admin.stage.withdrawRevision)
    },
    onMutate: () => setError(null),
    onSuccess: (result) =>
      onDone(
        result.openRevisionCount === 0
          ? 'Correction withdrawn. The file is back with the office at this stage.'
          : 'Correction withdrawn.',
      ),
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <Dialog open onClose={withdraw.isPending ? undefined : onClose}>
      <div
        className={workspace.noteModalOverlay}
        onClick={(event) => {
          if (event.target === event.currentTarget && !withdraw.isPending) onClose()
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-title"
      >
        <div className={workspace.noteModalDialog}>
          <div className={workspace.noteModalHeader}>
            <div className={workspace.noteModalHeaderLeft}>
              <div>
                <h3 id="withdraw-title" className={workspace.noteModalTitle}>
                  Withdraw the correction to {sectionTitle}
                </h3>
                <p className={workspace.noteModalSubtitle}>
                  The applicant will no longer be asked to change this section.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={workspace.noteModalCloseButton}
              onClick={onClose}
              aria-label="Close"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (reason.trim()) withdraw.mutate()
            }}
          >
            <div className={workspace.noteModalBody}>
              <blockquote className={workspace.earlierNoteQuote}>
                {revision.note}
              </blockquote>
              <label className="field-label" htmlFor="withdraw-reason">
                Why it is withdrawn
              </label>
              <textarea
                id="withdraw-reason"
                className="textarea"
                rows={3}
                value={reason}
                autoFocus
                onChange={(event) => setReason(event.target.value)}
              />
              {error ? (
                <p className="notice" data-tone="error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className={workspace.noteModalFooter}>
              <button
                type="button"
                className="button"
                onClick={onClose}
                disabled={withdraw.isPending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={workspace.primaryActionButton}
                disabled={!reason.trim() || withdraw.isPending}
              >
                {withdraw.isPending ? 'Withdrawing…' : 'Withdraw correction'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Dialog>
  )
}
