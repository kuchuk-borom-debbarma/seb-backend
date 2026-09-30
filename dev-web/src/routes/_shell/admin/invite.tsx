/**
 * Inviting somebody into the programme office.
 *
 * Two steps, deliberately: an administrator names the person and the role, and
 * the person themselves accepts. The role does not land until they do, so the
 * record always shows consent rather than an assignment somebody may not know
 * about.
 *
 * The link is emailed and is never shown here. An issuer who could read it
 * could forward it, and the invitee's mailbox is the whole reason possession of
 * the link means anything.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { OFFICE_LEDES } from '#/features/admin/officeGuidance'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import { InviteRoleDocument } from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { managedUserQuery } from '#/features/access/accessQueries'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { can } from '#/lib/session'
import { invitableRolesQuery } from '#/features/roles/roleQueries'

export const Route = createFileRoute('/_shell/admin/invite')({
  // Read by the page as it mounts, for whoever the gate below admits; asked
  // for here so the screen opens in one request.
  loader: ({ context }) =>
    can(context.user, 'role', 'invite') && can(context.user, 'user', 'read')
      ? context.queryClient.prefetchQuery(invitableRolesQuery)
      : undefined,
  component: InviteGate,
})

function InviteGate() {
  const { user } = Route.useRouteContext()
  /*
   * Two permissions, because the screen needs both to work. Inviting is the
   * point of it, but the first step looks somebody up by address, and the API
   * guards that with `user`/`read`. Admitting on the invite pair alone let a
   * role composed without the other one reach a screen where every lookup was
   * refused and there was no way forward.
   */
  if (!can(user, 'role', 'invite') || !can(user, 'user', 'read')) {
    return (
      <PermissionRefusal
        title="Invite a colleague"
        needs="anybody whose role may both look an account up and invite a colleague"
      />
    )
  }
  return <InvitePage />
}

function InvitePage() {
  /*
   * The list comes from the API, not from a table here.
   *
   * An invitation may not exceed the issuer's own authority, and that ceiling
   * is the server's rule. This screen used to carry its own copy of it, which
   * cannot be maintained at all now that a role is a row somebody composed —
   * and a stale copy would offer a choice the API then refuses.
   */
  const offered = useQuery(invitableRolesQuery)
  const roles = offered.data?.response ?? []
  const [email, setEmail] = useState('')
  const [looked, setLooked] = useState('')
  const [roleKey, setRoleKey] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ email: string; expiresAt: string } | null>(null)

  /*
   * Found by exact address, because that is the only way to find anybody here.
   * The access namespace deliberately offers no listing or prefix search, so
   * this screen cannot be used to enumerate accounts.
   */
  /*
   * The same query definition `/admin/access` uses, not a second one.
   *
   * Two definitions shared one cache key and stored different shapes — this
   * screen kept the unwrapped user, that one kept the envelope. Whichever
   * rendered second read the other's value, and this one crashed on
   * `subject.roles` because an envelope has no `roles`. One definition, one
   * shape.
   */
  const found = useQuery({
    ...managedUserQuery(looked.length > 0 ? looked : undefined),
    retry: false,
  })

  const invite = useMutation({
    mutationFn: async (subjectId: string) =>
      unwrap(
        (await gql(InviteRoleDocument, { input: { userId: subjectId, roleKey, reason } }))
          .access.inviteRole,
      ),
    onSuccess: (result) => {
      setError(null)
      setSent({ email: result.email, expiresAt: result.expiresAt })
    },
    onError: (failure) => setError(messageFor(failure)),
  })

  const subject = found.data?.response

  return (
    <main className="page">
      <PageHeader title="Invite a colleague" description={OFFICE_LEDES.invite} />

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Find the person</h3>
            <p className="field-hint">
              They must already have signed up and verified their email address.
            </p>
          </div>
        </div>

        <form
          className="stack"
          onSubmit={(submitted) => {
            submitted.preventDefault()
            setSent(null)
            setError(null)
            setLooked(email.trim().toLowerCase())
          }}
        >
          <div>
            <label className="field-label" htmlFor="invite-email">
              Their email address
            </label>
            <input
              id="invite-email"
              className="input"
              type="email"
              required
              value={email}
              onChange={(changed) => setEmail(changed.target.value)}
            />
          </div>
          <div className="row">
            <button type="submit" className="button">
              Look them up
            </button>
          </div>
        </form>

        {found.isError ? <p className="field-error">{messageFor(found.error)}</p> : null}

        {/*
          An address nobody holds is an ordinary refusal, not a thrown error.
          The shared query keeps the envelope, so a miss arrives as
          `success: false` with a message and leaves `isError` false — say so,
          or looking somebody up who has never signed up shows nothing at all.
        */}
        {found.data && !found.data.success ? (
          <p className="field-error" role="alert">
            {found.data.message ?? 'No account was found for that address.'}
          </p>
        ) : null}
      </div>

      {subject ? (
        <div className="card">
          <div className="card-header">
            <div>
              <h3>{subject.email}</h3>
              <p className="field-hint">
                {subject.roles.length === 0
                  ? 'Holds no active role.'
                  : `Currently: ${subject.roles.join(', ')}.`}
              </p>
            </div>
          </div>

          <form
            className="stack"
            onSubmit={(submitted) => {
              submitted.preventDefault()
              invite.mutate(subject.id)
            }}
          >
            <div>
              <label className="field-label" htmlFor="invite-role">
                Invite them to be
              </label>
              <select
                id="invite-role"
                className="select"
                required
                value={roleKey}
                onChange={(changed) => setRoleKey(changed.target.value)}
              >
                <option value="">Choose a role…</option>
                {roles.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.name} — {choice.description}
                  </option>
                ))}
              </select>
              {/*
                A refusal and an empty list are different answers and read
                differently. `isSuccess` covers both: react-query means the
                request resolved, while the envelope's `success` means the API
                agreed. Keying the sentence below on the former announced the
                ceiling to somebody whose request had actually been refused,
                and the refusal's own message was never shown at all.
              */}
              {offered.data && !offered.data.success ? (
                <p className="field-error" role="alert">
                  {offered.data.message ?? 'The roles you may offer could not be read.'}
                </p>
              ) : offered.data?.success && roles.length === 0 ? (
                /*
                 * An empty list is a rule, not a fault: you may offer only a
                 * role whose permissions you already hold, and this account
                 * holds nothing it can pass on. Saying so beats a picker with
                 * nothing in it.
                 */
                <p className="field-hint">
                  There is no role you can offer. An invitation cannot exceed your
                  own authority, so a super administrator has to compose one that
                  fits within it — or send the invitation themselves.
                </p>
              ) : null}
            </div>

            <div>
              <label className="field-label" htmlFor="invite-reason">
                Why
              </label>
              <input
                id="invite-reason"
                className="input"
                required
                maxLength={500}
                placeholder="Joining the intake team"
                value={reason}
                onChange={(changed) => setReason(changed.target.value)}
              />
              <p className="field-hint">Recorded against the invitation.</p>
            </div>

            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="row">
              <button
                type="submit"
                className="button"
                data-variant="primary"
                disabled={invite.isPending || !reason.trim()}
              >
                {invite.isPending ? 'Sending…' : 'Send the invitation'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {sent ? (
        <div className="card" role="status">
          <div className="card-header">
            <div>
              <h3>Invitation sent to {sent.email}</h3>
              {/*
                No link here on purpose. It went to their mailbox, which is
                what makes holding it mean anything.
              */}
              <p className="field-hint">
                It expires {formatDateTime(sent.expiresAt)}. If they miss it, send another
                — nothing is spent until somebody accepts.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
