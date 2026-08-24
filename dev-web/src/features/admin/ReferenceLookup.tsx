/**
 * Looking an application up by the reference number an applicant quotes.
 *
 * Exact match, because that is what the API offers and what the situation
 * calls for: somebody is on the phone reading a number out. There is no partial
 * search to build a list from, so this either finds the one application or
 * says it did not.
 *
 * The lookup runs on submit rather than as the number is typed. A reference is
 * a dozen characters long and every keystroke before the last one would be a
 * request that could only miss.
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { byReferenceQuery } from '#/features/admin/intakeQueries'
import { statusTone } from '#/features/admin/queues'
import { formatDateTime, humanize } from '#/lib/format'

export function ReferenceLookup() {
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const [looking, setLooking] = useState('')
  const { data, isFetching } = useQuery(byReferenceQuery(looking))

  const found = data?.response

  return (
    <div className="card">
      <div className="card-body">
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault()
            setLooking(typed.trim().toUpperCase())
          }}
        >
          <div style={{ flex: '1 1 18rem' }}>
            <label className="field-label" htmlFor="reference">
              Reference number
            </label>
            <input
              id="reference"
              className="input tabular"
              value={typed}
              placeholder="SEP-2026-000123"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className="button"
            data-variant="primary"
            disabled={typed.trim().length === 0 || isFetching}
            style={{ alignSelf: 'end' }}
          >
            {isFetching ? 'Looking…' : 'Find it'}
          </button>
        </form>

        {looking && !isFetching ? (
          found ? (
            <div className="detail-grid" style={{ marginTop: '1rem' }}>
              <div>
                <span className="field-label">Reference</span>
                <button
                  type="button"
                  className="button"
                  data-variant="ghost"
                  onClick={() =>
                    navigate({
                      to: '/admin/applications/$id',
                      params: { id: found.id },
                    })
                  }
                >
                  Open {found.referenceNumber}
                </button>
              </div>
              <div>
                <span className="field-label">Status</span>
                <span className="badge" data-tone={statusTone(found.status)}>
                  {humanize(found.status)}
                </span>
              </div>
              <div>
                <span className="field-label">Assigned</span>
                <span>
                  {/* Who, not just when. Somebody looking a reference up is
                      usually about to go and ask whoever has it. */}
                  {found.assignedTo
                    ? `${found.assignedTo.email} · ${formatDateTime(found.assignedAt)}`
                    : found.assignedToUserId
                      ? `Claimed ${formatDateTime(found.assignedAt)}`
                      : 'Nobody'}
                </span>
              </div>
            </div>
          ) : (
            // The API's own message, which distinguishes a number that does not
            // exist from one this account may not see.
            <p
              className="notice"
              data-tone="error"
              role="alert"
              style={{ marginTop: '1rem' }}
            >
              {data?.message ?? 'No application has that reference number.'}
            </p>
          )
        ) : null}
      </div>
    </div>
  )
}
