/** Finishes the journey successfully, with a flag that ends the pipeline. */
import { z } from 'zod'
import { defineEffect } from '../registry'
import { flagOf } from './flags'

export const completePipeline = defineEffect('COMPLETE_PIPELINE', {
  params: z.strictObject({ flag: z.string() }),
  permissions: () => ['stage:advance'],
  validate: (params, { definition }) => {
    const flag = flagOf(definition, params.flag)
    return flag && !flag.terminal ? [`${flag.key} does not end the pipeline, so it cannot complete it.`] : []
  },
  plan: (params) => ({ stage: { kind: 'END', flag: params.flag } }),
})
