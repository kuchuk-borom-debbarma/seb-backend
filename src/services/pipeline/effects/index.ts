/**
 * Every effect handler, keyed by the catalogue's own union.
 *
 * `satisfies Record<EffectType, …>` makes a catalogue effect with no handler a
 * compile error, and the explicit key on each handler lets the test prove the
 * record's keys and the handlers' own keys agree.
 */
import type { EffectType } from '../../catalogue/workflow.generated'
import type { EffectHandler } from '../registry'
import { addInternalNote } from './add-internal-note'
import { addStatus } from './add-status'
import { closeApplication } from './close-application'
import { completePipeline } from './complete-pipeline'
import { moveByChoice } from './move-by-choice'
import { moveToStage } from './move-to-stage'
import { notifyApplicant } from './notify-applicant'
import { removeStatus } from './remove-status'
import { requestRevision } from './request-revision'
import { returnToPrevious } from './return-to-previous'
import { setRecordedValue } from './set-recorded-value'

export const effectHandlers = {
  ADD_STATUS: addStatus,
  REMOVE_STATUS: removeStatus,
  SET_RECORDED_VALUE: setRecordedValue,
  REQUEST_REVISION: requestRevision,
  NOTIFY_APPLICANT: notifyApplicant,
  ADD_INTERNAL_NOTE: addInternalNote,
  MOVE_TO_STAGE: moveToStage,
  MOVE_BY_CHOICE: moveByChoice,
  RETURN_TO_PREVIOUS: returnToPrevious,
  COMPLETE_PIPELINE: completePipeline,
  CLOSE_APPLICATION: closeApplication,
  // Structural on purpose: each handler keeps its own precise parameter type,
  // and this only proves every catalogue effect has one.
} satisfies Record<EffectType, { readonly key: EffectType }>

/** A handler by type, widened for callers that hold a type from a parsed document. */
export const effectHandler = (type: EffectType): EffectHandler =>
  effectHandlers[type] as unknown as EffectHandler
