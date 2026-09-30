/**
 * Sends the file back to the stage it actually came from.
 *
 * "Previous" is this file's own trail, not the pipeline's order: a file routed
 * to the second-choice bank returns to whoever routed it, not to the first
 * bank, and a file at the first stage has nowhere to return to.
 */
import { z } from 'zod'
import { defineEffect } from '../registry'

export const returnToPrevious = defineEffect('RETURN_TO_PREVIOUS', {
  params: z.strictObject({}),
  permissions: () => ['stage:return'],
  validate: (_params, { definition, stage }) =>
    stage.key === definition.initialStageKey ? [`${stage.key} is where files enter, so nothing can be returned from it.`] : [],
  plan: (_params, context) =>
    context.trail.length > 0 ? { stage: { kind: 'RETURN' } } : { refusal: 'This application has no earlier stage to return to.' },
})
