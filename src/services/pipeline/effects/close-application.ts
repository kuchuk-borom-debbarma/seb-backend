/**
 * Ends the journey without success — a rejection — with a flag that ends the
 * pipeline. A separate effect from completing, because closing a file is a
 * separate authority from moving one along.
 */
import { z } from 'zod'
import { defineEffect } from '../registry'
import { flagOf } from './flags'

export const closeApplication = defineEffect('CLOSE_APPLICATION', {
  params: z.strictObject({ flag: z.string() }),
  permissions: () => ['stage:close'],
  validate: (params, { definition }) => {
    const flag = flagOf(definition, params.flag)
    return flag && !flag.terminal ? [`${flag.key} does not end the pipeline, so it cannot close the application.`] : []
  },
  plan: (params) => ({ stage: { kind: 'END', flag: params.flag } }),
})
