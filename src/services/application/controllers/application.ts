/** Applicant application, validation, expansion, and submission use cases. */
import { auditActions, applicationStatuses } from '../../../db/schema'
import { decodeCursor, pageSize } from '../pagination'
import {
  findEnterpriseFacts,
  evaluateExpansionEligibility,
  expansionClaimFromAward,
  findApplicationVersion,
  findEnterpriseApplicationSource,
  findExpansionAwardForApplication,
  findLatestSubmittedVersion,
  findOpenProgrammeCycle,
  findProgrammeCycleIdentity,
  findDownloadablePolicyDocument,
  findSubmissionPolicy,
  findUserEmailById,
  findDraftChanges,
  findOwnedApplicationHead,
  insertApplicationAggregate,
  listActiveDocumentFieldKeys,
  listApplicationTimeline,
  listApplicantProgrammeCycles,
  listAvailableProgrammeCycles,
  listOpenRevisionStageKeys,
  listOwnedApplications,
  loadOwnedApplication,
  saveApplicationSnapshot,
  setApplicationDeleted,
  snapshotRecordToPublic,
  submitApplicationSnapshot,
} from '../queries/application'
import {
  AUTH_REQUIRED_MESSAGE,
  auditRecord,
  completeGuardedOperation,
  currentApplicant,
  firstValidationIssueMessage,
  requireInvariant,
  runConstraintRetry,
  runConstraintSafe,
} from '../support'
import { failure, success } from '../../envelope'
import { bestEffort } from '../../best-effort'
import {
  APPLICATION_NOT_FOUND_MESSAGE,
  applicantForVersionedWrite,
  ownedApplication,
  ownedApplicationAtVersion,
} from '../ownership'
import { applicationStatusGuide } from '../status-guide'
import type { ValidationReport } from '../form/engine'
/*
 * Re-exported because `applicationFormTemplate` and `validateApplication` below
 * return them: a caller holding either result and unable to name its type would
 * have a value it cannot take apart.
 */
/*
 * Re-exported so a caller can name what `applicationFormTemplate` and
 * `validateApplication` return. Both are the engine's own types; declaring them
 * here instead would be a second copy of the vocabulary, so the two functions
 * carry a suppression rather than this module carrying a duplicate.
 */
export type { ResolvedFormTemplate } from '../form/types'
export type { ValidationReport } from '../form/engine'
import type { AnswerMap, AnswerValue, ResolvedFormTemplate } from '../form/types'
import type {
  Application,
  ApplicationOperationContext,
  ApplicationSection,
  ApplicationStatus,
  ApplicationStatusGuideEntry,
  ApplicationSummary,
  ApplicationType,
  Connection,
  DownloadAuthorization,
  ExpansionClaim,
  ExpansionEligibility,
  ProgrammeCycle,
  SebResult,
  TimelineEvent,
} from '../types'
import { storage } from '../../storage'
import { changedStageKeys, pruneHidden } from '../form/answers'
import {
  normalizeAnswers,
  requiredDocumentFieldKeys,
  applicationCategoryOf,
  validateAnswersForSubmission,
} from '../form/engine'
import {
  answersFromRows,
  answersToRows,
  findAnswerRows,
  findPinnedCycleRules,
  findPinnedRulesForApplication,
} from '../queries/form-template'
import { ROLE_CANONICAL_KEY } from '../../../db/schema'
import { confirmationPdfUrl } from '../confirmation-link'
import { sendNotification } from '../../external-notification'
import { createAuditEvent } from '../../auth/queries/auth'

const EMPTY_EXPANSION_CLAIM: ExpansionClaim = {
  priorSanctionOrderNumber: null,
  priorSanctionDate: null,
  priorNetDisbursedAmountPaise: null,
  continuousOperationMonths: null,
}

export const availableProgrammeCycles = async (
  context: ApplicationOperationContext,
): Promise<SebResult<{ cycles: ProgrammeCycle[] }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  return success({ cycles: await listAvailableProgrammeCycles(context.db, new Date()) })
}

/**
 * Every cycle this applicant has work in, including closed and archived ones.
 *
 * The client renders these read-only. Offering "start application" is driven by
 * `availableProgrammeCycles` alone, so a closed cycle can never carry one.
 */
export const myProgrammeCycles = async (
  context: ApplicationOperationContext,
): Promise<SebResult<{ cycles: ProgrammeCycle[] }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  return success({ cycles: await listApplicantProgrammeCycles(context.db, applicant.id) })
}

/**
 * A short-lived download URL for a cycle's published policy PDF.
 *
 * Fetched on click rather than embedded in the cycle read, because the URL
 * expires in minutes and a cached query would serve dead links. Fails closed
 * for draft or deleted cycles and for any file whose scan is not ACCEPTED.
 */
export const cyclePolicyDocumentDownloadUrl = async (
  cycleId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<DownloadAuthorization>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const document = await findDownloadablePolicyDocument(context.db, cycleId)
  if (!document) return failure('The policy document is not available.')
  return success(
    await storage(context.env, context.requestUrl).authorizeDownload(
      document.r2ObjectKey,
      document.originalFilename,
      new Date(),
    ),
  )
}

export const myApplications = async (
  input: {
    first?: number | null
    after?: string | null
    enterpriseId?: string | null
    status?: ApplicationStatus | null
    programmeCycleId?: string | null
    applicationType?: ApplicationType | null
    search?: string | null
    includeDeleted?: boolean | null
  },
  context: ApplicationOperationContext,
): Promise<SebResult<Connection<ApplicationSummary>>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const first = pageSize(input.first)
  const cursor = decodeCursor(input.after, 'updatedAt')
  if (first === null || cursor === 'INVALID') return failure('Invalid pagination input.')
  if (input.status && !applicationStatuses.includes(input.status)) {
    return failure('Select a valid application status.')
  }
  return success(
    await listOwnedApplications(context.db, {
      userId: applicant.id,
      first,
      cursor,
      enterpriseId: input.enterpriseId,
      status: input.status,
      programmeCycleId: input.programmeCycleId,
      applicationType: input.applicationType,
      search: input.search,
      includeDeleted: input.includeDeleted === true,
    }),
  )
}

export const applicationById = async (
  id: string,
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const application = await loadOwnedApplication(context.db, applicant.id, id, true)
  return application ? success(application) : failure('The application was not found.')
}

export const expansionEligibility = async (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<ExpansionEligibility>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const now = new Date()
  const [source, cycle] = await Promise.all([
    findEnterpriseApplicationSource(context.db, applicant.id, input.enterpriseId),
    findOpenProgrammeCycle(context.db, input.programmeCycleId, now),
  ])
  if (!source) return failure('The enterprise was not found or its funding case is not open.')
  if (!cycle) return failure('The programme cycle is not open.')
  const evaluated = await evaluateExpansionEligibility(
    context.db,
    source.fundingCase.id,
    now,
    undefined,
    cycle.id,
  )
  return success(evaluated.result)
}

const startApplication = async (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
  expansion: boolean,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const now = new Date()
  const [source, cycle] = await Promise.all([
    findEnterpriseApplicationSource(context.db, applicant.id, input.enterpriseId),
    findOpenProgrammeCycle(context.db, input.programmeCycleId, now),
  ])
  if (!source) return failure('The enterprise was not found or its funding case is not open.')
  if (!cycle) return failure('The programme cycle is not open.')

  let phaseNumber = 1
  let qualifyingAwardId: string | null = null
  let qualifyingReleaseAt: Date | null = null
  let expansionClaim = EMPTY_EXPANSION_CLAIM
  if (expansion) {
    const evaluated = await evaluateExpansionEligibility(
      context.db,
      source.fundingCase.id,
      now,
      undefined,
      cycle.id,
    )
    if (!evaluated.result.eligible || !evaluated.award || !evaluated.result.nextPhaseNumber) {
      return failure('The enterprise is not currently eligible for an expansion application.')
    }
    phaseNumber = evaluated.result.nextPhaseNumber
    qualifyingAwardId = evaluated.award.awardId
    qualifyingReleaseAt = evaluated.award.firstReleaseAt
    expansionClaim = expansionClaimFromAward(evaluated.award, now)
  }

  /*
   * The cycle's form, resolved before anything is written.
   *
   * A cycle whose template does not resolve cannot take an application at all:
   * the draft would exist with no questions, and the applicant would be told
   * nothing about why. Refused here rather than at the first save.
   */
  const rules = await findPinnedCycleRules(context.db, cycle.id, cycle.currentVersion)
  if (!rules) return failure('This programme cycle has no application form yet.')

  const applicationId = crypto.randomUUID()
  const inserted = await runConstraintSafe(() =>
    insertApplicationAggregate(context.db, {
      applicationId,
      applicantUserId: applicant.id,
      enterpriseId: source.enterprise.id,
      fundingCaseId: source.fundingCase.id,
      programmeCycleId: cycle.id,
      programmeCycleVersion: cycle.currentVersion,
      applicationType: expansion ? 'EXPANSION' : 'INITIAL',
      phaseNumber,
      /*
       * Empty. Nothing is prefilled any more: the enterprise facts stopped
       * being answers when the entity became their single home, and the two
       * remaining roles — an owner's date of birth and the requested amount —
       * are things only the applicant can say.
       */
      answerRows: [],
      expansionClaim,
      qualifyingAwardId,
      qualifyingReleaseAt,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: auditActions.applicationStarted,
        entityType: 'SEB_APPLICATION',
        entityId: applicationId,
        metadata: { type: expansion ? 'EXPANSION' : 'INITIAL', phaseNumber },
        now,
      }),
    }),
  )
  if (!inserted) {
    return failure(
      'This enterprise already has a live application for this funding phase. '
      + 'One live application per phase, whichever cycle it is in — a new '
      + 'attempt becomes possible if that one is rejected or cancelled.',
    )
  }
  return success(requireInvariant(
    await loadOwnedApplication(context.db, applicant.id, applicationId),
    'Created application could not be read.',
  ))
}

export const startInitialApplication = (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => startApplication(input, context, false)

export const startExpansionApplication = (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => startApplication(input, context, true)

/**
 * The stages a revision may change, or null when this save is out of scope.
 *
 * A revision reopens named stages and nothing else, so every stage outside the
 * open set must be identical to what was submitted. This is the same
 * `changedStageKeys` the applicant's own review screen and the administrative
 * workspace use — it was once a second implementation with a `Date` branch the
 * other did not have, which is exactly how two answers to "did this change"
 * come to disagree.
 */
const revisionChangesAreAllowed = async (
  context: ApplicationOperationContext,
  application: Application,
  template: ResolvedFormTemplate,
  answers: AnswerMap,
): Promise<Set<ApplicationSection> | null> => {
  const [submitted, openStageKeys] = await Promise.all([
    findLatestSubmittedVersion(context.db, application.id),
    listOpenRevisionStageKeys(context.db, application.id),
  ])
  if (!submitted || openStageKeys.size === 0) return null
  const submittedAnswers = answersFromRows(
    template,
    submitted.id,
    await findAnswerRows(context.db, [submitted.id]),
  )
  const changed = changedStageKeys(template, submittedAnswers, answers)
  return changed.every((stageKey) => openStageKeys.has(stageKey)) ? openStageKeys : null
}

const expansionEvidenceForHead = async (
  context: ApplicationOperationContext,
  application: Application,
  now: Date,
): Promise<{
  claim: ExpansionClaim
  qualifyingAwardId: string | null
  qualifyingReleaseAt: Date | null
} | null> => {
  if (application.applicationType === 'INITIAL') {
    return {
      claim: EMPTY_EXPANSION_CLAIM,
      qualifyingAwardId: null,
      qualifyingReleaseAt: null,
    }
  }
  const award = await findExpansionAwardForApplication(context.db, application.id)
  return award
    ? {
        claim: expansionClaimFromAward(award, now),
        qualifyingAwardId: award.awardId,
        qualifyingReleaseAt: award.firstReleaseAt,
      }
    : null
}

export const saveApplicationDraft = async (
  input: {
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    /** Whatever the client sent. Untyped on purpose — see `normalizeAnswers`. */
    answers: unknown
  },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => {
  const authorized = await ownedApplicationAtVersion(input, context)
  if ('refusal' in authorized) return authorized.refusal
  const applicant = { id: authorized.applicantId }
  const application = authorized.application
  if (application.status !== 'DRAFT' && application.status !== 'REVISION_REQUIRED') {
    return failure('The application cannot be edited in its current status.')
  }
  /*
   * Resolved once, and everything downstream reads this object: the normaliser,
   * the revision-scope diff, the equality check and the rows that get written.
   * Resolving it twice is how a save and its validation come to disagree about
   * what the form is.
   */
  const rules = await findPinnedRulesForApplication(
    context.db, application.id, application.currentVersion,
  )
  if (!rules) return failure('The form this application was filled against could not be read.')

  const normalized = normalizeAnswers(rules.template, input.answers, new Date())
  if (!normalized.value || normalized.issues.length > 0) {
    return failure(firstValidationIssueMessage(
      normalized.issues,
      'The draft contains invalid values.',
    ))
  }
  /*
   * A hidden question's answer is cleared on the way in, not merely ignored.
   * Left in place it would be stored, shown to a reviewer, and read as though
   * somebody had been asked for it.
   */
  const answers = pruneHidden(rules.template, normalized.value)

  const revisionStageKeys = application.status === 'REVISION_REQUIRED'
    ? await revisionChangesAreAllowed(context, application, rules.template, answers)
    : undefined
  if (application.status === 'REVISION_REQUIRED' && !revisionStageKeys) {
    return failure('Only stages requested for revision may be changed.')
  }
  // Nothing changed, so nothing is versioned. An autosave that stores an
  // identical version on every keystroke makes the history useless.
  if (changedStageKeys(rules.template, application.answers, answers).length === 0) {
    return success(application)
  }
  const now = new Date()
  const expansionEvidence = await expansionEvidenceForHead(context, application, now)
  if (!expansionEvidence) return failure('The qualifying award is no longer valid.')
  const currentVersionRecord = await findApplicationVersion(
    context.db,
    application.id,
    application.currentVersion,
  )
  const readableVersion = requireInvariant(currentVersionRecord, 'Application version is missing.')
  const saved = await runConstraintSafe(() => saveApplicationSnapshot(context.db, {
    head: application,
    userId: applicant.id,
    answerRows: answersToRows(rules.template, answers),
    expansionClaim: expansionEvidence.claim,
    qualifyingAwardId: expansionEvidence.qualifyingAwardId,
    qualifyingReleaseAt: expansionEvidence.qualifyingReleaseAt,
    revisionStageKeys: revisionStageKeys ? [...revisionStageKeys] : undefined,
    programmeCycleVersion: readableVersion.programmeCycleVersion,
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: auditActions.applicationSaved,
      entityType: 'SEB_APPLICATION',
      entityId: application.id,
      now,
    }),
  }))
  return completeGuardedOperation(
    saved,
    'The application changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, applicant.id, application.id),
    'Saved application could not be read.',
  )
}

export const validateApplication = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<ValidationReport>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const application = await loadOwnedApplication(context.db, applicant.id, applicationId)
  if (!application) return failure('The application was not found.')
  const rules = await findPinnedRulesForApplication(
    context.db, application.id, application.currentVersion,
  )
  if (!rules) return failure('The form this application was filled against could not be read.')
  return success(validateAnswersForSubmission(
    rules.template,
    application.answers,
    await listActiveDocumentFieldKeys(context.db, applicationId),
    new Date(),
    rules.policy,
    await findEnterpriseFacts(context.db, application.enterpriseId),
  ))
}

const changeApplicationDeletion = async (
  input: {
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    reason?: string | null
  },
  context: ApplicationOperationContext,
  deleted: boolean,
): Promise<SebResult<Application>> => {
  const authorized = await applicantForVersionedWrite<Application>(input, context)
  if ('refusal' in authorized) return authorized.refusal
  const applicant = { id: authorized.applicantId }
  // Soft-deleted heads are included: restoring one is a write on a row that is
  // deliberately still there.
  const head = await findOwnedApplicationHead(context.db, applicant.id, input.applicationId, true)
  if (!head) return failure(APPLICATION_NOT_FOUND_MESSAGE)
  if (
    head.currentVersion !== input.expectedVersion ||
    head.statusVersion !== input.expectedStatusVersion ||
    head.status !== 'DRAFT'
  ) return failure('Only an unchanged draft can be removed or restored.')
  let restoreAwardId: string | null = null
  let restoreAwardNetDisbursedPaise: number | null = null
  let restoreAwardFirstReleaseAt: Date | null = null
  if (!deleted && head.applicationType === 'EXPANSION') {
    const evaluated = await evaluateExpansionEligibility(
      context.db,
      head.fundingCaseId,
      new Date(),
      head.id,
      head.programmeCycleId,
    )
    if (!evaluated.result.eligible || !evaluated.award) {
      return failure('The expansion draft is no longer eligible for restoration.')
    }
    restoreAwardId = evaluated.award.awardId
    restoreAwardNetDisbursedPaise = evaluated.award.netDisbursedPaise
    restoreAwardFirstReleaseAt = evaluated.award.firstReleaseAt
  }
  const now = new Date()
  const changed = await runConstraintSafe(() => setApplicationDeleted(context.db, {
      head,
      userId: applicant.id,
      deleted,
      reason: deleted ? (input.reason?.trim() || 'REMOVED_BY_APPLICANT') : null,
      restoreAwardId,
      restoreAwardNetDisbursedPaise,
      restoreAwardFirstReleaseAt,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: deleted ? auditActions.applicationDeleted : auditActions.applicationRestored,
        entityType: 'SEB_APPLICATION',
        entityId: head.id,
        now,
      }),
    }))
  return completeGuardedOperation(
    changed,
    'The application state changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, applicant.id, head.id, true),
    'Changed application could not be read.',
  )
}

export const softDeleteApplicationDraft = (
  input: {
    applicationId: string
    expectedVersion: number
    expectedStatusVersion: number
    reason?: string | null
  },
  context: ApplicationOperationContext,
) => changeApplicationDeletion(input, context, true)

export const restoreApplicationDraft = (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
) => changeApplicationDeletion(input, context, false)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const createReferenceNumber = (cycleYear: number): string => {
  const random = crypto.getRandomValues(new Uint8Array(8))
  let suffix = ''
  for (const byte of random) suffix += CROCKFORD[byte % CROCKFORD.length]
  return `SEP-${cycleYear}-${suffix}`
}

/*
 * Best effort, and deliberately after the write: a mail failure must not undo
 * or hide a submission that has already happened. The same policy as the
 * password-change notice in `auth/controllers/account.ts`, with the same
 * shape of record when it fails — a FAILURE audit row under its own action,
 * and a fixed log line that never carries the error object, because a
 * transport error can echo the recipient and these logs are public in CI.
 */
const sendSubmissionConfirmation = async (
  context: ApplicationOperationContext,
  applicantId: string,
  application: Application,
  template: ResolvedFormTemplate,
): Promise<void> => {
  try {
    const [email, cycle] = await Promise.all([
      findUserEmailById(context.db, applicantId),
      findProgrammeCycleIdentity(context.db, application.programmeCycleId),
    ])
    if (!email || !cycle) throw new Error('The confirmation cannot be addressed.')
    // The provider attaches by URL: it fetches this signed link and encloses
    // the PDF the route rebuilds from the frozen submission.
    const url = await confirmationPdfUrl(
      context.env, context.requestUrl, application.id, new Date(),
    )
    await sendNotification({
      to: email,
      subject: 'Your Mission SEP application has been submitted',
      body:
        'Your Mission SEP application has been submitted.\n\n'
        + `Reference: ${application.referenceNumber ?? application.id}\n`
        + `Cycle: ${cycle.displayName} (${cycle.cycleCode})\n\n`
        + 'A copy of the application is attached for your records. The '
        + 'programme office will review it, and you will be notified of the '
        + 'outcome and of any request for corrections.',
      attachments: [{
        filename: `application-${application.referenceNumber ?? application.id}.pdf`,
        contentType: 'application/pdf',
        url,
      }],
    }, context.env)
  } catch {
    // Guarded itself: the audit write failing must not throw into the
    // submission that has already succeeded.
    await bestEffort(createAuditEvent(context.db, {
      ...auditRecord(context, {
        actorUserId: applicantId,
        action: auditActions.submissionConfirmationFailed,
        entityType: 'SEB_APPLICATION',
        entityId: application.id,
        now: new Date(),
      }),
      outcome: 'FAILURE',
    }), 'A submission confirmation failed')
  }
}

const submit = async (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
  resubmission: boolean,
): Promise<SebResult<Application>> => {
  const authorized = await ownedApplicationAtVersion(input, context)
  if ('refusal' in authorized) return authorized.refusal
  const applicant = { id: authorized.applicantId }
  const application = authorized.application
  if (application.status !== (resubmission ? 'REVISION_REQUIRED' : 'DRAFT')) {
    return failure('The application changed or cannot be submitted in its current status.')
  }
  const now = new Date()
  const cycle = resubmission
    ? null
    : await findOpenProgrammeCycle(context.db, application.programmeCycleId, now)
  if (!resubmission && !cycle) return failure('The programme cycle is no longer open.')
  const revisionStageKeys = resubmission
    ? await listOpenRevisionStageKeys(context.db, application.id)
    : undefined
  if (resubmission && revisionStageKeys?.size === 0) {
    return failure('There are no open revision requests to resolve.')
  }
  const expansionEvidence = await expansionEvidenceForHead(context, application, now)
  if (!expansionEvidence) return failure('The expansion application is no longer eligible.')
  if (application.applicationType === 'EXPANSION') {
    const evaluated = await evaluateExpansionEligibility(
      context.db,
      application.fundingCaseId,
      now,
      application.id,
      application.programmeCycleId,
    )
    if (!evaluated.result.eligible) return failure('The expansion application is no longer eligible.')
  }
  /*
   * Resolved **once**, and handed to both the validator and the write.
   *
   * They have to agree about which questions exist and which documents this
   * cycle requires, and the only way they do is by reading the same object. Two
   * resolutions of the same cycle version would almost always agree, which is
   * what makes the day they do not so hard to find.
   */
  const rules = await findPinnedRulesForApplication(
    context.db, application.id, application.currentVersion,
  )
  if (!rules) return failure('The form this application was filled against could not be read.')
  const answers = application.answers
  const facts = await findEnterpriseFacts(context.db, application.enterpriseId)
  const report = validateAnswersForSubmission(
    rules.template,
    answers,
    await listActiveDocumentFieldKeys(context.db, application.id),
    now,
    rules.policy,
    facts,
  )
  if (!report.valid) return failure('The application is incomplete. Run validation for details.')
  const currentVersionRecord = await findApplicationVersion(
    context.db,
    application.id,
    application.currentVersion,
  )
  const readableVersion = requireInvariant(currentVersionRecord, 'Application version is missing.')

  const submitted = await runConstraintRetry(() => submitApplicationSnapshot(context.db, {
    head: application,
    currentVersion: readableVersion,
    userId: applicant.id,
    answerRows: answersToRows(rules.template, answers),
    expansionClaim: expansionEvidence.claim,
    qualifyingAwardId: expansionEvidence.qualifyingAwardId,
    qualifyingReleaseAt: expansionEvidence.qualifyingReleaseAt,
    revisionStageKeys: revisionStageKeys ? [...revisionStageKeys] : undefined,
    programmeCycleVersion: readableVersion.programmeCycleVersion,
    referenceNumber: createReferenceNumber(cycle?.cycleYear ?? new Date().getUTCFullYear()),
    resubmission,
    requiredDocumentFieldKeys: requiredDocumentFieldKeys(rules.template, answers),
    // Frozen onto the snapshot here, from the same facts the validator read —
    // the moment of submission is what the sorting must reflect.
    applicationCategory: applicationCategoryOf(
      facts?.establishmentDate ?? null,
      rules.policy.categoryAMaximumMonths,
      now,
    ),
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: resubmission
        ? auditActions.applicationResubmitted
        : auditActions.applicationSubmitted,
      entityType: 'SEB_APPLICATION',
      entityId: application.id,
      now,
    }),
  }), 3)
  const result = await completeGuardedOperation(
    submitted === true,
    'The application changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, applicant.id, application.id),
    'Submitted application could not be read.',
  )
  if (submitted === true && result.success && result.response) {
    await bestEffort(
      sendSubmissionConfirmation(context, applicant.id, result.response, rules.template),
      'A submission confirmation failed',
    )
  }
  return result
}

export const submitApplication = (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
) => submit(input, context, false)

export const resubmitApplication = (
  input: { applicationId: string; expectedVersion: number; expectedStatusVersion: number },
  context: ApplicationOperationContext,
) => submit(input, context, true)

/**
 * The plain-language catalogue for every application status.
 *
 * Static, but kept behind the applicant guard so the whole `seb` namespace has
 * one authentication rule rather than an exception a reader has to remember.
 */
export const applicationStatusExplanations = async (
  context: ApplicationOperationContext,
): Promise<SebResult<{ statuses: ApplicationStatusGuideEntry[] }>> => {
  if (!await currentApplicant(context)) return failure(AUTH_REQUIRED_MESSAGE)
  return success({ statuses: applicationStatusGuide })
}

/**
 * The form one of this applicant's applications is filled against.
 *
 * Its own operation rather than a field on the application, because the two
 * have opposite lifetimes: the application changes on every autosave and the
 * form does not change at all once the cycle version is pinned.
 */
export const applicationFormTemplate = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<ResolvedFormTemplate>> => {
  const owned = await ownedApplication<ResolvedFormTemplate>(applicationId, context)
  if ('refusal' in owned) return owned.refusal
  const rules = await findPinnedRulesForApplication(
    context.db, owned.application.id, owned.application.currentVersion,
  )
  return rules
    ? success(rules.template)
    : failure('The form this application was filled against could not be read.')
}

/** What this draft changes relative to the last submission, for a final review. */
export const applicationDraftChanges = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<{
  stageKeys: ApplicationSection[]
  comparedToSubmissionNumber: number
}>> => {
  const owned = await ownedApplication<{
    stageKeys: ApplicationSection[]
    comparedToSubmissionNumber: number
  }>(applicationId, context)
  if ('refusal' in owned) return owned.refusal
  const changes = await findDraftChanges(context.db, owned.application)
  return changes
    ? success(changes)
    : failure('This application has not been submitted yet, so there is nothing to compare.')
}

/**
 * A fresh signed link to the PDF copy of the submitted application — the same
 * document the confirmation email attaches, built from the same frozen
 * submission, so the screen and the inbox can never disagree.
 */
export const submittedApplicationCopy = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<{ url: string }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!(await findOwnedApplicationHead(context.db, applicant.id, applicationId, true))) {
    return failure('The application was not found.')
  }
  if (!(await findLatestSubmittedVersion(context.db, applicationId))) {
    return failure('The application has not been submitted yet.')
  }
  return success({
    url: await confirmationPdfUrl(context.env, context.requestUrl, applicationId, new Date()),
  })
}

export const applicationTimeline = async (
  input: { applicationId: string; first?: number | null; after?: string | null },
  context: ApplicationOperationContext,
): Promise<SebResult<Connection<TimelineEvent>>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  if (!(await findOwnedApplicationHead(context.db, applicant.id, input.applicationId, true))) {
    return failure('The application was not found.')
  }
  const first = pageSize(input.first)
  const cursor = decodeCursor(input.after, 'createdAt')
  if (first === null || cursor === 'INVALID') return failure('Invalid pagination input.')
  return success(
    await listApplicationTimeline(context.db, {
      applicationId: input.applicationId,
      first,
      cursor,
    }),
  )
}
