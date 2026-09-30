/** Adds a status flag that neither ends the journey nor unlocks the form. */
import { z } from 'zod'
import { defineEffect } from '../registry'
import { flagOf, flagPermission } from './flags'

export const addStatus = defineEffect('ADD_STATUS', {
  params: z.strictObject({ flag: z.string() }),
  permissions: (params, definition) => [flagPermission(definition, params.flag)],
  validate: (params, { definition }) => {
    const flag = flagOf(definition, params.flag)
    if (!flag) return []
    return [
      // Ending the journey has its own effects, so the stage is cleared with it.
      ...(flag.terminal ? [`${flag.key} ends the pipeline; use COMPLETE_PIPELINE or CLOSE_APPLICATION to add it.`] : []),
      // The applicant's lock is loosened by a revision request and nothing else.
      ...(flag.applicantEdit !== 'NONE' ? [`${flag.key} lets the applicant edit; only REQUEST_REVISION may add it.`] : []),
    ]
  },
  plan: (params) => ({ addFlags: [params.flag] }),
})
