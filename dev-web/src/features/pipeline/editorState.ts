/**
 * The editor's one piece of state: the working document, and the saved copy
 * it is compared against.
 *
 * A single reducer, so every edit — a label, a reordered stage, a renamed
 * key and everything that referred to it — is one transition from one
 * document to the next. "Unsaved" is not a flag somebody has to remember to
 * set: it is whether the working copy still serialises to what was last saved.
 */
import {
  definitionToJson,
  type PipelineAction,
  type PipelineCondition,
  type PipelineDefinition,
  type PipelineStage,
} from './definition'

export type EditorState = {
  definition: PipelineDefinition
  /** The document as last loaded or saved, serialised. */
  savedJson: string
}

export type EditorAction =
  | { type: 'load'; definition: PipelineDefinition }
  | { type: 'edit'; update: (definition: PipelineDefinition) => PipelineDefinition }

export const initialEditorState = (definition: PipelineDefinition): EditorState => ({
  definition,
  savedJson: definitionToJson(definition),
})

export const editorReducer = (state: EditorState, action: EditorAction): EditorState => {
  switch (action.type) {
    case 'load':
      return initialEditorState(action.definition)
    case 'edit':
      return { ...state, definition: action.update(state.definition) }
  }
}

export const isDirty = (state: EditorState): boolean => definitionToJson(state.definition) !== state.savedJson

/* ---- Immutable updates, by position ------------------------------------ */

export const replaceAt = <T>(list: readonly T[], index: number, next: T): T[] =>
  list.map((item, at) => (at === index ? next : item))

export const removeAt = <T>(list: readonly T[], index: number): T[] => list.filter((_, at) => at !== index)

/** Moves one item by `offset` places, staying inside the list. */
export const moveAt = <T>(list: readonly T[], index: number, offset: number): T[] => {
  const target = index + offset
  if (target < 0 || target >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  return next
}

export const updateStage = (
  definition: PipelineDefinition,
  stageIndex: number,
  update: (stage: PipelineStage) => PipelineStage,
): PipelineDefinition => ({
  ...definition,
  stages: replaceAt(definition.stages, stageIndex, update(definition.stages[stageIndex]!)),
})

export const updateAction = (
  definition: PipelineDefinition,
  stageIndex: number,
  actionIndex: number,
  update: (action: PipelineAction) => PipelineAction,
): PipelineDefinition =>
  updateStage(definition, stageIndex, (stage) => ({
    ...stage,
    actions: replaceAt(stage.actions, actionIndex, update(stage.actions[actionIndex]!)),
  }))

/* ---- Renaming a key everywhere it is named ------------------------------ */

const renameIn = (conditions: PipelineCondition[], source: PipelineCondition['source'], from: string, to: string) =>
  conditions.map((condition) =>
    condition.source === source && condition.key === from ? { ...condition, key: to } : condition,
  )

/** Every action of the document, rewritten by one function. */
const everyAction = (definition: PipelineDefinition, update: (action: PipelineAction) => PipelineAction): PipelineDefinition => ({
  ...definition,
  stages: definition.stages.map((stage) => ({ ...stage, actions: stage.actions.map(update) })),
})

/**
 * A stage renamed, with every move, route and the entry point following it.
 *
 * Without this, renaming a stage would leave every action that sent files
 * there pointing at a stage that no longer exists — a document that only the
 * server's validation would then explain.
 */
export const renameStage = (definition: PipelineDefinition, from: string, to: string): PipelineDefinition => {
  const renamed = everyAction(definition, (action) => ({
    ...action,
    effects: action.effects.map((effect) => {
      if (effect.type === 'MOVE_TO_STAGE' && effect.params.target === from) {
        return { ...effect, params: { ...effect.params, target: to } }
      }
      if (effect.type === 'MOVE_BY_CHOICE' && effect.params.routes && typeof effect.params.routes === 'object') {
        const routes = Object.fromEntries(
          Object.entries(effect.params.routes as Record<string, unknown>).map(([option, stage]) => [option, stage === from ? to : stage]),
        )
        return { ...effect, params: { ...effect.params, routes } }
      }
      return effect
    }),
  }))
  return {
    ...renamed,
    initialStageKey: renamed.initialStageKey === from ? to : renamed.initialStageKey,
    stages: renamed.stages.map((stage) => (stage.key === from ? { ...stage, key: to } : stage)),
  }
}

/** A status flag renamed in presence flags, submission flags, effects and conditions. */
export const renameFlag = (definition: PipelineDefinition, from: string, to: string): PipelineDefinition => {
  const swap = (flags: string[]) => flags.map((flag) => (flag === from ? to : flag))
  const renamed = everyAction(definition, (action) => ({
    ...action,
    availableWhen: renameIn(action.availableWhen, 'STATUS_FLAG', from, to),
    effects: action.effects.map((effect) => ({
      ...effect,
      when: renameIn(effect.when, 'STATUS_FLAG', from, to),
      params: effect.params.flag === from ? { ...effect.params, flag: to } : effect.params,
    })),
  }))
  return {
    ...renamed,
    onSubmit: { addFlags: swap(renamed.onSubmit.addFlags) },
    statusFlags: renamed.statusFlags.map((flag) => (flag.key === from ? { ...flag, key: to } : flag)),
    stages: renamed.stages.map((stage) => ({ ...stage, presenceFlags: swap(stage.presenceFlags) })),
  }
}

/** A recorded value renamed where effects record it, conditions read it and inputs start from it. */
export const renameRecordedValue = (definition: PipelineDefinition, from: string, to: string): PipelineDefinition => {
  const renamed = everyAction(definition, (action) => ({
    ...action,
    availableWhen: renameIn(action.availableWhen, 'RECORDED_VALUE', from, to),
    inputs: action.inputs.map((input) =>
      input.defaultFrom?.source === 'RECORDED_VALUE' && input.defaultFrom.key === from
        ? { ...input, defaultFrom: { ...input.defaultFrom, key: to } }
        : input,
    ),
    effects: action.effects.map((effect) => ({
      ...effect,
      when: renameIn(effect.when, 'RECORDED_VALUE', from, to),
      params: effect.params.target === from && effect.type === 'SET_RECORDED_VALUE'
        ? { ...effect.params, target: to }
        : effect.params,
    })),
  }))
  return {
    ...renamed,
    recordedValues: renamed.recordedValues.map((value) => (value.key === from ? { ...value, key: to } : value)),
  }
}

/** An action's input renamed in its effects and in every condition that reads it. */
export const renameInput = (action: PipelineAction, from: string, to: string): PipelineAction => ({
  ...action,
  inputs: action.inputs.map((input) => ({
    ...(input.key === from ? { ...input, key: to } : input),
    visibleWhen: renameIn(input.visibleWhen, 'INPUT', from, to),
  })),
  effects: action.effects.map((effect) => ({
    ...effect,
    when: renameIn(effect.when, 'INPUT', from, to),
    params: effect.params.input === from ? { ...effect.params, input: to } : effect.params,
  })),
})

/* ---- Where a problem is ------------------------------------------------- */

export type EditorTab = 'flow' | 'stages' | 'flags' | 'values' | 'actions' | 'owners' | 'versions'

/** Where the editor should go to show a problem the server reported at `path`. */
export type ProblemLocation = { tab: EditorTab; stageIndex?: number; actionIndex?: number; index?: number }

export const locationOf = (path: string): ProblemLocation => {
  const parts = path.split('.')
  if (parts[0] === 'stages' && parts[1] !== undefined && /^\d+$/u.test(parts[1])) {
    const stageIndex = Number(parts[1])
    if (parts[2] === 'actions' && parts[3] !== undefined && /^\d+$/u.test(parts[3])) {
      return { tab: 'actions', stageIndex, actionIndex: Number(parts[3]) }
    }
    return { tab: 'stages', stageIndex }
  }
  if (parts[0] === 'statusFlags' || parts[0] === 'onSubmit') {
    return { tab: 'flags', index: parts[1] !== undefined && /^\d+$/u.test(parts[1]) ? Number(parts[1]) : undefined }
  }
  if (parts[0] === 'recordedValues') {
    return { tab: 'values', index: parts[1] !== undefined && /^\d+$/u.test(parts[1]) ? Number(parts[1]) : undefined }
  }
  return { tab: 'stages' }
}

/** A path as a person reads it: `stages.1.actions.0.effects.2` → "Stage 2 › action 1 › effect 3". */
export const describePath = (path: string, definition: PipelineDefinition): string => {
  const parts = path.split('.')
  const words: string[] = []
  let stage: PipelineStage | undefined
  for (let at = 0; at < parts.length; at += 1) {
    const part = parts[at]!
    const next = parts[at + 1]
    const index = next !== undefined && /^\d+$/u.test(next) ? Number(next) : null
    if (part === 'stages' && index !== null) {
      stage = definition.stages[index]
      words.push(stage ? stage.name || stage.key : `Stage ${index + 1}`)
      at += 1
    } else if (part === 'actions' && index !== null) {
      const action = stage?.actions[index]
      words.push(action ? action.label || action.key : `action ${index + 1}`)
      at += 1
    } else if (index !== null) {
      words.push(`${part.replace(/s$/u, '')} ${index + 1}`)
      at += 1
    } else if (!/^\d+$/u.test(part)) {
      words.push(part)
    }
  }
  return words.join(' › ')
}
