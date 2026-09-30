/**
 * Authorization and policy validation for the programme-cycle lifecycle.
 *
 * A cycle is the policy an application is judged by, and opening one freezes
 * its rules into every application started while it is open. Validation is
 * therefore strictest before opening; afterwards only the guidance text and the
 * closing time may change, each with a retained reason.
 */
import { eligibilityEvaluators } from '../../application/eligibility'
import { resolveFormTemplate } from '../../application/form/template'
import { authenticatedWithPermission } from '../../auth'
import { holdsPermission } from '../../auth/permissions'
import { parseDefinition } from '../../pipeline/definition'
import { pipelinePinProblems } from '../../pipeline/validate'
import { formTemplateProblem } from '../form-template-input'
import { expandGroupDefinitions } from '../group-definitions'
import { decodeAdminCursor, adminPageSize } from '../pagination'
import { findCyclePolicyDocument } from '../queries/policy-document'
import {
  findExpiredOpenCycles,
  findPipelinePublishedDefinition,
  insertProgrammeCycle,
  listProgrammeCycleEvents,
  listProgrammeCycles,
  loadProgrammeCycle,
  programmeCycleCounts,
  reviseOpenProgrammeCycle,
  setDraftCycleDeleted,
  transitionProgrammeCycle,
  unfinishedApplicationCount,
  updateDraftProgrammeCycle,
} from '../queries/programme-cycle'
import {
  ADMIN_REQUIRED_MESSAGE,
  constraintSafe,
  currentStaff,
  normalizeRequiredText,
  STALE_MESSAGE,
} from '../support'
import { failure, success } from '../../envelope'
import type {
  AdminOperationContext,
  AdminResult,
  ProgrammeCycleInput,
} from '../types'

const uniqueBy = <T, K>(values: T[], key: (value: T) => K): boolean =>
  new Set(values.map(key)).size === values.length

const validateCycleIdentity = (input: ProgrammeCycleInput): string | null => {
  if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/u.test(input.cycleCode)) {
    return 'Cycle code must contain 3–32 uppercase letters, numbers, or hyphens.'
  }
  if (!normalizeRequiredText(input.displayName, 120)) return 'Enter a cycle display name.'
  if (!Number.isInteger(input.cycleYear) || input.cycleYear < 2000 || input.cycleYear > 9999) {
    return 'Enter a valid policy year.'
  }
  if (input.opensAt && input.closesAt && input.closesAt <= input.opensAt) {
    return 'The closing time must be later than the opening time.'
  }
  return null
}

const KEY = /^[A-Z][A-Z0-9_]{1,63}$/u

const validatePolicyCollections = (input: ProgrammeCycleInput): string | null => {
  const policy = input.policy
  const rules = policy.formTemplate.rules ?? []
  if (
    !uniqueBy(policy.formTemplate.stages, (stage) => stage.stageKey) ||
    !uniqueBy(policy.formTemplate.fields, (field) => field.fieldKey) ||
    !uniqueBy(rules, (rule) => rule.ruleKey) ||
    !uniqueBy(policy.applicationKinds, (kind) => kind.kindKey)
  ) return 'Cycle policy entries must be unique.'
  if (!normalizeRequiredText(policy.pipelineId, 128)) {
    return 'Choose the pipeline this cycle\u2019s applications are worked in.'
  }
  /*
   * Refused here so it cannot be authored, and refused again by
   * `resolveFormTemplate` when the rows are read back.
   *
   * The schema catches most of this too, but a constraint violation arrives as
   * "the record changed", which tells somebody editing a cycle nothing about
   * which question to fix. That is the whole reason this layer exists.
   */
  const templateProblem = formTemplateProblem(policy.formTemplate)
  if (templateProblem) return templateProblem
  if (policy.applicationKinds.length > 10) return 'A cycle may accept at most 10 kinds of application.'
  if (policy.applicationKinds.some((kind) =>
    !KEY.test(kind.kindKey) ||
    !normalizeRequiredText(kind.label, 80) ||
    (kind.description?.trim().length ?? 0) > 500 ||
    kind.rules.length > 10,
  )) return 'One or more application kinds are invalid.'
  return kindRuleProblem(policy.applicationKinds)
}

/**
 * Each eligibility rule's parameters, against its evaluator's own schema — the
 * schema the rule is later evaluated with, so a rule saved here can never be
 * one the start operation refuses to read. Keys that name something (a kind,
 * a flag, a pipeline) are checked for shape only: a flag is the pipeline's to
 * declare, and the pipeline may be republished after the cycle is written.
 */
const kindRuleProblem = (kinds: ProgrammeCycleInput['policy']['applicationKinds']): string | null => {
  const kindKeys = new Set(kinds.map((kind) => kind.kindKey))
  for (const kind of kinds) {
    for (const rule of kind.rules) {
      const evaluator = eligibilityEvaluators[rule.ruleType]
      if (!evaluator) return `${kind.kindKey} uses a rule type this build does not know.`
      const parsed = evaluator.params.safeParse(rule.params)
      if (!parsed.success) {
        return `${kind.kindKey}: the ${rule.ruleType} rule\u2019s settings are incomplete or invalid.`
      }
      const named = (parsed.data as { kind?: unknown }).kind
      if (typeof named === 'string' && !kindKeys.has(named)) {
        return `${kind.kindKey}: the ${rule.ruleType} rule names ${named}, which this cycle does not accept.`
      }
      if (JSON.stringify(rule.params).length > 4096) {
        return `${kind.kindKey}: the ${rule.ruleType} rule\u2019s settings are too large.`
      }
    }
  }
  return null
}

const validatePolicyNumbers = (input: ProgrammeCycleInput): string | null => {
  const policy = input.policy
  if (
    policy.minimumApplicantAge !== null &&
    (!Number.isInteger(policy.minimumApplicantAge) || policy.minimumApplicantAge < 0)
  ) return 'Minimum age must be a non-negative whole number.'
  if (
    policy.maximumApplicantAge !== null &&
    (!Number.isInteger(policy.maximumApplicantAge) || policy.maximumApplicantAge < 0)
  ) return 'Maximum age must be a non-negative whole number.'
  if (
    policy.minimumApplicantAge !== null &&
    policy.maximumApplicantAge !== null &&
    policy.maximumApplicantAge < policy.minimumApplicantAge
  ) return 'Maximum age cannot be lower than minimum age.'
  if (policy.categoryAMaximumMonths !== null &&
      (!Number.isInteger(policy.categoryAMaximumMonths) || policy.categoryAMaximumMonths < 0)) {
    return 'Category A month limit must be a non-negative whole number.'
  }
  return null
}

const validateFundingCeiling = (input: ProgrammeCycleInput): string | null => {
  const policy = input.policy
  if (
    policy.fundingCeilingState === 'UNRESOLVED' &&
    (policy.fundingCeilingAmountPaise !== null || policy.fundingCeilingScope !== null)
  ) return 'An unresolved funding ceiling cannot contain an amount or scope.'
  if (
    policy.fundingCeilingState === 'RESOLVED' &&
    (!Number.isSafeInteger(policy.fundingCeilingAmountPaise) ||
      policy.fundingCeilingAmountPaise! <= 0 ||
      policy.fundingCeilingScope === null)
  ) return 'A resolved funding ceiling requires a positive amount and scope.'
  return null
}

/*
 * Structures expand before anything validates: every pass below — uniqueness,
 * the whole-form check, the byte budget — must see the questions the applicant
 * will actually be asked, and those are the expanded ones. The definitions
 * ride along on the template and are stored beside the derived rows, which is
 * what lets the authoring read strip the expansion and show the structure.
 */
const withExpandedTemplate = <T extends ProgrammeCycleInput>(input: T): T | string => {
  const expanded = expandGroupDefinitions(input.policy.formTemplate)
  if (typeof expanded === 'string') return expanded
  return { ...input, policy: { ...input.policy, formTemplate: expanded } }
}

const validateCycleInput = (input: ProgrammeCycleInput): string | null =>
  validateCycleIdentity(input) ??
  validatePolicyCollections(input) ??
  validatePolicyNumbers(input) ??
  validateFundingCeiling(input)

const listOf = (items: readonly string[]): string =>
  items.length === 1
    ? items[0]!
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`

const openingProblem = (
  cycle: Awaited<ReturnType<typeof loadProgrammeCycle>>,
  policyDocument: Awaited<ReturnType<typeof findCyclePolicyDocument>>,
  pipelinePublishedVersion: number | null,
): string | null => {
  if (!cycle) return 'The programme cycle was not found.'
  const version = cycle.version
  /*
   * Named, not counted. The officer who reads "complete every field" reopens
   * the whole form hunting for the blank one; the refusal exists to say which
   * it is.
   */
  const missing = [
    policyDocument === null
      ? 'the policy document (the order or circular this cycle implements)'
      : null,
    !version.applicantGuidance?.trim() ? 'the guidance for applicants' : null,
    !version.opensAt ? 'the opening date' : null,
    // No closing date is a legitimate opening: the cycle takes applications
    // until somebody closes it. "Change closing time" can still set one.
    version.minimumApplicantAge === null ? 'the minimum applicant age' : null,
    version.maximumApplicantAge === null ? 'the maximum applicant age' : null,
    version.categoryAMaximumMonths === null ? 'the category threshold' : null,
    version.majorityOwnershipRequired === null ? 'the ownership rule' : null,
    version.jurisdiction === null ? 'the jurisdiction' : null,
    version.fundingCeilingState === null ? 'the funding ceiling' : null,
  ].filter((field): field is string => field !== null)
  if (missing.length > 0) {
    return `Before this cycle can open, fill in ${listOf(missing)}.`
  }
  /*
   * A document nobody can download must not gate-pass: applicants and staff
   * both fail closed on anything but an ACCEPTED scan, so a cycle opened on a
   * pending or rejected file would publish a link that only ever refuses.
   */
  if (policyDocument !== null && policyDocument.scanStatus === 'PENDING') {
    return 'The policy document is still being checked for malware. '
      + 'Try again in a moment.'
  }
  if (policyDocument !== null && policyDocument.scanStatus !== 'ACCEPTED') {
    return 'The policy document failed its malware check. '
      + 'Upload a clean copy before opening.'
  }
  if (version.closesAt && version.closesAt <= new Date()) {
    return 'This cycle\u2019s closing time has already passed. Move it forward, '
      + 'or remove it, before opening.'
  }
  if (cycle.formStages.length === 0 || cycle.formFields.length === 0) {
    return 'Define the questions before opening the cycle.'
  }
  if (cycle.applicationKinds.length === 0) {
    return 'Define at least one kind of application before opening the cycle.'
  }
  /*
   * Opening pins the pipeline's published version, so a pipeline never
   * published has nothing to pin — and a cycle opened on it could accept an
   * application no stage could ever receive.
   */
  if (pipelinePublishedVersion === null) {
    return 'Publish the cycle\u2019s pipeline before opening the cycle.'
  }
  return null
}

/**
 * The caller, if they may write a cycle **and** choose its pipeline.
 *
 * Choosing a pipeline decides how every application in the cycle is worked,
 * so it needs the authority to read pipelines as well as to write the cycle —
 * somebody who cannot see a route should not be the one sending files down it.
 * One session read answers both pairs.
 */
const cycleAuthor = async (context: AdminOperationContext, action: 'create' | 'update') => {
  const session = action === 'create'
    ? await authenticatedWithPermission(context, 'programme_cycle', 'create')
    : await authenticatedWithPermission(context, 'programme_cycle', 'update')
  return session && holdsPermission(session, 'pipeline', 'read') ? session.user : null
}

/**
 * Why a cycle may not name this pipeline, or null. Only a pipeline with a
 * published version and not retired may be chosen: anything else is one the
 * cycle could never open on, and saying so at the choice beats saying so at
 * the opening.
 */
const pipelineChoiceProblem = async (
  context: AdminOperationContext,
  pipelineId: string,
): Promise<string | null> =>
  (await findPipelinePublishedDefinition(context.db, pipelineId)) === null
    ? 'Choose a pipeline that has been published and has not been retired.'
    : null

export const createProgrammeCycle = async (
  input: ProgrammeCycleInput,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  // A cycle's policy and form decide who is eligible and for how much — the
  // programme's own rulebook, not casework — so cycle writes carry their own
  // permissions, granted separately from anything that works an application.
  const administrator = await cycleAuthor(context, 'create')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const expanded = withExpandedTemplate(input)
  if (typeof expanded === 'string') return failure(expanded)
  const problem = validateCycleInput(expanded)
    ?? await pipelineChoiceProblem(context, expanded.policy.pipelineId)
  if (problem) return failure(problem)
  const id = await constraintSafe(() =>
    insertProgrammeCycle(context, expanded, administrator.id, new Date()),
  )
  if (!id) return failure('The cycle code is already in use or the policy is invalid.')
  // The guarded insert and read use the same D1 request. A successfully
  // returned ID therefore identifies a row that cannot disappear: programme
  // cycles are never hard-deleted.
  return success((await loadProgrammeCycle(context.db, id))!)
}

export const updateDraftProgrammeCycleController = async (
  input: ProgrammeCycleInput & { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await cycleAuthor(context, 'update')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const expanded = withExpandedTemplate(input)
  if (typeof expanded === 'string') return failure(expanded)
  const problem = validateCycleInput(expanded)
    ?? await pipelineChoiceProblem(context, expanded.policy.pipelineId)
  if (problem) return failure(problem)
  if (!normalizeRequiredText(input.reason, 500)) return failure('Enter a change reason.')
  const changed = await constraintSafe(() =>
    updateDraftProgrammeCycle(context, expanded, administrator.id, new Date()),
  )
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadProgrammeCycle(context.db, input.id))!)
}

/**
 * Why this cycle's form cannot carry the pipeline version it would pin, or null.
 *
 * The two are authored apart — a pipeline knows nothing of which forms will
 * use it — so this is where they meet: every answer the pipeline reads must be
 * a top-level question of this form, of the type it expects. Checked at
 * opening because that is when both are frozen; a mismatch found later would
 * be a condition silently never true on the first file that reached it.
 */
const pinningProblem = (
  cycle: NonNullable<Awaited<ReturnType<typeof loadProgrammeCycle>>>,
  definition: unknown,
): string | null => {
  const parsed = parseDefinition(definition)
  // A published version was checked when it was published; failing to parse
  // now means a build removed something it uses, and it must not be pinned.
  if (!parsed.ok) return 'The cycle\u2019s pipeline no longer matches what this system can run. Publish it again.'
  const template = resolveFormTemplate({
    programmeCycleId: cycle.head.id,
    programmeCycleVersion: cycle.head.currentVersion,
    stages: cycle.formStages,
    fields: cycle.formFields,
    options: cycle.formFieldOptions,
    conditions: cycle.formFieldConditions,
  })
  if (!template) return 'The cycle\u2019s questions cannot be read. Fix them before opening.'
  const problems = pipelinePinProblems(parsed.definition, template)
  if (problems.length === 0) return null
  const shown = problems.slice(0, 5).map((problem) => problem.message).join(' ')
  return `This cycle\u2019s questions do not fit its pipeline: ${shown}`
}

export const openProgrammeCycle = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'programme_cycle', 'open')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  const published = aggregate
    ? await findPipelinePublishedDefinition(context.db, aggregate.version.pipelineId)
    : null
  const problem = openingProblem(
    aggregate,
    await findCyclePolicyDocument(context.db, input.id),
    published?.version ?? null,
  )
  if (problem) return failure(problem)
  if (!aggregate || !published || aggregate.head.status !== 'DRAFT' || aggregate.head.deletedAt) {
    return failure('Only an active draft cycle can be opened.')
  }
  const pinProblem = pinningProblem(aggregate, published.definition)
  if (pinProblem) return failure(pinProblem)
  const reason = normalizeRequiredText(input.reason, 500)
  if (!reason) return failure('Enter an opening reason.')
  const changed = await constraintSafe(() => transitionProgrammeCycle(context, {
    aggregate,
    expectedVersion: input.expectedVersion,
    toStatus: 'OPEN',
    changeType: 'OPENED',
    reason,
    message: 'This programme cycle is now published.',
    action: 'SEB.CYCLE_OPENED',
    actorUserId: administrator.id,
    now: new Date(),
    pinnedPipelineVersion: published.version,
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadProgrammeCycle(context.db, input.id))
}

export const updateOpenCycleGuidance = async (
  input: {
    id: string
    expectedVersion: number
    applicantGuidance: string
    reason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'programme_cycle', 'update')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const [guidance, reason] = [
    normalizeRequiredText(input.applicantGuidance, 5_000),
    normalizeRequiredText(input.reason, 500),
  ]
  if (!guidance || !reason) {
    return failure('Enter applicant guidance and a change reason.')
  }
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  if (!aggregate || aggregate.head.status !== 'OPEN') return failure('The cycle is not open.')
  const changed = await constraintSafe(() => reviseOpenProgrammeCycle(context, {
    aggregate,
    expectedVersion: input.expectedVersion,
    applicantGuidance: guidance,
    changeType: 'GUIDANCE_CHANGED',
    reason,
    message: 'Applicant guidance for this cycle changed.',
    action: 'SEB.CYCLE_GUIDANCE_CHANGED',
    actorUserId: administrator.id,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadProgrammeCycle(context.db, input.id))
}

export const changeOpenCycleClosingTime = async (
  // Null removes the closing time: the cycle takes applications until the
  // office closes it, the same open-endedness opening without one allows.
  input: { id: string; expectedVersion: number; closesAt: Date | null; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'programme_cycle', 'update')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 500)
  const now = new Date()
  if (!reason || (input.closesAt !== null && input.closesAt <= now)) {
    return failure('Enter a future closing time and reason.')
  }
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  if (
    !aggregate ||
    aggregate.head.status !== 'OPEN' ||
    !aggregate.head.opensAt ||
    (input.closesAt !== null && input.closesAt <= aggregate.head.opensAt)
  ) return failure('The cycle is not open or the closing time is invalid.')
  const changed = await constraintSafe(() => reviseOpenProgrammeCycle(context, {
    aggregate,
    expectedVersion: input.expectedVersion,
    closesAt: input.closesAt,
    changeType: 'CLOSING_CHANGED',
    reason,
    message: input.closesAt
      ? `The application closing time changed to ${input.closesAt.toISOString()}.`
      : 'The application closing time was removed; the cycle stays open until closed.',
    action: 'SEB.CYCLE_CLOSING_CHANGED',
    actorUserId: administrator.id,
    now,
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadProgrammeCycle(context.db, input.id))
}

/**
 * The half of closing and archiving that is the same, with the half that is not
 * decided by the caller.
 *
 * **The permission is not this helper's to assume, and it does not take one as
 * an argument either.** Closing a cycle and archiving one were one capability
 * when this was written, so naming it here cost nothing; they are separate
 * permissions now, and a helper that chose for itself would hand archive
 * authority to anybody who may close. `docs/rules/code.md` records what that
 * shape did the last time: a shared preamble named `STAFF_READ` for itself and
 * a reviewer could claim an application, with the guard looking present at both
 * call sites and doing its job at neither.
 *
 * The caller resolves its own actor and passes it in, rather than passing the
 * pair down. A pair assembled behind a variable is invisible to
 * `check:catalog`, which asks whether every permission in the catalogue is
 * actually enforced somewhere — and a permission nothing can be shown to
 * enforce is one nobody can audit.
 */
const cycleTransition = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
  toStatus: 'CLOSED' | 'ARCHIVED',
  administrator: { id: string } | null,
): Promise<AdminResult<unknown>> => {
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 500)
  if (!reason) return failure('Enter a transition reason.')
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  if (!aggregate) return failure('The programme cycle was not found.')
  if (toStatus === 'CLOSED' && aggregate.head.status !== 'OPEN') {
    return failure('Only an open cycle can be closed.')
  }
  if (toStatus === 'ARCHIVED') {
    if (aggregate.head.status !== 'CLOSED') return failure('Only a closed cycle can be archived.')
    // Unfinished: a draft, or a file still at a stage of its pipeline.
    if (await unfinishedApplicationCount(context.db, input.id) > 0) {
      return failure('Finish the cycle’s active applications before archiving it.')
    }
  }
  const changed = await constraintSafe(() => transitionProgrammeCycle(context, {
    aggregate,
    expectedVersion: input.expectedVersion,
    toStatus,
    changeType: toStatus === 'CLOSED' ? 'CLOSED' : 'ARCHIVED',
    reason,
    message: toStatus === 'CLOSED'
      ? 'This programme cycle is closed to new applications.'
      : 'This programme cycle was archived.',
    action: toStatus === 'CLOSED' ? 'SEB.CYCLE_CLOSED' : 'SEB.CYCLE_ARCHIVED',
    actorUserId: administrator.id,
    now: new Date(),
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadProgrammeCycle(context.db, input.id))
}

export const closeProgrammeCycle = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
) => cycleTransition(
  input,
  context,
  'CLOSED',
  await currentStaff(context, 'programme_cycle', 'close'),
)

export const archiveProgrammeCycle = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
) => cycleTransition(
  input,
  context,
  'ARCHIVED',
  await currentStaff(context, 'programme_cycle', 'archive'),
)

export const setProgrammeCycleDeleted = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
  deleted: boolean,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'programme_cycle', 'delete')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = deleted ? normalizeRequiredText(input.reason, 500) : null
  if (deleted && !reason) return failure('Enter a deletion reason.')
  const changed = await constraintSafe(() => setDraftCycleDeleted(context, {
    ...input,
    reason,
    deleted,
    actorUserId: administrator.id,
    now: new Date(),
  }))
  if (!changed) return failure('Only an unused draft cycle can be changed this way.')
  return success(await loadProgrammeCycle(context.db, input.id))
}

export const programmeCycles = async (
  input: {
    first?: number | null
    after?: string | null
    includeDeleted?: boolean | null
    status?: Parameters<typeof listProgrammeCycles>[1]['status']
    cycleYear?: number | null
    search?: string | null
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  if (!await currentStaff(context, 'programme_cycle', 'read')) return failure(ADMIN_REQUIRED_MESSAGE)
  const first = adminPageSize(input.first)
  const after = decodeAdminCursor(input.after, 'updatedAt')
  if (!first || after === 'INVALID') return failure('Invalid pagination arguments.')
  // A year is a year. Anything else is a mistake worth naming rather than a
  // filter that silently matches nothing.
  if (input.cycleYear !== null && input.cycleYear !== undefined &&
      (!Number.isInteger(input.cycleYear) || input.cycleYear < 2000 || input.cycleYear > 2100)) {
    return failure('Select a valid programme year.')
  }
  return success(await listProgrammeCycles(context.db, {
    first,
    after,
    includeDeleted: input.includeDeleted === true,
    status: input.status,
    cycleYear: input.cycleYear,
    search: input.search,
  }))
}

export const programmeCycleById = async (id: string, context: AdminOperationContext) => {
  if (!await currentStaff(context, 'programme_cycle', 'read')) return failure(ADMIN_REQUIRED_MESSAGE)
  const cycle = await loadProgrammeCycle(context.db, id)
  return cycle ? success(cycle) : failure('The programme cycle was not found.')
}

export const programmeCycleApplicationCounts = async (
  id: string,
  context: AdminOperationContext,
) => {
  if (!await currentStaff(context, 'programme_cycle', 'read')) return failure(ADMIN_REQUIRED_MESSAGE)
  return success({ counts: await programmeCycleCounts(context.db, id) })
}

export const programmeCycleEvents = async (
  input: { id: string; first?: number | null },
  context: AdminOperationContext,
) => {
  if (!await currentStaff(context, 'programme_cycle', 'read')) return failure(ADMIN_REQUIRED_MESSAGE)
  const first = adminPageSize(input.first)
  if (!first) return failure('Invalid pagination arguments.')
  return success({ events: await listProgrammeCycleEvents(context.db, input.id, first) })
}

/** Cron closes only a bounded set; no request actor is invented. */
export const closeExpiredProgrammeCycles = async (
  context: AdminOperationContext,
): Promise<void> => {
  const expired = await findExpiredOpenCycles(context.db, new Date())
  for (const { id } of expired) {
    // Programme cycles are never hard-deleted, so every ID selected above is
    // still loadable inside this maintenance request.
    const aggregate = (await loadProgrammeCycle(context.db, id))!
    await constraintSafe(() => transitionProgrammeCycle(context, {
      aggregate,
      expectedVersion: aggregate.head.currentVersion,
      toStatus: 'CLOSED',
      changeType: 'CLOSED',
      reason: 'SCHEDULED_CLOSING_TIME_REACHED',
      message: 'This programme cycle is closed to new applications.',
      action: 'SEB.CYCLE_CLOSED',
      actorUserId: null,
      now: new Date(),
    }))
  }
}
