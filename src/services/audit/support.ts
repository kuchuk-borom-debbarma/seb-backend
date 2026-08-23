/**
 * The audit service's response envelope.
 *
 * The same shape the other services use, kept as its own copy for the reason
 * `admin/support.ts` gives: one per service is what stops them drifting to
 * different envelopes. There is no audit-row builder here, because this service
 * only reads — every service writes its own rows, inside the batch that makes
 * the change, which is what makes a change and its record inseparable.
 */
import type { AuditResult } from './types'

export const AUDIT_REQUIRED_MESSAGE = 'You do not have permission to do that.'
export const INVALID_REQUEST_MESSAGE = 'That request could not be understood.'

export const success = <T>(response: T, message: string | null = null): AuditResult<T> => ({
  success: true,
  message,
  response,
})

export const failure = <T>(message: string): AuditResult<T> => ({
  success: false,
  message,
  response: null,
})
