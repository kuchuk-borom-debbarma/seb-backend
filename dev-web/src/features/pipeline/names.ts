/**
 * What the document names, as the pickers offer it.
 *
 * One place that turns stages, flags, values and questions into `{ key,
 * label }`, so every picker in the editor lists them the same way.
 */
import { defaultFormTemplate } from '#/features/admin/defaultFormTemplate'
import type { PipelineDefinition } from './definition'
import type { Named } from './paramControls'

export type TabProps = {
  definition: PipelineDefinition
  edit: (update: (definition: PipelineDefinition) => PipelineDefinition) => void
  readOnly: boolean
}

export const stageNames = (definition: PipelineDefinition): Named[] =>
  definition.stages.map((stage) => ({ key: stage.key, label: stage.name || stage.key }))

export const flagNames = (definition: PipelineDefinition): Named[] =>
  definition.statusFlags.map((flag) => ({ key: flag.key, label: flag.label || flag.key }))

export const recordedValueNames = (definition: PipelineDefinition): Named[] =>
  definition.recordedValues.map((value) => ({ key: value.key, label: value.label || value.key }))

const UNANSWERABLE: readonly string[] = ['FILE', 'STATEMENT', 'REPEAT_GROUP']

/**
 * The questions of the default form a pipeline may read.
 *
 * Suggestions only: a pipeline is written before any cycle's form, and which
 * questions exist is the cycle's decision. Each cycle is checked against the
 * pipeline when it opens, so a key typed here that its form lacks is refused
 * there, by name. Top-level only — the pin check refuses a question inside a
 * repeated group, which has several answers to choose from.
 */
export const defaultAnswerNames: Named[] = (() => {
  const template = defaultFormTemplate()
  return template.fields
    .filter((field) => !field.parentFieldKey && !UNANSWERABLE.includes(field.fieldType))
    .map((field) => ({ key: field.fieldKey, label: field.label }))
})()
