/**
 * The three registries a pipeline document is carried out through: what each
 * effect does, how each parameter kind is checked, and where each condition
 * source reads from.
 *
 * Each entry is declared with a `define…('KEY', …)` call in its own file, and
 * each registry is a record keyed by the catalogue's own union, so an entry
 * missing from a registry is a compile error here and a named failure in
 * `check:workflow-catalog`, and an entry the catalogue does not declare is both
 * too. The marker is the literal the check script matches, which is why every
 * registration is a call with the key as its first argument rather than an
 * object literal.
 */
import type { z } from 'zod'
import type { AnswerValue } from '../application/form/types'
import type {
  ConditionSource,
  EffectType,
  InputFieldType,
  ParamKind,
} from '../catalogue/workflow.generated'
import type {
  PipelineAction,
  PipelineDefinition,
  PipelineStage,
} from './definition'

/** A catalogue permission, spelled as the catalogue spells it. */
export type PermissionPair = `${string}:${string}`

/** What one fired effect contributes to an action's outcome. */
export type PlanFragment = {
  /** Where the file goes. At most one fired effect may say. */
  readonly stage?:
    | { readonly kind: 'MOVE'; readonly to: string }
    | { readonly kind: 'RETURN' }
    | { readonly kind: 'END'; readonly flag: string }
  readonly addFlags?: readonly string[]
  readonly removeFlags?: readonly string[]
  readonly recorded?: Readonly<Record<string, AnswerValue>>
  /** The file waits for the applicant, holding this flag, at the same stage. */
  readonly revision?: { readonly flag: string }
  readonly notify?: { readonly message: string; readonly email: boolean }
  readonly internalNote?: string
}

/**
 * Everything an effect may read while planning. Pure data: nothing here
 * reaches the database, so planning is a function of its inputs and can be
 * tested exhaustively.
 */
export type PlanContext = {
  readonly definition: PipelineDefinition
  readonly stage: PipelineStage
  readonly action: PipelineAction
  /** The officer's inputs, already normalized by the form engine. */
  readonly inputs: Readonly<Record<string, AnswerValue>>
  /** The applicant's submitted answers, by key. */
  readonly answers: Readonly<Record<string, AnswerValue>>
  readonly flags: ReadonlySet<string>
  readonly recorded: Readonly<Record<string, AnswerValue>>
  /** The stages the file came through, oldest first; the last is where a return goes. */
  readonly trail: readonly string[]
  /** The cycle's resolved per-application ceiling, or null when none applies. */
  readonly cycleCeilingPaise: number | null
}

/** A plan an effect refused, with the input it refused on when there is one. */
export type PlanRefusal = { readonly refusal: string; readonly inputKey?: string }

export type EffectHandler<S extends z.ZodObject = z.ZodObject> = {
  readonly key: EffectType
  /** The parameters, as a strict schema; compared to the catalogue by test. */
  readonly params: S
  /**
   * Which permissions acting needs. Usually the catalogue's fixed pair; a
   * status effect decides by the flag's kind, because approving something and
   * noting progress are different authorities.
   */
  readonly permissions: (params: z.infer<S>, definition: PipelineDefinition) => readonly PermissionPair[]
  /** Document-level checks beyond the parameter kinds, e.g. every option routed. */
  readonly validate?: (
    params: z.infer<S>,
    scope: { definition: PipelineDefinition; stage: PipelineStage; action: PipelineAction },
  ) => readonly string[]
  readonly plan: (params: z.infer<S>, context: PlanContext) => PlanFragment | PlanRefusal
}

/** Registers an effect. The key is the marker `check:workflow-catalog` matches. */
export const defineEffect = <S extends z.ZodObject>(
  key: EffectType,
  handler: Omit<EffectHandler<S>, 'key'>,
): EffectHandler<S> => ({ key, ...handler })

/** Where a parameter value is checked, and against what it may refer to. */
export type ParamScope = {
  readonly definition?: PipelineDefinition
  readonly action?: PipelineAction
  /** Application kinds a cycle declares, for eligibility parameters. */
  readonly applicationKinds?: ReadonlySet<string>
}

export type ParamKindHandler = {
  readonly key: ParamKind
  readonly schema: z.ZodType
  /** A sentence naming what is wrong, or null. Only called on a value the schema accepted. */
  readonly problem: (value: unknown, scope: ParamScope) => string | null
}

export const defineParamKind = (
  key: ParamKind,
  handler: Omit<ParamKindHandler, 'key'>,
): ParamKindHandler => ({ key, ...handler })

/** A value a condition compares, with the type that says how to read it. */
export type ConditionOperand = { readonly value: AnswerValue | undefined; readonly type: InputFieldType }

/** What a condition source may read from: the same pure context planning uses. */
export type ConditionScope = {
  readonly definition: PipelineDefinition
  readonly answers: Readonly<Record<string, AnswerValue>>
  readonly flags: ReadonlySet<string>
  readonly recorded: Readonly<Record<string, AnswerValue>>
  readonly inputs: Readonly<Record<string, AnswerValue>>
  readonly action: PipelineAction | null
}

export type ConditionSourceHandler = {
  readonly key: ConditionSource
  /**
   * The operand for a key, or null when the key names nothing — which makes
   * the condition false, never true: a condition that cannot be evaluated must
   * not unlock an action.
   */
  readonly read: (key: string, scope: ConditionScope, declaredType: InputFieldType | null) => ConditionOperand | null
}

export const defineConditionSource = (
  key: ConditionSource,
  handler: Omit<ConditionSourceHandler, 'key'>,
): ConditionSourceHandler => ({ key, ...handler })
