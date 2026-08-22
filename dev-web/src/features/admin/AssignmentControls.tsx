/**
 * Who is working on this application.
 *
 * Claiming, releasing and reassigning all carry the assignment version read
 * from the workspace, so two people claiming at the same moment produce a
 * refusal for one of them rather than both believing they hold it.
 *
 * Taking an application somebody else already holds is possible and is not
 * hidden — it is a normal thing to need — but it has to be acknowledged
 * explicitly, and the API records that acknowledgement against the person who
 * made it.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  reasonsFor,
  type ReasonCategory,
} from '#/features/admin/workspaceQueries'
import {
  ClaimApplicationDocument,
  ManagedUserByEmailDocument,
  ReassignApplicationDocument,
  ReleaseApplicationDocument,
} from '#/graphql/generated/operations'
import { formatDateTime } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'
import { sessionQuery } from '#/lib/session'

export function AssignmentControls({
  applicationId,
  assignedToUserId,
  assignedAt,
  assignmentVersion,
  reasons,
  onChanged,
}: {
  applicationId: string
  assignedToUserId: string | null
  assignedAt: string | null
  assignmentVersion: number
  reasons: ReasonCategory[] | undefined
  onChanged: () => Promise<unknown>
}) {
  const { data: session } = useQuery(sessionQuery)
  const [error, setError] = useState<string | null>(null)
  const [showRelease, setShowRelease] = useState(false)
  const [showReassign, setShowReassign] = useState(false)

  const mine = Boolean(assignedToUserId) && assignedToUserId === session?.user.id
  const someoneElse = Boolean(assignedToUserId) && !mine

  const claim = useMutation({
    mutationFn: async () => {
      const data = await gql(ClaimApplicationDocument, {
        input: {
          applicationId,
          expectedAssignmentVersion: assignmentVersion,
          // Taking it from somebody is a deliberate act; claiming an unheld
          // application is not, and must not be reported as one.
          conflictAcknowledged: someoneElse,
        },
      })
      unwrap(data.admin.intake.claim)
    },
    onMutate: () => setError(null),
    onSuccess: onChanged,
    onError: (cause) => setError(messageFor(cause)),
  })

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <p className="eyebrow">Assignment</p>
          <h3>
            {mine
              ? 'You have this'
              : someoneElse
                ? 'Someone else has this'
                : 'Nobody has claimed this'}
          </h3>
          {assignedAt ? (
            <p className="field-hint">Claimed {formatDateTime(assignedAt)}</p>
          ) : null}
        </div>
        <div className="row">
          {mine ? (
            <button type="button" className="button" onClick={() => setShowRelease(true)}>
              Release it
            </button>
          ) : (
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={claim.isPending}
              onClick={() => claim.mutate()}
            >
              {claim.isPending ? 'Claiming…' : someoneElse ? 'Take it over' : 'Claim it'}
            </button>
          )}
          {assignedToUserId ? (
            <button type="button" className="button" onClick={() => setShowReassign(true)}>
              Hand it to someone
            </button>
          ) : null}
        </div>
      </div>

      {someoneElse ? (
        <div className="card-body">
          <p className="notice" data-tone="warn">
            <span className="notice-title">Already claimed</span>
            Taking it over is recorded against your account, and the person who
            had it loses it immediately.
          </p>
        </div>
      ) : null}

      {showRelease ? (
        <ReasonedAction
          title="Release this application"
          explanation="It goes back to the queue for anyone to pick up."
          confirmLabel="Release it"
          reasons={reasonsFor(reasons, 'ASSIGNMENT_RELEASE')}
          onCancel={() => setShowRelease(false)}
          onConfirm={async (reasonCategoryId, reason) => {
            const data = await gql(ReleaseApplicationDocument, {
              input: {
                applicationId,
                expectedAssignmentVersion: assignmentVersion,
                reasonCategoryId,
                reason,
              },
            })
            unwrap(data.admin.intake.release)
            setShowRelease(false)
            await onChanged()
          }}
        />
      ) : null}

      {showReassign ? (
        <ReasonedAction
          title="Hand this to someone else"
          explanation="They hold it from that moment, and this is recorded against your account."
          confirmLabel="Hand it over"
          reasons={reasonsFor(reasons, 'ASSIGNMENT_REASSIGN')}
          needsPerson
          onCancel={() => setShowReassign(false)}
          onConfirm={async (reasonCategoryId, reason, toUserId) => {
            const data = await gql(ReassignApplicationDocument, {
              input: {
                applicationId,
                expectedAssignmentVersion: assignmentVersion,
                toUserId: toUserId as string,
                reasonCategoryId,
                reason,
                conflictAcknowledged: true,
              },
            })
            unwrap(data.admin.intake.reassign)
            setShowReassign(false)
            await onChanged()
          }}
        />
      ) : null}

      {error ? (
        <div className="card-body">
          <p className="notice" data-tone="error" role="alert">
            {error}
          </p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * An action that must name a reason from the cycle's catalogue, and sometimes a
 * person.
 *
 * The reason is two parts on purpose: a category the programme reports on, and
 * a sentence about this particular application. The API requires both.
 *
 * People are identified by email rather than by an internal id, because that is
 * what a colleague can tell you. The address is resolved through the same
 * lookup the access screens use, so a typo is caught before the reassignment is
 * attempted rather than after.
 */
function ReasonedAction({
  title,
  explanation,
  confirmLabel,
  reasons,
  needsPerson,
  onCancel,
  onConfirm,
}: {
  title: string
  explanation: string
  confirmLabel: string
  reasons: ReasonCategory[]
  needsPerson?: boolean
  onCancel: () => void
  onConfirm: (reasonCategoryId: string, reason: string, toUserId?: string) => Promise<void>
}) {
  const [categoryId, setCategoryId] = useState('')
  const [reason, setReason] = useState('')
  const [email, setEmail] = useState('')
  const [person, setPerson] = useState<{ id: string; email: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const find = useMutation({
    mutationFn: async () => {
      const data = await gql(ManagedUserByEmailDocument, { email: email.trim() })
      return unwrap(data.access.user)
    },
    onMutate: () => setError(null),
    onSuccess: (found) => setPerson({ id: found.id, email: found.email }),
    onError: (cause) => {
      setPerson(null)
      setError(messageFor(cause))
    },
  })

  const confirm = useMutation({
    mutationFn: () => onConfirm(categoryId, reason.trim(), person?.id),
    onMutate: () => setError(null),
    onError: (cause) => setError(messageFor(cause)),
  })

  const ready =
    Boolean(categoryId) && reason.trim().length > 0 && (!needsPerson || Boolean(person))

  return (
    <div className="card-body" style={{ borderTop: '1px solid var(--hairline)' }}>
      <h4>{title}</h4>
      <p className="field-hint">{explanation}</p>

      {needsPerson ? (
        <div className="row" style={{ marginTop: '0.75rem', alignItems: 'end' }}>
          <div style={{ flex: '1 1 18rem' }}>
            <label className="field-label" htmlFor="assignee-email">
              Their email address
            </label>
            <input
              id="assignee-email"
              className="input"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setPerson(null)
              }}
            />
          </div>
          <button
            type="button"
            className="button"
            disabled={!email.trim() || find.isPending}
            onClick={() => find.mutate()}
          >
            {find.isPending ? 'Looking…' : 'Find them'}
          </button>
          {person ? <span className="badge" data-tone="ok">Found {person.email}</span> : null}
        </div>
      ) : null}

      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor="reason-category">
            Reason
          </label>
          <select
            id="reason-category"
            className="select"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Choose a reason</option>
            {reasons.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ gridColumn: '2 / -1' }}>
          <label className="field-label" htmlFor="reason-detail">
            What happened
          </label>
          <input
            id="reason-detail"
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>

      {reasons.length === 0 ? (
        <p className="notice" data-tone="warn" style={{ marginTop: '0.75rem' }}>
          <span className="notice-title">This cycle has no reasons for that</span>
          The reason catalogue is defined per programme cycle. Add one in cycle
          administration before doing this.
        </p>
      ) : null}

      {error ? (
        <p className="notice" data-tone="error" role="alert" style={{ marginTop: '0.75rem' }}>
          {error}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <button
          type="button"
          className="button"
          data-variant="primary"
          disabled={!ready || confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending ? 'Working…' : confirmLabel}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
