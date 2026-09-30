/** Removes a status flag. */
import { z } from 'zod'
import { defineEffect } from '../registry'
import { flagOf, flagPermission } from './flags'

export const removeStatus = defineEffect('REMOVE_STATUS', {
  params: z.strictObject({ flag: z.string() }),
  permissions: (params, definition) => [flagPermission(definition, params.flag)],
  validate: (params, { definition }) => {
    const flag = flagOf(definition, params.flag)
    // Resubmission is what closes a revision; removing the flag by hand would
    // leave open revision requests with nothing letting the applicant answer.
    return flag && flag.applicantEdit !== 'NONE'
      ? [`${flag.key} is removed when the applicant resubmits, not by an action.`]
      : []
  },
  plan: (params) => ({ removeFlags: [params.flag] }),
})
