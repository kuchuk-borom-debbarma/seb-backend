/**
 * What every pipeline operation shares: its context, its refusals, and its
 * audit wrapper.
 *
 * Two families of operation live in this service. **Authoring** changes a
 * pipeline's shape and who works its stages, behind the `pipeline` resource.
 * **Casework** works a file through a stage, behind the `stage` resource and
 * stage ownership. They share this module and nothing else, so each can be read
 * on its own.
 */
import type { Envelope } from '../envelope'
import { auditEventRow, type ActionWrittenBy, type AuditEventInput, type AuditEventRecord } from '../audit-event'
import type { AdminOperationContext } from '../admin/types'

/**
 * A pipeline operation's context. The same shape as an administrative one,
 * because a pipeline is staff work reached through the same `admin`
 * namespace; aliased so a signature says which service it belongs to.
 */
export type PipelineOperationContext = AdminOperationContext

export type PipelineResult<T> = Envelope<T>

/*
 * The refusal every insufficiently authorised request receives, whether the
 * caller lacks a permission or does not own the stage. One message for both,
 * and it names no role, for the reason `ADMIN_REQUIRED_MESSAGE` gives: naming
 * what would work tells a caller which account to look for.
 */
export { ADMIN_REQUIRED_MESSAGE as NOT_PERMITTED_MESSAGE, STALE_MESSAGE } from '../admin/support'

/** A pipeline, version or file the caller cannot see reads the same as one that does not exist. */
export const NOT_FOUND_MESSAGE = 'That could not be found.'

/** The actions this service may record. */
export type PipelineAuditAction = ActionWrittenBy<'pipeline'>

/**
 * One declared audit row for a pipeline act, at the instant its transaction
 * was stamped with — so the row and the business write agree on when.
 */
export const pipelineAudit = <A extends PipelineAuditAction>(
  context: PipelineOperationContext,
  input: AuditEventInput<A> & { now: Date },
): AuditEventRecord => auditEventRow(context, { ...input, createdAt: input.now })
