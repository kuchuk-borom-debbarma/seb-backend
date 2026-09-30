/**
 * Deciding what an action does, as a pure function of the file and the
 * officer's inputs.
 *
 * Nothing here reads or writes the database. The controller gathers the file's
 * state in one read, this decides, and the query writes the decision in one
 * guarded statement — so every rule below can be tested without a database,
 * and a decision made here is the only thing the write can do.
 *
 * Three rules hold whatever a pipeline is configured to say:
 *
 * 1. **A file is at one stage, or none.** At most one fired effect may move it,
 *    and moving and waiting for the applicant are exclusive.
 * 2. **A return goes where the file came from** — the last stage of its own
 *    trail, never a stage chosen by configuration.
 * 3. **Presence flags follow the stage.** A stage's presence flags are added
 *    when the file arrives and removed when it leaves, so "at a bank" can never
 *    outlive the file being at one.
 */
import { compareValue, holdsGroups } from '../application/form/conditions'
import type { AnswerValue } from '../application/form/types'
import { conditionSourceHandlers } from './condition-sources'
import type {
  PipelineAction,
  PipelineCondition,
  PipelineDefinition,
  PipelineStage,
} from './definition'
import { effectHandler } from './effects'
import type { ConditionScope, PermissionPair, PlanContext, PlanFragment, PlanRefusal } from './registry'

/** A file's state, as the engine reads it. */
export type FileState = {
  readonly stageKey: string | null
  readonly flags: ReadonlySet<string>
  readonly recorded: Readonly<Record<string, AnswerValue>>
  readonly trail: readonly string[]
  readonly answers: Readonly<Record<string, AnswerValue>>
}

/** Whether a set of conditions holds. An empty set always holds. */
export const conditionsHold = (conditions: readonly PipelineCondition[], scope: ConditionScope): boolean =>
  conditions.length === 0 ||
  holdsGroups(
    conditions.map((condition) => ({ ...condition, groupNumber: condition.group })),
    (condition) => {
      const operand = conditionSourceHandlers[condition.source].read(condition.key, scope, condition.answerType)
      return operand !== null && compareValue(condition.operator, operand.value, condition.value, { type: operand.type })
    },
  )

/** Whether the file holds a flag that has handed it to the applicant. */
export const awaitsApplicant = (definition: PipelineDefinition, flags: ReadonlySet<string>): boolean =>
  definition.statusFlags.some((flag) => flag.applicantEdit !== 'NONE' && flags.has(flag.key))

export const stageOf = (definition: PipelineDefinition, key: string | null): PipelineStage | undefined =>
  key === null ? undefined : definition.stages.find((stage) => stage.key === key)

/** Every permission an action needs: the union of what its effects need. */
export const permissionsFor = (definition: PipelineDefinition, action: PipelineAction): PermissionPair[] =>
  [...new Set(action.effects.flatMap((effect) =>
    effectHandler(effect.type).permissions(effectHandler(effect.type).params.parse(effect.params), definition),
  ))].sort()

/** Whether the file may be offered this action now, before any input. */
export const actionIsAvailable = (
  definition: PipelineDefinition,
  action: PipelineAction,
  state: FileState,
): boolean => {
  if (state.stageKey === null) return false
  // A file waiting on the applicant is theirs until they resubmit; the office
  // may withdraw the request, which is not a configured action.
  if (awaitsApplicant(definition, state.flags)) return false
  return conditionsHold(action.availableWhen, {
    definition,
    answers: state.answers,
    flags: state.flags,
    recorded: state.recorded,
    inputs: {},
    action,
  })
}

/** What taking an action will do, merged from every effect that fired. */
export type ActionPlan = {
  readonly fromStageKey: string
  /** Where the file ends up; null when the action ended the journey. */
  readonly toStageKey: string | null
  readonly trailOp: 'PUSH' | 'POP' | 'NONE'
  /** The terminal flag the journey ended with, when it ended. */
  readonly ended: string | null
  readonly flagsAdded: readonly string[]
  readonly flagsRemoved: readonly string[]
  /** The file's full flag set afterwards, sorted. */
  readonly flags: readonly string[]
  readonly recorded: Readonly<Record<string, AnswerValue>>
  /** The flag held while the applicant corrects the file, when revision was asked. */
  readonly revisionFlag: string | null
  readonly notifications: readonly { message: string; email: boolean }[]
  readonly internalNotes: readonly string[]
}

export type PlanOutcome =
  | { ok: true; plan: ActionPlan }
  | { ok: false; refusal: string; inputKey?: string }

/** Every fired effect's fragment, in order, or the first refusal among them. */
const firedFragments = (
  action: PipelineAction,
  scope: ConditionScope,
  planContext: PlanContext,
): PlanFragment[] | PlanRefusal => {
  const fragments: PlanFragment[] = []
  for (const effect of action.effects) {
    if (!conditionsHold(effect.when, scope)) continue
    const handler = effectHandler(effect.type)
    const fragment = handler.plan(handler.params.parse(effect.params), planContext)
    if ('refusal' in fragment) return fragment
    fragments.push(fragment)
  }
  return fragments
}

type Destination = Pick<ActionPlan, 'toStageKey' | 'trailOp' | 'ended'>

/** Where the one fired move — if any — sends the file, or why it cannot go there. */
const destinationOf = (
  move: PlanFragment['stage'],
  stage: PipelineStage,
  trail: readonly string[],
): Destination | PlanRefusal => {
  if (move?.kind === 'MOVE') return { toStageKey: move.to, trailOp: 'PUSH', ended: null }
  if (move?.kind === 'END') return { toStageKey: null, trailOp: 'NONE', ended: move.flag }
  if (move?.kind === 'RETURN') {
    const back = trail.at(-1)
    return back === undefined
      ? { refusal: 'This application has no earlier stage to return to.' }
      : { toStageKey: back, trailOp: 'POP', ended: null }
  }
  return { toStageKey: stage.key, trailOp: 'NONE', ended: null }
}

/**
 * The flags the action adds and removes. Leaving a stage takes its presence
 * flags with it and arriving adds the next's; a flag both added and removed
 * ends up removed.
 */
const flagChanges = (
  definition: PipelineDefinition,
  stage: PipelineStage,
  fragments: readonly PlanFragment[],
  destination: Destination,
  revisionFlag: string | null,
): { added: Set<string>; removed: Set<string> } => {
  const added = new Set(fragments.flatMap((fragment) => fragment.addFlags ?? []))
  const removed = new Set(fragments.flatMap((fragment) => fragment.removeFlags ?? []))
  if (destination.ended) added.add(destination.ended)
  if (revisionFlag) added.add(revisionFlag)
  if (destination.toStageKey !== stage.key) {
    for (const flag of stage.presenceFlags) removed.add(flag)
    for (const flag of stageOf(definition, destination.toStageKey)?.presenceFlags ?? []) added.add(flag)
  }
  for (const flag of removed) added.delete(flag)
  return { added, removed }
}

/**
 * Plans one action. Returns a refusal — never a partial plan — when any fired
 * effect refuses or when the fired effects together break a rule above.
 */
export const planAction = (
  context: Omit<PlanContext, 'trail'> & { readonly state: FileState },
): PlanOutcome => {
  const { definition, stage, action, inputs, state } = context
  const scope: ConditionScope = {
    definition,
    answers: state.answers,
    flags: state.flags,
    recorded: state.recorded,
    inputs,
    action,
  }
  const fragments = firedFragments(action, scope, { ...context, trail: state.trail })
  if (!Array.isArray(fragments)) return { ok: false, ...fragments }

  const moves = fragments.flatMap((fragment) => (fragment.stage ? [fragment.stage] : []))
  const revisions = fragments.flatMap((fragment) => (fragment.revision ? [fragment.revision] : []))
  // Validation refused these shapes when the pipeline was published; checked
  // again on what actually fired, because conditional effects can combine in
  // ways a static check sees only as possibilities.
  if (moves.length > 1 || revisions.length > 1 || (moves.length > 0 && revisions.length > 0)) {
    return { ok: false, refusal: 'This action is configured to do two incompatible things at once.' }
  }

  const destination = destinationOf(moves[0], stage, state.trail)
  if ('refusal' in destination) return { ok: false, ...destination }
  const revisionFlag = revisions[0]?.flag ?? null
  const { added, removed } = flagChanges(definition, stage, fragments, destination, revisionFlag)

  const flags = new Set(state.flags)
  for (const flag of removed) flags.delete(flag)
  for (const flag of added) flags.add(flag)

  return {
    ok: true,
    plan: {
      fromStageKey: stage.key,
      ...destination,
      flagsAdded: [...added].filter((flag) => !state.flags.has(flag)).sort(),
      flagsRemoved: [...removed].filter((flag) => state.flags.has(flag)).sort(),
      flags: [...flags].sort(),
      recorded: Object.assign({}, ...fragments.map((fragment) => fragment.recorded ?? {})),
      revisionFlag,
      notifications: fragments.flatMap((fragment) => (fragment.notify ? [fragment.notify] : [])),
      internalNotes: fragments.flatMap((fragment) => (fragment.internalNote ? [fragment.internalNote] : [])),
    },
  }
}
