/**
 * Who else is working this file.
 *
 * This replaced a set of claim, release and take-over controls. Claiming used
 * to be a requirement — you could not act on an application until you held it,
 * and holding it locked everybody else out. That was never what made a write
 * safe: two officers acting at once are settled by the version guard on the
 * transition itself, and the claim was a policy about desks rather than a
 * protection.
 *
 * It also had a cost that only appeared once the office grew more than one
 * role. Reading a document was gated on holding the file, and a reviewer — the
 * role whose entire job is reading casework — cannot claim anything. So the
 * people who most needed to read could not.
 *
 * ## Advisory, not a lock
 *
 * Everything here is information. There is no control to press, and the actions
 * beside it are never disabled by what it says. Two officers on one file is now
 * possible: one will finish and the other will be told the record changed,
 * which costs some wasted effort and no correctness. Telling them beforehand is
 * the cheap way to avoid it; forbidding it was the expensive way.
 */
import { formatDateTime } from '#/lib/format'
import { Explain } from '#/features/guide/Explain'
import { OFFICE_HELP } from './officeGuidance'
import { useMarker } from '../guide/GuideContext'

export function WhoIsOnThis({
  assignedTo,
  assignedAt,
  lastActivityAt,
  viewerUserId,
}: {
  /** Whoever last acted on it. Null when nobody has yet. */
  assignedTo: { id: string; email: string } | null
  assignedAt: string | null
  /** The most recent event of any kind, which is often newer than the above. */
  lastActivityAt: string | null
  viewerUserId: string | undefined
}) {
  const mark = useMarker()
  const mine = Boolean(assignedTo) && assignedTo?.id === viewerUserId
  const somebodyElse = Boolean(assignedTo) && !mine

  return (
    <section className="card" {...mark('assignment')}>
      <div className="card-header">
        <div>
          <div className="label-row">
            <p className="eyebrow">Who is on this</p>
            <Explain label="assignment" opener="Working the same file as somebody else">
              {OFFICE_HELP.workingTogether}
            </Explain>
          </div>
          <h3>
            {mine
              ? 'You worked this last'
              : somebodyElse
                ? `${assignedTo?.email} worked this last`
                : 'Nobody has worked this yet'}
          </h3>
          {assignedAt || lastActivityAt ? (
            <p className="field-hint">
              Last activity {formatDateTime(lastActivityAt ?? assignedAt!)}
            </p>
          ) : null}
        </div>
      </div>

      {somebodyElse ? (
        <div className="card-body">
          {/*
            A notice rather than a warning, and nothing below it is disabled.
            Two people working one file is allowed; it is only worth knowing
            about so that the second one can decide whether to bother.
          */}
          <p className="notice">
            <span className="notice-title">Somebody else has been here</span>
            You can still act on this. If you both act at once, whoever is
            second is told the record changed and nothing is overwritten — so
            it may be worth a word first.
          </p>
        </div>
      ) : null}
    </section>
  )
}
