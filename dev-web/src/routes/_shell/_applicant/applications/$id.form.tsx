import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useLocation, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { ClosingNotice } from '#/features/application/ClosingNotice'
import {
  APPLICATION_JOURNEY_STEPS,
  ApplicationJourney,
  firstIncompleteStep,
  issuesForStep,
  sectionForField,
} from '#/features/application/ApplicationJourney'
import {
  ApplicantSection,
  DeclarationSection,
  DocumentsSection,
  EnterpriseSection,
  FinancialSection,
  PriorFundingSection,
  type SectionIssues,
} from '#/features/application/DraftSections'
import { FORM_SECTIONS, draftFromSnapshot, sameDraft } from '#/features/application/draft'
import {
  applicationQuery,
  loadApplication,
  validationQuery,
} from '#/features/application/applicationQueries'
import { SaveApplicationDraftDocument } from '#/graphql/generated/operations'
import type { ApplicationDraftInput } from '#/graphql/generated/operations'
import type { ApplicationSection } from '#/graphql/generated/schema'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

/** Long enough that typing a sentence is one save, short enough to feel safe. */
const AUTOSAVE_DELAY_MS = 900

export const Route = createFileRoute('/_shell/_applicant/applications/$id/form')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: ApplicationSection } => ({
    section: FORM_SECTIONS.includes(search.section as ApplicationSection)
      ? (search.section as ApplicationSection)
      : undefined,
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

  const [draft, setDraft] = useState<ApplicationDraftInput | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  /** Whether a save is in flight, readable from inside a stale closure. */
  const inFlight = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [advanceIssueCount, setAdvanceIssueCount] = useState<number | null>(null)

  /*
   * What was last agreed with the server. Autosave compares against this rather
   * than against the query data, because the query is refetched after a save
   * and would otherwise race the comparison.
   */
  const persisted = useRef<ApplicationDraftInput | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seeded once from the server, then owned locally. Re-seeding on every
  // refetch would overwrite whatever is being typed.
  useEffect(() => {
    if (draft || !application) return
    const initial = draftFromSnapshot(application)
    persisted.current = initial
    setDraft(initial)
  }, [application, draft])

  const save = useMutation({
    mutationFn: async (next: ApplicationDraftInput) => {
      const data = await gql(SaveApplicationDraftDocument, {
        input: {
          applicationId: id,
          // Optimistic concurrency: a save built on a stale copy is refused
          // rather than overwriting a newer one.
          expectedVersion: application?.currentVersion ?? 0,
          expectedStatusVersion: application?.statusVersion ?? 0,
          draft: next,
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
    (next: ApplicationDraftInput) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (persisted.current && sameDraft(persisted.current, next)) {
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
    if (!hash || !draft) return
    const field = document.getElementById(hash)
    if (!field) return
    // A behaviour passed here overrides the stylesheet's reduced-motion rule,
    // so the preference is read rather than assumed.
    const stillness = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    field.scrollIntoView({ block: 'center', behavior: stillness ? 'auto' : 'smooth' })
    field.focus({ preventScroll: true })
  }, [hash, draft])

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
    (next: ApplicationDraftInput) => {
      setDraft(next)
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
    [scheduleSave],
  )

  /**
   * Validation issues, grouped by section and then by field.
   *
   * Recomputed only when the report changes, so it is not rebuilt on every
   * keystroke.
   */
  const issuesBySection = useMemo(() => {
    const grouped: Record<string, SectionIssues> = {}
    for (const issue of validation?.issues ?? []) {
      const section = grouped[issue.section] ?? {}
      section[issue.field] = issue.message
      grouped[issue.section] = section
    }
    return grouped
  }, [validation])

  const editable = new Set<ApplicationSection>(application?.editableSections ?? [])
  const readOnly = Boolean(application) && editable.size === 0
  const hashSection = hash ? sectionForField(hash) : null
  const incomplete = firstIncompleteStep(validation?.issues ?? [])
  const firstEditableSection = FORM_SECTIONS.find((section) => editable.has(section))
  const defaultSection =
    application?.status === 'REVISION_REQUIRED' && firstEditableSection
      ? firstEditableSection
      : !readOnly && FORM_SECTIONS.includes(incomplete as ApplicationSection)
        ? (incomplete as ApplicationSection)
        : 'ENTERPRISE'
  const requestedSection = search.section ?? hashSection
  const requestedIndex = requestedSection ? FORM_SECTIONS.indexOf(requestedSection) : -1
  const earliestIndex = FORM_SECTIONS.indexOf(defaultSection)
  const explicitIssueLink = hashSection !== null && hashSection === requestedSection
  const activeSection =
    requestedSection &&
    (readOnly ||
      application?.status === 'REVISION_REQUIRED' ||
      explicitIssueLink ||
      requestedIndex <= earliestIndex)
      ? requestedSection
      : defaultSection

  /*
   * A valid section name can still be unreachable because an earlier category
   * is incomplete. Keep the address honest when that happens: browser history
   * and a copied link must name the category that is actually on screen. Field
   * hashes remain the explicit exception and retain their requested category.
   */
  useEffect(() => {
    if (
      !application ||
      !validation ||
      !search.section ||
      search.section === activeSection ||
      explicitIssueLink
    ) {
      return
    }
    void navigate({
      search: { section: activeSection },
      hash: '',
      replace: true,
    })
  }, [
    activeSection,
    application,
    explicitIssueLink,
    navigate,
    search.section,
    validation,
  ])

  if (!application || !draft || !validation) return null

  const activeIndex = FORM_SECTIONS.indexOf(activeSection)
  const locked = !editable.has(activeSection)

  const moveTo = async (step: (typeof APPLICATION_JOURNEY_STEPS)[number]) => {
    if (FORM_SECTIONS.includes(step as ApplicationSection)) {
      await navigate({ search: { section: step as ApplicationSection }, hash: '' })
    } else if (step === 'ATTACH_EVIDENCE') {
      await router.navigate({
        to: '/applications/$id/documents',
        params: { id },
      })
    } else {
      await router.navigate({ to: '/applications/$id/review', params: { id } })
    }
  }

  const advance = async () => {
    if (timer.current) clearTimeout(timer.current)
    if (!locked && persisted.current && !sameDraft(persisted.current, draft)) {
      try {
        await save.mutateAsync(draft)
      } catch {
        return
      }
    }

    const currentValidation = await queryClient.fetchQuery(validationQuery(id))
    const outstanding = issuesForStep(currentValidation.issues, activeSection)
    if (outstanding.length > 0) {
      setAdvanceIssueCount(outstanding.length)
      const field = document.getElementById(outstanding[0]?.field ?? '')
      field?.focus()
      field?.scrollIntoView({ block: 'center' })
      return
    }

    setAdvanceIssueCount(null)
    const next = APPLICATION_JOURNEY_STEPS[activeIndex + 1]
    if (next) await moveTo(next)
  }

  return (
    <main className="page">
      <PageHeader
        title="Application form"
        description={
          readOnly
            ? 'This application can no longer be edited.'
            : application.status === 'REVISION_REQUIRED'
              ? 'Only the sections the programme office asked you to correct can be changed.'
              : 'Your answers are saved as you type.'
        }
      />

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
        <div style={{ marginBottom: '1rem' }}>
          <ClosingNotice programmeCycleId={application.programmeCycleId} />
        </div>
      ) : null}

      <ApplicationJourney
        applicationId={id}
        activeStep={activeSection}
        issues={validation?.issues ?? []}
        editableSections={application.editableSections}
        footerStatus={<SaveIndicator state={saveState} savedAt={savedAt} />}
        footer={
          <>
            {activeIndex > 0 ? (
              <button
                type="button"
                className="button"
                disabled={save.isPending}
                onClick={() =>
                  moveTo(APPLICATION_JOURNEY_STEPS[activeIndex - 1] ?? 'ENTERPRISE')
                }
              >
                Back
              </button>
            ) : (
              <Link to="/applications/$id" params={{ id }} className="button">
                Exit form
              </Link>
            )}
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={save.isPending}
              onClick={advance}
            >
              {save.isPending ? 'Saving…' : 'Next'}
            </button>
          </>
        }
      >
        {locked && application.status === 'REVISION_REQUIRED' ? (
          <p className="notice" data-tone="action" style={{ marginBottom: '1rem' }}>
            No correction was requested for this category, so it must stay exactly as it
            was submitted.
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
            category before continuing.
          </p>
        ) : null}

        <fieldset
          disabled={locked}
          style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
        >
          <SectionFields
            section={activeSection}
            draft={draft}
            issues={issuesBySection[activeSection] ?? {}}
            disabled={locked}
            onChange={update}
          />
        </fieldset>
      </ApplicationJourney>
    </main>
  )
}

/** Routes one section to its component, keeping the page free of a long switch. */
function SectionFields({
  section,
  draft,
  issues,
  disabled,
  onChange,
}: {
  section: ApplicationSection
  draft: ApplicationDraftInput
  issues: SectionIssues
  disabled: boolean
  onChange: (next: ApplicationDraftInput) => void
}) {
  if (section === 'ENTERPRISE') {
    return (
      <EnterpriseSection
        value={draft.enterprise}
        issues={issues}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, enterprise: value })}
      />
    )
  }
  if (section === 'APPLICANT_PROFILE') {
    return (
      <ApplicantSection
        value={draft.applicantProfile}
        issues={issues}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, applicantProfile: value })}
      />
    )
  }
  if (section === 'FINANCIAL') {
    return (
      <FinancialSection
        value={draft.financial}
        issues={issues}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, financial: value })}
      />
    )
  }
  if (section === 'PRIOR_FUNDING') {
    return (
      <PriorFundingSection
        value={draft.priorFunding}
        issues={issues}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, priorFunding: value })}
      />
    )
  }
  if (section === 'DOCUMENTS') {
    return (
      <DocumentsSection
        value={draft.documents}
        issues={issues}
        disabled={disabled}
        onChange={(value) => onChange({ ...draft, documents: value })}
      />
    )
  }
  return (
    <DeclarationSection
      value={draft.declaration}
      issues={issues}
      disabled={disabled}
      onChange={(value) => onChange({ ...draft, declaration: value })}
    />
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
      <span className="badge" aria-live="polite">
        Saving…
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span className="badge" data-tone="error" aria-live="assertive">
        Could not save
      </span>
    )
  }
  if (state === 'saved' && savedAt) {
    return (
      <span className="badge" data-tone="ok" aria-live="polite">
        Saved {formatDateTime(savedAt)}
      </span>
    )
  }
  return null
}
