/**
 * The pipelines: the routes an application takes after it is submitted.
 *
 * Each row says what a cycle choosing it would get — the version that is
 * published now — and whether somebody has unpublished work in a draft, since
 * a draft changes nothing until it is published and the list should not let
 * that be mistaken for the live route.
 *
 * Creating one is offered only to `pipeline:create`, and absent rather than
 * disabled for anybody else, like every other authoring control here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Plus, Workflow, X } from 'lucide-react'
import { useState } from 'react'
import { Dialog } from '#/components/Dialog'
import { PageHeader } from '#/components/PageHeader'
import modal from '#/features/admin/CycleDetails.module.css'
import { KEY_PATTERN, toKey } from '#/features/pipeline/definition'
import { pipelinesQuery, type PipelineSummary } from '#/features/pipeline/pipelineQueries'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { CreatePipelineDocument } from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/pipelines/')({
  loader: ({ context }) =>
    can(context.user, 'pipeline', 'read')
      ? context.queryClient.ensureQueryData(pipelinesQuery)
      : null,
  component: PipelinesGate,
})

function PipelinesGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'pipeline', 'read')) {
    return <PermissionRefusal title="Pipelines" needs="anybody who may read the office's pipelines" />
  }
  return <PipelinesPage mayCreate={can(user, 'pipeline', 'create')} />
}

function PipelinesPage({ mayCreate }: { mayCreate: boolean }) {
  const pipelines = useQuery(pipelinesQuery)
  const listed = pipelines.data?.response ?? []
  const [creating, setCreating] = useState(false)

  return (
    <main className="page">
      <PageHeader
        title="Pipelines"
        description={
          'The route an application takes once it is submitted: its stages, who ' +
          'works each one, and what each action there does. A cycle pins the ' +
          'version published when it opens.'
        }
        actions={
          mayCreate ? (
            <button type="button" className="button" data-variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden /> New pipeline
            </button>
          ) : null
        }
      />

      {pipelines.data && !pipelines.data.success ? (
        <div className="card card-body"><p className="field-error">{pipelines.data.message}</p></div>
      ) : null}

      {listed.length === 0 && pipelines.data?.success ? (
        <div className="card card-body">
          <p>
            No pipeline exists yet, so no cycle can open.
            {mayCreate ? ' Create one — starting from the example is the quickest way to a working route.' : ''}
          </p>
        </div>
      ) : null}

      <div className="stack">
        {listed.map((pipeline) => (
          <PipelineRow key={pipeline.id} pipeline={pipeline} />
        ))}
      </div>

      {creating ? <CreatePipelineDialog onClose={() => setCreating(false)} /> : null}
    </main>
  )
}

function PipelineRow({ pipeline }: { pipeline: PipelineSummary }) {
  return (
    <article className="card">
      <div className="card-header">
        <div>
          <h3>
            <Workflow size={16} aria-hidden /> {pipeline.name}{' '}
            {pipeline.retiredAt ? <span className="badge" data-tone="error">Retired</span> : null}
            {pipeline.draftVersion !== null ? (
              <span className="badge" data-tone="warn">Draft v{pipeline.draftVersion}</span>
            ) : null}
          </h3>
          <p className="field-hint">{pipeline.description || 'No description.'}</p>
        </div>
        <Link to="/admin/pipelines/$key" params={{ key: pipeline.key }} className="button">
          Open
        </Link>
      </div>
      <dl className="detail-grid card-body">
        <div>
          <dt className="field-label">Key</dt>
          <dd><code>{pipeline.key}</code></dd>
        </div>
        <div>
          <dt className="field-label">Published</dt>
          <dd>
            {pipeline.currentPublishedVersion === null
              ? 'Never — no cycle can choose it yet'
              : `Version ${pipeline.currentPublishedVersion}`}
          </dd>
        </div>
        <div>
          <dt className="field-label">Last changed</dt>
          <dd>{formatDateTime(pipeline.updatedAt)}</dd>
        </div>
        {pipeline.retiredAt ? (
          <div>
            <dt className="field-label">Why it was retired</dt>
            <dd>{pipeline.retireReason}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  )
}

function CreatePipelineDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [fromExample, setFromExample] = useState(true)

  // The key follows the name until somebody types one of their own.
  const effectiveKey = keyTouched ? key : toKey(name)
  const keyValid = KEY_PATTERN.test(effectiveKey)

  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        (
          await gql(CreatePipelineDocument, {
            input: { key: effectiveKey, name: name.trim(), description: description.trim(), startFromExample: fromExample },
          })
        ).admin.pipeline.create,
      ),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['pipelines'] })
      await navigate({ to: '/admin/pipelines/$key', params: { key: created.key } })
    },
  })

  return (
    <Dialog open onClose={onClose}>
      <div className={modal.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="newPipelineTitle">
        <div className={modal.modalDialog}>
          <div className={modal.modalHeader}>
            <h3 className={modal.modalTitle} id="newPipelineTitle">New pipeline</h3>
            <button type="button" className={modal.modalCloseButton} onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim() && keyValid) create.mutate()
            }}
          >
            <div className={modal.modalBody}>
              <div>
                <label className="field-label" htmlFor="pipelineName">Name</label>
                <input
                  id="pipelineName"
                  className="input"
                  value={name}
                  maxLength={120}
                  placeholder="e.g., Mission SEP route"
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <label className="field-label" htmlFor="pipelineKey">Key</label>
                <input
                  id="pipelineKey"
                  className="input"
                  value={effectiveKey}
                  aria-invalid={effectiveKey !== '' && !keyValid}
                  onChange={(event) => {
                    setKeyTouched(true)
                    setKey(event.target.value.toUpperCase())
                  }}
                />
                <p className="field-hint">
                  How cycles and the history name it. Capital letters, digits and underscores; it cannot be changed later.
                </p>
              </div>
              <div>
                <label className="field-label" htmlFor="pipelineDescription">Description</label>
                <textarea
                  id="pipelineDescription"
                  className="textarea"
                  value={description}
                  maxLength={1000}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <label className="checkbox-row">
                <input type="checkbox" checked={fromExample} onChange={(event) => setFromExample(event.target.checked)} />
                <span>
                  Start from the example (TTC → Industries &amp; Commerce → SBI or TGB). Otherwise the draft starts with one empty stage.
                </span>
              </label>
              {create.error ? <p className="field-error" role="alert">{messageFor(create.error)}</p> : null}
            </div>
            <div className={modal.modalFooter}>
              <button type="button" className="button" onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={!name.trim() || !keyValid || create.isPending}
              >
                {create.isPending ? 'Creating…' : 'Create the draft'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Dialog>
  )
}
