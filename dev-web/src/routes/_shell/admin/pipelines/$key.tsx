/**
 * One pipeline: its flow, stages, flags, values, actions, owners and versions.
 *
 * Reading needs `pipeline:read`; each control beyond that is offered only to
 * the act the API gates it on — editing to `update`, publishing to `publish`,
 * retiring to `retire`, owners to `assign` — and absent otherwise, so nobody
 * is shown a button that can only refuse.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { PipelineEditor } from '#/features/pipeline/PipelineEditor'
import { pipelineCatalogueQuery, pipelineQuery } from '#/features/pipeline/pipelineQueries'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/pipelines/$key')({
  loader: async ({ context, params }) => {
    if (!can(context.user, 'pipeline', 'read')) return null
    await Promise.all([
      context.queryClient.ensureQueryData(pipelineQuery(params.key)),
      context.queryClient.ensureQueryData(pipelineCatalogueQuery),
    ])
    return null
  },
  component: PipelineGate,
})

function PipelineGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'pipeline', 'read')) {
    return <PermissionRefusal title="Pipeline" needs="anybody who may read the office's pipelines" />
  }
  return <PipelinePage />
}

function PipelinePage() {
  const { key } = Route.useParams()
  const detail = useQuery(pipelineQuery(key))
  const catalogue = useQuery(pipelineCatalogueQuery)
  const pipeline = detail.data?.response ?? null

  const back = (
    <Link to="/admin/pipelines" className="button" data-variant="ghost">
      <ArrowLeft size={16} aria-hidden /> All pipelines
    </Link>
  )

  if (detail.data && !detail.data.success) {
    return (
      <main className="page">
        <PageHeader title="Pipeline" actions={back} />
        <div className="card card-body"><p className="field-error">{detail.data.message}</p></div>
      </main>
    )
  }
  if (catalogue.data && !catalogue.data.success) {
    return (
      <main className="page">
        <PageHeader title="Pipeline" actions={back} />
        <div className="card card-body"><p className="field-error">{catalogue.data.message}</p></div>
      </main>
    )
  }
  if (!pipeline || !catalogue.data?.response) {
    return (
      <main className="page">
        <PageHeader title="Pipeline" actions={back} />
        <p className="muted">Loading…</p>
      </main>
    )
  }

  return (
    <main className="page">
      <PageHeader title={pipeline.name} meta={pipeline.key} description={pipeline.description || undefined} actions={back} />
      {pipeline.retiredAt ? (
        <div className="notice" data-tone="error">
          Retired — no new cycle can choose it. {pipeline.retireReason}
        </div>
      ) : null}
      <PipelineEditor
        // A new draft, or none, is a different document: start its editor afresh.
        key={pipeline.draft ? `draft-${pipeline.draft.version}` : `published-${pipeline.published?.version ?? 0}`}
        detail={pipeline}
        catalogue={catalogue.data.response}
      />
    </main>
  )
}
