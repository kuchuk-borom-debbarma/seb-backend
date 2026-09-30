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

import { can, isApplicant, isSuperAdministrator, type Permission } from '#/lib/session'

/**
 * The desks a file passes between. A pipeline decides which stages there are;
 * these are who sits at them — the applicant, the programme office's stages,
 * and a partner bank's stage.
 */
export const DESKS = {
  applicant: 'Applicant',
  office: 'Programme office',
  bank: 'Partner bank',
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

/**
 * Which account may walk a route.
 *
 * `super` is a narrowing of `admin`, not a separate desk: role management is
 * the one office job an ordinary administrator cannot do. `stage` is anybody
 * who works a pipeline stage, such as a bank's officer, whether or not they
 * read the office-wide list.
 */
export type TourAudience = 'applicant' | 'admin' | 'stage' | 'super'

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
        // Stage-agnostic on purpose: the stages are the cycle's own, so their
        // number and names are whatever that programme year decided to ask.
        title: 'Answer the form, stage by stage',
        body: 'The stages and their questions are declared by the cycle itself, so each programme year asks exactly what its policy needs. Answers are saved as they are typed: the indicator says "Saving" the moment something changes and "Saved" only once the server has it — it never claims work is safe that is not.',
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
        body: 'Submission freezes a copy of the answers and the documents attached to them, and issues one reference number that never changes again — through every stage, every correction and every decision.',
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
      'How submitted work is found, read, noted, and — through its pipeline — moved on or returned for correction.',
    steps: [
      {
        title: 'Start from what needs you',
        body: 'The console leads with the stages you work and the submitted files that have waited longest. Which stage holds each one is its pipeline’s, and the list shows it.',
        desk: DESKS.office,
        to: '/admin',
        mark: 'waiting-on-us',
      },
      {
        title: 'Open the list',
        body: 'Filter by pipeline, by stage, by the status flags a file holds, or by what was asked for. Every filter lives in the address, so a view can be bookmarked or sent to a colleague and comes back with the same rows in it.',
        desk: DESKS.office,
        to: '/admin/queue',
        mark: 'queue-filters',
      },
      {
        title: 'Pick a file out of the list',
        body: 'Every row is one application, longest wait first. Opening one is also how this route learns which file you are working on — the steps after this follow it.',
        desk: DESKS.office,
        to: '/admin/queue',
        mark: 'queue-rows',
        needs:
          'A submitted application. If the list is empty, nothing has been sent in yet.',
      },
      {
        title: 'What to do next is decided by where the file is',
        body: 'What may happen next is the file’s pipeline’s: the actions its current stage offers, to the roles that own that stage. A button that exists to be refused teaches people to distrust the screen, so none is offered here that the pipeline would refuse.',
        desk: DESKS.office,
        to: '/admin/applications/$id',
        mark: 'next-step',
        needs: 'Open an application from the queue first.',
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
        body: 'A stage that asks for a correction names the sections; exactly those unlock for the applicant and nothing else. They see your words, and the application returns to that stage when they resubmit.',
        desk: DESKS.office,
      },
    ],
  },
  {
    id: 'working-a-stage',
    for: 'stage',
    title: 'Working your stage',
    audience: 'An officer who works a pipeline stage',
    promise:
      'How the files waiting at your stage are found, and how an action moves one on, sends it back, or asks the applicant to correct it.',
    steps: [
      {
        title: 'Start from your stages',
        body: 'Every stage your roles work is here, with how many files wait at each. A bank officer sees their bank’s stage and no other: two stages can need the same permissions and still belong to different people.',
        desk: DESKS.office,
        to: '/admin/stages',
        mark: 'my-stages',
      },
      {
        title: 'Open the file, not a form',
        body: 'A stage’s queue lists its files oldest arrival first. Open one to see where it stands: its status, what has been recorded on it, and the trail of stages it came through.',
        desk: DESKS.office,
        to: '/admin/applications/$id',
        mark: 'next-step',
        needs: 'Open a file from one of your stage queues first.',
      },
      {
        title: 'Each button is one configured action',
        body: 'What a button asks for and what it does is set by the pipeline: an amount pre-filled from what was asked, the bank the applicant chose first, a note for the next stage. If a colleague acted a moment before you, nothing is written and you are told the file changed.',
        desk: DESKS.office,
        to: '/admin/applications/$id',
        mark: 'next-step',
        needs: 'Open a file from one of your stage queues first.',
      },
      {
        title: 'Sending back retraces the file’s own steps',
        body: 'A send-back returns the file to the stage it actually came from, never to one chosen by hand — so a file routed to one bank and sent back goes to the office that routed it, which may then choose the other bank.',
        desk: DESKS.bank,
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
        body: 'Age bands, category thresholds, the kinds of application it accepts and who may start each, and the pipeline its files are worked in. All of it is decided before anyone applies.',
        desk: DESKS.office,
        to: '/admin/cycles/new',
        mark: 'cycle-policy',
      },
      {
        // The documents stopped being a separate rule set: each one is a FILE
        // question of the cycle's own form, shown and required by the same
        // conditions as any other question.
        title: 'The questions are the cycle’s too',
        body: 'Everything an applicant answers — including which documents to attach — is declared by the cycle itself, stage by stage. What this card lists is exactly what an application under this cycle is asked.',
        desk: DESKS.office,
        to: '/admin/cycles/$id',
        mark: 'cycle-questions',
        needs: 'Open a cycle from the list.',
      },
      {
        title: 'Change what a draft cycle asks',
        body: 'Stages, questions, the choices they offer and the rules between them are edited here. Every change is a cycle revision with its reason kept in the history — and it is only possible while the cycle is a draft.',
        desk: DESKS.office,
        to: '/admin/cycles/$id/form',
        mark: 'cycle-authoring',
        needs:
          'Open a draft cycle from the list. Only a super administrator may change a cycle’s questions.',
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
        body: 'This is what an application started under the cycle carries: the eligibility rules, the questions it asks, the pipeline version it is worked in, and the version they were frozen at. A later cycle — or a later pipeline version — changing its mind does not reach back.',
        desk: DESKS.office,
        to: '/admin/cycles/$id',
        mark: 'cycle-frozen',
        needs: 'Open a cycle from the list.',
      },
      {
        title: 'The route is the pipeline’s',
        body: 'Which stages a file passes through, who works each, and what every action there does is the pipeline the cycle names. Changing the route is publishing a new pipeline version, and only cycles opened after that use it.',
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
  user: { roles: readonly string[]; permissions: readonly Permission[] } | undefined,
): boolean => {
  if (tour.for === 'super') return isSuperAdministrator(user)
  /*
   * A permission the office itself is gated on, not a role name.
   *
   * Roles are composed now, so naming one here would offer the tour to whoever
   * happens to hold that key today and to nobody the office composes tomorrow.
   * Gating on reading casework offers it to everybody whose work is on these
   * screens, which is what a tour is for.
   */
  if (tour.for === 'admin') return can(user, 'application', 'read')
  if (tour.for === 'stage') return can(user, 'stage', 'read')
  return isApplicant(user)
}
