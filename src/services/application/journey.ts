/**
 * Where an applicant's file is, in the words its pipeline wrote for them.
 *
 * The applicant never sees a stage's office name, an office-only flag or a
 * value the pipeline keeps from them: only the stage's applicant label and
 * explanation, the flags declared `applicantVisible` by their applicant label,
 * and the recorded values declared `applicantVisible`. The pinned version is
 * read, so a pipeline edited after the file started still describes it the way
 * it is being worked.
 *
 * Pure shaping over the per-request definition loader: a page of applications
 * across several pipeline versions resolves every definition in one statement.
 */
import { pipelineVersionKey, type Loaders } from '../../loaders'
import type { Application } from './types'

type Journeyed = Pick<Application, 'status' | 'pipelineId' | 'pipelineVersion' | 'currentStageKey' | 'statusFlags' | 'recordedValues'>

export const applicantJourney = async (application: Journeyed, loaders: Loaders) => {
  if (application.status === 'DRAFT') return null
  const definition = await loaders.pipelineDefinition.load(
    pipelineVersionKey(application.pipelineId, application.pipelineVersion),
  )
  if (!definition) return null
  const held = new Set(application.statusFlags)
  const stage = definition.stages.find((each) => each.key === application.currentStageKey)
  const ended = definition.statusFlags.find((flag) => flag.terminal && held.has(flag.key))
  return {
    stageLabel: stage?.applicantLabel ?? null,
    stageExplanation: stage?.applicantExplanation ?? null,
    ended: ended?.applicantVisible ? ended.applicantLabel : ended ? 'Finished' : null,
    flags: definition.statusFlags
      .filter((flag) => flag.applicantVisible && held.has(flag.key))
      .map((flag) => ({ key: flag.key, label: flag.applicantLabel, explanation: flag.explanation })),
    recordedValues: definition.recordedValues.flatMap((declared) => {
      const value = application.recordedValues[declared.key]
      if (!declared.applicantVisible || value === undefined || value === null || value === '') return []
      return [{
        key: declared.key,
        label: declared.label,
        type: declared.type,
        value: Array.isArray(value) ? value.join(', ') : String(value),
      }]
    }),
  }
}
