/**
 * Naming a new role.
 *
 * Naming a role and deciding what it may do are two acts, and this is only the
 * first: a role arrives holding nothing. That is deliberate — a role is live
 * from the moment it exists, so one that arrived already carrying permissions
 * would be authorizing people during the window nobody is looking at it.
 *
 * No password is asked for here, and the screen says why. A step-up prompt
 * appears on the edit screen instead, where the change actually moves what
 * somebody may do; asking for one on an act that grants nothing teaches people
 * to type their password without reading the question.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { rolesQuery } from '#/features/roles/roleQueries'
import { CreateRoleDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { isSuperAdministrator } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/roles/new')({
  component: ComposeGate,
})

function ComposeGate() {
  const { user } = Route.useRouteContext()
  if (!isSuperAdministrator(user)) {
    return (
      <PermissionRefusal
        title="Compose a role"
        needs="super administrators"
      />
    )
  }
  return <ComposePage />
}

function ComposePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async () =>
      unwrap((await gql(CreateRoleDocument, {
        input: { key: key.trim(), name: name.trim(), description: description.trim() },
      })).access.createRole),
    onMutate: () => setError(null),
    onSuccess: async (role) => {
      await queryClient.invalidateQueries({ queryKey: rolesQuery.queryKey })
      // Straight into the editor: the role exists but holds nothing, so the
      // job is not finished and the screen should not pretend it is.
      await navigate({ to: '/admin/roles/$key', params: { key: role.key } })
    },
    onError: (failure) => setError(messageFor(failure)),
  })

  return (
    <main className="page">
      <PageHeader
        title="Compose a role"
        description={
          'Name a job the office does. You choose what it may do on the next ' +
          'screen, so it starts able to do nothing.'
        }
      />

      <form
        className="card card-body stack"
        onSubmit={(submitted) => {
          submitted.preventDefault()
          create.mutate()
        }}
      >
        <div>
          <label className="field-label" htmlFor="role-name">What the office calls it</label>
          <input
            id="role-name"
            className="input"
            required
            maxLength={80}
            value={name}
            placeholder="SBI bank officer"
            onChange={(changed) => setName(changed.target.value)}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="role-key">Key</label>
          <input
            id="role-key"
            className="input"
            required
            maxLength={63}
            value={key}
            placeholder="SBI_BANK"
            onChange={(changed) => setKey(changed.target.value)}
          />
          <p className="field-hint">
            How the role is named in the activity history and in invitations.
            Letters, digits and underscores. It is never reused once a role is
            retired, so past records cannot confuse two different jobs.
          </p>
        </div>

        <div>
          <label className="field-label" htmlFor="role-description">What it is for</label>
          <textarea
            id="role-description"
            className="input"
            required
            rows={3}
            maxLength={500}
            value={description}
            placeholder="Works the State Bank of India stage: sends files back and records the loan."
            onChange={(changed) => setDescription(changed.target.value)}
          />
          <p className="field-hint">
            Whoever hands this role out reads this sentence before they do.
          </p>
        </div>

        {error ? <p className="field-error">{error}</p> : null}

        <div className="row">
          <button type="submit" className="button" data-variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Composing…' : 'Compose the role'}
          </button>
        </div>
      </form>
    </main>
  )
}
