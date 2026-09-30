/**
 * What the office's own words mean.
 *
 * These are the answers to the words whose names do not give one — shown when
 * somebody asks, beside the card that uses the word.
 *
 * **Copy lives here rather than at the call sites** for three reasons: some of
 * these anchors are inside components rendered by more than one screen, so
 * "beside the screen" is not available; the strings are derived from
 * `docs/admin-workflow-guide.md` and `docs/pipeline-guide.md`, and a policy
 * change there has to have a findable consequence here; and copy should be
 * reviewable as copy, in one diff, by somebody who is not reading React.
 *
 * Each entry names the section of the guide it is drawn from, so the two can
 * be checked against each other.
 */

/** The office words that earn an explanation. One per card, at most. */
export type OfficeTerm = 'frozenEvidence' | 'frozenPolicy' | 'stageActions'

/**
 * The answer shown when somebody asks what a word means.
 *
 * Written as prose an officer would say to a new colleague — what the thing is
 * and what follows from it, never how it is built.
 */
export const OFFICE_HELP: Record<OfficeTerm, string> = {
  // Source: admin-workflow-guide.md, "Frozen evidence and document safety".
  frozenEvidence:
    'A submission freezes the exact version of every document attached to it. These ' +
    'are the ones this submission carries — replacing a file later makes a new ' +
    'version and cannot change what was reviewed here.',

  // Source: pipeline-guide.md, "Actions" and "The journey of one file".
  stageActions:
    'What this stage may do next is set by its pipeline. An action is offered to ' +
    'the roles that own the stage and hold every permission its effects need. ' +
    'Every action is checked against the version you are looking at, so if a ' +
    'colleague acted first you are told the file changed and nothing is ' +
    'overwritten.',

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
    'Narrow it to a person, to everybody holding a role, to a kind of ' +
    'activity or one action, to an application, or to a range of days, and ' +
    'open any entry to see everything it recorded. Only a role that may read ' +
    'the history can open this, because it carries more about people than any ' +
    'other screen here.',

  invite:
    'Somebody signs up as an applicant, you choose the role, and they accept it ' +
    'themselves from a link sent to their address. The role lands only when ' +
    'they accept, so the record always shows they agreed to it. Their applicant ' +
    'access is exchanged for the staff role rather than added to.',

  cycle:
    'The policy applications in this programme year are judged by. Opening it ' +
    'publishes the cycle and freezes these rules into every application started ' +
    'while it is open.',

} as const
