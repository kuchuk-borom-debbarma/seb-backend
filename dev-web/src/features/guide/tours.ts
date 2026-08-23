/**
 * The guided routes through Mission SEP.
 *
 * A tour is a sequence of real screens with a sentence about each. Nothing here
 * simulates the product: every step names a route that exists, and a step that
 * needs particular data says so rather than pretending the data is there. A
 * demonstration that shows a mock-up of itself teaches nobody anything.
 *
 * Steps are numbered because the content genuinely is ordered — this is the
 * sequence a file moves through — and each carries the desk that holds it,
 * because "whose turn is it" is the question the whole product answers.
 */

import { isAdministrator, isApplicant, isSuperAdministrator } from '#/lib/session'
import type { AdminIntakeQueueKey, UserRole } from '#/graphql/generated/schema'

/** The four desks a file passes between. */
export const DESKS = {
  applicant: 'Applicant',
  office: 'Programme office',
  bank: 'Partner bank',
  committee: 'Committee',
} as const

export type Desk = (typeof DESKS)[keyof typeof DESKS]

export type TourStep = {
  /** What this step is about, in the imperative where something is done. */
  title: string
  /** One or two sentences. Says what happens and why, never how it is built. */
  body: string
  /** Whose turn it is at this point. */
  desk: Desk
  /** Where the step happens. Omitted when the step is about the idea, not a screen. */
  to?: string
  /**
   * The `data-guide` value of the element this step is about. The rail draws a
   * margin bracket beside it, the way an officer marks a passage in a file.
   */
  mark?: string
  /**
   * Narrows a list route to one queue, using the API's own keys.
   *
   * A step that says "pick one out of the queue" should land on the queue it
   * means rather than on whatever the reader last filtered to.
   */
  search?: { queue: AdminIntakeQueueKey }
  /** Stated when a step needs data the demonstration may not have yet. */
  needs?: string
}

/**
 * Which account may walk a route.
 *
 * `super` is a narrowing of `admin`, not a separate desk: role management is
 * the one office job an ordinary administrator cannot do.
 */
export type TourAudience = 'applicant' | 'admin' | 'super'

export type Tour = {
  id: string
  title: string
  /**
   * Who is allowed to walk this route.
   *
   * Required, and deliberately so. This lived in a lookup table beside the page
   * that reads it, keyed by tour id — and a tour absent from that table fell
   * through to applicant-only and disappeared from the office with nothing
   * failing. Naming it here makes forgetting a compile error instead.
   */
  for: TourAudience
  /** Who this route is for, in their own words. */
  audience: string
  /** What somebody will understand by the end. */
  promise: string
  steps: TourStep[]
}

export const TOURS: Tour[] = [
  {
    id: 'applying',
    for: 'applicant',
    title: 'Applying for seed funding',
    audience: 'A first-generation entrepreneur applying to the programme',
    promise:
      'How an application is started, filled in, checked and sent — and what the applicant is told at each point.',
    steps: [
      {
        title: 'Register the enterprise first',
        body: 'An application belongs to an enterprise, not to a person. The enterprise is registered once and can carry several applications across programme years.',
        desk: DESKS.applicant,
        to: '/enterprises',
        mark: 'enterprise-list',
      },
      {
        title: 'Start an application in an open cycle',
        body: 'Applications can only be started while a programme cycle is open. The cycle decides which documents are required and what the money can be spent on.',
        desk: DESKS.applicant,
        to: '/applications/new',
        mark: 'start-application',
      },
      {
        title: 'Answer the six sections',
        body: 'Answers are saved as they are typed. The indicator says "Saving" the moment something changes and "Saved" only once the server has it — it never claims work is safe that is not.',
        desk: DESKS.applicant,
        to: '/applications',
        mark: 'application-list',
        needs: 'Open any application to see the form.',
      },
      {
        title: 'Attach the evidence',
        body: 'Which documents are required comes from the cycle’s own rules, so the evidence screen shows the programme office’s exact words against each one rather than a rule restated here.',
        desk: DESKS.applicant,
        needs: 'Open an application, then choose Evidence.',
      },
      {
        title: 'Check before sending',
        body: 'Every outstanding issue is listed with the question it belongs to, and each one links to the field that fixes it — not just to the page it is on.',
        desk: DESKS.applicant,
        needs: 'Open an application, then choose Check and submit.',
      },
      {
        title: 'Keep the reference number',
        body: 'Submission freezes a copy of the answers and the documents attached to them, and issues one reference number that never changes again — through review, corrections, the award, and every payment.',
        desk: DESKS.applicant,
      },
    ],
  },
  {
    id: 'reviewing',
    for: 'admin',
    title: 'Reviewing what comes in',
    audience: 'A programme officer at the desk',
    promise:
      'How work is picked up, checked, and either sent to a bank, returned for correction, or closed.',
    steps: [
      {
        title: 'Start from what needs you',
        body: 'The console leads with the three queues waiting on the programme office. The rest are shown as counts, because an application waiting on a bank is information rather than work.',
        desk: DESKS.office,
        to: '/admin',
        mark: 'waiting-on-us',
      },
      {
        title: 'Open a queue',
        body: 'Every filter lives in the address, so a view can be bookmarked or sent to a colleague and comes back with the same rows in it.',
        desk: DESKS.office,
        to: '/admin/queue',
        mark: 'queue-filters',
      },
      {
        title: 'Pick a file out of the queue',
        body: 'Every row is one application, longest wait first. Opening one is also how this route learns which file you are working on — the steps after this follow it.',
        desk: DESKS.office,
        to: '/admin/queue',
        search: { queue: 'NEW_SUBMISSIONS' },
        mark: 'queue-rows',
        needs:
          'A submitted application. If this queue is empty, nothing has been sent in yet.',
      },
      {
        title: 'Claim it before you work on it',
        body: 'Claiming records who holds the application. Taking one somebody else holds is allowed — it is a normal thing to need — but it is acknowledged, and the acknowledgement is kept against your account.',
        desk: DESKS.office,
        to: '/admin/applications/$id',
        mark: 'assignment',
        needs: 'Open an application from the queue first; this route then follows it.',
      },
      {
        title: 'What to do next is decided by where the file is',
        body: 'Only the transitions the API will accept from this status are offered — the desk review on a submitted application, the form that completes it on one under review, nothing at all on one waiting for somebody else. A button that exists to be refused teaches people to distrust the screen.',
        desk: DESKS.office,
        to: '/admin/applications/$id',
        mark: 'next-step',
        needs: 'Open an application from the queue first.',
      },
      {
        title: 'Run the nine checks',
        body: 'A desk review is one form and one write, not a wizard that could be abandoned half-recorded. The outcome decides what happens next: on to a bank, back to the applicant, or closed.',
        desk: DESKS.office,
        needs: 'Claim an application and start its desk review.',
      },
      {
        title: 'Everything said about a file stays with it',
        body: 'Internal notes are never shown to the applicant, and none can be edited or deleted — a correction is a new note pointing at the one it corrects. What was thought at the time survives alongside what replaced it.',
        desk: DESKS.office,
        to: '/admin/applications/$id',
        mark: 'internal-notes',
        needs: 'Open an application from the queue first.',
      },
      {
        title: 'Ask for corrections precisely',
        body: 'Naming a section unlocks exactly that section for the applicant and nothing else. They see your words, and the application returns to you when they resubmit.',
        desk: DESKS.office,
      },
    ],
  },
  {
    id: 'deciding',
    for: 'admin',
    title: 'The bank and the committee',
    audience: 'A programme officer carrying a file through approval',
    promise:
      'How an application reaches a partner bank, comes back, and is put to the committee.',
    steps: [
      {
        title: 'Refer it to a partner bank',
        body: 'The bank evaluates the proposal and writes back. Nothing is decided here — the office records what the bank said, which is why every form asks for the reference and date of the bank’s own document.',
        desk: DESKS.bank,
        to: '/admin/applications/$id',
        mark: 'bank-stage',
        needs: 'An application whose desk review ended in "Refer to a partner bank".',
      },
      {
        title: 'Record the outcome, never edit it',
        body: 'A correction supersedes the outcome it replaces and both are kept. What the bank first said, and when the office learned otherwise, are both part of the file.',
        desk: DESKS.bank,
      },
      {
        title: 'Schedule a meeting and build its agenda',
        body: 'An application joins an agenda while the meeting is still being planned. Position is the order the committee will take it in, so moving one is recorded with a reason.',
        desk: DESKS.committee,
        to: '/admin/meetings',
        mark: 'meetings-list',
      },
      {
        title: 'Position is the agenda’s whole meaning',
        body: 'Position is the order the committee will take the applications in. Moving one, or taking it off, asks for a reason and the programme keeps it — an agenda that quietly reorders itself is not a record of anything.',
        desk: DESKS.committee,
        to: '/admin/meetings/$meetingId',
        mark: 'agenda',
        needs: 'Open a meeting from the list.',
      },
      {
        title: 'The committee sits',
        body: 'A decision is only accepted while the meeting is in session and only from the person holding the application — the same rules the room itself works by.',
        desk: DESKS.committee,
      },
    ],
  },
  {
    id: 'money',
    for: 'admin',
    title: 'From approval to money',
    audience: 'A programme officer handling sanctions and payments',
    promise:
      'How a sanction order is issued, how instalments are released, and what has to be in hand before money moves.',
    steps: [
      {
        title: 'Start from what has been approved',
        body: 'An award is issued against the committee’s decision and takes its amount from it, so the work starts here: files that have a decision and no sanction order yet.',
        desk: DESKS.office,
        to: '/admin/queue',
        search: { queue: 'APPROVED' },
        mark: 'queue-rows',
        needs:
          'An approved application. If this queue is empty, nothing has reached a committee decision yet.',
      },
      {
        title: 'Issue the sanction order',
        body: 'The number and the date are the sanction letter’s own. The amount is not asked for — it comes from the committee’s decision, and a second figure typed on this screen could only ever disagree with the letter.',
        desk: DESKS.office,
        to: '/admin/applications/$id/funding',
        needs: 'Open an approved application from the queue first.',
      },
      {
        title: 'The ledger is the record, and the screen does not add it up',
        body: 'Every entry is appended and numbered; nothing is removed. The totals come from the programme’s own arithmetic, because a subtotal computed in the browser is one more thing that can disagree with the sanction letter.',
        desk: DESKS.office,
        to: '/admin/applications/$id/funding',
        mark: 'ledger',
        needs: 'An application with a sanction order issued against it.',
      },
      {
        title: 'Release an instalment',
        body: 'The most consequential write in the product, and the API guards it: the committee approval it is paid under, evidence the bank account was verified, the executed performance agreement, and where the programme requires it, the physical verification.',
        desk: DESKS.office,
      },
      {
        title: 'Correct a payment without deleting it',
        body: 'A reversal is its own ledger entry naming the payment it corrects. Neither is removed, and the applicant sees the correction folded into the payment it belongs to.',
        desk: DESKS.office,
      },
      {
        title: 'What the applicant is allowed to know',
        body: 'Their funding screen shows the sanctioned amount, what has reached them, and what is still to come. Internal banking prerequisites and reviewer notes are absent from that view by design.',
        desk: DESKS.applicant,
      },
    ],
  },
  {
    id: 'cycles',
    for: 'admin',
    title: 'Setting up a programme year',
    audience: 'The programme office before applications open',
    promise:
      'How a cycle’s policy is written, opened, and frozen into every application started under it.',
    steps: [
      {
        title: 'Write the policy',
        body: 'Age bands, category thresholds, required documents, the assessments an award will need, and the reasons staff may choose from. All of it is decided before anyone applies.',
        desk: DESKS.office,
        to: '/admin/cycles/new',
        mark: 'cycle-policy',
      },
      {
        title: 'Open it for applications',
        body: 'Opening publishes the cycle and freezes its policy. An application started under it keeps that version of the rules even if a later cycle changes them.',
        desk: DESKS.office,
        to: '/admin/cycles',
        mark: 'cycle-list',
      },
      {
        title: 'The policy once it is frozen',
        body: 'This is what an application started under the cycle carries: the document rules, the assessments an award will need, and the version they were frozen at. A later cycle changing its mind does not reach back.',
        desk: DESKS.office,
        to: '/admin/cycles/$id',
        mark: 'cycle-frozen',
        needs: 'Open a cycle from the list.',
      },
      {
        title: 'Reasons are part of the policy',
        body: 'Releasing a claim, asking for a correction, deferring a decision, writing off a recovery — each names a reason from this cycle’s catalogue, so the programme can report on why things happened.',
        desk: DESKS.office,
      },
    ],
  },
  {
    id: 'access',
    for: 'super',
    title: 'Who is allowed to do what',
    audience: 'A super administrator',
    promise: 'How roles are granted, revoked, and accounted for afterwards.',
    steps: [
      {
        title: 'Find somebody by their exact address',
        body: 'There is no listing and no partial search. That is a security property rather than a missing feature: this surface cannot be used to enumerate accounts.',
        desk: DESKS.office,
        to: '/admin/access',
        mark: 'access-lookup',
      },
      {
        title: 'Every change is confirmed with your own password',
        body: 'A step-up, not a second sign-in. It is verified against the account making the change.',
        desk: DESKS.office,
      },
      {
        title: 'Revoking closes a grant, it does not erase it',
        body: 'The history keeps why somebody had a role and why they stopped having it. A grant made by the system itself — verified signup, the one-time bootstrap — says so, because no person made it.',
        desk: DESKS.office,
      },
    ],
  },
]

export const tourById = (id: string): Tour | undefined =>
  TOURS.find((tour) => tour.id === id)

/**
 * Whether this account may walk this route.
 *
 * Shared rather than written once at the page that lists the routes, because a
 * saved position outlives the list: a tour started before a role was revoked,
 * or restored from storage in the other portal, has to be refused where it
 * would be *rendered*, not only where it was offered.
 */
export const canWalk = (
  tour: Tour,
  user: { roles: readonly UserRole[] } | undefined,
): boolean => {
  if (tour.for === 'super') return isSuperAdministrator(user)
  if (tour.for === 'admin') return isAdministrator(user)
  return isApplicant(user)
}
