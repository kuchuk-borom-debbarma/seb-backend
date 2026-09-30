/**
 * Authoring pipelines: reading them, drafting and publishing versions,
 * retiring them, and deciding which roles work each stage.
 *
 * Every operation here is behind the `pipeline` resource, asked with a literal
 * pair so `check:catalog` sees each act enforced by name. The session is read
 * once per request — `authenticatedWithPermission` returns it with the
 * caller's permissions and owned stages — and the owner ceiling is answered
 * from that same read.
 *
 * What a draft may *say* is `definition.ts` (syntax) and `validate.ts`
 * (meaning). This module decides only who may change what, when, and records
 * it. A draft may be saved while it still has problems — authors build a route
 * over several sittings — but it may be published only when it has none, and
 * the problems are checked against the exact revision being published.
 */
import { authenticatedWithPermission } from '../../auth'
import { ownsStage, withinAuthority } from '../../auth/permissions'
import { findRolesByKeys } from '../../auth/queries/roles'
import { auditReason } from '../../audit-vocabulary/fields'
import { constraintSafe } from '../../constraints'
import { failure, success } from '../../envelope'
import { normalizeOptionalText, normalizeRequiredText } from '../../text'
import {
  conditionSources,
  effectCatalogue,
  eligibilityCatalogue,
  formRuleCatalogue,
  inputFieldTypes,
  paramKinds,
  workflowDescriptions,
} from '../../catalogue/workflow.generated'
import { parseDefinition, type PipelineDefinition } from '../definition'
import { examplePipeline } from '../example'
import {
  createPipelineWrite,
  discardDraftWrite,
  findPipelineById,
  findPipelineByKey,
  findPipelineDraft,
  findPipelineStage,
  findPipelineVersion,
  listPipelines,
  listPipelineStages,
  listPipelineVersions,
  listPublishedChoices,
  publishDraftWrite,
  retirePipelineWrite,
  saveDraftWrite,
  setStageOwnersWrite,
  startPipelineDraftWrite,
  type PipelineHead,
} from '../queries/authoring'
import {
  NOT_FOUND_MESSAGE,
  NOT_PERMITTED_MESSAGE,
  pipelineAudit,
  STALE_MESSAGE,
  type PipelineOperationContext,
  type PipelineResult,
} from '../support'
import { pipelineProblems, type PipelineProblem } from '../validate'

/**
 * The largest document the API accepts: 48 KB of JSON text.
 *
 * Set by the transport, not the table. The whole GraphQL request is capped at
 * 64 KB before anything is parsed, and the document arrives as an escaped
 * string inside it beside the rest of the request, so a bound any higher could
 * only ever be met by the transport's refusal, with no word about which part
 * was too large. The table's 256 KB CHECK stays as the storage backstop. The
 * worked example is about 13 KB, so this leaves room for a route several times
 * its size.
 */
const DEFINITION_MAX_BYTES = 48 * 1_024

const KEY = /^[A-Z][A-Z0-9_]{1,63}$/u

/** The most problems a refusal message lists; `validateDraft` returns them all. */
const PROBLEMS_IN_A_MESSAGE = 5

/**
 * The document a pipeline started from nothing begins as: one stage and no
 * actions. It parses, so it can be saved and opened in the editor; it has
 * problems — nothing leaves the stage, nothing ends the journey — so it cannot
 * be published until the author has built a route.
 */
const blankDefinition = (): PipelineDefinition => ({
  schema: 1,
  initialStageKey: 'FIRST_STAGE',
  onSubmit: { addFlags: [] },
  statusFlags: [],
  recordedValues: [],
  stages: [{
    key: 'FIRST_STAGE',
    name: 'First stage',
    description: null,
    applicantLabel: 'Under review',
    applicantExplanation: null,
    presenceFlags: [],
    actions: [],
  }],
})

const stageKeysOf = (definition: PipelineDefinition): string =>
  JSON.stringify([...new Set(definition.stages.map((stage) => stage.key))])

const problemsMessage = (lead: string, problems: readonly PipelineProblem[]): string => {
  const shown = problems.slice(0, PROBLEMS_IN_A_MESSAGE).map((problem) => `${problem.path}: ${problem.message}`)
  const more = problems.length > PROBLEMS_IN_A_MESSAGE ? ` (and ${problems.length - PROBLEMS_IN_A_MESSAGE} more)` : ''
  return `${lead} ${shown.join('; ')}${more}`
}

/**
 * A submitted document as JSON text, parsed for its syntax.
 *
 * Text rather than the API's `JSON` scalar, which is bounded to the answer
 * map's one level of nesting; a pipeline is a tree, bounded by
 * {@link DEFINITION_MAX_BYTES} instead.
 */
const readDocument = (text: string): { ok: true; definition: PipelineDefinition; value: unknown } | { ok: false; problems: PipelineProblem[] } => {
  if (new TextEncoder().encode(text).length > DEFINITION_MAX_BYTES) {
    return { ok: false, problems: [{ path: '(definition)', message: 'The pipeline is larger than 48 KB.' }] }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, problems: [{ path: '(definition)', message: 'The pipeline is not valid JSON.' }] }
  }
  const parsed = parseDefinition(value)
  return parsed.ok ? { ok: true, definition: parsed.definition, value } : { ok: false, problems: [...parsed.problems] }
}

/** How the audit rows name a pipeline: by key and by its name at the time. */
const named = (head: PipelineHead) => ({ pipelineKey: head.key, pipelineName: head.name })

/* ------------------------------------------------------------------ reads */

/** Every pipeline, with whether it has a draft and which version cycles may pin. */
export const pipelines = async (context: PipelineOperationContext): Promise<PipelineResult<unknown[]>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'read')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const rows = await listPipelines(context.db)
  return success(rows.map((row) => ({ ...row.head, draftVersion: row.draftVersion })))
}

/**
 * One pipeline as its editor needs it: identity, versions, the draft with its
 * problems, the published document, and every stage with its live owners.
 *
 * Four statements whatever the pipeline's size. The draft's problems are
 * computed here rather than stored, so a build that tightens a rule shows the
 * new problem on the next read without a migration.
 */
const pipelineDetail = async (db: PipelineOperationContext['db'], head: PipelineHead) => {
  // Sequential on purpose: one connection serves a request, so issuing these
  // together would queue them on it anyway.
  const versions = await listPipelineVersions(db, head.id)
  const draft = await findPipelineDraft(db, head.id)
  const stages = await listPipelineStages(db, head.id)
  const published = head.currentPublishedVersion === null
    ? null
    : await findPipelineVersion(db, head.id, head.currentPublishedVersion)
  return {
    ...head,
    versions,
    draft: draft && {
      ...draft,
      definitionJson: JSON.stringify(draft.definition),
      problems: pipelineProblems(draft.definition),
    },
    published: published && { ...published, definitionJson: JSON.stringify(published.definition) },
    stages,
  }
}

export const pipelineByKey = async (
  key: string,
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'read')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const head = await findPipelineByKey(context.db, key)
  if (!head) return failure(NOT_FOUND_MESSAGE)
  return success(await pipelineDetail(context.db, head))
}

/**
 * Every problem with a document, without saving it — what the editor's
 * "Check" runs, and what a publish would refuse with.
 */
export const validatePipelineDraft = async (
  definition: string,
  context: PipelineOperationContext,
): Promise<PipelineResult<{ problems: PipelineProblem[] }>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'read')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const document = readDocument(definition)
  return success({ problems: document.ok ? pipelineProblems(document.value) : document.problems })
}

/**
 * The vocabulary an author may use, straight from the workflow catalogue, and
 * the shipped example to start from.
 *
 * Served rather than compiled into the client so the editor can never offer an
 * effect, a parameter kind or a rule this build does not carry out.
 */
export const pipelineCatalogue = async (context: PipelineOperationContext): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'read')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const described = (family: string, keys: readonly string[]) =>
    keys.map((key) => ({ key, description: workflowDescriptions[`${family}.${key}`] ?? '' }))
  return success({
    effects: Object.entries(effectCatalogue).map(([key, entry]) => ({ key, ...entry })),
    inputFieldTypes: described('inputFieldTypes', inputFieldTypes),
    conditionSources: described('conditionSources', conditionSources),
    paramKinds: described('paramKinds', paramKinds),
    formRules: Object.entries(formRuleCatalogue).map(([key, entry]) => ({ key, ...entry })),
    eligibilityRules: Object.entries(eligibilityCatalogue).map(([key, entry]) => ({ key, ...entry })),
    exampleDefinitionJson: JSON.stringify(examplePipeline),
  })
}

/** The pipelines a cycle may choose: published, and not retired. */
export const publishedPipelineChoices = async (
  context: PipelineOperationContext,
): Promise<PipelineResult<PipelineHead[]>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'read')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  return success(await listPublishedChoices(context.db))
}

/* ----------------------------------------------------------------- writes */

/** Re-reads the pipeline after a write, for the response. */
const detailAfter = async (context: PipelineOperationContext, pipelineId: string) => {
  const head = await findPipelineById(context.db, pipelineId)
  return head ? success(await pipelineDetail(context.db, head)) : failure(NOT_FOUND_MESSAGE)
}

export const createPipeline = async (
  input: { key: string; name: string; description?: string | null; startFromExample?: boolean | null },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'create')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const key = input.key.trim()
  if (!KEY.test(key)) {
    return failure('A pipeline key is 2–64 capital letters, digits or underscores, starting with a letter.')
  }
  const name = normalizeRequiredText(input.name, 120)
  if (!name) return failure('Name the pipeline, in at most 120 characters.')
  const description = normalizeOptionalText(input.description, 1000)
  if (description === 'INVALID') return failure('A description is at most 1000 characters.')

  const definition = input.startFromExample ? examplePipeline : blankDefinition()
  const id = crypto.randomUUID()
  const now = new Date()
  const created = await constraintSafe(() => createPipelineWrite(context.db, {
    id,
    key,
    name,
    description: description ?? '',
    draftId: crypto.randomUUID(),
    definitionJson: JSON.stringify(definition),
    stageKeysJson: stageKeysOf(definition),
    actorUserId: actor.user.id,
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.PIPELINE_CREATED',
      entityType: 'SEB_PIPELINE',
      entityId: id,
      actorUserId: actor.user.id,
      payload: { pipelineKey: key, pipelineName: name },
      now,
    }),
  }))
  if (!created) return failure('That pipeline key is already in use.')
  return detailAfter(context, id)
}

/**
 * Saves the whole draft document, or starts the next draft.
 *
 * `expectedRevision: 0` means "there is no draft; start one" — what the editor
 * sends after a publish, when it shows the published document for editing. Any
 * other number is the revision of the draft being replaced.
 *
 * A document that does not parse is refused; one that parses but has problems
 * is saved, and the problems come back with it, so an author can keep a route
 * half-built between sittings.
 */
export const savePipelineDraft = async (
  input: { pipelineId: string; expectedRevision: number; definition: string },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'update')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const head = await findPipelineById(context.db, input.pipelineId)
  if (!head) return failure(NOT_FOUND_MESSAGE)
  if (head.retiredAt) return failure('This pipeline is retired, so it can no longer change.')
  const document = readDocument(input.definition)
  if (!document.ok) return failure(problemsMessage('The pipeline could not be read:', document.problems))

  const now = new Date()
  const definitionJson = JSON.stringify(document.definition)
  const stageKeysJson = stageKeysOf(document.definition)
  const stageCount = document.definition.stages.length

  if (input.expectedRevision === 0) {
    const versions = await listPipelineVersions(context.db, head.id)
    if (versions.some((version) => version.status === 'DRAFT')) return failure(STALE_MESSAGE)
    const version = (versions[0]?.version ?? 0) + 1
    const started = await constraintSafe(() => startPipelineDraftWrite(context.db, {
      pipelineId: head.id,
      draftId: crypto.randomUUID(),
      version,
      definitionJson,
      stageKeysJson,
      actorUserId: actor.user.id,
      now,
      audit: pipelineAudit(context, {
        action: 'SEB.PIPELINE_DRAFT_SAVED',
        entityType: 'SEB_PIPELINE',
        entityId: head.id,
        actorUserId: actor.user.id,
        payload: { ...named(head), version, revision: 1, stageCount },
        now,
      }),
    }))
    return started ? detailAfter(context, head.id) : failure(STALE_MESSAGE)
  }

  const draft = await findPipelineDraft(context.db, head.id)
  if (!draft || draft.revision !== input.expectedRevision) return failure(STALE_MESSAGE)
  const saved = await constraintSafe(() => saveDraftWrite(context.db, {
    pipelineId: head.id,
    version: draft.version,
    expectedRevision: input.expectedRevision,
    definitionJson,
    stageKeysJson,
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.PIPELINE_DRAFT_SAVED',
      entityType: 'SEB_PIPELINE',
      entityId: head.id,
      actorUserId: actor.user.id,
      payload: { ...named(head), version: draft.version, revision: input.expectedRevision + 1, stageCount },
      now,
    }),
  }))
  return saved ? detailAfter(context, head.id) : failure(STALE_MESSAGE)
}

/**
 * Publishes the draft at the revision the author validated.
 *
 * Every problem is listed at once, the way a form's problems are. The check
 * runs on the stored document at `expectedRevision`, and the write is guarded
 * by the same revision, so what was checked is what goes live.
 */
export const publishPipelineDraft = async (
  input: { pipelineId: string; expectedRevision: number; changeNote?: string | null },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'publish')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const head = await findPipelineById(context.db, input.pipelineId)
  if (!head) return failure(NOT_FOUND_MESSAGE)
  if (head.retiredAt) return failure('This pipeline is retired, so it can no longer change.')
  const changeNote = normalizeOptionalText(input.changeNote, 500)
  if (changeNote === 'INVALID') return failure('A change note is at most 500 characters.')
  const draft = await findPipelineDraft(context.db, head.id)
  if (!draft || draft.revision !== input.expectedRevision) return failure(STALE_MESSAGE)
  const problems = pipelineProblems(draft.definition)
  if (problems.length > 0) {
    return failure(problemsMessage('This pipeline cannot be published yet:', problems))
  }
  const parsed = parseDefinition(draft.definition)
  // `pipelineProblems` parsed it already; this only narrows the type.
  if (!parsed.ok) return failure(problemsMessage('This pipeline cannot be published yet:', parsed.problems))

  const now = new Date()
  const published = await constraintSafe(() => publishDraftWrite(context.db, {
    pipelineId: head.id,
    version: draft.version,
    expectedRevision: input.expectedRevision,
    actorUserId: actor.user.id,
    changeNote,
    stageKeysJson: stageKeysOf(parsed.definition),
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.PIPELINE_PUBLISHED',
      entityType: 'SEB_PIPELINE',
      entityId: head.id,
      actorUserId: actor.user.id,
      payload: {
        ...named(head),
        version: draft.version,
        ...(changeNote ? { changeNote: auditReason(changeNote) } : {}),
      },
      now,
    }),
  }))
  return published ? detailAfter(context, head.id) : failure(STALE_MESSAGE)
}

export const discardPipelineDraft = async (
  input: { pipelineId: string; expectedRevision: number },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'update')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const head = await findPipelineById(context.db, input.pipelineId)
  if (!head) return failure(NOT_FOUND_MESSAGE)
  const draft = await findPipelineDraft(context.db, head.id)
  if (!draft || draft.revision !== input.expectedRevision) return failure(STALE_MESSAGE)
  const now = new Date()
  const discarded = await discardDraftWrite(context.db, {
    pipelineId: head.id,
    version: draft.version,
    expectedRevision: input.expectedRevision,
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.PIPELINE_DRAFT_DISCARDED',
      entityType: 'SEB_PIPELINE',
      entityId: head.id,
      actorUserId: actor.user.id,
      payload: { ...named(head), version: draft.version },
      now,
    }),
  })
  return discarded ? detailAfter(context, head.id) : failure(STALE_MESSAGE)
}

export const retirePipeline = async (
  input: { pipelineId: string; reason: string },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'retire')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 1000)
  if (!reason) return failure('Say why the pipeline is being retired.')
  const head = await findPipelineById(context.db, input.pipelineId)
  if (!head) return failure(NOT_FOUND_MESSAGE)
  if (head.retiredAt) return failure('This pipeline is already retired.')
  const now = new Date()
  const retired = await retirePipelineWrite(context.db, {
    pipelineId: head.id,
    actorUserId: actor.user.id,
    reason,
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.PIPELINE_RETIRED',
      entityType: 'SEB_PIPELINE',
      entityId: head.id,
      actorUserId: actor.user.id,
      payload: { ...named(head), reason: auditReason(reason) },
      now,
    }),
  })
  return retired ? detailAfter(context, head.id) : failure(STALE_MESSAGE)
}

/**
 * Replaces the roles that work one stage.
 *
 * **The assign ceiling.** Attaching a role to a stage hands everybody holding
 * it the authority to act there, so it is the dangerous act in this module, and
 * it is bounded the way an invitation is: every role added *or removed* must
 * be one the caller could offer — its permissions within theirs — and the
 * caller must work the stage themselves. Removal is bounded too, because taking
 * a stage away from a role above you is still deciding that role's work. A
 * super administrator passes both, as with every ceiling.
 *
 * One refusal for every role beyond the ceiling, naming none of them, for the
 * reason `ADMIN_REQUIRED_MESSAGE` names none.
 */
export const setPipelineStageOwners = async (
  input: { pipelineId: string; stageKey: string; expectedOwnersVersion: number; roleKeys: readonly string[]; reason: string },
  context: PipelineOperationContext,
): Promise<PipelineResult<unknown>> => {
  const actor = await authenticatedWithPermission(context, 'pipeline', 'assign')
  if (!actor) return failure(NOT_PERMITTED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 1000)
  if (!reason) return failure('Say why who works this stage is changing.')
  const wanted = [...new Set(input.roleKeys.map((key) => key.trim()))]
  if (wanted.length > 32) return failure('A stage may be worked by at most 32 roles.')
  const head = await findPipelineById(context.db, input.pipelineId)
  if (!head) return failure(NOT_FOUND_MESSAGE)
  const stage = await findPipelineStage(context.db, head.id, input.stageKey)
  if (!stage) return failure(NOT_FOUND_MESSAGE)
  if (!ownsStage(actor, head.id, stage.stageKey)) return failure(NOT_PERMITTED_MESSAGE)
  if (stage.ownersVersion !== input.expectedOwnersVersion) return failure(STALE_MESSAGE)

  const current = new Set(stage.owners.map((owner) => owner.roleKey))
  const addedKeys = wanted.filter((key) => !current.has(key))
  const removedKeys = [...current].filter((key) => !wanted.includes(key))
  if (addedKeys.length === 0 && removedKeys.length === 0) {
    return failure('Those are already the roles that work this stage.')
  }
  const roles = await findRolesByKeys(context.db, [...addedKeys, ...removedKeys])
  const byKey = new Map(roles.map((role) => [role.key, role]))
  const unknown = addedKeys.filter((key) => !byKey.has(key))
  if (unknown.length > 0) return failure(`No role is called ${unknown.join(', ')}.`)
  // A removed role that has since been retired is still removable: it is
  // closed here by id from the owner row, whatever became of the role.
  const removedIds = stage.owners.filter((owner) => removedKeys.includes(owner.roleKey)).map((owner) => owner.roleId)
  const beyond = [...addedKeys, ...removedKeys].some((key) => {
    const role = byKey.get(key)
    return role !== undefined && !withinAuthority(actor, role.permissions)
  })
  if (beyond) return failure(NOT_PERMITTED_MESSAGE)

  const now = new Date()
  const changed = await constraintSafe(() => setStageOwnersWrite(context.db, {
    pipelineId: head.id,
    stageKey: stage.stageKey,
    expectedOwnersVersion: input.expectedOwnersVersion,
    addedJson: JSON.stringify(addedKeys.map((key) => ({ id: crypto.randomUUID(), role_id: byKey.get(key)!.id }))),
    removedJson: JSON.stringify(removedIds),
    actorUserId: actor.user.id,
    reason,
    now,
    audit: pipelineAudit(context, {
      action: 'SEB.PIPELINE_STAGE_OWNERS_CHANGED',
      entityType: 'SEB_PIPELINE_STAGE',
      entityId: `${head.id}/${stage.stageKey}`,
      actorUserId: actor.user.id,
      payload: {
        ...named(head),
        stageKey: stage.stageKey,
        rolesAdded: addedKeys,
        rolesRemoved: removedKeys,
        reason: auditReason(reason),
      },
      now,
    }),
  }))
  return changed ? detailAfter(context, head.id) : failure(STALE_MESSAGE)
}
