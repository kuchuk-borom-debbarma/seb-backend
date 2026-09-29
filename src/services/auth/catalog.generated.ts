/**
 * GENERATED FROM `catalog.json`. Do not edit.
 *
 * `npm run catalog:generate` writes it; `npm run check:catalog` regenerates
 * and fails on any difference, which is what makes the JSON the source of truth
 * rather than a second copy of these types. Same arrangement as
 * `database/schema.sql`, and for the same reason.
 *
 * The literal unions are the point. A guard that named a resource or an action
 * as a plain string would let a typo through to run time, where it reads as a
 * permission nobody holds — a refusal with no cause anybody can find.
 */

/** Every kind of record something may be done to. */
export const resources = ['application', 'decision', 'funding', 'recovery', 'programme_cycle', 'form_template', 'policy_document', 'announcement', 'audit', 'user', 'role', 'analytics'] as const

export type Resource = (typeof resources)[number]

/**
 * Every act that may be permitted, as a vocabulary shared across resources.
 *
 * Not exported: `actionDescriptions` below carries the same list as its keys
 * and `grants` carries which resource offers what, so a third way to ask would
 * be a third thing to keep in step.
 */
const actions = ['read', 'note', 'review', 'refer', 'record', 'correct', 'award', 'release', 'reverse', 'assess', 'open', 'cancel', 'close', 'create', 'update', 'archive', 'delete', 'upload', 'publish', 'remove', 'reorder', 'invite'] as const

export type Action = (typeof actions)[number]

/**
 * Which actions each resource actually offers.
 *
 * Kept separate from the two lists above because `read` means the same thing
 * everywhere while only some resources offer it, and a flat product of the two
 * would contain pairs no operation could ever check.
 */
export const grants = {
  application: ['read', 'note', 'review', 'refer'],
  decision: ['record', 'correct'],
  funding: ['read', 'award', 'release', 'reverse', 'assess'],
  recovery: ['read', 'open', 'record', 'cancel', 'close'],
  programme_cycle: ['read', 'create', 'update', 'open', 'close', 'archive', 'delete'],
  form_template: ['update'],
  policy_document: ['read', 'upload'],
  announcement: ['read', 'create', 'update', 'publish', 'remove', 'reorder'],
  audit: ['read'],
  user: ['read'],
  role: ['read', 'invite'],
  analytics: ['read'],
} as const satisfies Record<Resource, readonly Action[]>

/**
 * The actions one resource offers, as a type.
 *
 * This is what makes a guard's two arguments check against each other:
 * `ActionOf<'audit'>` is `'read'`, so asking to award something on the audit
 * history does not compile.
 */
export type ActionOf<R extends Resource> = (typeof grants)[R][number]

/** Every legal pair, in catalogue order. */
export const permissions = [
  { resource: 'application', action: 'read' },
  { resource: 'application', action: 'note' },
  { resource: 'application', action: 'review' },
  { resource: 'application', action: 'refer' },
  { resource: 'decision', action: 'record' },
  { resource: 'decision', action: 'correct' },
  { resource: 'funding', action: 'read' },
  { resource: 'funding', action: 'award' },
  { resource: 'funding', action: 'release' },
  { resource: 'funding', action: 'reverse' },
  { resource: 'funding', action: 'assess' },
  { resource: 'recovery', action: 'read' },
  { resource: 'recovery', action: 'open' },
  { resource: 'recovery', action: 'record' },
  { resource: 'recovery', action: 'cancel' },
  { resource: 'recovery', action: 'close' },
  { resource: 'programme_cycle', action: 'read' },
  { resource: 'programme_cycle', action: 'create' },
  { resource: 'programme_cycle', action: 'update' },
  { resource: 'programme_cycle', action: 'open' },
  { resource: 'programme_cycle', action: 'close' },
  { resource: 'programme_cycle', action: 'archive' },
  { resource: 'programme_cycle', action: 'delete' },
  { resource: 'form_template', action: 'update' },
  { resource: 'policy_document', action: 'read' },
  { resource: 'policy_document', action: 'upload' },
  { resource: 'announcement', action: 'read' },
  { resource: 'announcement', action: 'create' },
  { resource: 'announcement', action: 'update' },
  { resource: 'announcement', action: 'publish' },
  { resource: 'announcement', action: 'remove' },
  { resource: 'announcement', action: 'reorder' },
  { resource: 'audit', action: 'read' },
  { resource: 'user', action: 'read' },
  { resource: 'role', action: 'read' },
  { resource: 'role', action: 'invite' },
  { resource: 'analytics', action: 'read' },
] as const

export type Permission = (typeof permissions)[number]

/** What each resource is, for whoever is deciding whether to hand it out. */
export const resourceDescriptions: Record<Resource, string> = {
  application: 'An applicant\'s submitted file and the casework on it. Reading one includes what sits on its desk — its decisions, its funding and its bank referrals — because the workspace returns them together.',
  decision: 'The programme\'s own verdict on an application, as distinct from what a partner bank reported back.',
  funding: 'Money committed against an approved application, paid out, reversed, or judged after the fact.',
  recovery: 'A demand for released money to come back, and the ledger of what was demanded, received or written off.',
  programme_cycle: 'One round of the programme: the rules every applicant in it is judged against, and the window it is open for.',
  form_template: 'The questions a cycle asks. Editing them is one authority rather than one per question, because they are authored as a whole.',
  policy_document: 'The order or circular a cycle implements, stored as a PDF beside it.',
  announcement: 'The banner on the public landing page, including cards not yet published.',
  audit: 'The retained history of who did what. It carries more about people than any other read.',
  user: 'An account, as somebody administering access sees it: its address, its state, and the roles it has held.',
  role: 'A named set of permissions and who holds it. Only reading and inviting appear here — composing a role is the super administrator\'s alone.',
  analytics: 'Counts and totals across the whole programme, naming no individual applicant.',
}

/** What each action permits, in the words somebody reads before allowing it. */
export const actionDescriptions: Record<Action, string> = {
  read: 'Open and list it, changing nothing.',
  note: 'Write a staff-only note against a file. The narrowest write there is — somebody may comment without being able to work the review.',
  review: 'Work the desk review: start it, complete its checklist, and withdraw a revision it asked for.',
  refer: 'Send a file to a partner bank and handle what comes back. What the bank reported is an input to the programme\'s verdict, not the verdict.',
  record: 'State something for the first time, into a history that supersedes rather than overwrites.',
  correct: 'Supersede something already stated, keeping both readable and the reason beside them.',
  award: 'Commit money against an approved file, or change what was committed. Nothing has left the account yet.',
  release: 'Pay out against a commitment already made. This is money leaving.',
  reverse: 'Compensate a payment that should not have gone out.',
  assess: 'Judge how well money already paid was used.',
  open: 'Bring it into its live state — a cycle accepting applications, a demand being pursued.',
  cancel: 'End it on the grounds that it should never have been started.',
  close: 'End it on the grounds that it has run its course.',
  create: 'Bring a new one into existence.',
  update: 'Change one that already exists.',
  archive: 'Retire a finished round from the working set, keeping it readable.',
  delete: 'Withdraw a draft that was never used. The row survives; it stops being offered.',
  upload: 'Attach a file, and settle the upload once the bytes have arrived.',
  publish: 'Put it in front of the public, or take it back out of sight.',
  remove: 'Take a published item down for good.',
  reorder: 'Change the order things are shown in.',
  invite: 'Offer somebody a role they accept themselves. Bounded by what the issuer already holds.',
}
