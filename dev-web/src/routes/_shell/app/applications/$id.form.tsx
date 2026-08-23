import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import {
  ApplicantSection,
  DeclarationSection,
  DocumentsSection,
  EnterpriseSection,
  FinancialSection,
  PriorFundingSection,
  type SectionIssues,
} from '#/features/application/DraftSections'
import {
  FORM_SECTIONS,
  SECTION_TITLES,
  draftFromSnapshot,
  sameDraft,
} from '#/features/application/draft'
import {
  applicationQuery,
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

export const Route = createFileRoute('/_shell/app/applications/$id/form')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(applicationQuery(params.id)),
      context.queryClient.ensureQueryData(validationQuery(params.id)),
    ])
  },
  component: DraftFormPage,
})

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

function DraftFormPage() {
  const { id } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: application } = useQuery(applicationQuery(id))
  const { data: validation } = useQuery(validationQuery(id))

  const [draft, setDraft] = useState<ApplicationDraftInput | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

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
      setSaveState('saving')
      setSaveError(null)
    },
    onSuccess: async (saved, next) => {
      persisted.current = next
      setSaveState('saved')
      setSavedAt(saved.updatedAt)
      // The version moved, so the next save needs the new one. Validation is
      // now stale too.
      await queryClient.invalidateQueries({ queryKey: ['application', id] })
      await queryClient.invalidateQueries({ queryKey: ['validation', id] })
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
        if (save.isPending) {
          // Try again after the in-flight save settles rather than stacking.
          scheduleSave(next)
          return
        }
        save.mutate(next)
      }, AUTOSAVE_DELAY_MS)
    },
    [save],
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const update = useCallback(
    (next: ApplicationDraftInput) => {
      setDraft(next)
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

  if (!application || !draft) return null

  const editable = new Set<ApplicationSection>(application.editableSections)
  const readOnly = editable.size === 0

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
        actions={<SaveIndicator state={saveState} savedAt={savedAt} />}
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

      <div className="stack">
        {FORM_SECTIONS.map((section) => {
          const locked = !editable.has(section)
          return (
            <fieldset className="fieldset" key={section} disabled={locked}>
              <legend className="eyebrow">
                {SECTION_TITLES[section]}
                {locked ? (
                  <span className="badge" style={{ marginLeft: '0.5rem' }}>
                    Locked
                  </span>
                ) : null}
              </legend>

              {/*
                A locked section is explained rather than silently inert: while
                a revision is open, only the sections named by the programme
                office may change.
              */}
              {locked && application.status === 'REVISION_REQUIRED' ? (
                <p className="field-hint" style={{ marginBottom: '0.75rem' }}>
                  No correction was requested for this section, so it must stay exactly as
                  it was submitted.
                </p>
              ) : null}

              <SectionFields
                section={section}
                draft={draft}
                issues={issuesBySection[section] ?? {}}
                disabled={locked}
                onChange={update}
              />
            </fieldset>
          )
        })}
      </div>

      <div className="row" style={{ marginTop: '1.5rem' }}>
        <Link
          to="/app/applications/$id/documents"
          params={{ id }}
          className="button"
          data-variant="primary"
        >
          Attach evidence
        </Link>
        <Link to="/app/applications/$id/review" params={{ id }} className="button">
          Check and submit
        </Link>
        <Link to="/app/applications/$id" params={{ id }} className="button">
          Back to the application
        </Link>
      </div>
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
