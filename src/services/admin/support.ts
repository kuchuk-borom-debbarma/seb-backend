/**
 * Shared policy-layer helpers for the administrative controllers.
 *
 * What belongs here is what is genuinely this service's: its refusal messages,
 * its capability preamble, its audit-row builder. The response envelope itself
 * is **not** — `success` and `failure` were once defined identically in four
 * support modules, which is one decision copied rather than four decisions, and
 * copies drift. They live in `services/envelope.ts` now.
 *
 * Audit metadata stays deliberately smaller than the business record: a flat
 * map of primitives, never the form itself.
 */
import { sql, type SQL } from 'drizzle-orm'
import { coreAuditEvent, sebApplication, type auditActions } from '../../db/schema'
import { failure } from '../envelope'
/*
 * Re-exported rather than moved out of every caller's import: `constraintSafe`
 * is named in this package's README as part of the shared preamble, and it is
 * still that. Its definition now lives beside `isExpectedConstraintError`,
 * because `services/auth` needs it too.
 */
export { constraintSafe } from '../constraints'
import { authenticatedWithCapability, type Capability } from '../auth'
import type { AdminOperationContext, AdminResult } from './types'

/**
 * The one refusal every insufficiently authorized staff request receives.
 *
 * Deliberately does not name a role. The office now holds four of them, so
 * "administrator access is required" would be wrong for a reviewer refused a
 * write and misleading for an approver refused a desk review — and naming the
 * role that *would* work tells a caller which account to go looking for.
 */
export const ADMIN_REQUIRED_MESSAGE = 'You do not have permission to do that.'
export const STALE_MESSAGE = 'The record changed. Reload and try again.'

/**
 * The caller, if they hold the capability this operation needs.
 *
 * Named for staff rather than administrators because the office now holds four
 * roles and two of them are not administrators: a reviewer may read a
 * workspace, and an approver may record a decision, without being able to do
 * anything else. Which role carries which capability is decided in one place,
 * `auth/capabilities.ts`, and never restated here.
 *
 * The capability is a required argument on purpose. A default would mean an
 * operation that forgot to say what it needs silently inherits somebody else's
 * answer, and the direction that mistake fails in is "too permissive".
 */
export const currentStaff = async (
  context: AdminOperationContext,
  capability: Capability,
) => {
  const authenticated = await authenticatedWithCapability(context, capability)
  return authenticated?.user ?? null
}

export type AdminAuditAction = (typeof auditActions)[keyof typeof auditActions]

/** Audit metadata stays deliberately smaller than the business record. */
export const adminAudit = (
  context: AdminOperationContext,
  input: {
    actorUserId: string | null
    action: AdminAuditAction
    entityType: string
    entityId: string
    now: Date
    metadata?: Record<string, string | number | boolean | null>
  },
): typeof coreAuditEvent.$inferInsert => ({
  id: crypto.randomUUID(),
  actorUserId: input.actorUserId,
  action: input.action,
  entityType: input.entityType,
  entityId: input.entityId,
  outcome: 'SUCCESS',
  requestId:
    context.requestHeaders.get('CF-Ray') ?? context.requestHeaders.get('X-Request-ID'),
  ipAddress: context.requestHeaders.get('CF-Connecting-IP'),
  userAgent: context.requestHeaders.get('User-Agent'),
  changesJson: null,
  metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
  createdAt: input.now,
})

/**
 * Whether the head update that opens this transaction actually landed.
 *
 * Every guarded write is an `UPDATE ... WHERE status_version = expected`
 * followed by inserts that must fire only if it matched. Those inserts cannot
 * read the update's result, so they re-state the condition — and the obvious
 * re-statement, *"the head is now at `expected + 1`"*, is true whenever the
 * head was **already** there. An officer acting from a page one version stale
 * therefore had their update refused and their inserts accepted: the caller
 * was told the write did not happen, and a decision nobody made appeared on
 * the application.
 *
 * Demonstrated in `test/service/decision-bound.test.ts` before this existed.
 *
 * The timestamp is what makes it this operation rather than that version. Each
 * write mints one `now` and stamps it on the head in the same statement, so
 * the pair identifies the update that just ran and nothing else — no earlier
 * transition can have written the same instant.
 */
export const headJustMovedTo = (
  applicationId: string,
  statusVersion: number,
  now: Date,
): SQL => sql`EXISTS (
  SELECT 1 FROM ${sebApplication}
  WHERE ${sebApplication.id} = ${applicationId}
    AND ${sebApplication.statusVersion} = ${statusVersion}
    AND ${sebApplication.statusChangedAt} = ${now}
)`


/*
 * Re-exported rather than moved out of every caller's import, like
 * `constraintSafe` above: the definitions live in `services/text.ts` because
 * the announcement service needs them too. Imported as well, because this
 * file's own preamble below still normalizes reasons.
 */
import { normalizeRequiredText } from '../text'
export { normalizeRequiredText, normalizeOptionalText } from '../text'

/*
 * Re-exported rather than reimplemented. This was a second definition reading
 * D1's `{ meta: { changes } }`, a shape nothing produces any more.
 */
export { changedExactlyOne } from '../../db'

/**
 * Refuses an undisclosed self-review.
 *
 * A member of staff may act on their own application — `docs/policy-alignment.md`
 * records that as permitted, with disclosure — but they must say so, and the
 * saying is what lands in the audit trail.
 *
 * This used to live on claiming, which was the first act on a file. There is
 * nothing to reserve now, so the disclosure moved onto the transitions that
 * actually decide something: completing a desk review and recording a
 * decision. Left where it was, it would simply never be collected.
 *
 * Absent is treated as not acknowledged. Only somebody reviewing their own
 * application has to send it, so every other caller is unaffected.
 */
export const undisclosedSelfReview = (
  applicantUserId: string,
  actorId: string,
  acknowledged: boolean | null | undefined,
): boolean => applicantUserId === actorId && acknowledged !== true

export const SELF_REVIEW_MESSAGE =
  'Acknowledge that you are acting on your own application.'

/**
 * Whether an act is a *disclosed self-review*, as a term the write evaluates.
 *
 * Deliberately not the caller's word. `undisclosedSelfReview` above refuses an
 * acknowledgement that is **missing** from the applicant; nothing there stops
 * anybody asserting one on a file that is not theirs, and a review wrongly
 * marked as a self-review is worse than one not marked at all — it is a false
 * statement in a record kept for an auditor, and it makes
 * `SEB.SELF_REVIEW_DISCLOSED` return files that were nothing of the kind.
 *
 * So the ownership half is read from the application row inside the same
 * statement that stores the answer, which is the layering rule this codebase
 * follows everywhere else: the controller decides, and the write proves it
 * again in SQL.
 *
 * **A boolean, not a `1`.** It read `${Number(acknowledged)} = 1` and its
 * callers compared the whole subquery to `1` again — the SQLite spelling.
 * Postgres refuses to compare a boolean to an integer, so the disclosure write
 * did not go unrecorded, it *threw*, taking the whole desk review down with
 * it. Anything comparing this to a number will fail the same way.
 */
export const disclosedSelfReview = (
  applicationId: string,
  actorUserId: string,
  acknowledged: boolean | null | undefined,
): SQL => sql`(
  SELECT ${acknowledged === true}
    AND ${sebApplication.applicantUserId} = ${actorUserId}
  FROM ${sebApplication} WHERE ${sebApplication.id} = ${applicationId}
)`

/**
 * The preamble every reasoned, version-guarded administrative transition shares.
 *
 * Each of these transitions is authorized the same way, requires the same
 * bounded mandatory reason, and takes the same optimistic-concurrency version.
 * Only the message describing a malformed request differs, so that is the one
 * thing a caller supplies.
 */
export const authorizeReasonedTransition = async (
  context: AdminOperationContext,
  capability: Capability,
  input: { reason: string; expectedVersion: number },
  invalidRequestMessage: string,
): Promise<{ actorId: string; reason: string } | { refusal: AdminResult<never> }> => {
  const administrator = await currentStaff(context, capability)
  if (!administrator) return { refusal: failure(ADMIN_REQUIRED_MESSAGE) }
  const reason = normalizeRequiredText(input.reason, 1_000)
  if (!reason || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { refusal: failure(invalidRequestMessage) }
  }
  return { actorId: administrator.id, reason }
}
