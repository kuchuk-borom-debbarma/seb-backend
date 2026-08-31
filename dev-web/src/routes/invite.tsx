/**
 * Where an emailed invitation lands.
 *
 * ## Why this is a page and not a redirect
 *
 * The link could have pointed straight at the API and swapped the role on
 * arrival. It does not, because mail providers open links: Gmail, Outlook and
 * most scanners fetch them to check for malware. The invitation would have been
 * spent before the person ever saw it, and the record would show an acceptance
 * nobody performed.
 *
 * So opening the link does nothing. A person has to press the button.
 *
 * ## Why the token is in the fragment
 *
 * `#<token>` rather than `?token=`. A fragment is never sent to a server, so
 * the invitation stays out of access logs, out of `Referer` headers, and out of
 * anything sitting between the browser and the portal. It is read here in the
 * browser and sent in the body of the mutation.
 *
 * Outside the portal shell on purpose: whoever opens this is not staff yet, and
 * may not be signed in at all.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AcceptRoleInviteDocument } from '#/graphql/generated/operations'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { forgetSession } from '#/lib/session'
import styles from './sign-in.module.css'

/** How a role reads to the person being offered it. */
const ROLE_NAMES: Record<string, string> = {
  REVIEWER: 'a reviewer',
  APPROVER: 'an approver',
  ADMIN: 'a programme officer',
  ANNOUNCER: 'an announcer',
  SUPER_ADMIN: 'a super administrator',
}

export const Route = createFileRoute('/invite')({
  component: AcceptInvitePage,
})

function AcceptInvitePage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [token, setToken] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
   * Read after mount, not during render. The fragment does not exist during
   * server rendering — it never reaches the server — so reading it any earlier
   * gives nothing and warns about a hydration mismatch.
   */
  useEffect(() => {
    setToken(window.location.hash.replace(/^#/u, '') || null)
  }, [])

  const accept = useMutation({
    mutationFn: async (sealed: string) =>
      unwrap(
        (await gql(AcceptRoleInviteDocument, { token: sealed })).access.acceptRoleInvite,
      ),
    onSuccess: async (result) => {
      setError(null)
      setAccepted(result.role)
      /*
       * Their roles just changed, so anything cached about who they are is
       * wrong rather than merely stale — including the navigation, which is
       * drawn from the capabilities the session carries.
       */
      await forgetSession(queryClient)
      await router.invalidate()
    },
    onError: (failure) => setError(messageFor(failure)),
  })

  if (accepted) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <h1>You are now {ROLE_NAMES[accepted] ?? accepted}</h1>
          <p>
            Your applicant access has been exchanged for it, so the programme office is
            where you work from now.
          </p>
          <Link to="/admin" className="button" data-variant="primary">
            Open the programme office
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1>You have been invited to the programme office</h1>

        {token === null ? (
          <p>
            This link is incomplete. Open the one from your email exactly as it was sent —
            copying only part of it leaves the invitation behind.
          </p>
        ) : (
          <>
            <p>
              Accepting exchanges your applicant access for a staff role. If you were not
              expecting this, close this page and nothing changes.
            </p>

            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={accept.isPending}
              onClick={() => accept.mutate(token)}
            >
              {accept.isPending ? 'Accepting…' : 'Accept the invitation'}
            </button>
          </>
        )}
      </div>
    </main>
  )
}
