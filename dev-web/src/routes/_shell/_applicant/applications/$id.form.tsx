import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useBlocker, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, LogOut, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CategoryHint } from '#/features/application/CategoryHint'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import { cyclesQuery } from '#/features/application/queries'
import {
  ATTACH_EVIDENCE,
  ApplicationJourney,
  isDocumentIssue,
  issuesForStep,
  journeySteps,
  stageForField,
} from '#/features/application/ApplicationJourney'
import type { AnswerEntry, AnswerMap, AnswerValue } from '#/features/application/answers'
import type { FieldIssues } from '#/features/application/FormControls'
import { StageForm } from '#/features/application/FormRenderer'
import { brokenFormRules } from '#/features/application/formRules'
import { pruneHidden, resolveTemplate, visibleFields } from '#/features/application/formTemplate'
import {
  applicationQuery,
  formTemplateQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import { SaveApplicationDraftDocument } from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import styles from './DraftForm.module.css'
import { awaitingCorrection } from '#/features/application/revision'

/*
 * One object, so a stage with no issues gets the identical reference every
 * render and its memo comparison holds. A fresh `{}` would defeat it.
 */
const EMPTY_ISSUES: FieldIssues = {}

/**
 * Whether two answer sets say the same thing.
 *
 * A structural compare rather than `JSON.stringify`, whose result depends on
 * key insertion order — two identical answer sets built by different code paths
 * would compare unequal and read as unsaved changes that change nothing.
 */
const sameAnswers = (previous: AnswerMap, next: AnswerMap): boolean => {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    const left = previous[key]
    const right = next[key]
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return false
      if (left.length !== right.length) return false
      for (const [index, item] of left.entries()) {
        const other = right[index]
        if (item !== null && typeof item === 'object') {
          if (other === null || typeof other !== 'object') return false
          const members = new Set([...Object.keys(item), ...Object.keys(other)])
          for (const member of members) {
            if (
              (item as Record<string, unknown>)[member] !==
              (other as Record<string, unknown>)[member]
            ) {
              return false
            }
          }
          continue
        }
        if (item !== other) return false
      }
      continue
    }
    if (left !== right) return false
  }
  return true
}

export const Route = createFileRoute('/_shell/_applicant/applications/$id/form')({
  // The stage keys are the template's own, so the address can only be checked
  // against them once the template is loaded — the component does that.
  validateSearch: (search: Record<string, unknown>): { stage?: string } => ({
    stage: typeof search.stage === 'string' ? search.stage : undefined,
  }),
  loader: ({ context, params }) =>
    Promise.all([
      loadApplication(context.queryClient, params.id),
      // Read by the closing notice as the page mounts; asked for here so it
      // travels in the same request as the application rather than after it.
      context.queryClient.prefetchQuery(cyclesQuery),
    ]),
  component: DraftFormPage,
})

/*
 * Where the answers on screen stand against the server.
 *
 * Saving is the applicant's own act — a Save button, and "Save & next" —
 * never a timer. `unsaved` is the one state with something to lose, and what
 * arms the leave-the-page guards.
 */
type SaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'failed'

function DraftFormPage() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: validation } = useQuery(validationQuery(id))
  const { data: rawTemplate } = useQuery(formTemplateQuery(id))
  const template = useMemo(
    () => (rawTemplate ? resolveTemplate(rawTemplate) : null),
    [rawTemplate],
  )

  const [answers, setAnswers] = useState<AnswerMap | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [advanceIssueCount, setAdvanceIssueCount] = useState<number | null>(null)
  /*
   * The stages whose problems are on show.
   *
   * A stage nobody has tried to finish yet is not wrong, only unfinished, so
   * it opens without a single red mark. Its problems appear once the applicant
   * presses "Save & next" there, or arrives from the review page to fix one.
   */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  /*
   * The questions changed since the server last checked the answers.
   *
   * The server's report is only as fresh as the last save, so its complaint
   * about a question the applicant has since answered would still be on show —
   * "add at least one owner" under the owner just added. Its issues for these
   * questions are set aside until the next report; the cross-field rules are
   * checked live and are unaffected.
   */
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set())
  const reveal = (stageKey: string) =>
    setRevealed((shown) => (shown.has(stageKey) ? shown : new Set([...shown, stageKey])))
  const latest = useRef<AnswerMap | null>(null)

  /*
   * What was last agreed with the server. "Unsaved" compares against this
   * rather than against the query data, because the query is refetched after a
   * save and would otherwise race the comparison.
   */
  const persisted = useRef<AnswerMap | null>(null)

  // Seeded once from the server, then owned locally. Re-seeding on every
  // refetch would overwrite whatever is being typed.
  useEffect(() => {
    if (answers || !application) return
    persisted.current = application.answers
    /*
     * The freshest answers, readable without waiting for a render.
     *
     * `answers` reaches a memoised stage as of whenever that stage last
     * rendered; this is what a change merges against, so an edit in one stage
     * cannot be built on a map that predates an edit in another.
     */
    latest.current = application.answers
    setAnswers(application.answers)
  }, [application, answers])

  const save = useMutation({
    mutationFn: async (next: AnswerMap) => {
      const data = await gql(SaveApplicationDraftDocument, {
        input: {
          applicationId: id,
          // Optimistic concurrency: a save built on a stale copy is refused
          // rather than overwriting a newer one.
          expectedVersion: application?.currentVersion ?? 0,
          expectedStatusVersion: application?.statusVersion ?? 0,
          answers: next,
        },
      })
      return unwrap(data.seb.application.saveDraft)
    },
    onMutate: () => {
      // Clears a previous failure, so a retry is not shown as still broken.
      setSaveState('saving')
      setSaveError(null)
    },
    onSuccess: (saved, next) => {
      persisted.current = next
      setSavedAt(saved.updatedAt)
      /*
       * The save answers with the application as it now is, and that is what
       * the cache holds: the next save quotes its versions, and the screen
       * shows "Saved" when the server said so, with no refetch of the record.
       * Only the validation report is fetched again; "Save & next" waits for
       * it.
       */
      queryClient.setQueryData(applicationQuery(id).queryKey, saved)
      void queryClient.invalidateQueries({ queryKey: ['validation', id] })
      // An answer changed while the save was in flight is still unsaved.
      setSaveState(latest.current && !sameAnswers(next, latest.current) ? 'unsaved' : 'saved')
    },
    onError: (error) => {
      setSaveState('failed')
      setSaveError(messageFor(error))
    },
  })

  /**
   * Saves what is on screen, if it differs from what the server holds.
   *
   * The applicant's Save button, "Save & next", Cmd/Ctrl+S and "Save and
   * leave" all come here, so there is one save and one set of rules for it.
   * Resolves to whether the answers on screen are now safe.
   */
  const saveNow = async (): Promise<boolean> => {
    const next = latest.current
    if (!next || (persisted.current && sameAnswers(persisted.current, next))) {
      if (saveState === 'unsaved') setSaveState('idle')
      return true
    }
    try {
      await save.mutateAsync(next)
      return true
    } catch {
      return false
    }
  }

  /*
   * Arriving from the validation report with a field named in the address.
   *
   * Waits for the draft to be seeded, because until then the fields are not on
   * the page to focus. Focusing rather than only scrolling means somebody using
   * a keyboard or a screen reader lands on the control too, not merely near it.
   */
  const hash = useLocation({ select: (location) => location.hash })
  useEffect(() => {
    if (!hash || !answers) return
    const field = document.getElementById(hash)
    if (!field) return
    // A behaviour passed here overrides the stylesheet's reduced-motion rule,
    // so the preference is read rather than assumed.
    const stillness = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    field.scrollIntoView({ block: 'center', behavior: stillness ? 'auto' : 'smooth' })
    field.focus({ preventScroll: true })
  }, [hash, answers])

  /*
   * Unsaved answers are never lost silently. Closing or reloading the tab gets
   * the browser's own prompt — the only thing that can interrupt a navigation
   * it does not control — and leaving for another page of the portal gets the
   * dialog below, which offers to save first. Moving between this form's own
   * stages is not leaving: the answers stay on screen.
   */
  const unsaved = saveState === 'unsaved' || saveState === 'saving' || saveState === 'failed'
  const leaving = useBlocker({
    shouldBlockFn: ({ current, next }) => unsaved && next.pathname !== current.pathname,
    enableBeforeUnload: () => unsaved,
    withResolver: true,
  })

  // Cmd/Ctrl+S saves, as it does everywhere else a person writes.
  const saveNowRef = useRef(saveNow)
  saveNowRef.current = saveNow
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNowRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const update = useCallback(
    (fieldKey: string, value: AnswerValue | readonly AnswerEntry[]) => {
      /*
       * Merged against `latest`, not against the `answers` of some render.
       *
       * A stage is memoised and re-renders only when an answer it reads has
       * changed, so a stage the applicant has moved away from is still holding
       * the map as it stood then. It used to hand that map back with one key
       * replaced, which **discarded every answer given elsewhere since** — the
       * applicant filled the form, the page said "Saved", and the review screen
       * listed two dozen questions as still needed.
       */
      const raw = { ...(latest.current ?? {}), [fieldKey]: value } as AnswerMap
      /*
       * Hidden answers are cleared here, not merely left off the screen.
       *
       * The server prunes too, and that is what makes it correct — but if the
       * client did not, the applicant would watch an answer vanish on the next
       * refetch without having done anything, and the unsaved-changes check
       * would see a change the applicant did not make.
       */
      const next = template ? pruneHidden(template, raw) : raw
      latest.current = next
      setAnswers(next)
      setAdvanceIssueCount(null)
      setEdited((keys) => (keys.has(fieldKey) ? keys : new Set([...keys, fieldKey])))
      // Unsaved from the keystroke: nothing is on the server until Save.
      setSaveState((state) =>
        state === 'saving'
          ? state
          : persisted.current && sameAnswers(persisted.current, next) ? 'idle' : 'unsaved',
      )
    },
    [template],
  )

  /**
   * Validation issues, grouped by stage and then by field.
   *
   * Recomputed only when the report changes, so it is not rebuilt on every
   * keystroke — and each stage's object is stable between reports, which is
   * what lets `StageForm` skip re-rendering on an unrelated answer.
   */
  /*
   * The cross-field rules broken by the answers on screen, checked here as
   * the applicant types rather than after the next save. Reduced to a
   * string of their keys, which compares by value, so the grouping below is
   * rebuilt only when the verdict changes and not on every keystroke.
   */
  const brokenRuleKeys = useMemo(
    () =>
      template && rawTemplate && answers
        ? brokenFormRules(template, rawTemplate.rules, answers, visibleFields(template, answers))
            .map((rule) => rule.key)
            .join(',')
        : '',
    [template, rawTemplate, answers],
  )

  // A fresh report speaks for every question again.
  useEffect(() => setEdited(new Set()), [validation])

  const issuesByStage = useMemo(() => {
    const grouped: Record<string, FieldIssues> = {}
    for (const issue of validation?.issues ?? []) {
      // `OWNERS[0].NAME` and `OWNERS` are both about the question `OWNERS`.
      if (edited.has(issue.field.replace(/[[.].*$/, ''))) continue
      const stage = grouped[issue.stageKey] ?? {}
      stage[issue.field] = issue.message
      grouped[issue.stageKey] = stage
    }
    // The server reports a broken rule against its first question; so does
    // this, so the two land on the same control and never show twice.
    const broken = new Set(brokenRuleKeys.split(','))
    for (const rule of rawTemplate?.rules ?? []) {
      const first = rule.operandKeys[0]
      if (!broken.has(rule.key) || !first) continue
      const stage = grouped[rule.stageKey] ?? {}
      if (!stage[first]) stage[first] = rule.message
      grouped[rule.stageKey] = stage
    }
    return grouped
  }, [validation, edited, brokenRuleKeys, rawTemplate])

  const issues = validation?.issues ?? []
  const editable = new Set(application?.editableStageKeys ?? [])
  const readOnly = Boolean(application) && editable.size === 0
  const stageKeys = template ? template.stages.map((stage) => stage.key) : []
  const hashStage = hash && template ? stageForField(template, hash) : null
  // Arriving to fix a named field is arriving to see what is wrong with it.
  useEffect(() => {
    if (hashStage) reveal(hashStage)
  }, [hashStage])
  const firstEditableStage = stageKeys.find((key) => editable.has(key))
  const firstIncompleteFormIndex = template
    ? stageKeys.findIndex((key) => issuesForStep(template, issues, key).length > 0)
    : -1

  /*
   * Initial stage to open when not explicitly requested in the URL.
   * Captured so the form opens at the right place on entry, but never jumps
   * automatically while the applicant is actively editing.
   */
  const initialStage =
    hashStage ??
    (awaitingCorrection(application) && firstEditableStage
      ? firstEditableStage
      : !readOnly && firstIncompleteFormIndex !== -1
        ? stageKeys[firstIncompleteFormIndex]!
        : stageKeys[0])

  // Sync initial stage into search params so the active stage is fixed and persistent.
  useEffect(() => {
    if (!template || !stageKeys.length || search.stage) return
    if (initialStage) {
      void navigate({
        search: { stage: initialStage },
        replace: true,
      })
    }
  }, [template, stageKeys.length, search.stage, initialStage, navigate])

  const currentStage =
    search.stage && stageKeys.includes(search.stage)
      ? search.stage
      : (initialStage ?? stageKeys[0])

  if (!application || !answers || !template || !validation || !currentStage) {
    return null
  }

  const steps = journeySteps(template)
  // What the office asked to change, still open: read where it is changed.
  const openRequests = application.revisionRequests.filter(
    (request) => request.resolvedAt === null && request.cancelledAt === null,
  )
  const askedHere = openRequests.filter((request) => request.stageKey === currentStage)
  const shownCounts = new Map(
    stageKeys.map((key) => [
      key,
      // Files are counted on the evidence step, as the report counts them.
      revealed.has(key)
        ? Object.keys(issuesByStage[key] ?? EMPTY_ISSUES).filter(
            (field) => !isDocumentIssue(template, field),
          ).length
        : 0,
    ]),
  )
  const activeIndex = steps.indexOf(currentStage)
  const locked = !editable.has(currentStage)

  const moveTo = async (step: string) => {
    if (stageKeys.includes(step)) {
      await navigate({ search: { stage: step }, hash: '' })
    } else if (step === ATTACH_EVIDENCE) {
      await router.navigate({
        to: '/applications/$id/documents',
        params: { id },
      })
    } else {
      await router.navigate({ to: '/applications/$id/review', params: { id } })
    }
  }

  const advance = async () => {
    // "Save & next" is literally true: the same save as the Save button, then
    // the stage is checked before moving on.
    if (!locked && !(await saveNow())) return

    const currentValidation = await queryClient.fetchQuery(validationQuery(id))
    const outstanding = issuesForStep(template, currentValidation.issues, currentStage)
    if (outstanding.length > 0) {
      reveal(currentStage)
      setAdvanceIssueCount(outstanding.length)
      const field = document.getElementById(outstanding[0]?.field ?? '')
      field?.focus()
      field?.scrollIntoView({ block: 'center' })
      return
    }

    setAdvanceIssueCount(null)
    const next = steps[activeIndex + 1]
    if (next) await moveTo(next)
  }

  return (
    <main className={styles.pageShell}>
      <div className={styles.headerWrap}>
        <div className={styles.headerLeft}>
          <h1 className={styles.pageTitle}>Application form</h1>
          <p className={styles.pageDescription}>
            {readOnly
              ? 'This application can no longer be edited.'
              : awaitingCorrection(application)
                ? 'Only the stages the programme office asked you to correct can be changed.'
                : 'Your answers are kept when you press Save, or Save & next. Nothing is saved automatically.'}
          </p>
        </div>
        <FormArtwork />
      </div>

      {saveError ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginBottom: '1rem' }}
        >
          {saveError}
        </p>
      ) : null}

      {/* Only while the application can still be sent. Telling somebody a
          closed application is closing would be noise — and once submission
          has stamped the category, a hint about it would be too. */}
      {!readOnly ? (
        <>
          <ClosingNotice programmeCycleId={application.programmeCycleId} />
          <CategoryHint
            enterpriseId={application.enterpriseId}
            programmeCycleId={application.programmeCycleId}
          />
        </>
      ) : null}

      <ApplicationJourney
        applicationId={id}
        template={template}
        activeStep={currentStage}
        issues={issues}
        shownCounts={shownCounts}
        correctionStageKeys={openRequests.map((request) => request.stageKey)}
        editableStageKeys={application.editableStageKeys}
        footerLeft={
          <div className={styles.footerLeftGroup}>
            {activeIndex > 0 ? (
              <button
                type="button"
                className={styles.backButton}
                disabled={save.isPending}
                onClick={() => moveTo(steps[activeIndex - 1] ?? currentStage)}
              >
                <ArrowLeft size={16} aria-hidden="true" />
                <span>Back</span>
              </button>
            ) : (
              <Link to="/applications/$id" params={{ id }} className={styles.exitButton}>
                <LogOut size={15} aria-hidden="true" />
                <span>Exit form</span>
              </Link>
            )}
            <SaveIndicator state={saveState} savedAt={savedAt} />
          </div>
        }
        footerRight={
          <div className={styles.footerRightGroup}>
            {readOnly ? null : (
              <button
                type="button"
                className={styles.saveButton}
                disabled={save.isPending || saveState !== 'unsaved' && saveState !== 'failed'}
                onClick={() => void saveNow()}
                title="Save your answers (Ctrl+S / ⌘S)"
              >
                <Save size={15} aria-hidden="true" />
                <span>{save.isPending ? 'Saving…' : 'Save'}</span>
              </button>
            )}
            <button
              type="button"
              className={styles.nextButton}
              disabled={save.isPending}
              onClick={advance}
            >
              <span>{readOnly || locked ? 'Next' : 'Save & next'}</span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        }
      >
        {askedHere.map((request) => (
          <div
            key={request.id}
            className="notice"
            data-tone="action"
            style={{ marginBottom: '1rem' }}
          >
            <span className="notice-title">The office asked you to change this</span>
            {request.note}
          </div>
        ))}

        {locked && awaitingCorrection(application) ? (
          <p className="notice" data-tone="action" style={{ marginBottom: '1rem' }}>
            No correction was requested for this stage, so it must stay exactly as it was
            submitted.
          </p>
        ) : null}

        {advanceIssueCount ? (
          <p
            className="notice"
            data-tone="error"
            role="alert"
            style={{ marginBottom: '1rem' }}
          >
            Fix {advanceIssueCount} {advanceIssueCount === 1 ? 'item' : 'items'} in this
            stage before continuing.
          </p>
        ) : null}

        <fieldset
          disabled={locked}
          style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
        >
          <StageForm
            template={template}
            stageKey={currentStage}
            answers={answers}
            issues={
              revealed.has(currentStage)
                ? (issuesByStage[currentStage] ?? EMPTY_ISSUES)
                : EMPTY_ISSUES
            }
            disabled={locked}
            onChange={update}
          />
        </fieldset>
      </ApplicationJourney>

      {leaving.status === 'blocked' ? (
        <LeaveDialog
          saving={save.isPending}
          error={saveError}
          onSave={async () => {
            if (await saveNow()) leaving.proceed()
          }}
          onDiscard={() => leaving.proceed()}
          onStay={() => leaving.reset()}
        />
      ) : null}
    </main>
  )
}

/**
 * Asked when the applicant leaves the form with answers not yet saved.
 *
 * Saving is the first choice and the default focus, because it is almost
 * always what somebody who typed something wants; leaving without it is
 * offered plainly rather than hidden, because sometimes it is.
 */
function LeaveDialog({
  saving,
  error,
  onSave,
  onDiscard,
  onStay,
}: {
  saving: boolean
  error: string | null
  onSave: () => void
  onDiscard: () => void
  onStay: () => void
}) {
  return (
    <div className={styles.leaveBackdrop} role="presentation">
      <div
        className={styles.leaveDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        aria-describedby="leave-body"
      >
        <h2 id="leave-title" className={styles.leaveTitle}>Save your changes?</h2>
        <p id="leave-body" className={styles.leaveBody}>
          You have answers on this page that are not saved yet. They will be lost if you
          leave without saving.
        </p>
        {error ? (
          <p className="notice" data-tone="error" role="alert">{error}</p>
        ) : null}
        <div className={styles.leaveActions}>
          <button type="button" className={styles.discardButton} onClick={onDiscard} disabled={saving}>
            Leave without saving
          </button>
          <button type="button" className={styles.backButton} onClick={onStay} disabled={saving}>
            Stay
          </button>
          <button
            type="button"
            className={styles.nextButton}
            onClick={onSave}
            disabled={saving}
            // The dialog's first choice, focused so Enter saves.
            autoFocus
          >
            {saving ? 'Saving…' : 'Save and leave'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Says exactly what the server knows, in three unambiguous states.
 *
 * "Saved" reports the time the server recorded, not the moment the request was
 * sent, so it can never claim work is safe that is not.
 */
function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: string | null }) {
  if (state === 'unsaved') {
    return (
      <span className={styles.saveStatus} data-tone="unsaved" aria-live="polite">
        <span className={styles.statusDot} aria-hidden="true" />
        <span>Unsaved changes</span>
      </span>
    )
  }
  if (state === 'saving') {
    return (
      <span className={styles.saveStatus} data-tone="saving" aria-live="polite">
        <span className={styles.spinnerIcon} aria-hidden="true" />
        <span>Saving…</span>
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className={styles.saveStatus} data-tone="error" aria-live="assertive">
        <span className={styles.statusDot} aria-hidden="true" />
        <span>Could not save</span>
      </span>
    )
  }
  if (state === 'saved' && savedAt) {
    return (
      <span className={styles.saveStatus} data-tone="ok" aria-live="polite">
        <span className={styles.statusDot} aria-hidden="true" />
        <span>Saved {formatDateTime(savedAt)}</span>
      </span>
    )
  }
  return null
}

export function FormArtwork() {
  return (
    <svg
      width="130"
      height="85"
      viewBox="0 0 130 85"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={styles.headerArtwork}
      aria-hidden="true"
    >
      <circle cx="98" cy="38" r="28" fill="#FEF3C7" opacity="0.6" />
      <circle cx="38" cy="52" r="22" fill="#EBF3FC" opacity="0.7" />

      {/* Clipboard board */}
      <rect
        x="52"
        y="14"
        width="54"
        height="66"
        rx="6"
        fill="#FFFFFF"
        stroke="#CBD5E1"
        strokeWidth="1.5"
      />

      {/* Clip at top */}
      <rect x="68" y="10" width="22" height="7" rx="2" fill="#CBD5E1" stroke="#94A3B8" strokeWidth="1.2" />
      <path
        d="M74 10C74 7.5 76 5.5 79 5.5C82 5.5 84 7.5 84 10"
        stroke="#94A3B8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* Checklist items */}
      <rect x="59" y="27" width="8" height="8" rx="2" stroke="#4271B7" strokeWidth="1.4" fill="#F0F5FC" />
      <path
        d="M61 31L63.5 33.5L68 28.5"
        stroke="#4271B7"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="72" y1="31" x2="96" y2="31" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />

      <rect x="59" y="41" width="8" height="8" rx="2" stroke="#4271B7" strokeWidth="1.4" fill="#F0F5FC" />
      <path
        d="M61 45L63.5 47.5L68 42.5"
        stroke="#4271B7"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="72" y1="45" x2="92" y2="45" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />

      <rect x="59" y="55" width="8" height="8" rx="2" stroke="#4271B7" strokeWidth="1.4" fill="#F0F5FC" />
      <path
        d="M61 59L63.5 61.5L68 56.5"
        stroke="#4271B7"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="72" y1="59" x2="88" y2="59" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />

      {/* Potted plant */}
      <path d="M110 60H124L121 78H113L110 60Z" fill="#FFFFFF" stroke="#94A3B8" strokeWidth="1.4" />
      <path d="M117 60C117 52 111 48 109 48C109 54 113 60 117 60Z" fill="#23814C" opacity="0.85" />
      <path d="M117 60C117 50 124 46 126 46C126 53 121 60 117 60Z" fill="#23814C" />

      {/* Ground baseline */}
      <line x1="42" y1="80" x2="128" y2="80" stroke="#CBD5E1" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
