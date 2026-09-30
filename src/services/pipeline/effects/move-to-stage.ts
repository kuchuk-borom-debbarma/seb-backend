/** Sends the file to a fixed stage. */
import { z } from 'zod'
import { defineEffect } from '../registry'

export const moveToStage = defineEffect('MOVE_TO_STAGE', {
  params: z.strictObject({ target: z.string() }),
  permissions: () => ['stage:advance'],
  validate: (params, { stage }) =>
    params.target === stage.key ? [`A move from ${stage.key} to itself would change nothing.`] : [],
  plan: (params) => ({ stage: { kind: 'MOVE', to: params.target } }),
})
