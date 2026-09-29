/**
 * The shape every audited action declares about itself.
 *
 * An audit row used to carry a flat bag of whatever its call site thought to
 * put in it, which is how a recorded decision came to be stored without its
 * outcome and a payment without its amount: nothing asked. A spec is the
 * question asked once per action — what does this event need to say, who is it
 * about, and how does a person read it — and the answer is enforced twice: by
 * the compiler at every call site, and by the payload schema at every write.
 */
import type { z } from 'zod'

/**
 * The families an action belongs to, for filtering and for the screen's
 * grouping. `OTHER` is never declared by a spec: it is what a row whose action
 * this build does not know — a legacy name, a fixture — reads as.
 */
export const auditCategories = [
  'SIGN_IN',
  'ACCOUNT',
  'ACCESS',
  'ENTERPRISE',
  'APPLICATION',
  'DOCUMENT',
  'REVIEW',
  'BANK',
  'DECISION',
  'FUNDING',
  'RECOVERY',
  'PROGRAMME',
  'ANNOUNCEMENT',
  'AUDIT',
  'OTHER',
] as const
export type AuditCategory = (typeof auditCategories)[number]

/**
 * How one payload value is read.
 *
 * The five reference kinds — `USER`, `ROLE`, `APPLICATION`, `ENTERPRISE`,
 * `CYCLE` — carry an identifier the read side turns into something a person
 * recognizes (an address, a role's name, a reference number). Everything else
 * is shown as recorded, formatted by kind: `MONEY` is integer paise, `DATE` an
 * ISO calendar date, `DATETIME` an ISO instant.
 */
export const auditDetailKinds = [
  'TEXT',
  'REASON',
  'EMAIL',
  'ENUM',
  'BOOLEAN',
  'COUNT',
  'MONEY',
  'DATE',
  'DATETIME',
  'ID',
  'USER',
  'ROLE',
  'APPLICATION',
  'ENTERPRISE',
  'CYCLE',
  'FILTERS',
] as const
export type AuditDetailKind = (typeof auditDetailKinds)[number]

/** The kinds whose value is resolved to a name when the row is read. */
export const auditReferenceKinds = ['USER', 'ROLE', 'APPLICATION', 'ENTERPRISE', 'CYCLE'] as const
export type AuditReferenceKind = (typeof auditReferenceKinds)[number]

/** The services that write audit rows, each allowed only its own actions. */
export type AuditWriter = 'auth' | 'admin' | 'application' | 'announcement' | 'audit'

/**
 * Who an event is *about*, which is what `subject_user_id` records.
 *
 * - `ACTOR` — the person acting on themselves: an applicant saving a draft.
 * - `ENTITY` — the row's entity is a `core_user`: a password reset.
 * - `APPLICANT` — the applicant of the event's application, resolved inside
 *   the same statement: an officer recording a decision on somebody's file.
 * - `NONE` — nobody in particular: a cycle opening.
 * - `{ payload }` — a person named in the payload: the holder of a grant.
 */
export type AuditSubjectRule<P> =
  | 'ACTOR'
  | 'ENTITY'
  | 'APPLICANT'
  | 'NONE'
  | { payload: { [K in keyof P]-?: NonNullable<P[K]> extends string ? K : never }[keyof P] }

/** How one payload key is labelled and read. */
export type AuditFieldSpec = { label: string; kind: AuditDetailKind }

/**
 * One label per payload key, every key required.
 *
 * `-?` is the point: an optional payload key still needs a label, because the
 * day it is present is the day somebody has to read it.
 */
export type AuditFieldSpecs<P> = { [K in keyof P]-?: AuditFieldSpec }

/** Turns a reference into its display name, or the raw id when unknown. */
export type AuditNamer = (kind: AuditReferenceKind, id: string) => string

export type AuditSpec<
  S extends z.ZodObject = z.ZodObject,
  W extends AuditWriter = AuditWriter,
  App extends 'REQUIRED' | 'NONE' = 'REQUIRED' | 'NONE',
  E extends string = string,
> = {
  /** A past-tense phrase naming the act: "Recorded a programme decision". */
  label: string
  category: Exclude<AuditCategory, 'OTHER'>
  writer: W
  entityTypes: readonly E[]
  subject: AuditSubjectRule<z.infer<S>>
  /**
   * `REQUIRED` for anything that happened to an application, its documents,
   * its review, its decision or its money: the row must carry the
   * application's id so the per-application history is one indexed read.
   */
  application: App
  /**
   * Set on the actions the credential-bearing maintenance paths write. Those
   * paths record no request labels, because the caller is not yet anybody and
   * could otherwise write chosen text into the history — so the payload must
   * not be a second way in. Such a spec has no `TEXT` or `FILTERS` field. A
   * `REASON` is allowed because every reason comes from a signed-in operator
   * or a constant, never from the anonymous caller; an `EMAIL` is allowed
   * because it is stored only after it has parsed as an address.
   */
  callerTextFree?: true
  payload: S
  fields: AuditFieldSpecs<z.infer<S>>
  /** One sentence a person can read without the details beside it. */
  summary: (payload: z.infer<S>, name: AuditNamer) => string
  /** A valid payload, parsed by the vocabulary test for every action. */
  example: z.infer<S>
}

/**
 * Declares one action's spec, keeping its writer, application rule and entity
 * types as literals so the row builder can check a call site against them.
 */
export const defineAudit = <
  S extends z.ZodObject,
  const W extends AuditWriter,
  const App extends 'REQUIRED' | 'NONE',
  const E extends string,
>(
  spec: AuditSpec<S, W, App, E>,
): AuditSpec<S, W, App, E> => spec
