/**
 * The route a file takes.
 *
 * Every status the programme has, placed under the desk that holds the file at
 * that moment, in the order they happen. This is the product's whole thesis in
 * one picture: an application is a file passing between four desks, and the
 * question anybody has about it is which desk has it now.
 *
 * The desks, the order and what happens at each stop are this screen's own
 * words, written from the office's point of view — a guide has to say something
 * a status name does not.
 *
 * Alongside them, where the account can see it, is the programme's own
 * plain-language explanation from the API's status guide: the exact sentence an
 * applicant reads on their application. That surface is deliberately behind the
 * applicant guard — the whole `seb` namespace has one authentication rule — so
 * an administrator sees the left column and not the right, and the screen says
 * which is which rather than quietly dropping one.
 */
import { useQuery } from '@tanstack/react-query'
import { statusGuideQuery } from '#/features/application/queries'
import type { ApplicationStatus } from '#/graphql/generated/schema'
import { DESKS, type Desk } from './tours'
import styles from './RouteDiagram.module.css'

/** Which desk physically holds a file in each status. */
const DESK_OF: Record<ApplicationStatus, Desk> = {
  DRAFT: DESKS.applicant,
  SUBMITTED: DESKS.office,
  DESK_REVIEW: DESKS.office,
  REVISION_REQUIRED: DESKS.applicant,
  PARTNER_BANK_EVALUATION: DESKS.bank,
  TTM_REVIEW: DESKS.committee,
  APPROVED: DESKS.office,
  REJECTED: DESKS.office,
  SANCTIONED: DESKS.office,
  DISBURSED: DESKS.office,
  CANCELLED: DESKS.office,
}

/**
 * The order the route runs in.
 *
 * The two endings sit last because they are where a file stops, not where it
 * passes through. The guide returns statuses in its own order; this is the one
 * the office works in.
 */
const ROUTE: ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'DESK_REVIEW',
  'REVISION_REQUIRED',
  'PARTNER_BANK_EVALUATION',
  'TTM_REVIEW',
  'APPROVED',
  'SANCTIONED',
  'DISBURSED',
  'REJECTED',
  'CANCELLED',
]

/** How many stops the route has, for anything that needs to say so. */
export const ROUTE_LENGTH = ROUTE.length

const DESK_ORDER: Desk[] = [DESKS.applicant, DESKS.office, DESKS.bank, DESKS.committee]

/** How the API's answer to "who must act" reads in a sentence. */
const ACTOR_WORDS: Record<string, string> = {
  APPLICANT: 'the applicant',
  PROGRAMME_OFFICE: 'the programme office',
  NOBODY: 'nobody — it has stopped here',
}

/**
 * What happens at each stop, from the office's side.
 *
 * Not a paraphrase of the applicant's explanation: that one says what is
 * happening to *you*, this one says what the desk holding the file is doing.
 * Both are true and a demonstration needs the second.
 */
const AT_THIS_DESK: Record<ApplicationStatus, { name: string; happens: string }> = {
  DRAFT: {
    name: 'Draft',
    happens:
      'The applicant is answering the six sections and attaching evidence. Nobody at the office can see it.',
  },
  SUBMITTED: {
    name: 'Submitted',
    happens:
      'A copy is frozen and a reference number issued. It joins the new-submissions queue for anyone to claim.',
  },
  DESK_REVIEW: {
    name: 'Desk review',
    happens:
      'A named officer holds it and works through nine checks — identity, eligibility, jurisdiction, the documents and the project report.',
  },
  REVISION_REQUIRED: {
    name: 'Correction asked for',
    happens:
      'The office named specific sections. Only those unlock, and the file returns here when the applicant resubmits.',
  },
  PARTNER_BANK_EVALUATION: {
    name: 'With a partner bank',
    happens:
      'A bank evaluates the proposal and writes back. The office records what it said; it does not decide.',
  },
  TTM_REVIEW: {
    name: 'Before the committee',
    happens:
      'It sits on an agenda in a numbered position. A decision can only be recorded while the meeting is in session.',
  },
  APPROVED: {
    name: 'Approved',
    happens:
      'The committee approved an amount. A sanction order can now be issued against that decision.',
  },
  SANCTIONED: {
    name: 'Sanctioned',
    happens:
      'The sanction order exists. Money moves only once the approval, the verified bank account and the executed agreement are all in hand.',
  },
  DISBURSED: {
    name: 'Money released',
    happens:
      'Instalments have been paid. Each one creates an obligation to account for how it was used.',
  },
  REJECTED: {
    name: 'Rejected',
    happens:
      'Closed without funding, with the reason recorded from the cycle\u2019s own catalogue.',
  },
  CANCELLED: {
    name: 'Cancelled',
    happens:
      'Withdrawn before a decision. The record and everything said about it are kept.',
  },
}

export function RouteDiagram() {
  const { data: guide } = useQuery(statusGuideQuery)
  const entries = new Map((guide ?? []).map((entry) => [entry.status, entry]))

  return (
    <div className={styles.diagram}>
      <div className={styles.desks} aria-hidden="true">
        {DESK_ORDER.map((desk) => (
          <p className={styles.deskName} key={desk}>
            {desk}
          </p>
        ))}
      </div>

      <ol className={styles.route}>
        {ROUTE.map((status, index) => {
          const entry = entries.get(status)
          const desk = DESK_OF[status]
          const ending = status === 'REJECTED' || status === 'CANCELLED'
          return (
            <li
              className={styles.stop}
              key={status}
              data-column={DESK_ORDER.indexOf(desk) + 1}
              data-ending={ending ? 'true' : undefined}
              /*
               * One stop per row, explicitly. Auto-placement packs items into
               * the same row whenever their columns differ — which put Draft
               * and Submitted side by side and made two consecutive stops look
               * simultaneous. The route reads down; nothing here happens at the
               * same time as anything else.
               */
              style={{ gridRow: index + 1 }}
            >
              {/* The number is the order, which is the whole information this
                  diagram carries besides the column. */}
              <span className={styles.marker} aria-hidden="true">
                {index + 1}
              </span>
              <div className={styles.card}>
                <p className={styles.deskTag}>{desk}</p>
                <h3 className={styles.label}>{AT_THIS_DESK[status].name}</h3>
                <p className={styles.explanation}>{AT_THIS_DESK[status].happens}</p>
                {/* The applicant's own wording, when this account may read it. */}
                {entry ? (
                  <p className={styles.told}>
                    <span className={styles.toldLabel}>The applicant is told</span>
                    {entry.explanation}{' '}
                    <span className={styles.actor}>
                      Waiting on {ACTOR_WORDS[entry.nextActor] ?? 'the programme office'}
                      {entry.nextAction ? `. ${entry.nextAction}` : '.'}
                    </span>
                  </p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
