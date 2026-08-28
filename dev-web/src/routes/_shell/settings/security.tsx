import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { Lock, MonitorSmartphone } from 'lucide-react'
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <PasswordSection />
      <SessionsSection />
    </div>
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
    <section
      style={{
        background: '#ffffff',
        border: '1px solid #D9DDE2',
        borderRadius: '12px',
        padding: '24px 28px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: '#EBF3FC',
            color: '#4271B7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: '2px',
          }}
        >
          <Lock size={22} />
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ink)', margin: '0 0 4px' }}>
            Password
          </h2>
          <p style={{ fontSize: '13.5px', color: 'var(--ink-secondary)', margin: '0 0 18px' }}>
            Change the password you use to sign in.
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              const matches = newPassword === confirmation
              setMismatch(!matches)
              if (matches) change.mutate()
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '640px' }}
          >
            <div>
              <label
                htmlFor="current-password"
                style={{
                  display: 'block',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: '6px',
                }}
              >
                Current password
              </label>
              <input
                id="current-password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #D9DDE2',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
              <p style={{ fontSize: '12.5px', color: 'var(--ink-secondary)', margin: '6px 0 0' }}>
                Asked for so that finding this screen already open is not enough to take the account over.
              </p>
            </div>

            <div>
              <label
                htmlFor="new-password"
                style={{
                  display: 'block',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: '6px',
                }}
              >
                New password
              </label>
              <input
                id="new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                placeholder="Enter new password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #D9DDE2',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
              <p style={{ fontSize: '12.5px', color: 'var(--ink-secondary)', margin: '6px 0 0' }}>
                At least 8 characters.
              </p>
            </div>

            <div>
              <label
                htmlFor="confirm-password"
                style={{
                  display: 'block',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  marginBottom: '6px',
                }}
              >
                Repeat the new password
              </label>
              <input
                id="confirm-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={mismatch}
                placeholder="Repeat new password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: mismatch ? '1px solid #C92929' : '1px solid #D9DDE2',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
              {mismatch ? (
                <p className="field-error" role="alert" style={{ marginTop: '4px' }}>
                  These two do not match.
                </p>
              ) : null}
            </div>

            <p style={{ fontSize: '12.5px', color: 'var(--ink-secondary)', margin: 0 }}>
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

            <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '4px' }}>
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={change.isPending}
                style={{
                  background: '#4271B7',
                  color: '#ffffff',
                  padding: '9px 22px',
                  borderRadius: '6px',
                  fontSize: '13.5px',
                  fontWeight: 500,
                }}
              >
                {change.isPending ? 'Changing password…' : 'Change password'}
              </button>
            </div>
          </form>
        </div>
      </div>
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
    <section
      style={{
        background: '#ffffff',
        border: '1px solid #D9DDE2',
        borderRadius: '12px',
        padding: '24px 28px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: '#EBF3FC',
            color: '#4271B7',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: '2px',
          }}
        >
          <MonitorSmartphone size={22} />
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '16px',
              flexWrap: 'wrap',
              marginBottom: '16px',
            }}
          >
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ink)', margin: '0 0 4px' }}>
                Signed-in devices
              </h2>
              <p style={{ fontSize: '13.5px', color: 'var(--ink-secondary)', margin: 0 }}>
                Every browser currently holding a sign-in for this account. Revoking a session
                signs that browser out immediately.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="button"
                data-variant="ghost"
                disabled={others.length === 0 || revoke.isPending}
                onClick={() => revoke.mutate({ type: 'others' })}
                style={{ fontSize: '13px' }}
              >
                Sign out other devices
              </button>
              <button
                type="button"
                className="button"
                data-variant="danger"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate({ type: 'all' })}
                style={{ fontSize: '13px' }}
              >
                Sign out everywhere
              </button>
            </div>
          </div>

          {revoke.isError ? (
            <p className="notice" data-tone="error" role="alert" style={{ marginBottom: '16px' }}>
              {messageFor(revoke.error)}
            </p>
          ) : null}

          <div
            style={{
              border: '1px solid #D9DDE2',
              borderRadius: '8px',
              overflow: 'hidden',
              marginTop: '12px',
            }}
          >
            <table className="table" style={{ margin: 0, width: '100%' }}>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isCurrent ? (
            <span
              style={{
                background: '#EAF5EE',
                color: '#23814C',
                fontSize: '11px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '4px',
              }}
            >
              This device
            </span>
          ) : null}
          <span style={{ color: 'var(--ink)', fontSize: '13px' }}>
            {session.userAgent ?? 'Unknown browser'}
          </span>
        </div>
        {session.ipAddress ? (
          <span style={{ fontSize: '12px', color: 'var(--ink-secondary)' }}>{session.ipAddress}</span>
        ) : null}
      </td>
      <td style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>
        {formatDateTime(session.createdAt)}
      </td>
      <td style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>
        {formatDateTime(session.updatedAt)}
      </td>
      <td style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>
        {formatRelative(session.expiresAt)}
      </td>
      <td data-numeric>
        {isCurrent ? null : (
          <button
            type="button"
            className="button"
            data-variant="ghost"
            disabled={busy}
            onClick={() => onRevoke(session.id)}
            style={{ fontSize: '12.5px', color: '#C92929' }}
          >
            Revoke
          </button>
        )}
      </td>
    </tr>
  )
}
