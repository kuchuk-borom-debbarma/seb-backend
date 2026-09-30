/**
 * Asks the applicant to correct named form stages. The file stays at this
 * stage, holding the flag that unlocks exactly those stages, and comes back
 * here — not to the start — when the applicant resubmits.
 *
 * Which form stages and why are not parameters: they are chosen by the officer
 * for each file, and arrive with the action as revision requests.
 */
import { z } from 'zod'
import { defineEffect } from '../registry'
import { flagOf } from './flags'

export const requestRevision = defineEffect('REQUEST_REVISION', {
  params: z.strictObject({ flag: z.string() }),
  permissions: () => ['stage:request_revision'],
  validate: (params, { definition }) => {
    const flag = flagOf(definition, params.flag)
    if (!flag) return []
    return flag.applicantEdit === 'REVISION_SCOPED' && !flag.terminal
      ? []
      : [`${flag.key} must let the applicant edit the requested stages, and must not end the pipeline.`]
  },
  plan: (params) => ({ revision: { flag: params.flag } }),
})
