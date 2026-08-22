/**
 * Role management.
 *
 * Lookup is exact-match by design: the API offers no listing and no prefix
 * search, so this namespace cannot be used to enumerate accounts. That is a
 * security property, not a missing feature, and the screen says so rather than
 * offering a search box that would mostly return nothing.
 *
 * Every change to somebody's authority is confirmed with the operator's own
 * password. The API verifies it against the caller's account — this is a
 * step-up, not a second login.
 *
 * `APPLICANT` cannot be granted or revoked here. It is created only by verified
 * signup and nothing can grant it back, so allowing it would let one revocation
 * strip somebody permanently.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { managedUserQuery } from '#/features/access/accessQueries'
import { GrantRoleDocument, RevokeRoleDocument } from '#/graphql/generated/operations'
import type { ManageableRole } from '#/graphql/generated/schema'
import { formatDateTime, humanize, readableReason } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

type Search = { email?: string }

export const Route = createFileRoute('/_shell/access/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    email: typeof search.email === 'string' && search.email ? search.email : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    deps.email
      ? context.queryClient.ensureQueryData(managedUserQuery(deps.email))
      : undefined,
  component: AccessPage,
})

function AccessPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState(search.email ?? '')

  const { data, isFetching } = useQuery(managedUserQuery(search.email))
  const user = data?.response

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['managed-user', search.email] })

  return (
    <main className="page">
      <PageHeader
        title="Access"
        description="Who holds which role, and the whole history of how they got it."
      />

      <div className="stack">
        <div className="card">
          <div className="card-body">
            <form
              className="row"
              onSubmit={(event) => {
                event.preventDefault()
                navigate({ search: { email: typed.trim() || undefined } })
              }}
            >
              <div style={{ flex: '1 1 22rem' }}>
                <label className="field-label" htmlFor="email">
                  Email address
                </label>
                <input
                  id="email"
                  className="input"
                  type="email"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
                <span className="field-hint">
                  The whole address, exactly. There is no partial search — this
                  namespace deliberately cannot list accounts.
                </span>
              </div>
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={!typed.trim() || isFetching}
                style={{ alignSelf: 'start', marginTop: '1.5rem' }}
              >
                {isFetching ? 'Looking…' : 'Look them up'}
              </button>
            </form>
          </div>
        </div>

        {search.email && !isFetching && !user ? (
          <p className="notice" data-tone="error" role="alert">
            {data?.message ?? 'No account has that address.'}
          </p>
        ) : null}

        {user ? (
          <>
            <section className="card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Account</p>
                  <h2 style={{ marginTop: '0.25rem' }}>{user.email}</h2>
                </div>
                {user.deleted ? <span className="badge" data-tone="error">Closed</span> : null}
              </div>
              <div className="card-body">
                <div className="detail-grid">
                  <div>
                    <span className="field-label">Roles now</span>
                    <span>
                      {user.roles.length === 0
                        ? 'None'
                        : user.roles.map((role) => humanize(role)).join(', ')}
                    </span>
                  </div>
                  <div>
                    <span className="field-label">Email verified</span>
                    <span>{user.emailVerified ? 'Yes' : 'No'}</span>
                  </div>
                  <div>
                    <span className="field-label">Account created</span>
                    <span>{formatDateTime(user.createdAt)}</span>
                  </div>
                </div>
              </div>
            </section>

            <GrantRole userId={user.id} held={user.roles} onChanged={refresh} />

            <section className="card">
              <div className="card-header">
                <p className="eyebrow">Role history</p>
                <span className="muted">Complete, oldest first</span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Every role grant, open and closed</caption>
                  <thead>
                    <tr>
                      <th scope="col">Role</th>
                      <th scope="col">Granted</th>
                      <th scope="col">Why</th>
                      <th scope="col">State</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {user.grants.map((grant) => (
                      <tr key={grant.id} className={grant.revokedAt ? 'muted' : undefined}>
                        <td>{humanize(grant.role)}</td>
                        <td>
                          {formatDateTime(grant.grantedAt)}
                          {/* A null granter is a trusted system transition —
                              verified signup, or the one-time bootstrap — never
                              an anonymous person. */}
                          {grant.grantedByUserId ? null : (
                            <span className="field-hint">by the system</span>
                          )}
                        </td>
                        <td>{readableReason(grant.grantReason)}</td>
                        <td>
                          {grant.revokedAt ? (
                            <>
                              Revoked {formatDateTime(grant.revokedAt)}
                              <span className="field-hint">
                                {readableReason(grant.revocationReason ?? '')}
                              </span>
                            </>
                          ) : (
                            <span className="badge" data-tone="ok">Active</span>
                          )}
                        </td>
                        <td>
                          {!grant.revokedAt && grant.role !== 'APPLICANT' ? (
                            <RevokeRole grantId={grant.id} role={grant.role} onChanged={refresh} />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  )
}

const MANAGEABLE: ManageableRole[] = ['ADMIN', 'SUPER_ADMIN']

function GrantRole({
  userId,
  held,
  onChanged,
}: {
  userId: string
  held: readonly string[]
  onChanged: () => Promise<unknown>
}) {
  const [role, setRole] = useState<ManageableRole | ''>('')
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const grant = useMutation({
    mutationFn: async () => {
      const data = await gql(GrantRoleDocument, {
        input: {
          userId,
          role: role as ManageableRole,
          reason: reason.trim(),
          currentPassword: password,
        },
      })
      return unwrap(data.access.grantRole)
    },
    onMutate: () => {
      setError(null)
      setDone(null)
    },
    onSuccess: async () => {
      setDone(`${humanize(role as string)} granted.`)
      setRole('')
      setReason('')
      setPassword('')
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  // Offering a role somebody already holds would only produce a refusal.
  const available = MANAGEABLE.filter((candidate) => !held.includes(candidate))

  return (
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">Grant a role</p>
      </div>
      <div className="card-body">
        {available.length === 0 ? (
          <p className="muted">This account already holds every role you can grant.</p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              grant.mutate()
            }}
          >
            <div className="detail-grid">
              <div>
                <label className="field-label" htmlFor="role">
                  Role
                </label>
                <select
                  id="role"
                  className="select"
                  value={role}
                  onChange={(event) => setRole(event.target.value as ManageableRole)}
                >
                  <option value="">Choose a role</option>
                  {available.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {humanize(candidate)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: '2 / -1' }}>
                <label className="field-label" htmlFor="grant-reason">
                  Why they should have it
                </label>
                <input
                  id="grant-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="grant-password">
                  Your password
                </label>
                <input
                  id="grant-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <span className="field-hint">Confirms it is you making this change.</span>
              </div>
            </div>

            {error ? (
              <p className="notice" data-tone="error" role="alert" style={{ marginTop: '0.75rem' }}>
                {error}
              </p>
            ) : null}
            {done ? (
              <p className="notice" data-tone="ok" style={{ marginTop: '0.75rem' }}>
                {done}
              </p>
            ) : null}

            <button
              type="submit"
              className="button"
              data-variant="primary"
              style={{ marginTop: '0.75rem' }}
              disabled={!role || !reason.trim() || !password || grant.isPending}
            >
              {grant.isPending ? 'Granting…' : 'Grant it'}
            </button>
          </form>
        )}
      </div>
    </section>
  )
}

/**
 * Closing one grant.
 *
 * The grant is named exactly, so acting on a row that has already changed fails
 * loudly rather than closing a different grant.
 */
function RevokeRole({
  grantId,
  role,
  onChanged,
}: {
  grantId: string
  role: string
  onChanged: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const revoke = useMutation({
    mutationFn: async () => {
      const data = await gql(RevokeRoleDocument, {
        input: { grantId, reason: reason.trim(), currentPassword: password },
      })
      return unwrap(data.access.revokeRole)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setOpen(false)
      setReason('')
      setPassword('')
      await onChanged()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  if (!open) {
    return (
      <button type="button" className="button" data-variant="danger" onClick={() => setOpen(true)}>
        Revoke
      </button>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        revoke.mutate()
      }}
    >
      <label className="field-label" htmlFor={`revoke-reason-${grantId}`}>
        Why revoke {humanize(role)}?
      </label>
      <input
        id={`revoke-reason-${grantId}`}
        className="input"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <label className="field-label" htmlFor={`revoke-password-${grantId}`}>
        Your password
      </label>
      <input
        id={`revoke-password-${grantId}`}
        className="input"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button
          type="submit"
          className="button"
          data-variant="danger"
          disabled={!reason.trim() || !password || revoke.isPending}
        >
          {revoke.isPending ? 'Revoking…' : 'Revoke it'}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}
