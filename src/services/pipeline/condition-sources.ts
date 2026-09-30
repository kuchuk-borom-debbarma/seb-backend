/**
 * Where each condition source reads its value, and the type that says how to
 * compare it.
 *
 * Every reader returns null for a key that names nothing, and a condition over
 * null is false: a configuration that cannot be evaluated must never unlock an
 * action.
 */
import type { ConditionSource } from '../catalogue/workflow.generated'
import { defineConditionSource, type ConditionSourceHandler } from './registry'

const answer = defineConditionSource('ANSWER', {
  // The type is the one the author declared and `pipelinePinProblem` proved
  // against the cycle's form when the cycle opened on this pipeline.
  read: (key, scope, declaredType) =>
    declaredType ? { value: scope.answers[key], type: declaredType } : null,
})

const statusFlag = defineConditionSource('STATUS_FLAG', {
  // Presence is the value, so IS_PRESENT, IS_ABSENT and EQUALS 'true' all read
  // it the way a yes-or-no answer is read.
  read: (key, scope) =>
    scope.definition.statusFlags.some((flag) => flag.key === key)
      ? { value: scope.flags.has(key) ? true : undefined, type: 'BOOLEAN' }
      : null,
})

const recordedValue = defineConditionSource('RECORDED_VALUE', {
  read: (key, scope) => {
    const declared = scope.definition.recordedValues.find((recorded) => recorded.key === key)
    return declared ? { value: scope.recorded[key], type: declared.type } : null
  },
})

const input = defineConditionSource('INPUT', {
  read: (key, scope) => {
    const declared = scope.action?.inputs.find((candidate) => candidate.key === key)
    return declared ? { value: scope.inputs[key], type: declared.type } : null
  },
})

export const conditionSourceHandlers = {
  ANSWER: answer,
  STATUS_FLAG: statusFlag,
  RECORDED_VALUE: recordedValue,
  INPUT: input,
} satisfies Record<ConditionSource, ConditionSourceHandler>
