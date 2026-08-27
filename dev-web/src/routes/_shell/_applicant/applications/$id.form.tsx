import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, LogOut } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import {
  ATTACH_EVIDENCE,
  ApplicationJourney,
  firstIncompleteStep,
  issuesForStep,
  journeySteps,
  stageForField,
} from '#/features/application/ApplicationJourney'
import type { AnswerEntry, AnswerMap, AnswerValue } from '#/features/application/answers'
import type { FieldIssues } from '#/features/application/FormControls'
import { StageForm } from '#/features/application/FormRenderer'
import { pruneHidden, resolveTemplate } from '#/features/application/formTemplate'
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

/** Long enough that typing a sentence is one save, short enough to feel safe. */
const AUTOSAVE_DELAY_MS = 900

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
 * would compare unequal and autosave a version that changed nothing.
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
  loader: ({ context, params }) => loadApplication(context.queryClient, params.id),
  component: DraftFormPage,
})

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

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
  /** Whether a save is in flight, readable from inside a stale closure. */
  const inFlight = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [advanceIssueCount, setAdvanceIssueCount] = useState<number | null>(null)
  const latest = useRef<AnswerMap | null>(null)

  /*
   * What was last agreed with the server. Autosave compares against this rather
   * than against the query data, because the query is refetched after a save
   * and would otherwise race the comparison.
   */
  const persisted = useRef<AnswerMap | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      /*
       * `saving` already, from the keystroke; this clears a previous failure so
       * a retry is not shown as still broken.
       *
       * `inFlight` is a ref rather than `save.isPending` because the scheduler
       * below reads it from inside a timer it created — see the note there.
       */
      inFlight.current = true
      setSaveState('saving')
      setSaveError(null)
    },
    onSettled: () => {
      inFlight.current = false
    },
    onSuccess: async (saved, next) => {
      persisted.current = next
      setSavedAt(saved.updatedAt)
      // The version moved, so the next save needs the new one. Validation is
      // now stale too.
      await queryClient.invalidateQueries({ queryKey: ['application', id] })
      await queryClient.invalidateQueries({ queryKey: ['validation', id] })
      setSaveState('saved')
    },
    onError: (error) => {
      setSaveState('failed')
      setSaveError(messageFor(error))
    },
  })

  /**
   * Schedules a save.
   *
   * Debounced, never overlapping an in-flight save, and skipped entirely when
   * nothing changed — the API already treats an unchanged draft as a no-op, and
   * there is no reason to spend a round trip discovering that.
   */
  const scheduleSave = useCallback(
    (next: AnswerMap) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (persisted.current && sameAnswers(persisted.current, next)) {
          setSaveState('idle')
          return
        }
        if (inFlight.current) {
          /*
           * Try again once the in-flight save settles, rather than stacking.
           *
           * Read from a ref, and it has to be. This runs inside a timer created
           * during some earlier render, and the recursion below re-enters *that*
           * render's `scheduleSave` — so `save.isPending` would be the boolean
           * as it stood when the timer was made, frozen. A closure created
           * while a save was in flight would see `true` for ever, reschedule
           * itself every debounce interval, and never save: the applicant's
           * last edit lost, the indicator stuck on "Saving", and the
           * leave-the-page warning armed with nothing behind it.
           */
          scheduleSave(next)
          return
        }
        save.mutate(next)
      }, AUTOSAVE_DELAY_MS)
    },
    // `mutate` is stable; nothing else here is read from the render.
    [save.mutate],
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

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
   * Autosave is debounced, so there is a window in which the last keystroke is
   * not yet on the server. Leaving during it would lose the edit silently, and
   * the browser's own prompt is the only thing that can interrupt a navigation
   * it does not control. Registered only while there is something to lose.
   */
  const unsaved = saveState === 'saving' || saveState === 'failed'
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

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
       * refetch without having done anything, and the autosave comparison would
       * see a change the applicant did not make.
       */
      const next = template ? pruneHidden(template, raw) : raw
      latest.current = next
      setAnswers(next)
      setAdvanceIssueCount(null)
      /*
       * "Saving" from the keystroke, not from the request. Autosave is
       * debounced, and leaving the indicator on "Saved" through that window
       * claims the newest answer is safe when it is still only in the browser.
       * It is also what makes the leave-the-page warning cover the window.
       */
      setSaveState('saving')
      scheduleSave(next)
    },
    [scheduleSave, template],
  )

  /**
   * Validation issues, grouped by stage and then by field.
   *
   * Recomputed only when the report changes, so it is not rebuilt on every
   * keystroke — and each stage's object is stable between reports, which is
   * what lets `StageForm` skip re-rendering on an unrelated answer.
   */
  const issuesByStage = useMemo(() => {
    const grouped: Record<string, FieldIssues> = {}
    for (const issue of validation?.issues ?? []) {
      const stage = grouped[issue.stageKey] ?? {}
      stage[issue.field] = issue.message
      grouped[issue.stageKey] = stage
    }
    return grouped
  }, [validation])

  const issues = validation?.issues ?? []
  const editable = new Set(application?.editableStageKeys ?? [])
  const readOnly = Boolean(application) && editable.size === 0
  const stageKeys = template ? template.stages.map((stage) => stage.key) : []
  const hashStage = hash && template ? stageForField(template, hash) : null
  const incomplete = template ? firstIncompleteStep(template, issues) : null
  const firstEditableStage = stageKeys.find((key) => editable.has(key))
  const firstIncompleteFormIndex = template
    ? stageKeys.findIndex((key) => issuesForStep(template, issues, key).length > 0)
    : -1
  /*
   * Evidence lives on its own route. Its missing files must not make the
   * completed answer stages appear unreachable: they remain available for
   * review and correction until the applicant returns to the upload step.
   */
  const lastReachableFormIndex =
    firstIncompleteFormIndex === -1 ? stageKeys.length - 1 : firstIncompleteFormIndex
  const defaultStage =
    application?.status === 'REVISION_REQUIRED' && firstEditableStage
      ? firstEditableStage
      : !readOnly && firstIncompleteFormIndex !== -1
        ? stageKeys[firstIncompleteFormIndex]!
        : stageKeys[0]
  const requestedStage =
    search.stage && stageKeys.includes(search.stage) ? search.stage : hashStage
  const requestedIndex = requestedStage ? stageKeys.indexOf(requestedStage) : -1
  const explicitIssueLink = hashStage !== null && hashStage === requestedStage
  const activeStage =
    requestedStage &&
    (readOnly ||
      application?.status === 'REVISION_REQUIRED' ||
      explicitIssueLink ||
      (requestedIndex >= 0 && requestedIndex <= lastReachableFormIndex))
      ? requestedStage
      : defaultStage

  /*
   * A valid stage key can still be unreachable because an earlier stage is
   * incomplete. Keep the address honest when that happens: browser history
   * and a copied link must name the stage that is actually on screen. Field
   * hashes remain the explicit exception and retain their requested stage.
   */
  useEffect(() => {
    if (
      !application ||
      !validation ||
      !template ||
      !activeStage ||
      !search.stage ||
      search.stage === activeStage ||
      explicitIssueLink
    ) {
      return
    }
    void navigate({
      search: { stage: activeStage },
      hash: '',
      replace: true,
    })
  }, [
    activeStage,
    application,
    explicitIssueLink,
    navigate,
    search.stage,
    template,
    validation,
  ])

  /*
   * The evidence screen is part of the same ordered journey, but it has its
   * own route rather than a form `stage`. Once the answer stages are complete,
   * rendering a plain `/form` address would otherwise fall through to the
   * first stage even though the next reachable work is attaching files. That
   * makes a form-to-evidence continuation appear stuck.
   *
   * Field bookmarks, revision work and read-only browsing retain their normal
   * form behavior; only an ordinary draft resume is redirected.
   */
  const resumeAtEvidence =
    !readOnly &&
    application?.status !== 'REVISION_REQUIRED' &&
    !search.stage &&
    !hash &&
    incomplete === ATTACH_EVIDENCE
  useEffect(() => {
    if (!resumeAtEvidence) return
    void router.navigate({
      to: '/applications/$id/documents',
      params: { id },
      replace: true,
    })
  }, [id, resumeAtEvidence, router])

  if (!application || !answers || !template || !validation || resumeAtEvidence) {
    return null
  }

  const steps = journeySteps(template)
  const currentStage = activeStage ?? stageKeys[0]
  if (!currentStage) return null
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
    // The footer's save is not a different save from autosave — it flushes the
    // same debounced write before moving, so "Save & next" is literally true.
    if (timer.current) clearTimeout(timer.current)
    if (
      !locked &&
      persisted.current &&
      latest.current &&
      !sameAnswers(persisted.current, latest.current)
    ) {
      try {
        await save.mutateAsync(latest.current)
      } catch {
        return
      }
    }

    const currentValidation = await queryClient.fetchQuery(validationQuery(id))
    const outstanding = issuesForStep(template, currentValidation.issues, currentStage)
    if (outstanding.length > 0) {
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
        <div className={styles.titleRow}>
          <Link
            to="/applications"
            className={styles.backBtn}
            aria-label="Back to applications"
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <h1 className={styles.pageTitle}>Application form</h1>
        </div>
        <p className={styles.pageDescription}>
          {readOnly
            ? 'This application can no longer be edited.'
            : application.status === 'REVISION_REQUIRED'
              ? 'Only the stages the programme office asked you to correct can be changed.'
              : 'Your answers are saved as you type.'}
        </p>
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
          closed application is closing would be noise. */}
      {!readOnly ? (
        <ClosingNotice programmeCycleId={application.programmeCycleId} />
      ) : null}

      <ApplicationJourney
        applicationId={id}
        template={template}
        activeStep={currentStage}
        issues={issues}
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
          <button
            type="button"
            className={styles.nextButton}
            disabled={save.isPending}
            onClick={advance}
          >
            <span>{save.isPending ? 'Saving…' : 'Save & next'}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        }
      >
        {locked && application.status === 'REVISION_REQUIRED' ? (
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
            issues={issuesByStage[currentStage] ?? EMPTY_ISSUES}
            disabled={locked}
            onChange={update}
          />
        </fieldset>
      </ApplicationJourney>
    </main>
  )
}

/**
 * Says exactly what the server knows, in three unambiguous states.
 *
 * "Saved" reports the time the server recorded, not the moment the request was
 * sent, so it can never claim work is safe that is not.
 */
function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: string | null }) {
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
