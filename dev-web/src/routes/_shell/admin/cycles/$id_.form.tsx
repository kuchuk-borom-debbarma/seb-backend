/**
 * The form-authoring screen for one draft cycle.
 *
 * Reached from the cycle's own page. Super administrators only — a cycle's
 * questions are the programme's policy, gated on `CYCLE_ADMIN` like every
 * other rule change — and drafts only, because an open cycle's questions are
 * frozen into the applications filled under it.
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { FormEditor, formEditorQuery } from '#/features/admin/FormEditor'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/cycles/$id_/form')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(formEditorQuery(params.id)),
  component: CycleFormAuthoringPage,
})

function CycleFormAuthoringPage() {
  const { id } = Route.useParams()
  const { user } = Route.useRouteContext()
  const { data } = useQuery(formEditorQuery(id))

  // Drawn from the capability the API itself gates these writes on, so the
  // screen and the refusal can never disagree about who may edit.
  if (!can(user, 'CYCLE_ADMIN')) {
    return (
      <main className="page">
        <PageHeader
          title="The form editor"
          description="Changing what a cycle asks is a change to the programme itself, so it is reserved for a super administrator."
        />
        <p className="notice" data-tone="error" role="alert">
          You do not have permission to change a cycle’s questions.
        </p>
        <p style={{ marginTop: '1.5rem' }}>
          <Link to="/admin/cycles/$id" params={{ id }}>
            Back to the cycle
          </Link>
        </p>
      </main>
    )
  }

  if (!data) return null
  const head = data.head

  return (
    <main className="page">
      <PageHeader
        title={`The form ${head.displayName} asks`}
        meta={`${head.cycleCode} · programme year ${head.cycleYear}`}
        description="Stages, questions, choices and the rules between them. Every change here is a cycle revision with its reason kept in the history."
      />

      {head.status !== 'DRAFT' ? (
        <p className="notice">
          <span className="notice-title">This cycle’s questions are frozen</span>A cycle’s
          questions can only be changed while it is a draft. Once it opens, every
          application is judged against the version it was filled under — to ask something
          different, open a new cycle.
        </p>
      ) : data.formTemplate === null ? (
        /*
         * The API returns a null template only where the cycle's rows were
         * edited by hand into something it cannot resolve. Nothing useful can
         * be drawn from that, so it is said rather than rendered wrongly.
         */
        <p className="notice" data-tone="error" role="alert">
          This cycle’s stored questions could not be read back, so they cannot be edited
          here.
        </p>
      ) : (
        <FormEditor cycleId={id} cycle={data} template={data.formTemplate} />
      )}

      <p style={{ marginTop: '1.5rem' }}>
        <Link to="/admin/cycles/$id" params={{ id }}>
          Back to the cycle
        </Link>
      </p>
    </main>
  )
}
