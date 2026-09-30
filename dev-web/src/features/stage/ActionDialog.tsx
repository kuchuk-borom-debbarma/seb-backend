/**
 * Taking one stage action: the dialog that asks what the action needs and
 * sends it.
 *
 * The action's inputs arrive as an ordinary one-stage form template, so they
 * are drawn by the applicant's own `StageForm` — money typed in rupees and
 * kept in paise, choices, dates and long text all behave exactly as they do
 * on the form, and are validated by the same engine on the server.
 *
 * What is quoted back is what the panel showed: the stage and the
 * `statusVersion`. If another officer acted in between, nothing is written and
 * the dialog says so, with a way to reload rather than a retry that would be
 * refused again.
 */
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Dialog } from '#/components/Dialog'
import type { AnswerEntry, AnswerMap, AnswerValue } from '#/features/application/answers'
import type { FieldIssues } from '#/features/application/FormControls'
import { StageForm } from '#/features/application/FormRenderer'
import { pruneHidden, resolveTemplate } from '#/features/application/formTemplate'
import workspace from '#/features/admin/Workspace.module.css'
import { TakeStageActionDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { OperationFailed, messageFor } from '#/lib/result'
import type { StageAction, StageFile } from './stageQueries'
import styles from './Stage.module.css'

/** The one stage every action's input template has. */
const INPUT_STAGE_KEY = 'ACTION_INPUTS'

/** A form section the officer asks the applicant to correct, with what to fix. */
type Correction = { stageKey: string; note: string }

/** Thrown when the inputs were refused, carrying the issues by field. */
/** The file moved on since it was read: the one refusal answered by reloading. */
class FileChanged extends Error {}

class InputsRefused extends Error {
  constructor(
    message: string,
    readonly issues: FieldIssues,
  ) {
    super(message)
  }
}

export function ActionDialog({
  file,
  action,
  sections,
  ownApplication,
  onClose,
  onDone,
}: {
  file: StageFile
  action: StageAction
  /** The file's own form sections, by key, for naming what to correct. */
  sections: readonly { key: string; title: string }[]
  /** The caller submitted this application themselves. */
  ownApplication: boolean
  onClose: () => void
  /** Called after a successful action, with a sentence saying what happened. */
  onDone: (message: string) => Promise<unknown>
}) {
  // No form at all for an action that asks nothing: an empty one still took
  // up the space of its margins, a gap above whatever came next.
  const template = useMemo(
    () =>
      action.inputForm && action.inputForm.fields.length > 0
        ? resolveTemplate(action.inputForm)
        : null,
    [action.inputForm],
  )
  const [answers, setAnswers] = useState<AnswerMap>(() => ({
    ...(action.defaults ?? {}),
  }))
  const [issues, setIssues] = useState<FieldIssues>({})
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [disclosed, setDisclosed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  const selectableSections = sections.filter((section) =>
    file.revisionStageKeys.includes(section.key),
  )

  const take = useMutation({
    mutationFn: async () => {
      const data = await gql(TakeStageActionDocument, {
        input: {
          applicationId: file.id,
          expectedStatusVersion: file.statusVersion,
          stageKey: file.stage?.key ?? '',
          actionKey: action.key,
          inputs: template ? pruneHidden(template, answers) : {},
          revisionRequests: action.requestsRevision
            ? corrections.map((correction) => ({
                stageKey: correction.stageKey,
                note: correction.note.trim(),
              }))
            : null,
          selfReviewDisclosed: ownApplication ? disclosed : null,
        },
      })
      const result = data.admin.stage.takeAction
      if (result.issues.length > 0) {
        const byField: FieldIssues = {}
        for (const issue of result.issues) byField[issue.field] = issue.message
        throw new InputsRefused(result.message ?? 'Some answers need attention.', byField)
      }
      if (result.stale) {
        throw new FileChanged(result.message ?? 'Somebody else acted on this file. Reload it and decide again.')
      }
      if (!result.success || !result.response) {
        throw new OperationFailed(result.message ?? 'The action could not be taken.')
      }
      return result.response
    },
    onMutate: () => {
      setError(null)
      setStale(false)
    },
    onSuccess: async (outcome) => {
      // A return goes to a stage the file has been through, so it is named.
      const returnedTo = file.trail.find((stage) => stage.key === outcome.stageKey)?.name
      const where = outcome.ended
        ? 'The file’s journey has ended.'
        : action.returnsFile
          ? `The file has gone back to ${returnedTo ?? 'the stage it came from'}.`
        : outcome.stageKey && outcome.stageKey !== file.stage?.key
          ? 'The file has moved on to its next stage.'
          : action.requestsRevision
            ? 'The applicant has been asked for the corrections.'
            : 'Done.'
      await onDone(`${action.label}: ${where}`)
    },
    onError: (cause) => {
      if (cause instanceof InputsRefused) {
        setIssues(cause.issues)
        /*
         * Each refusal is already shown under the input it is about; the
         * banner repeated it word for word. It is kept only for one the
         * dialog has no input to show it under.
         */
        const shown = Object.keys(cause.issues).every((key) => template?.byKey.has(key))
        if (shown) {
          setError(null)
          return
        }
      }
      setError(messageFor(cause))
      setStale(cause instanceof FileChanged)
    },
  })

  const correctionsComplete =
    !action.requestsRevision ||
    (corrections.length > 0 &&
      corrections.every((correction) => correction.note.trim().length > 0))
  const ready = correctionsComplete && (!ownApplication || disclosed) && !take.isPending

  const update = (fieldKey: string, value: AnswerValue | readonly AnswerEntry[]) => {
    setAnswers((current) => {
      const next = { ...current, [fieldKey]: value }
      return template ? pruneHidden(template, next) : next
    })
    setIssues((current) => {
      if (!current[fieldKey]) return current
      const { [fieldKey]: _cleared, ...rest } = current
      return rest
    })
  }

  const toggleSection = (stageKey: string, on: boolean) =>
    setCorrections((current) =>
      on
        ? [...current, { stageKey, note: '' }]
        : current.filter((correction) => correction.stageKey !== stageKey),
    )

  return (
    <Dialog open onClose={take.isPending ? undefined : onClose}>
      <div
        className={workspace.noteModalOverlay}
        onClick={(event) => {
          if (event.target === event.currentTarget && !take.isPending) onClose()
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-action-title"
      >
        <div className={`${workspace.noteModalDialog} ${styles.actionDialog}`}>
          <div className={workspace.noteModalHeader}>
            <div className={workspace.noteModalHeaderLeft}>
              <div>
                <h3 id="stage-action-title" className={workspace.noteModalTitle}>
                  {action.label}
                </h3>
                <p className={workspace.noteModalSubtitle}>
                  {file.referenceNumber ?? 'This application'} · at{' '}
                  {file.stage?.name ?? 'its stage'}
                </p>
              </div>
            </div>
            <button
              type="button"
              className={workspace.noteModalCloseButton}
              onClick={onClose}
              disabled={take.isPending}
              aria-label="Close"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (ready) take.mutate()
            }}
          >
            <div className={`${workspace.noteModalBody} ${styles.actionBody}`}>
              {action.description ? (
                <p className={styles.actionDescription}>{action.description}</p>
              ) : null}

              {template ? (
                <StageForm
                  template={template}
                  stageKey={INPUT_STAGE_KEY}
                  answers={answers}
                  issues={issues}
                  disabled={take.isPending}
                  onChange={update}
                />
              ) : null}

              {action.requestsRevision ? (
                <fieldset className={styles.corrections}>
                  <legend className="field-label">
                    What the applicant should correct
                  </legend>
                  <p className="field-hint">
                    Only the sections chosen here open for editing. Say what needs fixing
                    in each; the applicant reads it.
                  </p>
                  {selectableSections.length === 0 ? (
                    <p className="notice" data-tone="error">
                      This file’s form has no sections that can be reopened.
                    </p>
                  ) : (
                    selectableSections.map((section) => {
                      const chosen = corrections.find(
                        (correction) => correction.stageKey === section.key,
                      )
                      return (
                        <div key={section.key} className={styles.correctionRow}>
                          <label className={styles.checkLine}>
                            <input
                              type="checkbox"
                              checked={Boolean(chosen)}
                              disabled={take.isPending}
                              onChange={(event) =>
                                toggleSection(section.key, event.target.checked)
                              }
                            />
                            <span>{section.title}</span>
                          </label>
                          {chosen ? (
                            <textarea
                              className="textarea"
                              rows={2}
                              aria-label={`What to correct in ${section.title}`}
                              placeholder="What needs correcting in this section…"
                              value={chosen.note}
                              disabled={take.isPending}
                              onChange={(event) =>
                                setCorrections((current) =>
                                  current.map((correction) =>
                                    correction.stageKey === section.key
                                      ? { ...correction, note: event.target.value }
                                      : correction,
                                  ),
                                )
                              }
                            />
                          ) : null}
                        </div>
                      )
                    })
                  )}
                </fieldset>
              ) : null}

              {ownApplication ? (
                <label className={`${styles.checkLine} ${styles.disclosure}`}>
                  <input
                    type="checkbox"
                    checked={disclosed}
                    disabled={take.isPending}
                    onChange={(event) => setDisclosed(event.target.checked)}
                  />
                  <span>
                    This is my own application, and I am acting on it knowingly. This is
                    recorded in the activity history.
                  </span>
                </label>
              ) : null}

              {action.confirmation ? (
                <p
                  className="notice"
                  data-tone="action"
                  // The icon beside its sentence, not on a line of its own.
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}
                >
                  <AlertTriangle size={14} aria-hidden="true" style={{ flex: 'none', marginTop: '3px' }} />
                  <span>{action.confirmation}</span>
                </p>
              ) : null}

              {error ? (
                <div className="notice" data-tone="error" role="alert">
                  {error}
                  {stale ? (
                    <div style={{ marginTop: '8px' }}>
                      <button
                        type="button"
                        className="button"
                        onClick={() => void onDone('')}
                      >
                        Reload the file
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className={workspace.noteModalFooter}>
              <button
                type="button"
                className="button"
                onClick={onClose}
                disabled={take.isPending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={workspace.primaryActionButton}
                disabled={!ready}
              >
                {take.isPending ? 'Working…' : action.label}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Dialog>
  )
}
