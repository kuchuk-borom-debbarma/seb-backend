/**
 * A file at a stage, as staff read it: pure shaping, no reads.
 *
 * Kept apart from the controller so what the screen shows and what the guards
 * decide cannot be confused — every function here takes what was already
 * read and already authorised, and only names things. The two questions it
 * does answer, "which actions are offered" and "may this person take them",
 * are the engine's and the session's; this only lays their answers side by
 * side, so the screen and `takeAction` can never disagree.
 */
import type { AnswerValue } from '../../application/form/types'
import type { AuthenticatedUserRequest } from '../../auth/types'
import { holdsPermission, ownsStage } from '../../auth/permissions'
import type { PipelineAction, PipelineDefinition, PipelineInput, PipelineStage } from '../definition'
import { actionIsAvailable, awaitsApplicant, permissionsFor, stageOf, type FileState } from '../engine'
import { actionInputTemplate } from '../inputs'
import { holdsEvery } from '../permissions'
import type { StageActionRecord, StageFile } from '../queries/stage'

/** The file as the engine reads it. */
export const fileStateOf = (file: StageFile): FileState => ({
  stageKey: file.currentStageKey,
  flags: new Set(file.statusFlags),
  recorded: file.recordedValues,
  trail: file.stageTrail,
  answers: file.answers,
})

/** Whether this person may take this action at this file's stage: ownership, then every pair its effects need. */
export const mayTake = (
  session: AuthenticatedUserRequest,
  definition: PipelineDefinition,
  file: Pick<StageFile, 'pipelineId'>,
  stage: PipelineStage,
  action: PipelineAction,
): boolean => ownsStage(session, file.pipelineId, stage.key) && holdsEvery(session, permissionsFor(definition, action))

/** One value as text: paise and counts as digits, a choice as its code. */
const valueText = (value: AnswerValue | undefined): string | null => {
  if (value === undefined || value === null || value === '') return null
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** A choice's option label, for a value that names one. */
const optionLabel = (input: PipelineInput, value: string): string =>
  input.options.find((option) => option.value === value)?.label ?? value

export type ShownValue = { key: string; label: string; type: string; value: string }

/**
 * The officer's inputs as labelled values. Long text is left out unless asked
 * for: the history screen shows it, the audit row never carries it.
 */
export const shownInputs = (
  action: PipelineAction | undefined,
  inputs: Readonly<Record<string, AnswerValue>>,
  options: { longText: boolean },
): ShownValue[] =>
  (action?.inputs ?? []).flatMap((input) => {
    if (input.type === 'STATEMENT' || (input.type === 'LONG_TEXT' && !options.longText)) return []
    const raw = inputs[input.key]
    const text = input.type === 'SINGLE_CHOICE' && typeof raw === 'string'
      ? optionLabel(input, raw)
      : input.type === 'MULTI_CHOICE' && Array.isArray(raw)
        ? raw.map((each) => optionLabel(input, each)).join(', ')
        : valueText(raw)
    return text === null ? [] : [{ key: input.key, label: input.label, type: input.type, value: text }]
  })

/**
 * Recorded values as labelled values, for the office. The applicant's own
 * screen filters by `applicantVisible` in `application/journey.ts`.
 */
export const shownRecorded = (
  definition: PipelineDefinition,
  recorded: Readonly<Record<string, AnswerValue>>,
): ShownValue[] =>
  definition.recordedValues.flatMap((declared) => {
    const text = valueText(recorded[declared.key])
    return text === null ? [] : [{ key: declared.key, label: declared.label, type: declared.type, value: text }]
  })

/** How the audit vocabulary reads a configured type. */
const auditKindOf = (type: string): 'TEXT' | 'MONEY' | 'DATE' | 'COUNT' | 'ENUM' | 'BOOLEAN' =>
  type === 'MONEY_PAISE' ? 'MONEY' : type === 'DATE' ? 'DATE' : type === 'INTEGER' ? 'COUNT' : type === 'BOOLEAN' ? 'BOOLEAN' : 'TEXT'

/** A shown value, bounded for the history. */
export const auditValue = (shown: ShownValue) => ({
  label: shown.label.slice(0, 200),
  kind: auditKindOf(shown.type),
  value: shown.value.length <= 200 ? shown.value : `${shown.value.slice(0, 199)}…`,
})

/** A flag by its office label, falling back to its key when a version no longer declares it. */
export const flagLabel = (definition: PipelineDefinition, key: string): string =>
  definition.statusFlags.find((flag) => flag.key === key)?.label ?? key

export const stageName = (definition: PipelineDefinition, key: string | null): string | null =>
  key === null ? null : stageOf(definition, key)?.name ?? key

/**
 * What each input starts as: the answer or recorded value it names, when that
 * is a value the input can hold. A choice pre-filled with an option the input
 * does not offer would be a control showing something it cannot submit.
 */
const inputDefaults = (action: PipelineAction, file: StageFile): Record<string, AnswerValue> =>
  Object.fromEntries(action.inputs.flatMap((input) => {
    if (!input.defaultFrom) return []
    const source = input.defaultFrom.source === 'ANSWER' ? file.answers : file.recordedValues
    const value = source[input.defaultFrom.key]
    if (value === undefined || value === null) return []
    if (input.type === 'SINGLE_CHOICE' && !input.options.some((option) => option.value === value)) return []
    return [[input.key, value]]
  }))

/** Everything the stage screen shows about one file, for this reader. */
export const stageApplicationView = (
  session: AuthenticatedUserRequest,
  definition: PipelineDefinition,
  file: StageFile,
  history: readonly StageActionRecord[],
) => {
  const stage = stageOf(definition, file.currentStageKey)
  const state = fileStateOf(file)
  const works = stage !== undefined && ownsStage(session, file.pipelineId, stage.key)
  const ended = definition.statusFlags.find((flag) => flag.terminal && state.flags.has(flag.key)) ?? null
  const actionOf = (stageKey: string, actionKey: string) =>
    stageOf(definition, stageKey)?.actions.find((candidate) => candidate.key === actionKey)
  return {
    id: file.id,
    referenceNumber: file.referenceNumber,
    enterpriseName: file.enterpriseName,
    applicantUserId: file.applicantUserId,
    applicationKind: file.applicationKind,
    statusVersion: file.statusVersion,
    pipelineId: file.pipelineId,
    pipelineVersion: file.pipelineVersion,
    stage: stage
      ? { key: stage.key, name: stage.name, description: stage.description, applicantLabel: stage.applicantLabel }
      : null,
    stageEnteredAt: file.stageEnteredAt,
    trail: file.stageTrail.map((key) => ({ key, name: stageName(definition, key) ?? key })),
    flags: file.statusFlags.map((key) => {
      const declared = definition.statusFlags.find((flag) => flag.key === key)
      return {
        key,
        label: declared?.label ?? key,
        applicantLabel: declared?.applicantLabel ?? key,
        kind: declared?.kind ?? 'PROGRESS',
        terminal: declared?.terminal ?? false,
        applicantVisible: declared?.applicantVisible ?? false,
      }
    }),
    recordedValues: shownRecorded(definition, file.recordedValues),
    ended: ended ? { key: ended.key, label: ended.label } : null,
    awaitingApplicant: awaitsApplicant(definition, state.flags),
    openRevisions: file.openRevisions,
    revisionStageKeys: file.formStageKeys,
    worksStage: works,
    canWithdrawRevision: works && file.openRevisions.length > 0
      && holdsPermission(session, 'stage', 'request_revision'),
    actions: (stage?.actions ?? [])
      .filter((action) => actionIsAvailable(definition, action, state))
      .map((action) => ({
        key: action.key,
        label: action.label,
        description: action.description,
        confirmation: action.confirmation,
        inputForm: actionInputTemplate(action),
        defaults: inputDefaults(action, file),
        requestsRevision: action.effects.some((effect) => effect.type === 'REQUEST_REVISION'),
        permitted: mayTake(session, definition, file, stage!, action),
      })),
    history: history.map((entry) => {
      const action = actionOf(entry.stageKey, entry.actionKey)
      return {
        id: entry.id,
        stageKey: entry.stageKey,
        stageName: stageName(definition, entry.stageKey),
        actionKey: entry.actionKey,
        actionLabel: action?.label ?? entry.actionKey,
        toStageKey: entry.toStageKey,
        toStageName: stageName(definition, entry.toStageKey),
        actor: { id: entry.actorUserId, email: entry.actorEmail },
        flagsAdded: entry.flagsAdded.map((key) => flagLabel(definition, key)),
        flagsRemoved: entry.flagsRemoved.map((key) => flagLabel(definition, key)),
        recorded: shownRecorded(definition, entry.recorded),
        inputs: shownInputs(action, entry.inputs, { longText: true }),
        revisionStageKeys: entry.revisionStageKeys,
        selfReviewDisclosed: entry.selfReviewDisclosed,
        createdAt: entry.createdAt,
      }
    }),
  }
}
