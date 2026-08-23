/**
 * Recovering money that has to come back.
 *
 * A recovery case is a small ledger of its own: demands for principal and penal
 * interest, receipts against them, waivers, and reversals of any of those. The
 * API keeps the running balance, so the screen states it rather than computing
 * a second opinion.
 *
 * Nothing here is edited. A mistake is corrected with a reversal naming the
 * entry it reverses, exactly as on the award's own ledger.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { recoveryQuery } from '#/features/admin/fundingQueries'
import { reasonsFor, type ReasonCategory } from '#/features/admin/workspaceQueries'
import {
  CancelRecoveryDocument,
  CloseRecoveryDocument,
  OpenRecoveryDocument,
  RecordRecoveryEntryDocument,
} from '#/graphql/generated/operations'
import type { RecoveryComponent, RecoveryEntryType } from '#/graphql/generated/schema'
import { RECOVERY_TITLES, recoveryIsLive } from '#/features/admin/states'
import { formatDateTime, formatMoney, humanize } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor, unwrap } from '#/lib/result'

const ENTRY_TYPES: {
  value: RecoveryEntryType
  label: string
  means: string
}[] = [
  {
    value: 'DEMAND',
    label: 'Demand',
    means: 'Money the programme is asking for.',
  },
  { value: 'RECEIPT', label: 'Receipt', means: 'Money that has come back.' },
  {
    value: 'WAIVER',
    label: 'Waiver',
    means: 'Money the programme has written off.',
  },
  {
    value: 'REVERSAL',
    label: 'Reversal',
    means: 'Corrects an earlier entry. It names the one it reverses.',
  },
]

const COMPONENTS: RecoveryComponent[] = ['PRINCIPAL', 'PENAL_INTEREST']

type Case = {
  id: string
  fundingAwardId: string
  status: string
  currentVersion: number
  ledgerVersion: number
}

export function RecoveryCase({
  awardId,
  existing,
  reasons,
  onOpened,
}: {
  awardId: string
  existing: Case[]
  reasons: ReasonCategory[] | undefined
  onOpened: () => Promise<unknown> | void
}) {
  // A case stays live through demand and part-settlement; only cancellation
  // and closure end it.
  const open = existing.find((entry) => recoveryIsLive(entry.status))

  return (
    <section className="card">
      <div className="card-header">
        <p className="eyebrow">Recovery</p>
        {open ? (
          <span className="badge" data-tone="error">
            {RECOVERY_TITLES[open.status] ?? humanize(open.status)}
          </span>
        ) : null}
      </div>
      <div className="card-body">
        {open ? (
          <OpenCase recoveryCase={open} reasons={reasons} onClosed={onOpened} />
        ) : existing.length > 0 ? (
          <>
            <p className="muted">
              No recovery is open against this award. {existing.length}{' '}
              {existing.length === 1 ? 'case has' : 'cases have'} been closed.
            </p>
            <OpenRecovery awardId={awardId} reasons={reasons} onOpened={onOpened} />
          </>
        ) : (
          <>
            <p className="muted">
              Nothing is being recovered. Open a case when money has to come back — a
              failed utilization assessment, or a cancelled award with payments already
              made.
            </p>
            <OpenRecovery awardId={awardId} reasons={reasons} onOpened={onOpened} />
          </>
        )}
      </div>
    </section>
  )
}

function OpenRecovery({
  awardId,
  reasons,
  onOpened,
}: {
  awardId: string
  reasons: ReasonCategory[] | undefined
  onOpened: () => Promise<unknown> | void
}) {
  const [open, setOpen] = useState(false)
  const [officialDecisionReference, setReference] = useState('')
  const [officialDecisionDate, setDate] = useState('')
  const [reasonCategoryId, setCategoryId] = useState('')
  const [applicantMessage, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const recoveryReasons = reasonsFor(reasons, 'RECOVERY')

  const start = useMutation({
    mutationFn: async () => {
      const data = await gql(OpenRecoveryDocument, {
        input: {
          awardId,
          officialDecisionReference: officialDecisionReference.trim(),
          officialDecisionDate,
          reasonCategoryId,
          applicantMessage: applicantMessage.trim(),
        },
      })
      unwrap(data.admin.funding.openRecovery)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setOpen(false)
      await onOpened()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  if (!open) {
    return (
      <button
        type="button"
        className="button"
        data-variant="danger"
        style={{ marginTop: '0.75rem' }}
        onClick={() => setOpen(true)}
      >
        Open a recovery case
      </button>
    )
  }

  return (
    <form
      style={{ marginTop: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault()
        start.mutate()
      }}
    >
      <div className="detail-grid">
        <div>
          <label className="field-label" htmlFor="recovery-reference">
            Official decision reference
          </label>
          <input
            id="recovery-reference"
            className="input tabular"
            value={officialDecisionReference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="recovery-date">
            Dated
          </label>
          <input
            id="recovery-date"
            className="input"
            type="date"
            value={officialDecisionDate}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="recovery-reason">
            Reason
          </label>
          <select
            id="recovery-reason"
            className="select"
            value={reasonCategoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Choose a reason</option>
            {recoveryReasons.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="recovery-message">
          What the applicant is told
        </label>
        <textarea
          id="recovery-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setMessage(event.target.value)}
        />
      </div>

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.75rem' }}
        >
          {error}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <button
          type="submit"
          className="button"
          data-variant="danger"
          disabled={
            !officialDecisionReference.trim() ||
            !officialDecisionDate ||
            !reasonCategoryId ||
            !applicantMessage.trim() ||
            start.isPending
          }
        >
          {start.isPending ? 'Opening…' : 'Open the case'}
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** The ledger of one open case, its balance, and what can be added to it. */
function OpenCase({
  recoveryCase,
  reasons,
  onClosed,
}: {
  recoveryCase: Case
  reasons: ReasonCategory[] | undefined
  onClosed: () => Promise<unknown> | void
}) {
  const queryClient = useQueryClient()
  const { data } = useQuery(recoveryQuery(recoveryCase.id))
  const [error, setError] = useState<string | null>(null)

  const workspace = data?.response

  const finish = useMutation({
    mutationFn: async (action: 'cancel' | 'close') => {
      const input = {
        recoveryCaseId: recoveryCase.id,
        expectedVersion:
          workspace?.recoveryCase.currentVersion ?? recoveryCase.currentVersion,
        reason: reason.trim(),
      }
      if (action === 'cancel') {
        const answer = await gql(CancelRecoveryDocument, { input })
        return unwrap(answer.admin.funding.cancelRecovery)
      }
      const answer = await gql(CloseRecoveryDocument, { input })
      return unwrap(answer.admin.funding.closeRecovery)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setReason('')
      await queryClient.invalidateQueries({
        queryKey: ['recovery', recoveryCase.id],
      })
      await onClosed()
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  const [reason, setReason] = useState('')

  return (
    <>
      {workspace ? (
        <div className="detail-grid">
          <div>
            <span className="field-label">Principal demanded</span>
            <span className="tabular">
              {formatMoney(workspace.balance.principalDemanded)}
            </span>
          </div>
          <div>
            <span className="field-label">Interest demanded</span>
            <span className="tabular">
              {formatMoney(workspace.balance.interestDemanded)}
            </span>
          </div>
          <div>
            <span className="field-label">Received</span>
            <span className="tabular">{formatMoney(workspace.balance.receipts)}</span>
          </div>
          <div>
            <span className="field-label">Written off</span>
            <span className="tabular">{formatMoney(workspace.balance.waivers)}</span>
          </div>
          <div>
            <span className="field-label">Still outstanding</span>
            <span className="tabular">{formatMoney(workspace.balance.outstanding)}</span>
          </div>
        </div>
      ) : null}

      {workspace && workspace.entries.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: '1rem' }}>
          <table className="table">
            <caption className="visually-hidden">Entries in this recovery case</caption>
            <thead>
              <tr>
                <th scope="col" data-numeric>
                  No.
                </th>
                <th scope="col">Entry</th>
                <th scope="col">Against</th>
                <th scope="col" data-numeric>
                  Amount
                </th>
                <th scope="col">When</th>
                <th scope="col">Reference</th>
              </tr>
            </thead>
            <tbody>
              {workspace.entries.map((entry) => (
                <tr key={entry.id}>
                  <td data-numeric>{entry.sequenceNumber}</td>
                  <td>{humanize(entry.entryType)}</td>
                  <td>{humanize(entry.component)}</td>
                  <td data-numeric>{formatMoney(entry.amountPaise)}</td>
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td className="tabular">{entry.externalReference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {workspace ? (
        <EntryForm
          recoveryCaseId={recoveryCase.id}
          ledgerVersion={workspace.recoveryCase.ledgerVersion}
          entries={workspace.entries}
          reasons={reasons}
        />
      ) : null}

      <form style={{ marginTop: '1rem' }} onSubmit={(event) => event.preventDefault()}>
        <label className="field-label" htmlFor="recovery-finish-reason">
          Why the case is ending
        </label>
        <input
          id="recovery-finish-reason"
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <button
            type="button"
            className="button"
            disabled={!reason.trim() || finish.isPending}
            onClick={() => finish.mutate('close')}
          >
            {/* Closing settles the case; cancelling says it should never have
                been opened. They are different facts and both are kept. */}
            {finish.isPending ? 'Working…' : 'Close it as settled'}
          </button>
          <button
            type="button"
            className="button"
            data-variant="danger"
            disabled={!reason.trim() || finish.isPending}
            onClick={() => finish.mutate('cancel')}
          >
            Cancel the case
          </button>
        </div>
      </form>

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.75rem' }}
        >
          {error}
        </p>
      ) : null}
    </>
  )
}

function EntryForm({
  recoveryCaseId,
  ledgerVersion,
  entries,
  reasons,
}: {
  recoveryCaseId: string
  ledgerVersion: number
  entries: {
    id: string
    sequenceNumber: number
    entryType: string
    amountPaise: string
  }[]
  reasons: ReasonCategory[] | undefined
}) {
  const queryClient = useQueryClient()
  const [entryType, setEntryType] = useState<RecoveryEntryType>('DEMAND')
  const [component, setComponent] = useState<RecoveryComponent>('PRINCIPAL')
  const [relatedEntryId, setRelatedEntryId] = useState('')
  const [amount, setAmount] = useState('')
  const [externalReference, setReference] = useState('')
  const [occurredAt, setOccurredAt] = useState('')
  const [reasonCategoryId, setCategoryId] = useState('')
  const [applicantMessage, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const waiverReasons = reasonsFor(reasons, 'RECOVERY_WAIVER')

  const add = useMutation({
    mutationFn: async () => {
      const data = await gql(RecordRecoveryEntryDocument, {
        input: {
          recoveryCaseId,
          expectedLedgerVersion: ledgerVersion,
          entryType,
          component,
          relatedEntryId: entryType === 'REVERSAL' ? relatedEntryId : null,
          amountPaise: String(Math.round(Number(amount) * 100)),
          externalReference: externalReference.trim(),
          occurredAt: new Date(occurredAt).toISOString(),
          // A waiver writes money off, so the programme reports on why. The
          // other entry types do not carry a category.
          reasonCategoryId: entryType === 'WAIVER' ? reasonCategoryId : null,
          applicantMessage: applicantMessage.trim(),
        },
      })
      return unwrap(data.admin.funding.recordRecoveryEntry)
    },
    onMutate: () => setError(null),
    onSuccess: async () => {
      setAmount('')
      setReference('')
      setMessage('')
      await queryClient.invalidateQueries({
        queryKey: ['recovery', recoveryCaseId],
      })
    },
    onError: (cause) => setError(messageFor(cause)),
  })

  const ready =
    amount.trim() &&
    externalReference.trim() &&
    occurredAt &&
    applicantMessage.trim() &&
    (entryType !== 'REVERSAL' || Boolean(relatedEntryId)) &&
    (entryType !== 'WAIVER' || Boolean(reasonCategoryId))

  return (
    <form
      style={{ marginTop: '1rem' }}
      onSubmit={(event) => {
        event.preventDefault()
        add.mutate()
      }}
    >
      <h4>Add an entry</h4>

      <div className="stack" style={{ marginTop: '0.75rem' }}>
        {ENTRY_TYPES.map((option) => (
          <label className="choice-block" key={option.value}>
            <input
              type="radio"
              name="recovery-entry-type"
              checked={entryType === option.value}
              onChange={() => setEntryType(option.value)}
            />
            <span>
              <span style={{ fontWeight: 500 }}>{option.label}</span>
              <span className="field-hint">{option.means}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="detail-grid" style={{ marginTop: '0.75rem' }}>
        <div>
          <label className="field-label" htmlFor="entry-component">
            Against
          </label>
          <select
            id="entry-component"
            className="select"
            value={component}
            onChange={(event) => setComponent(event.target.value as RecoveryComponent)}
          >
            {COMPONENTS.map((value) => (
              <option key={value} value={value}>
                {humanize(value)}
              </option>
            ))}
          </select>
        </div>

        {entryType === 'REVERSAL' ? (
          <div>
            <label className="field-label" htmlFor="entry-related">
              The entry being reversed
            </label>
            <select
              id="entry-related"
              className="select"
              value={relatedEntryId}
              onChange={(event) => setRelatedEntryId(event.target.value)}
            >
              <option value="">Choose an entry</option>
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  #{entry.sequenceNumber} · {humanize(entry.entryType)} ·{' '}
                  {formatMoney(entry.amountPaise)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className="field-label" htmlFor="entry-amount">
            Amount (₹)
          </label>
          <input
            id="entry-amount"
            className="input tabular"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="entry-when">
            When
          </label>
          <input
            id="entry-when"
            className="input"
            type="datetime-local"
            value={occurredAt}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="entry-reference">
            Reference
          </label>
          <input
            id="entry-reference"
            className="input tabular"
            value={externalReference}
            onChange={(event) => setReference(event.target.value)}
          />
        </div>

        {entryType === 'WAIVER' ? (
          <div>
            <label className="field-label" htmlFor="entry-reason">
              Why it is being written off
            </label>
            <select
              id="entry-reason"
              className="select"
              value={reasonCategoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Choose a reason</option>
              {waiverReasons.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label className="field-label" htmlFor="entry-message">
          What the applicant is told
        </label>
        <textarea
          id="entry-message"
          className="textarea"
          rows={2}
          value={applicantMessage}
          onChange={(event) => setMessage(event.target.value)}
        />
      </div>

      {error ? (
        <p
          className="notice"
          data-tone="error"
          role="alert"
          style={{ marginTop: '0.75rem' }}
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="button"
        style={{ marginTop: '0.75rem' }}
        disabled={!ready || add.isPending}
      >
        {add.isPending ? 'Recording…' : 'Record the entry'}
      </button>
    </form>
  )
}
