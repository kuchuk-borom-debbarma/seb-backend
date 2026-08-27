import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  ChangePasswordDocument,
  RevokeAllSessionsDocument,
  RevokeOtherSessionsDocument,
  RevokeSessionDocument,
  SessionsDocument,
} from '#/graphql/generated/operations'
import { formatDateTime, formatRelative } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { assertSucceeded, messageFor, unwrap } from '#/lib/result'
import { forgetSession } from '#/lib/session'
import styles from '#/features/settings/Settings.module.css'

const sessionsQuery = queryOptions({
  queryKey: ['sessions'],
  queryFn: async () => {
    const data = await gql(SessionsDocument)
    return unwrap(data.auth.sessions).sessions
  },
  staleTime: 5_000,
})

export const Route = createFileRoute('/_shell/settings/security')({
  loader: ({ context }) => context.queryClient.ensureQueryData(sessionsQuery),
  component: SecuritySettings,
})

function SecuritySettings() {
  return (
    <>
      <PasswordSection />
      <SessionsSection />
    </>
  )
}

function PasswordSection() {
  const queryClient = useQueryClient()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [mismatch, setMismatch] = useState(false)

  const change = useMutation({
    mutationFn: async () => {
      const data = await gql(ChangePasswordDocument, { currentPassword, newPassword })
      assertSucceeded(data.auth.changePassword)
    },
    onSuccess: async () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      // Other devices were signed out; this one was not. Re-reading keeps the
      // device list below honest.
      await forgetSession(queryClient)
    },
  })

  return (
    <section className={styles.section}>
      <h2>Password</h2>
      <p className={styles.sectionDescription}>
        Change the password you use to sign in.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault()
          /*
           * Checked here rather than by the API, because a typed-twice
           * mismatch is not a refusal — it is this screen's own job, and
           * sending it would spend a rate-limit allowance and a scrypt
           * verification to be told something the browser already knew.
           */
          const matches = newPassword === confirmation
          setMismatch(!matches)
          if (matches) change.mutate()
        }}
      >
        <div>
          <label className="field-label" htmlFor="current-password">
            Current password
          </label>
          <input
            id="current-password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <p className="field-hint">
            Asked for so that finding this screen already open is not enough to take
            the account over.
          </p>
        </div>

        <div>
          <label className="field-label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p className="field-hint">At least 8 characters.</p>
        </div>

        <div>
          <label className="field-label" htmlFor="confirm-password">
            Repeat the new password
          </label>
          <input
            id="confirm-password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={mismatch}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {mismatch ? (
            <p className="field-error" role="alert">
              These two do not match.
            </p>
          ) : null}
        </div>

        <p className="field-hint">
          Your other signed-in devices will be signed out. This one stays signed in.
        </p>

        {change.isError ? (
          <p className="notice" data-tone="error" role="alert">
            {messageFor(change.error)}
          </p>
        ) : null}

        {change.isSuccess ? (
          <p className="notice" data-tone="ok" role="status">
            Your password has been changed.
          </p>
        ) : null}

        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={change.isPending}
        >
          {change.isPending ? 'Changing password…' : 'Change password'}
        </button>
      </form>
    </section>
  )
}

function SessionsSection() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: sessions } = useQuery(sessionsQuery)
  const revoke = useMutation({
    mutationFn: async (
      action: { type: 'one'; id: string } | { type: 'others' } | { type: 'all' },
    ) => {
      if (action.type === 'one') {
        const data = await gql(RevokeSessionDocument, { sessionId: action.id })
        assertSucceeded(data.auth.revokeSession)
        return { endsThisSession: false }
      }
      if (action.type === 'others') {
        const data = await gql(RevokeOtherSessionsDocument)
        assertSucceeded(data.auth.revokeOtherSessions)
        return { endsThisSession: false }
      }
      const data = await gql(RevokeAllSessionsDocument)
      assertSucceeded(data.auth.revokeAllSessions)
      return { endsThisSession: true }
    },
    onSuccess: async (result) => {
      if (result.endsThisSession) {
        queryClient.clear()
        await router.navigate({ to: '/' })
        return
      }
      await queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey })
      await forgetSession(queryClient)
    },
  })

  const current = sessions?.find((session) => session.current)
  const others = sessions?.filter((session) => !session.current) ?? []

  return (
    <section className={styles.section}>
      <h2>Signed-in devices</h2>
      <p className={styles.sectionDescription}>
        Every browser currently holding a sign-in for this account. Revoking a session
        signs that browser out immediately.
      </p>

      <div className={styles.securityActions}>
        <button
          type="button"
          className="button"
          disabled={others.length === 0 || revoke.isPending}
          onClick={() => revoke.mutate({ type: 'others' })}
        >
          Sign out other devices
        </button>
        <button
          type="button"
          className="button"
          data-variant="danger"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate({ type: 'all' })}
        >
          Sign out everywhere
        </button>
      </div>

      {revoke.isError ? (
        <p className="notice" data-tone="error" role="alert">
          {messageFor(revoke.error)}
        </p>
      ) : null}

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Signed-in devices</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Signed in</th>
                <th scope="col">Last used</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {current ? (
                <SessionRow
                  session={current}
                  isCurrent
                  busy={revoke.isPending}
                  onRevoke={(id) => revoke.mutate({ type: 'one', id })}
                />
              ) : null}
              {others.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  isCurrent={false}
                  busy={revoke.isPending}
                  onRevoke={(id) => revoke.mutate({ type: 'one', id })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

type Session = Awaited<ReturnType<NonNullable<typeof sessionsQuery.queryFn>>>[number]

function SessionRow({
  session,
  isCurrent,
  busy,
  onRevoke,
}: {
  session: Session
  isCurrent: boolean
  busy: boolean
  onRevoke: (sessionId: string) => void
}) {
  return (
    <tr>
      <td>
        <div className="row" style={{ gap: '0.5rem' }}>
          {isCurrent ? (
            <span className="badge" data-tone="ok">
              This device
            </span>
          ) : null}
          <span className="muted">{session.userAgent ?? 'Unknown browser'}</span>
        </div>
        {session.ipAddress ? (
          <span className="tabular muted">{session.ipAddress}</span>
        ) : null}
      </td>
      <td>{formatDateTime(session.createdAt)}</td>
      <td>{formatDateTime(session.updatedAt)}</td>
      <td>{formatRelative(session.expiresAt)}</td>
      <td data-numeric>
        {isCurrent ? null : (
          <button
            type="button"
            className="button"
            data-variant="ghost"
            disabled={busy}
            onClick={() => onRevoke(session.id)}
          >
            Revoke
          </button>
        )}
      </td>
    </tr>
  )
}
