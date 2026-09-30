/**
 * Shared policy-layer helpers for the administrative controllers.
 *
 * What belongs here is what is genuinely this service's: its refusal messages,
 * its permission preamble, its error classification. The response envelope is
 * **not** — `success` and `failure` were once defined identically in four
 * support modules, which is one decision copied rather than four decisions, and
 * copies drift. They live in `services/envelope.ts` now, and the audit row
 * lives in `services/audit-event.ts` for the same reason.
 *
 * What stays here is the vocabulary: an administrative action, written against
 * an entity this service owns. Audit metadata stays deliberately smaller than
 * the business record — a flat map of primitives, never the form itself.
 */
import {
  auditEventRow,
  type ActionWrittenBy,
  type AuditEventInput,
  type AuditEventRecord,
} from '../audit-event'
/*
 * Re-exported rather than moved out of every caller's import: `constraintSafe`
 * is named in this package's README as part of the shared preamble, and it is
 * still that. Its definition now lives beside `isExpectedConstraintError`,
 * because `services/auth` needs it too.
 */
export { constraintSafe } from '../constraints'
import { authenticatedWithPermission, type ActionOf, type Resource } from '../auth'
import type { AdminOperationContext } from './types'

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
 * The caller, if they hold the permission this operation needs.
 *
 * Named for staff rather than administrators because the office composes its
 * own roles: somebody may read a workspace without being able to change one,
 * and record a decision without being able to open a cycle. Which role carries
 * which permission is a row now, and never restated here.
 *
 * The pair is required arguments on purpose. A default would mean an operation
 * that forgot to say what it needs silently inherits somebody else's answer,
 * and the direction that mistake fails in is "too permissive". Two arguments
 * make the mistake harder still: a preamble defaulting one would have to
 * default both, which reads as obviously wrong.
 */
export const currentStaff = async <R extends Resource>(
  context: AdminOperationContext,
  resource: R,
  action: ActionOf<R>,
) => {
  const authenticated = await authenticatedWithPermission(context, resource, action)
  return authenticated?.user ?? null
}

/** The actions the programme office's service may record. */
export type AdminAuditAction = ActionWrittenBy<'admin'>

/**
 * Builds one declared audit row for an administrative act.
 *
 * The row itself is built by `services/audit-event.ts`, shared with every other
 * service. What this adds is the narrowing to this service's actions, and that
 * an act here always happens at the instant its transaction was stamped with.
 */
export const adminAudit = <A extends AdminAuditAction>(
  context: AdminOperationContext,
  input: AuditEventInput<A> & { now: Date },
): AuditEventRecord => auditEventRow(context, { ...input, createdAt: input.now })

/*
 * Re-exported rather than moved out of every caller's import, like
 * `constraintSafe` above: the definitions live in `services/text.ts` because
 * the announcement service needs them too.
 */
export { normalizeRequiredText, normalizeOptionalText } from '../text'

/*
 * Re-exported rather than reimplemented. This was a second definition reading
 * D1's `{ meta: { changes } }`, a shape nothing produces any more.
 */
export { changedExactlyOne } from '../../db'
