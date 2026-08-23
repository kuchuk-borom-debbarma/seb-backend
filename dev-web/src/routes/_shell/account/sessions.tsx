import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryOptions } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import {
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
  // Revoking elsewhere should show up promptly; this list is small and cheap.
  staleTime: 5_000,
})

export const Route = createFileRoute('/_shell/account/sessions')({
  // Started in the loader so the request and the route's code load together
  // rather than one after the other.
  loader: ({ context }) => context.queryClient.ensureQueryData(sessionsQuery),
  component: SessionsPage,
})

function SessionsPage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: sessions } = useQuery(sessionsQuery)

  /**
   * Every revocation refreshes the same list.
   *
   * Revoking the current session also ends this browser's sign-in, so the
   * identity has to be discarded and the person returned to the sign-in page
   * rather than left on a screen they can no longer load.
   */
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
      // Revoking everywhere includes this browser, so the sign-in ends here too.
      return { endsThisSession: true }
    },
    onSuccess: async (result) => {
      if (result.endsThisSession) {
        queryClient.clear()
        await router.navigate({ to: '/sign-in' })
        return
      }
      await queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey })
      await forgetSession(queryClient)
    },
  })

  const current = sessions?.find((session) => session.current)
  const others = sessions?.filter((session) => !session.current) ?? []

  return (
    <main className="page">
      <PageHeader
        title="Signed-in devices"
        description="Every browser currently holding a sign-in for this account. Revoking one signs it out immediately — sessions are deleted, not merely expired."
        actions={
          <>
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
          </>
        }
      />

      {revoke.isError ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginBottom: '1rem' }}
        >
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
    </main>
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
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            {session.userAgent ?? 'Unknown browser'}
          </span>
        </div>
        {session.ipAddress ? (
          <span className="tabular muted" style={{ fontSize: '0.75rem' }}>
            {session.ipAddress}
          </span>
        ) : null}
      </td>
      <td>{formatDateTime(session.createdAt)}</td>
      <td>{formatDateTime(session.updatedAt)}</td>
      <td>{formatRelative(session.expiresAt)}</td>
      <td style={{ textAlign: 'right' }}>
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
