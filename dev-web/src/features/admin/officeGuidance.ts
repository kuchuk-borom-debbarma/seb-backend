/**
 * What the office's own words mean.
 *
 * The programme office is where the vocabulary is hardest. An applicant reads
 * "Submitted" and knows what it means; an officer reads two queues that both
 * hold `SUBMITTED` and has to be told why they are separate. These are the
 * answers to the words whose names do not give one.
 *
 * **Copy lives here rather than at the call sites** for three reasons: half of
 * these anchors are inside components rendered by more than one screen, so
 * "beside the screen" is not available; the strings are derived from
 * `docs/admin-workflow-guide.md`, and a policy change there has to have a
 * findable consequence here; and copy should be reviewable as copy, in one
 * diff, by somebody who is not reading React.
 *
 * **This is not a rendering of `states.ts`.** That file's doc comments are a
 * maintainer's gloss — written to help somebody pick the right branch, uneven
 * in coverage, and free to say things a reader should not be told. The same
 * distinction is already drawn one level up in `RouteDiagram.tsx`: the office's
 * description of a stop is not a paraphrase of the applicant's. Two audiences,
 * two files. `queues.ts` is the exception and is reused verbatim, because its
 * descriptions were already written for staff and are already rendered.
 *
 * Each entry names the section of the workflow guide it is drawn from, so the
 * two can be checked against each other.
 */

/** The office words that earn an explanation. One per card, at most. */
export type OfficeTerm =
  | 'twoSubmittedQueues'
  | 'workingTogether'
  | 'frozenEvidence'
  | 'bankOutcome'
  | 'meetingState'
  | 'ledger'
  | 'recoveryLive'
  | 'frozenPolicy'
  | 'transcribing'

/**
 * The answer shown when somebody asks what a word means.
 *
 * Written as prose an officer would say to a new colleague — what the thing is
 * and what follows from it, never how it is built.
 */
export const OFFICE_HELP: Record<OfficeTerm, string> = {
  // Source: admin-workflow-guide.md, "Named queues".
  twoSubmittedQueues:
    'A first submission and an answer to a correction request are both submitted, ' +
    'and they are completely different jobs: one is a first read of a whole ' +
    'application, the other is checking that a named section was fixed. They are ' +
    'counted separately so the two never land in one pile.',

  // Source: admin-workflow-guide.md, "Working the same file as somebody else".
  workingTogether:
    'Anybody holding the right role can act on this; there is nothing to reserve ' +
    'first. Knowing who was here last is still worth having, so it is shown — but ' +
    'it is a courtesy, not a lock. If two of you act at once, the second is told ' +
    'the record changed and nothing is overwritten.',

  // Source: admin-workflow-guide.md, "Frozen evidence and document safety".
  frozenEvidence:
    'A submission freezes the exact version of every document attached to it. These ' +
    'are the ones this submission carries — replacing a file later makes a new ' +
    'version and cannot change what was reviewed here.',

  // Source: admin-workflow-guide.md, "Offline bank evaluation".
  bankOutcome:
    'The office records what the bank said; it does not decide. An outcome is never ' +
    'edited — a correction is a new outcome that supersedes the earlier one, and ' +
    'both stay on the file, so what was first said and when the office learned ' +
    'otherwise are both readable.',

  // Source: admin-workflow-guide.md, "TTM meetings and decisions".
  meetingState:
    'The state decides what is possible. While a meeting is being planned the agenda ' +
    'can be changed; once it is in session the evidence locks and decisions are ' +
    'recorded against it; once finalized nothing moves. It can only be finalized ' +
    'when every item on the agenda has an outcome.',

  // Source: admin-workflow-guide.md, "Awards, releases, and assessments".
  ledger:
    'Nothing here is ever removed. A payment that went wrong is corrected by a ' +
    'reversal, which is its own entry naming the release it corrects, so the two ' +
    'are read together. Every figure comes from the programme’s own arithmetic.',

  // Source: admin-workflow-guide.md, "Desk review and revisions".
  transcribing:
    'Passing a check means you have read the document; this is the number on it. ' +
    'Until these were recorded the programme could not tell whether the same ' +
    'certificate or the same account had been used twice, because no identity ' +
    'number was kept anywhere. Identity numbers and account numbers are stored ' +
    'as a one-way digest — nobody can read them back, and you confirm against ' +
    'the last four digits.',

  // Source: admin-workflow-guide.md, "Cancellation and recovery".
  recoveryLive:
    'A case stays live through demand and settlement — entries can still be added. ' +
    'Only cancellation or closure ends it, and closure is checked against a zero ' +
    'balance at the moment of writing, so a late entry cannot slip past it.',

  // Source: admin-workflow-guide.md, "Programme cycles: the policy window".
  frozenPolicy:
    'Opening a cycle publishes it and freezes these rules. An application started ' +
    'under it keeps them even if a later cycle decides differently — a change of ' +
    'policy makes a new cycle, not a new rule for files already in flight.',
}

/**
 * What each office screen is for, in one or two sentences.
 *
 * Only the screens whose lede is not already written at the call site. A lede
 * that depends on what is on the screen stays with the screen; these are the
 * ones that are the same on every visit.
 */
export const OFFICE_LEDES = {
  audit:
    'Every recorded action, newest first. This is what answers who changed ' +
    'something and when — the question asked after something has gone wrong. ' +
    'Filter by the person, by everybody holding a role, or by the kind of ' +
    'action. Only a super administrator can open this, because it carries more ' +
    'about people than any other screen here.',

  invite:
    'Somebody signs up as an applicant, you choose the role, and they accept it ' +
    'themselves from a link sent to their address. The role lands only when ' +
    'they accept, so the record always shows they agreed to it. Their applicant ' +
    'access is exchanged for the staff role rather than added to.',

  workspace:
    'Everything the office knows about this application, ordered by what a reviewer ' +
    'does next. A review records the numbers on the documents as well as the ' +
    'judgement, so a certificate or an account used twice is noticed. Every action ' +
    'is checked against the version you are looking at, so two people acting at ' +
    'once get a refusal rather than a silent overwrite.',

  meeting:
    'An agenda is built while the meeting is being planned, decisions are recorded ' +
    'while it is in session, and nothing moves once it is finalized. Only what the ' +
    'current state allows is offered.',

  cycle:
    'The policy applications in this programme year are judged by. Opening it ' +
    'publishes the cycle and freezes these rules into every application started ' +
    'while it is open.',

  meetings:
    'The committee sits, works through a numbered agenda, and records one decision ' +
    'for each application on it. An application joins an agenda from its own ' +
    'workspace, once a partner bank has answered.',

  funding:
    'The award, the money released against it, and anything that has to come back. ' +
    'Nothing here is deleted — a payment that went wrong is reversed with its own ' +
    'entry, and every figure is the programme’s arithmetic rather than the ' +
    'browser’s.',
} as const
