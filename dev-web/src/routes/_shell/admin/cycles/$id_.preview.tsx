/**
 * The cycle's form, seen as an applicant will see it.
 *
 * The real renderer, not a mock: the same `StageForm` the application form
 * mounts, driven by the same resolved template, so conditions fire, groups
 * grow, and presentation renders exactly as they will for an applicant.
 * Answers live only in this screen's memory — nothing is created, saved, or
 * submitted — which is why every stage is reachable here while the applicant
 * walks them in order.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { formEditorQuery } from '#/features/admin/FormEditor'
import { StageForm } from '#/features/application/FormRenderer'
import { pruneHidden, resolveTemplate } from '#/features/application/formTemplate'
import type {
  AnswerEntry,
  AnswerMap,
  AnswerValue,
} from '#/features/application/answers'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/cycles/$id_/preview')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(formEditorQuery(params.id)),
  component: PreviewPage,
})

function PreviewPage() {
  const { id } = Route.useParams()
  const { user } = Route.useRouteContext()
  const { data } = useQuery(formEditorQuery(id))
  const template = useMemo(
    () => (data?.formTemplate ? resolveTemplate(data.formTemplate) : null),
    [data?.formTemplate],
  )
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [stageKey, setStageKey] = useState<string | null>(null)

  if (!can(user, 'STAFF_READ')) {
    return (
      <main className="stack">
        <p className="notice" data-tone="error">
          This screen belongs to the programme office.
        </p>
      </main>
    )
  }
  if (!data || !template) {
    return (
      <main className="stack">
        <p className="muted">This cycle&rsquo;s form could not be read.</p>
      </main>
    )
  }

  const activeStage = stageKey ?? template.stages[0]?.key ?? null
  const update = (fieldKey: string, value: AnswerValue | readonly AnswerEntry[]) => {
    setAnswers((previous) =>
      pruneHidden(template, { ...previous, [fieldKey]: value } as AnswerMap),
    )
  }

  return (
    <main className="stack">
      <PageHeader
        title={`Previewing the form ${data.head.cycleCode} asks`}
        description="Exactly what an applicant sees, rendered by the same code. Answers typed here are not saved anywhere — close the tab and they are gone."
      />
      <p className="notice" data-tone="action">
        <span className="notice-title">This is a preview</span>
        Conditions, choices and repeated groups behave as they will for an applicant, but
        nothing is created or submitted. Every stage is open here; an applicant walks them
        in order, with documents attached on the evidence screen.
      </p>

      <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        {template.stages.map((stage) => (
          <button
            key={stage.key}
            type="button"
            className="button"
            data-variant={stage.key === activeStage ? 'primary' : 'ghost'}
            onClick={() => setStageKey(stage.key)}
          >
            {stage.title}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Link className="button" to="/admin/cycles/$id/form" params={{ id }}>
          Edit the form
        </Link>
        <Link className="button" to="/admin/cycles/$id" params={{ id }}>
          Back to the cycle
        </Link>
      </div>

      {activeStage ? (
        <div className="card">
          <div className="card-body">
            <StageForm
              template={template}
              stageKey={activeStage}
              answers={answers}
              issues={{}}
              disabled={false}
              onChange={update}
            />
          </div>
        </div>
      ) : (
        <p className="muted">This form has no stages yet.</p>
      )}
    </main>
  )
}
