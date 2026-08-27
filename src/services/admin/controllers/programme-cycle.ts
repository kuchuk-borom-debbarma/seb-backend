/**
 * Authorization and policy validation for the programme-cycle lifecycle.
 *
 * A cycle is the policy an application is judged by, and opening one freezes
 * its rules into every application started while it is open. Validation is
 * therefore strictest before opening; afterwards only the guidance text and the
 * closing time may change, each with a retained reason.
 */
import {
  programmeReasonContexts,
  deskReviewChecks,
  deskReviewIdentifierKinds,
} from '../../../db/schema'
import { formFieldRoles } from '../../../db/schema/seb/form-template'
import { formTemplateProblem } from '../form-template-input'
import { expandGroupDefinitions } from '../group-definitions'
import { decodeAdminCursor, adminPageSize } from '../pagination'
import {
  findExpiredOpenCycles,
  insertProgrammeCycle,
  listProgrammeCycleEvents,
  listProgrammeCycles,
  loadProgrammeCycle,
  programmeCycleCounts,
  reviseOpenProgrammeCycle,
  setDraftCycleDeleted,
  transitionProgrammeCycle,
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

const validatePolicyCollections = (input: ProgrammeCycleInput): string | null => {
  const policy = input.policy
  const identifierRules = policy.identifierRules ?? []
  if (
    !uniqueBy(policy.formTemplate.stages, (stage) => stage.stageKey) ||
    !uniqueBy(policy.formTemplate.fields, (field) => field.fieldKey) ||
    !uniqueBy(policy.requiredAssessmentTypes, (type) => type) ||
    !uniqueBy(identifierRules, (rule) => rule.kind) ||
    !uniqueBy(policy.reasons, (reason) => `${reason.context}:${reason.code}`)
  ) return 'Cycle policy entries must be unique.'
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
  /*
   * A unique index and a CHECK enforce both of these in SQL, which is what makes
   * the outcome correct. These exist to make the refusal *useful*: a constraint
   * violation arrives as "the record changed", which tells somebody editing a
   * cycle form nothing about which row to fix.
   */
  if (identifierRules.some(
    (rule) => !(deskReviewIdentifierKinds as readonly string[]).includes(rule.kind),
  )) {
    return 'The cycle contains an unknown identifier rule.'
  }
  if (identifierRules.some((rule) =>
    rule.requirement === 'REQUIRED_ON_PASS'
      ? !rule.checkType ||
        !(deskReviewChecks as readonly string[]).includes(rule.checkType)
      : Boolean(rule.checkType),
  )) {
    return 'An identifier demanded on a passing check must name that check, and no other may name one.'
  }
  if (policy.reasons.length > 50) return 'A cycle may contain at most 50 reason categories.'
  if (policy.reasons.some((reason) =>
    !/^[A-Z0-9_]{2,64}$/u.test(reason.code) ||
    !normalizeRequiredText(reason.label, 120) ||
    (reason.applicantMessageTemplate?.trim().length ?? 0) > 500,
  )) return 'One or more reason categories are invalid.'
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
  if (policy.expansionWaitMonths !== null &&
      (!Number.isInteger(policy.expansionWaitMonths) || policy.expansionWaitMonths < 1)) {
    return 'Expansion waiting time must be a positive whole number of months.'
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

const openingProblem = (cycle: Awaited<ReturnType<typeof loadProgrammeCycle>>): string | null => {
  if (!cycle) return 'The programme cycle was not found.'
  const version = cycle.version
  /*
   * Named, not counted. The officer who reads "complete every field" reopens
   * the whole form hunting for the blank one; the refusal exists to say which
   * it is.
   */
  const missing = [
    !version.policyReference?.trim() ? 'the policy reference' : null,
    !version.applicantGuidance?.trim() ? 'the guidance for applicants' : null,
    !version.opensAt ? 'the opening date' : null,
    // No closing date is a legitimate opening: the cycle takes applications
    // until somebody closes it. "Change closing time" can still set one.
    version.minimumApplicantAge === null ? 'the minimum applicant age' : null,
    version.maximumApplicantAge === null ? 'the maximum applicant age' : null,
    version.categoryAMaximumMonths === null ? 'the category threshold' : null,
    version.expansionWaitMonths === null ? 'the expansion wait' : null,
    version.majorityOwnershipRequired === null ? 'the ownership rule' : null,
    version.jurisdiction === null ? 'the jurisdiction' : null,
    version.fundingCeilingState === null ? 'the funding ceiling' : null,
  ].filter((field): field is string => field !== null)
  if (missing.length > 0) {
    return `Before this cycle can open, fill in ${listOf(missing)}.`
  }
  /*
   * Every role bound before a cycle can open.
   *
   * The administrative queue, the amount a decision is bounded by, and the
   * eligibility rules all reach their input through a role, and none of them
   * can resolve a key per cycle — the queue filters across all of them at once.
   * A cycle that leaves one unbound describes a form no staff screen could
   * read, so it is refused here rather than discovered later.
   */
  const boundRoles = new Set(cycle.formFields.map((field) => field.role).filter(Boolean))
  if (formFieldRoles.some((role) => !boundRoles.has(role))) {
    return 'Bind every reporting question before opening the cycle.'
  }
  if (cycle.formStages.length === 0 || cycle.formFields.length === 0) {
    return 'Define the questions before opening the cycle.'
  }
  if (cycle.assessmentRules.length === 0) {
    return 'Define the assessment requirements before opening the cycle.'
  }
  const contexts = new Set(cycle.reasons.map((reason) => reason.context))
  if (programmeReasonContexts.some((context) => !contexts.has(context))) {
    return 'Define at least one approved reason for every administrative action.'
  }
  return null
}

export const createProgrammeCycle = async (
  input: ProgrammeCycleInput,
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  // A cycle's policy and form decide who is eligible and for how much — the
  // programme's own rulebook, not casework — so every cycle write in this file
  // is held behind a stronger capability than `STAFF_WRITE`.
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const expanded = withExpandedTemplate(input)
  if (typeof expanded === 'string') return failure(expanded)
  const problem = validateCycleInput(expanded)
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
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const expanded = withExpandedTemplate(input)
  if (typeof expanded === 'string') return failure(expanded)
  const problem = validateCycleInput(expanded)
  if (problem) return failure(problem)
  if (!normalizeRequiredText(input.reason, 500)) return failure('Enter a change reason.')
  const changed = await constraintSafe(() =>
    updateDraftProgrammeCycle(context, expanded, administrator.id, new Date()),
  )
  if (!changed) return failure(STALE_MESSAGE)
  return success((await loadProgrammeCycle(context.db, input.id))!)
}

export const openProgrammeCycle = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  const problem = openingProblem(aggregate)
  if (problem) return failure(problem)
  if (!aggregate || aggregate.head.status !== 'DRAFT' || aggregate.head.deletedAt) {
    return failure('Only an active draft cycle can be opened.')
  }
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
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadProgrammeCycle(context.db, input.id))
}

export const updateOpenCycleGuidance = async (
  input: {
    id: string
    expectedVersion: number
    applicantGuidance: string
    partnerBankGuidance: string
    reason: string
  },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const [guidance, bankGuidance, reason] = [
    normalizeRequiredText(input.applicantGuidance, 5_000),
    normalizeRequiredText(input.partnerBankGuidance, 5_000),
    normalizeRequiredText(input.reason, 500),
  ]
  if (!guidance || !bankGuidance || !reason) {
    return failure('Enter applicant guidance, partner-bank guidance, and a change reason.')
  }
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  if (!aggregate || aggregate.head.status !== 'OPEN') return failure('The cycle is not open.')
  const changed = await constraintSafe(() => reviseOpenProgrammeCycle(context, {
    aggregate,
    expectedVersion: input.expectedVersion,
    applicantGuidance: guidance,
    partnerBankGuidance: bankGuidance,
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
  input: { id: string; expectedVersion: number; closesAt: Date; reason: string },
  context: AdminOperationContext,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
  if (!administrator) return failure(ADMIN_REQUIRED_MESSAGE)
  const reason = normalizeRequiredText(input.reason, 500)
  const now = new Date()
  if (!reason || input.closesAt <= now) return failure('Enter a future closing time and reason.')
  const aggregate = await loadProgrammeCycle(context.db, input.id)
  if (
    !aggregate ||
    aggregate.head.status !== 'OPEN' ||
    !aggregate.head.opensAt ||
    input.closesAt <= aggregate.head.opensAt
  ) return failure('The cycle is not open or the closing time is invalid.')
  const changed = await constraintSafe(() => reviseOpenProgrammeCycle(context, {
    aggregate,
    expectedVersion: input.expectedVersion,
    closesAt: input.closesAt,
    changeType: 'CLOSING_CHANGED',
    reason,
    message: `The application closing time changed to ${input.closesAt.toISOString()}.`,
    action: 'SEB.CYCLE_CLOSING_CHANGED',
    actorUserId: administrator.id,
    now,
  }))
  if (!changed) return failure(STALE_MESSAGE)
  return success(await loadProgrammeCycle(context.db, input.id))
}

const cycleTransition = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
  toStatus: 'CLOSED' | 'ARCHIVED',
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
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
    const counts = await programmeCycleCounts(context.db, input.id)
    const unfinished = new Set([
      'DRAFT', 'SUBMITTED', 'DESK_REVIEW', 'REVISION_REQUIRED',
      'PARTNER_BANK_EVALUATION', 'AWAITING_DECISION', 'APPROVED',
      'SANCTIONED',
    ])
    if (counts.some(({ status, count }) => count > 0 && unfinished.has(status))) {
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

export const closeProgrammeCycle = (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
) => cycleTransition(input, context, 'CLOSED')

export const archiveProgrammeCycle = (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
) => cycleTransition(input, context, 'ARCHIVED')

export const setProgrammeCycleDeleted = async (
  input: { id: string; expectedVersion: number; reason: string },
  context: AdminOperationContext,
  deleted: boolean,
): Promise<AdminResult<unknown>> => {
  const administrator = await currentStaff(context, 'CYCLE_ADMIN')
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
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
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
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  const cycle = await loadProgrammeCycle(context.db, id)
  return cycle ? success(cycle) : failure('The programme cycle was not found.')
}

export const programmeCycleApplicationCounts = async (
  id: string,
  context: AdminOperationContext,
) => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
  return success({ counts: await programmeCycleCounts(context.db, id) })
}

export const programmeCycleEvents = async (
  input: { id: string; first?: number | null },
  context: AdminOperationContext,
) => {
  if (!await currentStaff(context, 'STAFF_READ')) return failure(ADMIN_REQUIRED_MESSAGE)
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
