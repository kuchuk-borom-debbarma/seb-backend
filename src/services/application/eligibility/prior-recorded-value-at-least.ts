/** An earlier application recorded an amount of at least a given value. */
import { z } from 'zod'
import { defineEligibility, ELIGIBLE } from './define'

export const priorRecordedValueAtLeast = defineEligibility('PRIOR_RECORDED_VALUE_AT_LEAST', {
  params: z.strictObject({ value: z.string(), amountPaise: z.number().int().min(0) }),
  evaluate: (params, history) =>
    history.applications.some((application) => {
      const recorded = application.recorded[params.value]
      return typeof recorded === 'number' && recorded >= params.amountPaise
    })
      ? ELIGIBLE
      : { eligible: false, reason: 'This needs an earlier application with a larger recorded outcome.' },
})
