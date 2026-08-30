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
import { CapabilityRefusal } from '#/features/portal/CapabilityRefusal'
import { InviteRoleDocument } from '#/graphql/generated/operations'
import type { ManageableRole } from '#/graphql/generated/schema'
import { formatDateTime } from '#/lib/format'
import { managedUserQuery } from '#/features/access/accessQueries'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { can, type SignedInUser } from '#/lib/session'

/**
 * What each issuer may invite somebody to.
 *
 * Mirrors the ceiling the API enforces: an administrator may not invite
 * somebody to `ADMIN` or `SUPER_ADMIN`, because obtaining through a second
 * account what you are directly forbidden is the escalation the whole rule
 * exists to prevent. Shown here so nobody is offered a choice that will be
 * refused; the API refuses it regardless of what this offers.
 */
const invitableBy = (user: SignedInUser): ManageableRole[] =>
  can(user, 'ROLE_ADMIN')
    ? ['REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER']
    : ['REVIEWER', 'APPROVER']

const ROLE_LABELS: Record<ManageableRole, string> = {
  REVIEWER: 'Reviewer — reads casework, changes nothing',
  APPROVER: 'Approver — reads casework and records the decision',
  ADMIN: 'Programme officer — the full office workflow',
  ANNOUNCER: 'Announcer — writes the public announcement banner',
  SUPER_ADMIN: 'Super administrator',
}

export const Route = createFileRoute('/_shell/admin/invite')({
  component: InviteGate,
})

function InviteGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'ROLE_INVITE')) {
    return (
      <CapabilityRefusal
        title="Invite a colleague"
        needs="programme officers and super administrators"
      />
    )
  }
  return <InvitePage user={user} />
}

function InvitePage({ user }: { user: SignedInUser }) {
  const roles = invitableBy(user)
  const [email, setEmail] = useState('')
  const [looked, setLooked] = useState('')
  const [role, setRole] = useState<ManageableRole>(roles[0]!)
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
        (await gql(InviteRoleDocument, { input: { userId: subjectId, role, reason } }))
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
                value={role}
                onChange={(changed) => setRole(changed.target.value as ManageableRole)}
              >
                {roles.map((offered) => (
                  <option key={offered} value={offered}>
                    {ROLE_LABELS[offered]}
                  </option>
                ))}
              </select>
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
