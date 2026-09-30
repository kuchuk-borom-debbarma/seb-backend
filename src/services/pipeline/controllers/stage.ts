/**
 * Working a file at a pipeline stage: what a person works, the files waiting
 * there, one file's state, and taking an action on it.
 *
 * ## Who may do what
 *
 * - **Reading** is `application:read` office-wide, or `stage:read` over the
 *   stages one's roles own plus the files one has acted on (`stage-scope.ts`).
 * - **Acting** needs both halves, always: a role that **owns the stage**, and
 *   every permission the action's **effects** need (`permissionsFor`). The
 *   permission comes from the effect's catalogue entry, never from what the
 *   author called the action, so an approval cannot be made cheaper by naming
 *   it something else. Ownership is what separates two banks' officers who
 *   hold identical permissions.
 *
 * A refusal names no role, and a file outside the reader's scope reads exactly
 * like one that does not exist.
 *
 * ## `takeAction`, in round trips
 *
 * 1. The session: permissions and owned stages, one statement.
 * 2. The file, its pinned document, answers and ceiling: one statement.
 * 3. The write: one data-modifying statement, whatever the number of effects.
 *
 * Refusals are decided in a fixed order between 2 and 3, and nothing is
 * written until every one has passed. Notifications go out after the write has
 * committed and can never undo it.
 */
import { failure, success } from '../../envelope'
import type { ValidationIssue } from '../../application/form/codes'
import type { AnswerValue } from '../../application/form/types'
import { getCurrentSession } from '../../auth'
import { holdsPermission, ownsStage } from '../../auth/permissions'
import type { AuthenticatedUserRequest } from '../../auth/types'
import { auditReason } from '../../audit-vocabulary/fields'
import { insertAuditEvent } from '../../audit-event'
import { bestEffort } from '../../best-effort'
import { sendNotification } from '../../external-notification'
import { adminPageSize, decodeAdminCursor, encodeAdminCursor } from '../../admin/pagination'
import { normalizeRequiredText } from '../../text'
import { parseDefinition, type PipelineAction, type PipelineDefinition, type PipelineStage } from '../definition'
import { actionIsAvailable, planAction, stageOf, type ActionPlan, type FileState } from '../engine'
import { INPUT_STAGE_KEY, validateActionInputs } from '../inputs'
import { pipelineVersionKey } from '../../../loaders'
import {
  findStageFile,
  listStageActions,
  listStageQueue,
  listWorkedStages,
  writeRevisionWithdrawal,
  writeStageAction,
  type StageFile,
} from '../queries/stage'
import { ownedStagePairs, readScopeOf, type ReadScope } from '../queries/stage-scope'
import {
  NOT_FOUND_MESSAGE,
  NOT_PERMITTED_MESSAGE,
  pipelineAudit,
  STALE_MESSAGE,
  type PipelineOperationContext,
  type PipelineResult,
} from '../support'
import {
  auditValue,
  fileStateOf,
  flagLabel,
  mayTake,
  shownInputs,
  shownRecorded,
  stageApplicationView,
  stageName,
} from './stage-view'

const UNREADABLE_PIPELINE = 'This application’s pipeline can no longer be read. Tell the programme office.'
const NOTE_LIMIT = 2_000

/**
 * A pinned document, parsed once for the request and handed to the loader, so
 * any later read in the same request naming the same version costs nothing.
 */
const definitionOf = (context: PipelineOperationContext, file: StageFile): PipelineDefinition | null => {
  const parsed = parseDefinition(file.definition)
  if (!parsed.ok) return null
  context.loaders.pipelineDefinition.prime(pipelineVersionKey(file.pipelineId, file.pipelineVersion), parsed.definition)
  return parsed.definition
}

/**
 * The scope a file is looked up in before acting. Acting needs ownership in
 * any case, so somebody holding no read permission is still looked up among
 * the stages they own rather than refused before the question is asked.
 */
const actingScope = (session: AuthenticatedUserRequest): ReadScope =>
  readScopeOf(session) ?? { kind: 'STAGES', userId: session.user.id, owned: ownedStagePairs(session.ownedStages) }

/* ------------------------------------------------------------------ reads */

/** The stages the caller works, with how many files wait at each. */
export const myStages = async (context: PipelineOperationContext): Promise<PipelineResult<unknown>> => {
  const session = await getCurrentSession(context)
  if (!session || !holdsPermission(session, 'stage', 'read')) return failure(NOT_PERMITTED_MESSAGE)
  const rows = await listWorkedStages(
    context.db,
    session.superAdministrator ? null : ownedStagePairs(session.ownedStages),
  )
  const definitions = await context.loaders.pipelineDefinition.loadMany(
    rows.map((row) => pipelineVersionKey(row.pipelineId, row.version)),
  )
  return success(rows.map((row, index) => {
    const definition = definitions[index]
    const stage = definition && !(definition instanceof Error) ? stageOf(definition, row.stageKey) : undefined
    return {
      pipelineId: row.pipelineId,
      pipelineKey: row.pipelineKey,
      pipelineName: row.pipelineName,
      pipelineVersion: row.version,
      stageKey: row.stageKey,
      stageName: stage?.name ?? row.stageKey,
      waiting: row.waiting,
    }
  }))
}

/** One page of the files at one stage, oldest arrival first. */
export const stageQueue = async (
  input: { pipelineId: string; stageKey: string; flags?: readonly string[] | null; first?: number | null; after?: string | null },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const session = await getCurrentSession(context)
  if (!session) return failure(NOT_PERMITTED_MESSAGE)
  const readsOffice = holdsPermission(session, 'application', 'read')
  const readsStage = holdsPermission(session, 'stage', 'read') && ownsStage(session, input.pipelineId, input.stageKey)
  if (!readsOffice && !readsStage) return failure(NOT_PERMITTED_MESSAGE)
  const first = adminPageSize(input.first)
  const after = decodeAdminCursor(input.after, 'stageEnteredAt')
  if (!first || after === 'INVALID') return failure('Invalid pagination arguments.')
  const flags = [...new Set(input.flags ?? [])]
  if (flags.length > 8) return failure('Filter by at most 8 flags.')
  const page = await listStageQueue(context.db, { ...input, flags, first, after })
  const selected = page.rows.slice(0, first)
  const definitions = await context.loaders.pipelineDefinition.loadMany(
    selected.map((row) => pipelineVersionKey(input.pipelineId, row.pipelineVersion)),
  )
  const last = selected.at(-1)
  return success({
    nodes: selected.map((row, index) => {
      const loaded = definitions[index]
      const definition = loaded && !(loaded instanceof Error) ? loaded : null
      return {
        id: row.id,
        referenceNumber: row.referenceNumber,
        enterpriseName: row.enterpriseName,
        applicationKind: row.applicationKind,
        statusVersion: row.statusVersion,
        stageEnteredAt: row.stageEnteredAt,
        flags: row.statusFlags.map((key) => ({ key, label: definition ? flagLabel(definition, key) : key })),
        recordedValues: definition ? shownRecorded(definition, row.recordedValues) : [],
      }
    }),
    pageInfo: {
      hasNextPage: page.rows.length > first,
      totalCount: page.total,
      endCursor: last ? encodeAdminCursor('stageEnteredAt', last.stageEnteredAt, last.id) : null,
    },
  })
}

/** One file as the stage screen shows it: state, history and the actions offered to this reader. */
export const stageApplication = async (
  applicationId: string,
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const session = await getCurrentSession(context)
  const scope = session ? readScopeOf(session) : null
  if (!session || !scope) return failure(NOT_PERMITTED_MESSAGE)
  const file = await findStageFile(context.db, { applicationId, callerUserId: session.user.id, scope })
  if (!file) return failure(NOT_FOUND_MESSAGE)
  const definition = definitionOf(context, file)
  if (!definition) return failure(UNREADABLE_PIPELINE)
  const history = await listStageActions(context.db, file.id)
  return success(stageApplicationView(session, definition, file, history))
}

/* ----------------------------------------------------------------- writes */

type ActionResult = PipelineResult<unknown> & { issues: ValidationIssue[] }

const refused = (message: string, issues: ValidationIssue[] = []): ActionResult => ({ ...failure(message), issues })

type RevisionInput = { stageKey: string; note: string }

/**
 * The corrections an action asks for, checked against the form this file was
 * filled on, or a refusal. Only an action that hands the file to the applicant
 * may carry them, and such an action must carry at least one: an applicant
 * handed a file with nothing to correct could only resubmit it unchanged.
 */
const revisionsOf = (
  plan: ActionPlan,
  file: StageFile,
  requested: readonly RevisionInput[],
): { revisions: { id: string; stageKey: string; note: string }[] } | { refusal: string } => {
  if (!plan.revisionFlag) {
    return requested.length === 0 ? { revisions: [] } : { refusal: 'This action does not ask the applicant for changes.' }
  }
  if (requested.length === 0) return { refusal: 'Name at least one section of the form for the applicant to correct.' }
  const revisions: { id: string; stageKey: string; note: string }[] = []
  for (const each of requested) {
    if (!file.formStageKeys.includes(each.stageKey)) {
      return { refusal: 'A section named for correction is not part of this application’s form.' }
    }
    if (revisions.some((revision) => revision.stageKey === each.stageKey)) {
      return { refusal: 'Name each section for correction once.' }
    }
    const note = normalizeRequiredText(each.note, NOTE_LIMIT)
    if (!note) return { refusal: `Say what needs correcting in each section, in at most ${NOTE_LIMIT} characters.` }
    revisions.push({ id: crypto.randomUUID(), stageKey: each.stageKey, note })
  }
  return { revisions }
}

/** The file's flags after the plan, in the order they were added: survivors first, then what is new. */
const flagsAfter = (file: StageFile, plan: ActionPlan): string[] => [
  ...file.statusFlags.filter((flag) => !plan.flagsRemoved.includes(flag)),
  ...plan.flagsAdded.filter((flag) => !file.statusFlags.includes(flag)),
]

const trailAfter = (file: StageFile, plan: ActionPlan): string[] =>
  plan.trailOp === 'PUSH'
    ? [...file.stageTrail, plan.fromStageKey]
    : plan.trailOp === 'POP'
      ? file.stageTrail.slice(0, -1)
      : [...file.stageTrail]

/**
 * What the applicant's timeline says about an action: what the pipeline told
 * them, or else where their file now is, in the words written for them.
 */
const timelineMessage = (definition: PipelineDefinition, plan: ActionPlan): string | null => {
  if (plan.notifications.length > 0) return plan.notifications.map((each) => each.message).join('\n\n')
  if (plan.ended) {
    const flag = definition.statusFlags.find((each) => each.key === plan.ended)
    return flag?.applicantVisible ? flag.applicantLabel : null
  }
  if (plan.toStageKey !== null && plan.toStageKey !== plan.fromStageKey) {
    return stageOf(definition, plan.toStageKey)?.applicantLabel ?? null
  }
  return null
}

/**
 * Tells the applicant by email, after the write has landed. A failure is
 * recorded and never surfaces: the action already happened.
 */
const notifyApplicant = async (
  context: PipelineOperationContext,
  input: {
    file: StageFile
    plan: ActionPlan
    revisions: readonly { stageKey: string; note: string }[]
    actionId: string
    actionKey: string
    actorUserId: string
  },
): Promise<boolean> => {
  const messages = input.plan.notifications.filter((each) => each.email).map((each) => each.message)
  if (messages.length === 0) return false
  try {
    // Named as the applicant's form names them; the key is the cycle author's.
    const corrections = input.revisions.map((revision) =>
      `- ${input.file.formStageTitles.get(revision.stageKey) ?? revision.stageKey}: ${revision.note}`)
    await sendNotification({
      to: input.file.applicantEmail,
      subject: 'An update on your Mission SEP application',
      body: [
        ...messages,
        ...(corrections.length > 0 ? ['What to correct:', ...corrections] : []),
        `Reference: ${input.file.referenceNumber ?? input.file.id}`,
      ].join('\n\n'),
    }, context.env)
    return true
  } catch {
    const now = new Date()
    const record = input.revisions.length > 0
      ? pipelineAudit(context, {
          action: 'SEB.REVISION_NOTIFICATION_FAILED',
          entityType: 'SEB_APPLICATION',
          entityId: input.file.id,
          applicationId: input.file.id,
          actorUserId: input.actorUserId,
          outcome: 'FAILURE',
          payload: { stageCount: input.revisions.length },
          now,
        })
      : pipelineAudit(context, {
          action: 'SEB.STAGE_NOTIFICATION_FAILED',
          entityType: 'SEB_APPLICATION_STAGE_ACTION',
          entityId: input.actionId,
          applicationId: input.file.id,
          actorUserId: input.actorUserId,
          outcome: 'FAILURE',
          payload: { stageActionId: input.actionId, actionKey: input.actionKey },
          now,
        })
    await bestEffort(insertAuditEvent(context.db, record), 'A stage notification failed')
    return false
  }
}

export type TakeActionInput = {
  applicationId: string
  expectedStatusVersion: number
  stageKey: string
  actionKey: string
  inputs?: unknown
  revisionRequests?: readonly RevisionInput[] | null
  selfReviewDisclosed?: boolean | null
}

type Actable = {
  file: StageFile
  definition: PipelineDefinition
  stage: PipelineStage
  action: PipelineAction
  state: FileState
  /** Whether the officer is acting on their own application. */
  own: boolean
}

/**
 * The file, and everything about it an action is decided on, or the first
 * refusal in the fixed order: not there, moved on, not offered here, not this
 * person's to take, not available now, their own and unsaid.
 */
const actableFile = async (
  context: PipelineOperationContext,
  session: AuthenticatedUserRequest,
  input: TakeActionInput,
): Promise<Actable | { refusal: string }> => {
  const file = await findStageFile(context.db, {
    applicationId: input.applicationId,
    callerUserId: session.user.id,
    scope: actingScope(session),
  })
  if (!file) return { refusal: NOT_FOUND_MESSAGE }
  const definition = definitionOf(context, file)
  if (!definition) return { refusal: UNREADABLE_PIPELINE }
  // The screen the officer acted from must still be the file's state.
  const stage = file.currentStageKey === input.stageKey && file.statusVersion === input.expectedStatusVersion
    ? stageOf(definition, file.currentStageKey)
    : undefined
  if (!stage) return { refusal: STALE_MESSAGE }
  const action = stage.actions.find((candidate) => candidate.key === input.actionKey)
  if (!action) return { refusal: 'That action is not offered at this stage.' }
  if (!mayTake(session, definition, file, stage, action)) return { refusal: NOT_PERMITTED_MESSAGE }
  const state = fileStateOf(file)
  if (!actionIsAvailable(definition, action, state)) {
    return { refusal: 'That action is not available for this application now.' }
  }
  const own = session.user.id === file.applicantUserId
  if (own && input.selfReviewDisclosed !== true) {
    return { refusal: 'This is your own application. Confirm that you are acting on it to continue.' }
  }
  return { file, definition, stage, action, state, own }
}

type Planned = {
  plan: ActionPlan
  inputs: Readonly<Record<string, AnswerValue>>
  revisions: { id: string; stageKey: string; note: string }[]
}

/**
 * The officer's inputs through the form engine, the effects through the
 * planner, and the corrections checked against the file's own form — or the
 * refusal, with the inputs it names as form-shaped issues.
 */
const plannedAction = (actable: Actable, input: TakeActionInput, now: Date): Planned | ActionResult => {
  const { file, definition, stage, action, state } = actable
  const validated = validateActionInputs(action, input.inputs ?? {}, now)
  if (!validated.ok) return refused('Some of what you entered needs correcting.', [...validated.issues])
  const outcome = planAction({
    definition,
    stage,
    action,
    inputs: validated.values,
    answers: file.answers,
    flags: state.flags,
    recorded: file.recordedValues,
    cycleCeilingPaise: file.ceilingPaise,
    state,
  })
  if (!outcome.ok) {
    return refused(outcome.refusal, outcome.inputKey
      ? [{ stageKey: INPUT_STAGE_KEY, field: outcome.inputKey, code: 'TOO_LARGE', message: outcome.refusal }]
      : [])
  }
  const revised = revisionsOf(outcome.plan, file, input.revisionRequests ?? [])
  if ('refusal' in revised) return refused(revised.refusal)
  return { plan: outcome.plan, inputs: validated.values, revisions: revised.revisions }
}

/**
 * The history's record of the action, and of the officer saying it was their
 * own application when it was. Inputs are labelled values; long text never.
 */
const actionAudits = (
  context: PipelineOperationContext,
  actable: Actable,
  planned: Planned,
  ids: { actionId: string; actorUserId: string; now: Date },
) => {
  const { file, definition, stage, action } = actable
  const { plan } = planned
  const common = {
    entityType: 'SEB_APPLICATION_STAGE_ACTION' as const,
    entityId: ids.actionId,
    applicationId: file.id,
    actorUserId: ids.actorUserId,
    now: ids.now,
  }
  const moved = plan.toStageKey !== null && plan.toStageKey !== stage.key
  const taken = pipelineAudit(context, {
    ...common,
    action: 'SEB.STAGE_ACTION_TAKEN',
    payload: {
      pipelineKey: file.pipelineKey,
      pipelineVersion: file.pipelineVersion,
      stageKey: stage.key,
      stageName: stage.name,
      actionKey: action.key,
      actionLabel: action.label,
      ...(moved ? { toStageKey: plan.toStageKey!, toStageName: stageName(definition, plan.toStageKey) ?? plan.toStageKey! } : {}),
      ...(plan.ended ? { ended: flagLabel(definition, plan.ended) } : {}),
      flagsAdded: plan.flagsAdded.map((key) => flagLabel(definition, key)),
      flagsRemoved: plan.flagsRemoved.map((key) => flagLabel(definition, key)),
      recorded: shownRecorded(definition, plan.recorded).map(auditValue),
      inputs: shownInputs(action, planned.inputs, { longText: false }).map(auditValue),
      revisionStageCount: planned.revisions.length,
      notified: plan.notifications.some((each) => each.email),
    },
  })
  if (!actable.own) return [taken]
  return [taken, pipelineAudit(context, {
    ...common,
    action: 'SEB.SELF_REVIEW_DISCLOSED',
    payload: { stageKey: stage.key, actionKey: action.key },
  })]
}

/** Takes one configured action on one file. */
export const takeStageAction = async (
  input: TakeActionInput,
  context: PipelineOperationContext,
): Promise<ActionResult> => {
  const session = await getCurrentSession(context)
  if (!session) return refused(NOT_PERMITTED_MESSAGE)
  const actable = await actableFile(context, session, input)
  if ('refusal' in actable) return refused(actable.refusal)
  const now = new Date()
  const planned = plannedAction(actable, input, now)
  if ('success' in planned) return planned
  const { file, definition, stage, action } = actable
  const { plan } = planned
  const actionId = crypto.randomUUID()
  const flags = flagsAfter(file, plan)
  const landed = await writeStageAction(context.db, {
    file,
    actionId,
    actionKey: action.key,
    actorUserId: session.user.id,
    now,
    toStageKey: plan.toStageKey,
    moved: plan.toStageKey !== null && plan.toStageKey !== stage.key,
    trail: trailAfter(file, plan),
    flags,
    recorded: plan.recorded,
    flagsAdded: plan.flagsAdded,
    flagsRemoved: plan.flagsRemoved,
    inputs: planned.inputs,
    revisions: planned.revisions,
    notes: plan.internalNotes.map((note) => ({ id: crypto.randomUUID(), note: note.slice(0, 5_000) })),
    selfReviewDisclosed: actable.own,
    timelineMessage: timelineMessage(definition, plan),
    audits: actionAudits(context, actable, planned, { actionId, actorUserId: session.user.id, now }),
  })
  if (!landed) return refused(STALE_MESSAGE)

  await notifyApplicant(context, {
    file,
    plan,
    revisions: planned.revisions,
    actionId,
    actionKey: action.key,
    actorUserId: session.user.id,
  })
  return {
    ...success({
      applicationId: file.id,
      stageActionId: actionId,
      statusVersion: file.statusVersion + 1,
      stageKey: plan.toStageKey,
      flags,
      ended: plan.ended !== null,
    }),
    issues: [],
  }
}

/**
 * Withdraws a correction asked for in error. When it was the last one open,
 * the flag that handed the file to the applicant goes with it, and the file is
 * the office's to work again — at the same stage, which never changed.
 */
export const withdrawRevision = async (
  input: { applicationId: string; expectedStatusVersion: number; revisionRequestId: string; reason: string },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const session = await getCurrentSession(context)
  if (!session) return failure(NOT_PERMITTED_MESSAGE)
  const file = await findStageFile(context.db, {
    applicationId: input.applicationId,
    callerUserId: session.user.id,
    scope: actingScope(session),
  })
  if (!file) return failure(NOT_FOUND_MESSAGE)
  const definition = definitionOf(context, file)
  if (!definition) return failure(UNREADABLE_PIPELINE)
  if (file.statusVersion !== input.expectedStatusVersion || file.currentStageKey === null) return failure(STALE_MESSAGE)
  if (!ownsStage(session, file.pipelineId, file.currentStageKey) || !holdsPermission(session, 'stage', 'request_revision')) {
    return failure(NOT_PERMITTED_MESSAGE)
  }
  const request = file.openRevisions.find((each) => each.id === input.revisionRequestId)
  if (!request) return failure('That correction request is not open.')
  const reason = normalizeRequiredText(input.reason, 500)
  if (!reason) return failure('Say why the correction is no longer needed, in at most 500 characters.')
  const stillOpen = file.openRevisions.length - 1
  const editing = new Set(definition.statusFlags.filter((flag) => flag.applicantEdit !== 'NONE').map((flag) => flag.key))
  const flags = stillOpen > 0 ? file.statusFlags : file.statusFlags.filter((flag) => !editing.has(flag))
  const now = new Date()
  const landed = await writeRevisionWithdrawal(context.db, {
    file,
    revisionRequestId: request.id,
    stageKey: request.stageKey,
    reason,
    flags,
    actorUserId: session.user.id,
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.REVISION_CANCELLED',
      entityType: 'SEB_APPLICATION',
      entityId: file.id,
      applicationId: file.id,
      actorUserId: session.user.id,
      now,
      payload: { revisionRequestId: request.id, reason: auditReason(reason) },
    }),
  })
  if (!landed) return failure(STALE_MESSAGE)
  return success({ applicationId: file.id, statusVersion: file.statusVersion + 1, flags, openRevisionCount: stillOpen })
}
