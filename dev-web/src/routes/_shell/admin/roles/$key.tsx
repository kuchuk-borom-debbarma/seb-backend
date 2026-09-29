/**
 * Deciding what a role may do, and retiring one.
 *
 * The picker renders entirely from the server's own catalogue, so it can never
 * offer a permission nothing checks — a role editor with a hard-coded list
 * would be exactly that, one deploy later.
 *
 * ## Why the whole set is sent
 *
 * A role is live while it is being edited: every holder's next request is
 * authorized against whatever it currently holds. Turning six permissions on
 * and two off as eight separate writes would authorize people against six
 * intermediate states nobody chose. So the set goes in one write, guarded by
 * the version read with it, and a concurrent edit refuses rather than
 * interleaving.
 *
 * ## What the screen shows before it acts
 *
 * The pending change is drawn beside the save control — what is being added and
 * what is being taken away — because "save" on a permission picker is one of
 * the few buttons in this portal that silently changes what other people can
 * do. The holder count sits beside the retire control for the same reason.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Minus, Plus, Trash2, Users } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import {
  catalogueQuery,
  humanizeKey,
  permissionKey,
  roleQuery,
  type Role,
} from '#/features/roles/roleQueries'
import { DeleteRoleDocument, UpdateRoleDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { isSuperAdministrator } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/roles/$key')({
  loader: ({ context, params }) => Promise.all([
    context.queryClient.ensureQueryData(roleQuery(params.key)),
    context.queryClient.ensureQueryData(catalogueQuery),
  ]),
  component: EditGate,
})

function EditGate() {
  const { user } = Route.useRouteContext()
  const { key } = Route.useParams()
  if (!isSuperAdministrator(user)) {
    return <PermissionRefusal title="Edit a role" needs="super administrators" />
  }
  return <EditLoader roleKey={key} />
}

function EditLoader({ roleKey }: { roleKey: string }) {
  const found = useQuery(roleQuery(roleKey))
  const role = found.data?.response
  if (found.data && !found.data.success) {
    return (
      <main className="page">
        <PageHeader title="Edit a role" description="" />
        <div className="card"><p className="field-error">{found.data.message}</p></div>
      </main>
    )
  }
  if (!role) return null
  /*
   * Keyed on the version so the form's own state is thrown away whenever the
   * role moves underneath it. Without this a reload after a refused save would
   * re-mount with the stale selection still in hand.
   */
  return <EditPage key={`${role.id}:${role.version}`} role={role} />
}

function EditPage({ role }: { role: Role }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const catalogue = useQuery(catalogueQuery)

  const saved = new Set(role.permissions.map(permissionKey))
  const [chosen, setChosen] = useState<Set<string>>(new Set(saved))
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retiring, setRetiring] = useState(false)
  const [reason, setReason] = useState('')

  const added = [...chosen].filter((pair) => !saved.has(pair))
  const removed = [...saved].filter((pair) => !chosen.has(pair))
  const changed =
    added.length > 0 || removed.length > 0 ||
    name !== role.name || description !== role.description

  const toggle = (pair: string) => setChosen((held) => {
    const next = new Set(held)
    if (next.has(pair)) next.delete(pair)
    else next.add(pair)
    return next
  })

  const save = useMutation({
    mutationFn: async () =>
      unwrap((await gql(UpdateRoleDocument, {
        input: {
          roleId: role.id,
          expectedVersion: role.version,
          name: name.trim(),
          description: description.trim(),
          permissions: [...chosen].map((pair) => {
            const [resource, action] = pair.split(':')
            return { resource: resource!, action: action! }
          }),
          currentPassword: password,
        },
      })).access.updateRole),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setPassword('')
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
    },
    onError: (failure) => setError(messageFor(failure)),
  })

  const retire = useMutation({
    mutationFn: async () =>
      unwrap((await gql(DeleteRoleDocument, {
        input: {
          roleId: role.id,
          expectedVersion: role.version,
          reason: reason.trim(),
          currentPassword: password,
        },
      })).access.deleteRole),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      await navigate({ to: '/admin/roles' })
    },
    onError: (failure) => setError(messageFor(failure)),
  })

  return (
    <main className="page">
      <PageHeader
        title={role.name}
        description={`${role.key} · held by ${role.memberCount === 1
          ? '1 account'
          : `${role.memberCount} accounts`}`}
        actions={
          // Composed, edited, retired: this role's own history. Only a super
          // administrator reaches this screen, and they may read the history.
          <Link to="/admin/audit" search={{ types: ['CORE_ROLE'], entity: role.id }} className="button">
            History
          </Link>
        }
      />

      <form
        className="card stack"
        onSubmit={(submitted) => {
          submitted.preventDefault()
          save.mutate()
        }}
      >
        <div className="card-header">
          <div>
            <h3>Name and purpose</h3>
            <p className="field-hint">
              Changing these alters nobody's authority, so they save with the
              permissions below.
            </p>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="role-name">What the office calls it</label>
          <input
            id="role-name" className="input" required maxLength={80}
            value={name} onChange={(changed_) => setName(changed_.target.value)}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="role-description">What it is for</label>
          <textarea
            id="role-description" className="input" required rows={3} maxLength={500}
            value={description}
            onChange={(changed_) => setDescription(changed_.target.value)}
          />
        </div>

        <div className="card-header">
          <div>
            <h3>What it may do</h3>
            <p className="field-hint">
              Everything this server can enforce, grouped by what it acts on.
              Anything left unticked is taken away when you save.
            </p>
          </div>
        </div>

        {(catalogue.data?.response?.resources ?? []).map((resource) => {
          const all = resource.actions.map((act) =>
            permissionKey({ resource: resource.resource, action: act.action }))
          const every = all.every((pair) => chosen.has(pair))
          return (
            <fieldset key={resource.resource} className="stack">
              <legend className="field-label">
                {humanizeKey(resource.resource)}
              </legend>
              <p className="field-hint">{resource.description}</p>
              <button
                type="button"
                className="button-quiet"
                onClick={() => setChosen((held) => {
                  const next = new Set(held)
                  for (const pair of all) {
                    if (every) next.delete(pair)
                    else next.add(pair)
                  }
                  return next
                })}
              >
                {every ? <Minus size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
                {every ? ' Clear all' : ' Select all'}
              </button>
              {resource.actions.map((act) => {
                const pair = permissionKey({
                  resource: resource.resource,
                  action: act.action,
                })
                return (
                  <label key={pair} className="checkbox">
                    <input
                      type="checkbox"
                      checked={chosen.has(pair)}
                      onChange={() => toggle(pair)}
                    />
                    <span>
                      <strong>{humanizeKey(act.action)}</strong>
                      <span className="field-hint"> {act.description}</span>
                    </span>
                  </label>
                )
              })}
            </fieldset>
          )
        })}

        {changed ? (
          <div className="card">
            <h4>About to change</h4>
            <ul>
              {added.map((pair) => <li key={pair}>Add <code>{pair}</code></li>)}
              {removed.map((pair) => (
                <li key={pair}>
                  Take away <code>{pair}</code>
                  {role.memberCount > 0
                    ? ` — ${role.memberCount === 1 ? '1 account loses' : `${role.memberCount} accounts lose`} it on their next request`
                    : null}
                </li>
              ))}
              {name !== role.name ? <li key="name">Rename to “{name}”</li> : null}
              {description !== role.description
                ? <li key="purpose">Rewrite what it is for</li>
                : null}
            </ul>
          </div>
        ) : null}

        <div>
          <label className="field-label" htmlFor="role-password">Your password</label>
          <input
            id="role-password" className="input" type="password"
            autoComplete="current-password"
            value={password}
            onChange={(changed_) => setPassword(changed_.target.value)}
          />
          <p className="field-hint">
            Re-entered because this moves what every holder may do the moment it
            lands. It is checked against your own account, not theirs.
          </p>
        </div>

        {error ? <p className="field-error">{error}</p> : null}

        <div className="row">
          <button
            type="submit"
            className="button"
            disabled={!changed || password.length === 0 || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save what it may do'}
          </button>
        </div>
      </form>

      <section className="card stack">
        <div className="card-header">
          <div>
            <h3>Retire this role</h3>
            <p className="field-hint">
              <Users size={14} aria-hidden />{' '}
              {role.memberCount === 0
                ? 'Nobody holds it, so nobody loses anything.'
                : `${role.memberCount === 1 ? '1 account holds' : `${role.memberCount} accounts hold`} it and will lose that access on their next request.`}
              {' '}Its grants stay in the activity history, closed with a reason.
            </p>
          </div>
        </div>

        {retiring ? (
          <form
            className="stack"
            onSubmit={(submitted) => {
              submitted.preventDefault()
              retire.mutate()
            }}
          >
            <div>
              <label className="field-label" htmlFor="retire-reason">Why</label>
              <input
                id="retire-reason" className="input" required maxLength={500}
                value={reason} onChange={(changed_) => setReason(changed_.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="retire-password">Your password</label>
              <input
                id="retire-password" className="input" type="password"
                autoComplete="current-password"
                value={password}
                onChange={(changed_) => setPassword(changed_.target.value)}
              />
            </div>
            <div className="row">
              <button type="submit" className="button-danger" disabled={retire.isPending}>
                {retire.isPending ? 'Retiring…' : 'Retire it'}
              </button>
              <button type="button" className="button-quiet" onClick={() => setRetiring(false)}>
                Keep it
              </button>
            </div>
          </form>
        ) : (
          <div className="row">
            <button type="button" className="button-danger" onClick={() => setRetiring(true)}>
              <Trash2 size={16} aria-hidden /> Retire this role
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
