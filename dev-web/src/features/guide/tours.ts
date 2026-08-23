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
  /** Stated when a step needs data the demonstration may not have yet. */
  needs?: string
}

export type Tour = {
  id: string
  title: string
  /** Who this route is for, in their own words. */
  audience: string
  /** What somebody will understand by the end. */
  promise: string
  steps: TourStep[]
}

export const TOURS: Tour[] = [
  {
    id: 'applying',
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
        title: 'Claim it before you work on it',
        body: 'Claiming records who holds the application. Taking one somebody else holds is allowed — it is a normal thing to need — but it is acknowledged, and the acknowledgement is kept against your account.',
        desk: DESKS.office,
        needs: 'Open any submitted application from a queue.',
      },
      {
        title: 'Run the nine checks',
        body: 'A desk review is one form and one write, not a wizard that could be abandoned half-recorded. The outcome decides what happens next: on to a bank, back to the applicant, or closed.',
        desk: DESKS.office,
        needs: 'Claim an application and start its desk review.',
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
    title: 'The bank and the committee',
    audience: 'A programme officer carrying a file through approval',
    promise:
      'How an application reaches a partner bank, comes back, and is put to the committee.',
    steps: [
      {
        title: 'Refer it to a partner bank',
        body: 'The bank evaluates the proposal and writes back. Nothing is decided here — the office records what the bank said, which is why every form asks for the reference and date of the bank’s own document.',
        desk: DESKS.bank,
        needs: 'Complete a desk review with the outcome "Refer to a partner bank".',
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
        title: 'The committee sits',
        body: 'A decision is only accepted while the meeting is in session and only from the person holding the application — the same rules the room itself works by.',
        desk: DESKS.committee,
      },
    ],
  },
  {
    id: 'money',
    title: 'From approval to money',
    audience: 'A programme officer handling sanctions and payments',
    promise:
      'How a sanction order is issued, how instalments are released, and what has to be in hand before money moves.',
    steps: [
      {
        title: 'Issue the sanction order',
        body: 'The award is issued against the committee’s approval and takes its amount from that decision. It cannot exist without one.',
        desk: DESKS.office,
        needs: 'An approved application.',
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
        title: 'Reasons are part of the policy',
        body: 'Releasing a claim, asking for a correction, deferring a decision, writing off a recovery — each names a reason from this cycle’s catalogue, so the programme can report on why things happened.',
        desk: DESKS.office,
      },
    ],
  },
  {
    id: 'access',
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
