/**
 * The shape of a pipeline version's document, as the zod schema every save,
 * publish and load parses it against.
 *
 * This is the *syntax*: which keys exist, which values are well-formed, which
 * lists are bounded. Whether the document makes sense — a stage every other
 * stage can reach, a route for every option, an effect whose parameters name
 * things that exist — is `validate.ts`, because those are questions about the
 * document as a whole, and a schema that tried to answer them would be
 * unreadable.
 *
 * Every vocabulary here comes from the generated catalogue, never from a
 * literal, so a document naming an effect, a field type or a condition source
 * the code does not have fails to parse — at save, at publish, and again when a
 * stored version is loaded, which is what keeps stored configuration honest
 * after a build removes something.
 */
import { z } from 'zod'
import { formConditionOperators, TEMPLATE_KEY_PATTERN } from '../../db/schema'
import {
  conditionSources,
  effectTypes,
  inputFieldTypes,
} from '../catalogue/workflow.generated'

const key = z.string().regex(new RegExp(TEMPLATE_KEY_PATTERN, 'u'))
const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).nullable().default(null)

/**
 * One configured comparison.
 *
 * `group` is the combinator, exactly as in form conditions: conditions sharing
 * a group must all hold, and any group holding is enough. `answerType` is the
 * type the author believes an ANSWER source has; it is checked against the
 * cycle's frozen form when a cycle pins the pipeline, because the pipeline is
 * authored without knowing which forms will use it.
 */
const pipelineCondition = z.strictObject({
  group: z.number().int().min(1).max(16),
  source: z.enum(conditionSources),
  key,
  operator: z.enum(formConditionOperators),
  value: z.string().max(200).nullable().default(null),
  answerType: z.enum(inputFieldTypes).nullable().default(null),
})
export type PipelineCondition = z.infer<typeof pipelineCondition>

const inputOption = z.strictObject({ value: key, label: text(120) })

/**
 * One input an officer fills in when taking an action. A deliberate subset of a
 * form question: the same types and bounds, validated by the same engine, so an
 * amount typed by an officer and an amount typed by an applicant obey one rule.
 */
const pipelineInput = z.strictObject({
  key,
  type: z.enum(inputFieldTypes),
  label: text(160),
  helpText: optionalText(500),
  // Two of the form's three: CONDITIONAL needs REQUIRED_WHEN rules, and an
  // action's input that is required only sometimes is two actions.
  requirement: z.enum(['REQUIRED', 'OPTIONAL']).default('REQUIRED'),
  minLength: z.number().int().min(0).nullable().default(null),
  maxLength: z.number().int().min(1).max(10_000).nullable().default(null),
  minValue: z.number().int().min(0).nullable().default(null),
  maxValue: z.number().int().min(0).nullable().default(null),
  minDate: z.iso.date().nullable().default(null),
  maxDate: z.iso.date().nullable().default(null),
  relativeDateBound: z.enum(['NOT_FUTURE', 'NOT_PAST']).nullable().default(null),
  options: z.array(inputOption).max(50).default([]),
  /** Only INPUT-sourced: an input can depend on another input of the same action. */
  visibleWhen: z.array(pipelineCondition).max(8).default([]),
  /** Pre-fills the input from what the file already says; the officer may change it. */
  defaultFrom: z
    .strictObject({ source: z.enum(['ANSWER', 'RECORDED_VALUE']), key })
    .nullable()
    .default(null),
})
export type PipelineInput = z.infer<typeof pipelineInput>

/** One configured effect. Its parameters are validated by its handler's own schema. */
const pipelineEffect = z.strictObject({
  type: z.enum(effectTypes),
  params: z.record(z.string(), z.unknown()).default({}),
  when: z.array(pipelineCondition).max(8).default([]),
})

const pipelineAction = z.strictObject({
  key,
  label: text(60),
  description: optionalText(300),
  /** Asked before the action is taken, for one that cannot be undone. */
  confirmation: optionalText(300),
  inputs: z.array(pipelineInput).max(20).default([]),
  availableWhen: z.array(pipelineCondition).max(16).default([]),
  effects: z.array(pipelineEffect).min(1).max(10),
})
export type PipelineAction = z.infer<typeof pipelineAction>

const pipelineStage = z.strictObject({
  key,
  name: text(80),
  description: optionalText(500),
  /** What the applicant is told while their file is here. */
  applicantLabel: text(80),
  applicantExplanation: optionalText(400),
  /** Flags held exactly while the file is at this stage, such as BANKING_STAGE. */
  presenceFlags: z.array(key).max(4).default([]),
  actions: z.array(pipelineAction).max(12).default([]),
})
export type PipelineStage = z.infer<typeof pipelineStage>

/**
 * A status flag — the configurable half of an application's status.
 *
 * `terminal` ends the journey: a file holding one sits at no stage and offers
 * no action. `applicantEdit` is the one property that loosens the applicant's
 * lock, and the validator lets only `REQUEST_REVISION` add such a flag and the
 * resubmission write remove it.
 */
const pipelineStatusFlag = z.strictObject({
  key,
  label: text(60),
  applicantLabel: text(60),
  explanation: optionalText(300),
  applicantVisible: z.boolean(),
  kind: z.enum(['PROGRESS', 'OUTCOME']),
  terminal: z.boolean().default(false),
  applicantEdit: z.enum(['NONE', 'REVISION_SCOPED']).default('NONE'),
})
export type PipelineStatusFlag = z.infer<typeof pipelineStatusFlag>

const recordedValueTypes = ['MONEY_PAISE', 'INTEGER', 'DATE', 'TEXT', 'SINGLE_CHOICE'] as const

const pipelineRecordedValue = z.strictObject({
  key,
  label: text(80),
  type: z.enum(recordedValueTypes),
  applicantVisible: z.boolean(),
})

const pipelineDefinition = z.strictObject({
  schema: z.literal(1),
  initialStageKey: key,
  /** Flags a file gains the moment it is submitted, such as IN_REVIEW. */
  onSubmit: z.strictObject({ addFlags: z.array(key).max(8).default([]) }).default({ addFlags: [] }),
  statusFlags: z.array(pipelineStatusFlag).max(32),
  recordedValues: z.array(pipelineRecordedValue).max(16).default([]),
  stages: z.array(pipelineStage).min(1).max(30),
})
export type PipelineDefinition = z.infer<typeof pipelineDefinition>

/** A parsed definition, or the problems that stop it parsing, each at its path. */
export type ParsedDefinition =
  | { ok: true; definition: PipelineDefinition }
  | { ok: false; problems: readonly { path: string; message: string }[] }

export const parseDefinition = (value: unknown): ParsedDefinition => {
  const parsed = pipelineDefinition.safeParse(value)
  if (parsed.success) return { ok: true, definition: parsed.data }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(definition)',
      message: issue.message,
    })),
  }
}
