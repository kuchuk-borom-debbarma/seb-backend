/**
 * Authorization and input validation for the intake analytics summary.
 *
 * A read, gated exactly like the queue it summarizes: `STAFF_READ`, which a
 * reviewer holds — summarizing casework discloses nothing the queue does not
 * already list row by row. The filter validation is the queue's own, imported
 * rather than restated, so a range one screen refuses cannot quietly reach
 * the other as an empty chart.
 */
import { intakeAnalyticsSummary } from '../queries/analytics'
import { intakeFilterProblem, type IntakeQueueFilterInput } from './intake'
import { failure, success } from '../../envelope'
import { ADMIN_REQUIRED_MESSAGE, currentStaff } from '../support'
import type { AdminOperationContext, AdminResult } from '../types'

export const analyticsSummary = async (
  input: IntakeQueueFilterInput,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const problem = intakeFilterProblem(input)
  if (problem) return failure(problem)
  return success(await intakeAnalyticsSummary(context.db, input))
}
