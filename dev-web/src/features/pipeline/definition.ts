/**
 * A pipeline's document, as the editor holds it.
 *
 * The server's zod schema (`src/services/pipeline/definition.ts`) is the
 * authority: every save and publish parses the document again and reports what
 * it refuses at a path. These types are the editor's working copy of that
 * shape, spelled with every default filled in, so a control never has to ask
 * whether a list is absent or empty. What the enums may hold comes from the
 * generated API types, which the catalogue test keeps equal to
 * `workflow.json` — so this file carries no list of its own.
 */
import type {
  PipelineConditionSource,
  PipelineEffectType,
  PipelineInputFieldType,
} from '#/graphql/generated/schema'
import { humanize } from '#/lib/format'

export const CONDITION_OPERATORS = [
  'EQUALS',
  'NOT_EQUALS',
  'GREATER_THAN',
  'GREATER_OR_EQUAL',
  'LESS_THAN',
  'LESS_OR_EQUAL',
  'IS_PRESENT',
  'IS_ABSENT',
] as const
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

/** Operators that compare with nothing: the value box is not drawn for them. */
export const UNARY_OPERATORS: readonly ConditionOperator[] = ['IS_PRESENT', 'IS_ABSENT']

export type PipelineCondition = {
  group: number
  source: PipelineConditionSource
  key: string
  operator: ConditionOperator
  value: string | null
  answerType: PipelineInputFieldType | null
}

export type PipelineInput = {
  key: string
  type: PipelineInputFieldType
  label: string
  helpText: string | null
  requirement: 'REQUIRED' | 'OPTIONAL'
  minLength: number | null
  maxLength: number | null
  minValue: number | null
  maxValue: number | null
  minDate: string | null
  maxDate: string | null
  relativeDateBound: 'NOT_FUTURE' | 'NOT_PAST' | null
  options: { value: string; label: string }[]
  visibleWhen: PipelineCondition[]
  defaultFrom: { source: 'ANSWER' | 'RECORDED_VALUE'; key: string } | null
}

export type PipelineEffect = {
  type: PipelineEffectType
  params: Record<string, unknown>
  when: PipelineCondition[]
}

export type PipelineAction = {
  key: string
  label: string
  description: string | null
  confirmation: string | null
  inputs: PipelineInput[]
  availableWhen: PipelineCondition[]
  effects: PipelineEffect[]
}

export type PipelineStage = {
  key: string
  name: string
  description: string | null
  applicantLabel: string
  applicantExplanation: string | null
  presenceFlags: string[]
  actions: PipelineAction[]
}

export type PipelineStatusFlag = {
  key: string
  label: string
  applicantLabel: string
  explanation: string | null
  applicantVisible: boolean
  kind: 'PROGRESS' | 'OUTCOME'
  terminal: boolean
  applicantEdit: 'NONE' | 'REVISION_SCOPED'
}

export const RECORDED_VALUE_TYPES = ['MONEY_PAISE', 'INTEGER', 'DATE', 'TEXT', 'SINGLE_CHOICE'] as const
export type RecordedValueType = (typeof RECORDED_VALUE_TYPES)[number]

export type PipelineRecordedValue = {
  key: string
  label: string
  type: RecordedValueType
  applicantVisible: boolean
}

export type PipelineDefinition = {
  schema: 1
  initialStageKey: string
  onSubmit: { addFlags: string[] }
  statusFlags: PipelineStatusFlag[]
  recordedValues: PipelineRecordedValue[]
  stages: PipelineStage[]
}

/** The key shape every configured name shares: `SCREAMING_SNAKE_CASE`. */
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u

/** Whatever was typed, as the nearest key: `grant approved` → `GRANT_APPROVED`. */
export const toKey = (text: string): string =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 64)

/** A name nothing else in `taken` uses yet: `STAGE`, `STAGE_2`, `STAGE_3`… */
/**
 * A field or value type as an author reads it. Most read fine humanized;
 * money does not — "Money paise" names the unit it is stored in, while the
 * author types and reads rupees.
 */
export const typeLabel = (type: string): string =>
  type === 'MONEY_PAISE' ? 'Money (₹)' : humanize(type)

/**
 * Whether a flag may be added automatically — on submission, or as a stage's
 * presence flag. Only an ordinary flag may: one that ends the journey is added
 * by a completing or closing effect, and one that hands the applicant the pen
 * only by a revision request. The server refuses the rest; offering them would
 * offer a refusal.
 */
export const isOrdinaryFlag = (flag: { terminal: boolean; applicantEdit: string }): boolean =>
  !flag.terminal && flag.applicantEdit === 'NONE'

export const freshKey = (base: string, taken: readonly string[]): string => {
  if (!taken.includes(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`
    if (!taken.includes(candidate)) return candidate
  }
}

export const blankCondition = (source: PipelineConditionSource = 'ANSWER'): PipelineCondition => ({
  group: 1,
  source,
  key: '',
  operator: source === 'STATUS_FLAG' ? 'IS_PRESENT' : 'EQUALS',
  value: null,
  answerType: source === 'ANSWER' ? 'BOOLEAN' : null,
})

export const blankInput = (key: string): PipelineInput => ({
  key,
  type: 'LONG_TEXT',
  label: 'Note',
  helpText: null,
  requirement: 'REQUIRED',
  minLength: null,
  maxLength: null,
  minValue: null,
  maxValue: null,
  minDate: null,
  maxDate: null,
  relativeDateBound: null,
  options: [],
  visibleWhen: [],
  defaultFrom: null,
})

/**
 * A new action at one stage of a definition.
 *
 * An action needs at least one effect, so it starts with the one most likely
 * to be wanted and valid where it lands. Everywhere but the entry stage that is
 * sending the file back, which names nothing else in the document. At the entry
 * stage a return is always refused — the file came from nowhere — so there it
 * starts by moving the file on to the next stage instead.
 */
export const blankAction = (key: string, definition: PipelineDefinition, stageKey: string): PipelineAction => {
  const onward = definition.stages.find((stage) => stage.key !== stageKey)
  const atEntry = stageKey === definition.initialStageKey
  return {
    key,
    label: 'New action',
    description: null,
    confirmation: null,
    inputs: [],
    availableWhen: [],
    effects: [
      atEntry && onward
        ? { type: 'MOVE_TO_STAGE', params: { target: onward.key }, when: [] }
        : { type: 'RETURN_TO_PREVIOUS', params: {}, when: [] },
    ],
  }
}

export const blankStage = (key: string, name: string): PipelineStage => ({
  key,
  name,
  description: null,
  applicantLabel: name,
  applicantExplanation: null,
  presenceFlags: [],
  actions: [],
})

export const blankFlag = (key: string): PipelineStatusFlag => ({
  key,
  label: 'New status',
  applicantLabel: 'New status',
  explanation: null,
  applicantVisible: true,
  kind: 'PROGRESS',
  terminal: false,
  applicantEdit: 'NONE',
})

export const blankRecordedValue = (key: string): PipelineRecordedValue => ({
  key,
  label: 'New value',
  type: 'MONEY_PAISE',
  applicantVisible: false,
})

/** A document with one stage — what "start empty" means. */
export const emptyDefinition = (): PipelineDefinition => ({
  schema: 1,
  initialStageKey: 'FIRST_REVIEW',
  onSubmit: { addFlags: [] },
  statusFlags: [],
  recordedValues: [],
  stages: [blankStage('FIRST_REVIEW', 'First review')],
})

const listOf = <T>(value: unknown, each: (item: Record<string, unknown>) => T): T[] =>
  Array.isArray(value) ? value.map((item) => each((item ?? {}) as Record<string, unknown>)) : []

const textOr = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null)

const conditionOf = (raw: Record<string, unknown>): PipelineCondition => ({
  group: typeof raw.group === 'number' ? raw.group : 1,
  source: textOr(raw.source, 'ANSWER') as PipelineConditionSource,
  key: textOr(raw.key),
  operator: textOr(raw.operator, 'EQUALS') as ConditionOperator,
  value: textOrNull(raw.value),
  answerType: textOrNull(raw.answerType) as PipelineInputFieldType | null,
})

const inputOf = (raw: Record<string, unknown>): PipelineInput => ({
  key: textOr(raw.key),
  type: textOr(raw.type, 'TEXT') as PipelineInputFieldType,
  label: textOr(raw.label),
  helpText: textOrNull(raw.helpText),
  requirement: raw.requirement === 'OPTIONAL' ? 'OPTIONAL' : 'REQUIRED',
  minLength: numberOrNull(raw.minLength),
  maxLength: numberOrNull(raw.maxLength),
  minValue: numberOrNull(raw.minValue),
  maxValue: numberOrNull(raw.maxValue),
  minDate: textOrNull(raw.minDate),
  maxDate: textOrNull(raw.maxDate),
  relativeDateBound: textOrNull(raw.relativeDateBound) as PipelineInput['relativeDateBound'],
  options: listOf(raw.options, (option) => ({ value: textOr(option.value), label: textOr(option.label) })),
  visibleWhen: listOf(raw.visibleWhen, conditionOf),
  defaultFrom:
    raw.defaultFrom && typeof raw.defaultFrom === 'object'
      ? {
          source: (raw.defaultFrom as Record<string, unknown>).source === 'RECORDED_VALUE' ? 'RECORDED_VALUE' : 'ANSWER',
          key: textOr((raw.defaultFrom as Record<string, unknown>).key),
        }
      : null,
})

/**
 * A stored document as the editor's working copy, every default filled.
 *
 * Tolerant on purpose: a draft that is saved with problems is still a draft
 * the author must be able to open and fix, so a missing list reads as empty
 * rather than refusing to draw the screen. The server's parse is the check.
 */
export const definitionFromJson = (json: string): PipelineDefinition => {
  const raw = JSON.parse(json) as Record<string, unknown>
  return {
    schema: 1,
    initialStageKey: textOr(raw.initialStageKey),
    onSubmit: {
      addFlags: listOf((raw.onSubmit as Record<string, unknown> | undefined)?.addFlags, (flag) => flag as unknown as string)
        .filter((flag): flag is string => typeof flag === 'string'),
    },
    statusFlags: listOf(raw.statusFlags, (flag) => ({
      key: textOr(flag.key),
      label: textOr(flag.label),
      applicantLabel: textOr(flag.applicantLabel),
      explanation: textOrNull(flag.explanation),
      applicantVisible: flag.applicantVisible !== false,
      kind: flag.kind === 'OUTCOME' ? 'OUTCOME' : 'PROGRESS',
      terminal: flag.terminal === true,
      applicantEdit: flag.applicantEdit === 'REVISION_SCOPED' ? 'REVISION_SCOPED' : 'NONE',
    })),
    recordedValues: listOf(raw.recordedValues, (value) => ({
      key: textOr(value.key),
      label: textOr(value.label),
      type: textOr(value.type, 'TEXT') as RecordedValueType,
      applicantVisible: value.applicantVisible === true,
    })),
    stages: listOf(raw.stages, (stage) => ({
      key: textOr(stage.key),
      name: textOr(stage.name),
      description: textOrNull(stage.description),
      applicantLabel: textOr(stage.applicantLabel),
      applicantExplanation: textOrNull(stage.applicantExplanation),
      presenceFlags: Array.isArray(stage.presenceFlags)
        ? stage.presenceFlags.filter((flag): flag is string => typeof flag === 'string')
        : [],
      actions: listOf(stage.actions, (action) => ({
        key: textOr(action.key),
        label: textOr(action.label),
        description: textOrNull(action.description),
        confirmation: textOrNull(action.confirmation),
        inputs: listOf(action.inputs, inputOf),
        availableWhen: listOf(action.availableWhen, conditionOf),
        effects: listOf(action.effects, (effect) => ({
          type: textOr(effect.type, 'RETURN_TO_PREVIOUS') as PipelineEffectType,
          params:
            effect.params && typeof effect.params === 'object' && !Array.isArray(effect.params)
              ? { ...(effect.params as Record<string, unknown>) }
              : {},
          when: listOf(effect.when, conditionOf),
        })),
      })),
    })),
  }
}

/**
 * The document as the API takes it.
 *
 * Optional text left blank is sent as `null` rather than `""`: the server
 * trims and refuses an empty required label, and an empty optional one should
 * read as "none", not as a label of nothing.
 */
export const definitionToJson = (definition: PipelineDefinition): string =>
  JSON.stringify(definition, (key, value: unknown) =>
    ['description', 'confirmation', 'helpText', 'explanation', 'applicantExplanation'].includes(key) &&
    typeof value === 'string' &&
    value.trim() === ''
      ? null
      : value,
  )
