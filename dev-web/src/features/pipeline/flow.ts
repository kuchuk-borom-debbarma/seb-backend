/**
 * The shape of a pipeline as a diagram: which stage leads where, and by which
 * action.
 *
 * Read from the effects, never drawn by hand, so the picture cannot disagree
 * with what the draft does. Pure, so the diagram is a function of the document
 * and the layout can be reasoned about without rendering it.
 *
 * - A **move** (`MOVE_TO_STAGE`, each route of `MOVE_BY_CHOICE`) is a solid
 *   edge to its stage.
 * - A **return** (`RETURN_TO_PREVIOUS`) goes to wherever the file actually came
 *   from, which the document cannot know — so it is drawn dashed to every
 *   stage that moves files into this one.
 * - A **revision** (`REQUEST_REVISION`) is a dashed edge to the applicant, who
 *   hands it back to the same stage.
 * - An **ending** (`COMPLETE_PIPELINE`, `CLOSE_APPLICATION`) is an edge to an
 *   end node named by its terminal flag.
 */
import type { PipelineDefinition } from './definition'

export type FlowNode = {
  id: string
  label: string
  kind: 'stage' | 'end' | 'applicant'
  /** Only on stages: whether any route reaches it from where files enter. */
  reachable: boolean
  initial: boolean
  /** Only on end nodes: whether the flag closes rather than completes. */
  closes: boolean
  column: number
  row: number
}

export type FlowEdge = {
  from: string
  to: string
  label: string
  style: 'move' | 'return' | 'revision' | 'end'
}

export type Flow = { nodes: FlowNode[]; edges: FlowEdge[]; columns: number; rows: number }

const APPLICANT = 'applicant'
const endId = (flag: string) => `end:${flag}`

export const flowOf = (definition: PipelineDefinition): Flow => {
  const stageKeys = new Set(definition.stages.map((stage) => stage.key))
  const flagLabel = new Map(definition.statusFlags.map((flag) => [flag.key, flag.label || flag.key]))
  const edges: FlowEdge[] = []
  const endings = new Map<string, boolean>()
  let asksApplicant = false

  for (const stage of definition.stages) {
    for (const action of stage.actions) {
      const input = (key: unknown) => action.inputs.find((each) => each.key === key)
      for (const effect of action.effects) {
        const params = effect.params
        if (effect.type === 'MOVE_TO_STAGE' && typeof params.target === 'string' && stageKeys.has(params.target)) {
          edges.push({ from: stage.key, to: params.target, label: action.label, style: 'move' })
        }
        if (effect.type === 'MOVE_BY_CHOICE' && params.routes && typeof params.routes === 'object') {
          const options = input(params.input)?.options ?? []
          for (const [option, target] of Object.entries(params.routes as Record<string, unknown>)) {
            if (typeof target !== 'string' || !stageKeys.has(target)) continue
            const optionLabel = options.find((each) => each.value === option)?.label ?? option
            edges.push({ from: stage.key, to: target, label: `${action.label}: ${optionLabel}`, style: 'move' })
          }
        }
        if (effect.type === 'REQUEST_REVISION') {
          asksApplicant = true
          edges.push({ from: stage.key, to: APPLICANT, label: action.label, style: 'revision' })
        }
        if ((effect.type === 'COMPLETE_PIPELINE' || effect.type === 'CLOSE_APPLICATION') && typeof params.flag === 'string') {
          endings.set(params.flag, effect.type === 'CLOSE_APPLICATION')
          edges.push({ from: stage.key, to: endId(params.flag), label: action.label, style: 'end' })
        }
      }
    }
  }

  // Returns go back along every forward move into the stage.
  const moves = edges.filter((edge) => edge.style === 'move')
  for (const stage of definition.stages) {
    for (const action of stage.actions) {
      if (!action.effects.some((effect) => effect.type === 'RETURN_TO_PREVIOUS')) continue
      const sources = new Set(moves.filter((edge) => edge.to === stage.key).map((edge) => edge.from))
      for (const source of sources) edges.push({ from: stage.key, to: source, label: action.label, style: 'return' })
    }
  }

  // Columns by the shortest number of moves from the initial stage.
  const depth = new Map<string, number>()
  if (stageKeys.has(definition.initialStageKey)) {
    depth.set(definition.initialStageKey, 0)
    const queue = [definition.initialStageKey]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const edge of moves) {
        if (edge.from !== next || depth.has(edge.to)) continue
        depth.set(edge.to, (depth.get(next) ?? 0) + 1)
        queue.push(edge.to)
      }
    }
  }
  const reachedColumns = depth.size === 0 ? 0 : Math.max(...depth.values()) + 1
  // Stages nothing reaches sit in a column of their own, after the rest.
  const strayColumn = reachedColumns
  const hasStrays = definition.stages.some((stage) => !depth.has(stage.key))
  const endColumn = reachedColumns + (hasStrays ? 1 : 0)

  const rowsIn = new Map<number, number>()
  const place = (column: number) => {
    const row = rowsIn.get(column) ?? 0
    rowsIn.set(column, row + 1)
    return row
  }

  const nodes: FlowNode[] = definition.stages.map((stage) => {
    const column = depth.get(stage.key) ?? strayColumn
    return {
      id: stage.key,
      label: stage.name || stage.key,
      kind: 'stage',
      reachable: depth.has(stage.key),
      initial: stage.key === definition.initialStageKey,
      closes: false,
      column,
      row: place(column),
    }
  })
  for (const [flag, closes] of endings) {
    nodes.push({
      id: endId(flag),
      label: flagLabel.get(flag) ?? flag,
      kind: 'end',
      reachable: true,
      initial: false,
      closes,
      column: endColumn,
      row: place(endColumn),
    })
  }
  if (asksApplicant) {
    // Beneath the initial column: the applicant hands the file back where it was.
    nodes.push({
      id: APPLICANT,
      label: 'Applicant corrects',
      kind: 'applicant',
      reachable: true,
      initial: false,
      closes: false,
      column: 0,
      row: place(0),
    })
  }

  return {
    nodes,
    edges,
    columns: endColumn + (endings.size > 0 ? 1 : 0),
    rows: Math.max(1, ...rowsIn.values()),
  }
}
