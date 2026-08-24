/**
 * The audit service's refusals.
 *
 * The response envelope comes from `services/envelope.ts`, shared by every
 * service. What is left here is this service's own messages. There is no
 * audit-row builder, because this service only reads — every service writes its
 * own rows, inside the batch that makes the change, which is what makes a
 * change and its record inseparable.
 */
import type { AuditResult } from './types'

export const AUDIT_REQUIRED_MESSAGE = 'You do not have permission to do that.'
export const INVALID_REQUEST_MESSAGE = 'That request could not be understood.'

