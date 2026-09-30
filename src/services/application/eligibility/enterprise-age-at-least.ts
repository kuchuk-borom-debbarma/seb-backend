/** The enterprise was established at least a number of months ago. */
import { z } from 'zod'
import { defineEligibility, ELIGIBLE, monthsBetween } from './define'

export const enterpriseAgeAtLeast = defineEligibility('ENTERPRISE_AGE_AT_LEAST', {
  params: z.strictObject({ months: z.number().int().min(0) }),
  evaluate: (params, history) => {
    // An enterprise with no establishment date cannot show its age, and a rule
    // about age must not pass on a missing fact.
    if (history.enterpriseEstablishedOn === null) {
      return { eligible: false, reason: 'Add your enterprise’s establishment date to its profile.' }
    }
    const established = new Date(`${history.enterpriseEstablishedOn}T00:00:00Z`)
    return monthsBetween(established, history.now) >= params.months
      ? ELIGIBLE
      : { eligible: false, reason: `Your enterprise must have been established at least ${params.months} months ago.` }
  },
})
