/**
 * Who works each stage.
 *
 * Ownership is live authority rather than part of the document: a change takes
 * effect at once, is never published, and is kept as history with its reason.
 * It is also what separates two stages that need the same permissions — a
 * State Bank of India officer and a Tripura Gramin Bank officer hold identical
 * permissions and see different files only because they own different stages.
 *
 * The server holds the ceiling: you may give or take a stage only if you work
 * it yourself and could offer every role you add or remove. This screen offers
 * the change and shows the refusal in the server's words.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, X } from 'lucide-react'
import { useState } from 'react'
import { Dialog } from '#/components/Dialog'
import modal from '#/features/admin/CycleDetails.module.css'
import { rolesQuery } from '#/features/roles/roleQueries'
import { SetPipelineStageOwnersDocument } from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import type { PipelineDefinition } from './definition'
import type { PipelineDetail } from './pipelineQueries'
import styles from './Pipeline.module.css'

type StageRow = PipelineDetail['stages'][number]

export function OwnersTab({
  detail,
  definition,
  mayAssign,
}: {
  detail: PipelineDetail
  definition: PipelineDefinition
  mayAssign: boolean
}) {
  const [editing, setEditing] = useState<{ stage: StageRow; name: string } | null>(null)
  const saved = new Map(detail.stages.map((stage) => [stage.stageKey, stage]))
  const named = new Map(definition.stages.map((stage) => [stage.key, stage.name]))
  // The document's stages first, in its order; then any stage a published
  // version still has that the working copy no longer names.
  const keys = [
    ...definition.stages.map((stage) => stage.key),
    ...detail.stages.map((stage) => stage.stageKey).filter((key) => !named.has(key)),
  ]

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        The roles that work each stage. Changes take effect immediately, without publishing, and are kept in the
        activity history with their reason.
      </p>
      <div className="table-wrap card">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Worked by</th>
              <th scope="col"><span className="visually-hidden">Change</span></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const row = saved.get(key)
              return (
                <tr key={key}>
                  <td>
                    {named.get(key) ?? key}
                    <br />
                    <code className={styles.listKey}>{key}</code>
                    {!named.has(key) ? <><br /><span className="field-hint">Not in the working draft</span></> : null}
                  </td>
                  <td>
                    {!row ? (
                      <span className="field-hint">Save the draft first — a stage can be given owners once it has been saved.</span>
                    ) : row.owners.length === 0 ? (
                      <span className="badge" data-tone="warn">Nobody — files here cannot be worked</span>
                    ) : (
                      <ul className={styles.tagList}>
                        {row.owners.map((owner) => (
                          <li key={owner.roleId} className={styles.tag} title={`Since ${formatDateTime(owner.addedAt)}`}>
                            {owner.roleName}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {row && mayAssign ? (
                      <button type="button" className="button" onClick={() => setEditing({ stage: row, name: named.get(key) ?? key })}>
                        <Pencil size={14} aria-hidden /> Change
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {editing ? (
        <OwnersDialog pipelineId={detail.id} pipelineKey={detail.key} stage={editing.stage} stageName={editing.name} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  )
}

function OwnersDialog({
  pipelineId,
  pipelineKey,
  stage,
  stageName,
  onClose,
}: {
  pipelineId: string
  pipelineKey: string
  stage: StageRow
  stageName: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const roles = useQuery(rolesQuery)
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(stage.owners.map((owner) => owner.roleKey)))
  const [reason, setReason] = useState('')

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        (
          await gql(SetPipelineStageOwnersDocument, {
            input: {
              pipelineId,
              stageKey: stage.stageKey,
              expectedOwnersVersion: stage.ownersVersion,
              roleKeys: [...chosen].sort(),
              reason: reason.trim(),
            },
          })
        ).admin.pipeline.setStageOwners,
      ),
    onSuccess: async (detail) => {
      queryClient.setQueryData(['pipelines', 'detail', pipelineKey], { success: true, message: null, response: detail })
      await queryClient.invalidateQueries({ queryKey: ['pipelines'] })
      onClose()
    },
  })

  // Super administrators and applicants are not offered: the first works every
  // stage already, and the second is not staff.
  const offered = (roles.data?.response ?? []).filter((role) => !['SUPER_ADMIN', 'APPLICANT'].includes(role.key))

  return (
    <Dialog open onClose={onClose}>
      <div className={modal.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="ownersTitle">
        <div className={modal.modalDialog}>
          <div className={modal.modalHeader}>
            <h3 className={modal.modalTitle} id="ownersTitle">Who works {stageName}</h3>
            <button type="button" className={modal.modalCloseButton} onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className={modal.modalBody}>
            {roles.data && !roles.data.success ? <p className="field-error">{roles.data.message}</p> : null}
            {roles.isPending ? <p className="muted">Loading roles…</p> : null}
            <fieldset className="fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field-label">Roles</legend>
              <div className="stack" style={{ gap: '0.375rem', maxHeight: '16rem', overflowY: 'auto' }}>
                {offered.map((role) => (
                  <label key={role.id} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={chosen.has(role.key)}
                      onChange={(event) => {
                        const next = new Set(chosen)
                        if (event.target.checked) next.add(role.key)
                        else next.delete(role.key)
                        setChosen(next)
                      }}
                    />
                    <span>
                      {role.name} <code className={styles.listKey}>{role.key}</code>
                    </span>
                  </label>
                ))}
                {roles.data?.success && offered.length === 0 ? <p className="field-hint">No roles have been composed yet.</p> : null}
              </div>
            </fieldset>
            <div>
              <label className="field-label" htmlFor="ownersReason">Why</label>
              <textarea id="ownersReason" className="textarea" maxLength={500} value={reason}
                placeholder="Kept in the activity history" onChange={(event) => setReason(event.target.value)} />
            </div>
            {save.error ? <p className="field-error" role="alert">{messageFor(save.error)}</p> : null}
          </div>
          <div className={modal.modalFooter}>
            <button type="button" className="button" onClick={onClose}>Cancel</button>
            <button type="button" className="button" data-variant="primary" disabled={!reason.trim() || save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save owners'}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
