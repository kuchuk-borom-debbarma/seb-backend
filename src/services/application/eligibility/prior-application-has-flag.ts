/** An earlier application holds a flag, held for at least some months. */
import { z } from 'zod'
import { defineEligibility, ELIGIBLE, monthsBetween } from './define'

export const priorApplicationHasFlag = defineEligibility('PRIOR_APPLICATION_HAS_FLAG', {
  params: z.strictObject({
    flag: z.string(),
    pipelineKey: z.string().optional(),
    minMonthsSinceFlag: z.number().int().min(0).optional(),
  }),
  evaluate: (params, history) => {
    const holding = history.applications.filter(
      (application) =>
        application.flags.includes(params.flag) &&
        (params.pipelineKey === undefined || application.pipelineKey === params.pipelineKey),
    )
    if (holding.length === 0) return { eligible: false, reason: 'This needs an earlier application that reached the required outcome.' }
    const months = params.minMonthsSinceFlag ?? 0
    const longEnough = holding.some((application) => {
      const since = application.flagAddedAt[params.flag]
      return since !== undefined && monthsBetween(since, history.now) >= months
    })
    return longEnough
      ? ELIGIBLE
      : { eligible: false, reason: `This opens ${months} months after the earlier application's outcome.` }
  },
})
