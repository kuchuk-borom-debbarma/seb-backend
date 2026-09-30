/** Applicant application, validation, eligibility, and submission use cases. */
import { afterResponse, type DatabaseAccess } from '../../../deferred'
import { pinnedFormReader } from '../../../loaders'
import { auditActions, applicationStatuses } from '../../../db/schema'
import { decodeCursor, pageSize } from '../pagination'
import {
  findEnterpriseApplicationSource,
  findOpenCycleEligibility,
  type OpenCycleEligibility,
  findLatestSubmittedVersion,
  findDownloadablePolicyDocument,
  findDraftChanges,
  findOwnedApplicationHead,
  insertApplicationAggregate,
  listApplicationTimeline,
  listApplicantProgrammeCycles,
  listAvailableProgrammeCycles,
  listOwnedApplications,
  loadOwnedApplication,
  loadOwnedApplicationContext,
  applicationAfterWrite,
  assembleApplication,
  openRevisionStageKeys,
  activeDocumentFieldKeys,
  type LoadedApplication,
  type SubmittedHead,
  saveApplicationSnapshot,
  setApplicationDeleted,
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
import { getCurrentSession } from '../../auth'
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
export type { ApplicationFormTemplate } from '../form/types'
export type { ValidationReport } from '../form/engine'
import type { AnswerMap, ApplicationFormTemplate, ResolvedFormTemplate } from '../form/types'
import type {
  Application,
  ApplicationOperationContext,
  ApplicationSection,
  ApplicationStatus,
  ApplicationStatusGuideEntry,
  ApplicationKindEligibility,
  ApplicationSummary,
  Connection,
  DownloadAuthorization,
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
  applicationGrantCeiling,
  validateAnswersForSubmission,
} from '../form/engine'
import {
  answersToRows,
  findPinnedRulesForApplication,
} from '../queries/form-template'
import { confirmationPdfUrl } from '../confirmation-link'
import { sendNotification } from '../../external-notification'
import { insertAuditEvent } from '../../audit-event'
import { auditReason } from '../../audit-vocabulary/fields'
import { eligibilityOf } from '../eligibility'

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
    applicationKind?: string | null
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
      applicationKind: input.applicationKind,
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
  const application = await loadOwnedApplication(context.db, pinnedFormReader(context.loaders), applicant.id, id, true)
  return application ? success(application) : failure('The application was not found.')
}

/**
 * Every kind the cycle's current version declares, judged against the
 * enterprise's history.
 *
 * Each verdict comes from the kind's configured rules alone (`../eligibility`):
 * the code knows no kind by name. `phaseNumber` rides along for the start
 * operation — the count of this enterprise's applications of every kind
 * declared before this one, plus one — so a first application is phase 1 and
 * an application of a later kind follows the attempts before it.
 */
const judgeKinds = (
  eligibility: Pick<OpenCycleEligibility, 'kinds' | 'history'>,
): Array<ApplicationKindEligibility & { phaseNumber: number }> => {
  const { kinds, history } = eligibility
  return kinds.map((kind, index) => {
    const earlier = new Set(kinds.slice(0, index).map((each) => each.kindKey))
    const verdict = eligibilityOf(kind.rules, history)
    return {
      kindKey: kind.kindKey,
      label: kind.label,
      description: kind.description,
      eligible: verdict.eligible,
      reasons: verdict.reasons,
      phaseNumber: 1 + history.applications.filter((prior) => earlier.has(prior.kind)).length,
    }
  })
}

/**
 * Whether this enterprise may still hold an application of its kind — asked
 * again when a draft is submitted or restored, because the history it was
 * started against may have moved. The application itself is left out of the
 * history, so "no open application of this kind" does not count itself.
 *
 * Null when it may; otherwise the refusal, including the cycle having closed.
 */
const kindStillEligible = async (
  context: ApplicationOperationContext,
  head: { id: string; enterpriseId: string; programmeCycleId: string; applicationKind: string },
  now: Date,
): Promise<{ refusal: string } | { cycle: OpenCycleEligibility['cycle'] }> => {
  const eligibility = await findOpenCycleEligibility(context.db, {
    cycleId: head.programmeCycleId, enterpriseId: head.enterpriseId, now, excludeApplicationId: head.id,
  })
  if (!eligibility) return { refusal: 'The programme cycle is no longer open.' }
  const kind = judgeKinds(eligibility).find((each) => each.kindKey === head.applicationKind)
  if (!kind) return { refusal: 'This kind of application is no longer offered by the programme cycle.' }
  return kind.eligible ? { cycle: eligibility.cycle } : { refusal: kind.reasons.join(' ') }
}

export const applicationKindEligibility = async (
  input: { enterpriseId: string; programmeCycleId: string },
  context: ApplicationOperationContext,
): Promise<SebResult<{ kinds: ApplicationKindEligibility[] }>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const now = new Date()
  const source = await findEnterpriseApplicationSource(context.db, applicant.id, input.enterpriseId)
  if (!source) return failure('The enterprise was not found or its funding case is not open.')
  const eligibility = await findOpenCycleEligibility(context.db, {
    cycleId: input.programmeCycleId, enterpriseId: source.enterprise.id, now,
  })
  if (!eligibility) return failure('The programme cycle is not open.')
  const judged = judgeKinds(eligibility)
  return success({ kinds: judged.map(({ phaseNumber: _phase, ...kind }) => kind) })
}

export const startApplication = async (
  input: { enterpriseId: string; programmeCycleId: string; applicationKind: string },
  context: ApplicationOperationContext,
): Promise<SebResult<Application>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const now = new Date()
  const source = await findEnterpriseApplicationSource(context.db, applicant.id, input.enterpriseId)
  if (!source) return failure('The enterprise was not found or its funding case is not open.')
  const eligibility = await findOpenCycleEligibility(context.db, {
    cycleId: input.programmeCycleId, enterpriseId: source.enterprise.id, now,
  })
  if (!eligibility) return failure('The programme cycle is not open.')
  const { cycle } = eligibility

  const kind = judgeKinds(eligibility).find((each) => each.kindKey === input.applicationKind)
  if (!kind) return failure('Select a kind of application this programme cycle offers.')
  if (!kind.eligible) return failure(kind.reasons.join(' '))

  /*
   * The cycle's form, resolved before anything is written.
   *
   * A cycle whose template does not resolve cannot take an application at all:
   * the draft would exist with no questions, and the applicant would be told
   * nothing about why. Refused here rather than at the first save.
   */
  const rules = await pinnedFormReader(context.loaders)(cycle.id, cycle.currentVersion)
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
      applicationKind: kind.kindKey,
      phaseNumber: kind.phaseNumber,
      /*
       * Empty. Nothing is prefilled any more: the enterprise facts stopped
       * being answers when the entity became their single home, and the two
       * remaining roles — an owner's date of birth and the requested amount —
       * are things only the applicant can say.
       */
      answerRows: [],
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: auditActions.applicationStarted,
        entityType: 'SEB_APPLICATION',
        entityId: applicationId,
        // The id, not a subselect: the application row is inserted by this
        // same batch, and the audit row does not wait for it to exist.
        applicationId,
        payload: {
          kind: kind.kindKey,
          phaseNumber: kind.phaseNumber,
          enterpriseId: source.enterprise.id,
          programmeCycleId: cycle.id,
        },
        now,
      }),
    }),
  )
  if (!inserted) {
    return failure(
      'This enterprise already has an application in this programme cycle, or the '
      + 'cycle changed while it was being started. Reload and try again.',
    )
  }
  // Built from what was written rather than read back: a new draft has no
  // documents, requests or answers yet (rule 4).
  return success(assembleApplication({
    ...inserted, template: rules.template, answerRows: [], documents: [], revisionRequests: [],
  }))
}

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
const revisionChangesAreAllowed = (
  loaded: LoadedApplication,
  answers: AnswerMap,
): Set<ApplicationSection> | null => {
  const openStageKeys = openRevisionStageKeys(loaded.application)
  if (!loaded.submittedAnswers || openStageKeys.size === 0) return null
  const changed = changedStageKeys(loaded.rules.template, loaded.submittedAnswers, answers)
  return changed.every((stageKey) => openStageKeys.has(stageKey)) ? openStageKeys : null
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
  const { application, loaded } = authorized
  if (application.status === 'IN_PIPELINE' && application.editableStageKeys.length === 0) {
    return failure('The application cannot be edited in its current status.')
  }
  /*
   * The form the application was loaded against, and everything downstream
   * reads this one object: the normaliser, the revision-scope diff, the
   * equality check and the rows that get written. Two resolutions would be how
   * a save and its validation come to disagree about what the form is.
   */
  const rules = loaded.rules

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

  const revisionStageKeys = application.status === 'IN_PIPELINE'
    ? revisionChangesAreAllowed(loaded, answers)
    : undefined
  if (application.status === 'IN_PIPELINE' && !revisionStageKeys) {
    return failure('Only stages requested for revision may be changed.')
  }
  // Nothing changed, so nothing is versioned. An autosave that stores an
  // identical version on every keystroke makes the history useless.
  if (changedStageKeys(rules.template, application.answers, answers).length === 0) {
    return success(application)
  }
  const now = new Date()
  const readableVersion = loaded.version
  const saved = await runConstraintSafe(() => saveApplicationSnapshot(context.db, {
    head: application,
    userId: applicant.id,
    answerRows: answersToRows(rules.template, answers),
    revisionStageKeys: revisionStageKeys ? [...revisionStageKeys] : undefined,
    programmeCycleVersion: readableVersion.programmeCycleVersion,
    now,
    audit: auditRecord(context, {
      actorUserId: applicant.id,
      action: auditActions.applicationSaved,
      entityType: 'SEB_APPLICATION',
      entityId: application.id,
      applicationId: application.id,
      payload: { version: application.currentVersion + 1 },
      now,
    }),
  }))
  if (!saved) return failure('The application changed. Refresh it and try again.')
  return success(applicationAfterWrite(loaded, {
    head: { currentVersion: application.currentVersion + 1, updatedAt: now },
    version: {
      version: application.currentVersion + 1,
      changeType: application.status === 'DRAFT' ? 'SAVE' : 'REVISION',
      createdAt: now,
      declarationAcceptedAt: null,
      applicationCategory: null,
      answers,
    },
  }))
}

export const validateApplication = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<ValidationReport>> => {
  const applicant = await currentApplicant(context)
  if (!applicant) return failure(AUTH_REQUIRED_MESSAGE)
  const loaded = await loadOwnedApplicationContext(
    context.db, pinnedFormReader(context.loaders), applicant.id, applicationId,
  )
  if (!loaded) return failure('The application was not found.')
  return success(validateAnswersForSubmission(
    loaded.rules.template,
    loaded.application.answers,
    activeDocumentFieldKeys(loaded.application),
    new Date(),
    loaded.rules.policy,
    { establishmentDate: loaded.establishmentDate },
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
  const now = new Date()
  if (!deleted) {
    const judged = await kindStillEligible(context, head, now)
    if ('refusal' in judged) return failure(judged.refusal)
  }
  const reason = deleted ? (input.reason?.trim() || 'REMOVED_BY_APPLICANT') : null
  const changed = await runConstraintSafe(() => setApplicationDeleted(context.db, {
      head,
      userId: applicant.id,
      deleted,
      reason,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: deleted ? auditActions.applicationDeleted : auditActions.applicationRestored,
        entityType: 'SEB_APPLICATION',
        entityId: head.id,
        applicationId: head.id,
        payload: reason === null ? {} : { reason: auditReason(reason) },
        now,
      }),
    }))
  return completeGuardedOperation(
    changed,
    'The application state changed. Refresh it and try again.',
    () => loadOwnedApplication(context.db, pinnedFormReader(context.loaders), applicant.id, head.id, true),
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
  database: DatabaseAccess,
  context: ApplicationOperationContext,
  recipient: { applicantId: string; email: string },
  application: Application,
  cycle: LoadedApplication['cycle'],
): Promise<void> => {
  const { applicantId, email } = recipient
  try {
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
    await bestEffort(database((db) => insertAuditEvent(db, auditRecord(context, {
      actorUserId: applicantId,
      action: auditActions.submissionConfirmationFailed,
      entityType: 'SEB_APPLICATION',
      entityId: application.id,
      applicationId: application.id,
      outcome: 'FAILURE',
      payload: {},
      now: new Date(),
    }))), 'A submission confirmation failed')
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
  const { application, loaded } = authorized
  if (application.status !== (resubmission ? 'IN_PIPELINE' : 'DRAFT')) {
    return failure('The application changed or cannot be submitted in its current status.')
  }
  const now = new Date()
  const revisionStageKeys = resubmission ? openRevisionStageKeys(application) : undefined
  if (resubmission && revisionStageKeys?.size === 0) {
    return failure('There are no open revision requests to resolve.')
  }
  // A first submission re-asks whether the cycle is open and the kind's rules:
  // the history the draft was started against may have moved. A resubmission
  // is the same attempt.
  let cycle: OpenCycleEligibility['cycle'] | null = null
  if (!resubmission) {
    const judged = await kindStillEligible(context, application, now)
    if ('refusal' in judged) return failure(judged.refusal)
    cycle = judged.cycle
  }
  /*
   * The form the application was loaded against, handed to both the validator
   * and the write. They have to agree about which questions exist and which
   * documents this cycle requires, and the only way they do is by reading the
   * same object.
   */
  const rules = loaded.rules
  const answers = application.answers
  const facts = { establishmentDate: loaded.establishmentDate }
  const report = validateAnswersForSubmission(
    rules.template,
    answers,
    activeDocumentFieldKeys(application),
    now,
    rules.policy,
    facts,
  )
  if (!report.valid) return failure('The application is incomplete. Run validation for details.')
  const applicationCategory = applicationCategoryOf(
    facts.establishmentDate,
    rules.policy.categoryAMaximumMonths,
    now,
  )
  const submitted = await runConstraintRetry(async () => {
    // Minted per attempt, as it always was, and named once so the snapshot and
    // its audit row carry the same reference. A resubmission keeps the one the
    // first submission issued — the write keeps the head's when it has one.
    const referenceNumber = application.referenceNumber
      ?? createReferenceNumber(cycle?.cycleYear ?? new Date().getUTCFullYear())
    const written = await submitApplicationSnapshot(context.db, {
      head: application,
      userId: applicant.id,
      answerRows: answersToRows(rules.template, answers),
      revisionStageKeys: revisionStageKeys ? [...revisionStageKeys] : undefined,
      programmeCycleVersion: loaded.version.programmeCycleVersion,
      referenceNumber,
      resubmission,
      requiredDocumentFieldKeys: requiredDocumentFieldKeys(rules.template, answers),
      // Frozen onto the snapshot here, from the same facts the validator read —
      // the moment of submission is what the sorting must reflect.
      applicationCategory,
      now,
      audit: auditRecord(context, {
        actorUserId: applicant.id,
        action: resubmission
          ? auditActions.applicationResubmitted
          : auditActions.applicationSubmitted,
        entityType: 'SEB_APPLICATION',
        entityId: application.id,
        applicationId: application.id,
        payload: {
          referenceNumber,
          version: application.currentVersion + 1,
          ...(applicationCategory === null ? {} : { applicationCategory }),
          ...(revisionStageKeys ? { revisionStageCount: revisionStageKeys.size } : {}),
        },
        now,
      }),
    })
    return written && { ...written, referenceNumber }
  }, 3)
  if (!submitted) return failure('The application changed. Refresh it and try again.')
  const response = submittedApplication(loaded, submitted, { resubmission, applicationCategory, now })
  // After the response: the applicant is not kept waiting on a mail provider,
  // and a failure is recorded rather than reported (rule 6).
  await afterResponse(context, (database) => bestEffort(
    sendSubmissionConfirmation(
      database, context, { applicantId: applicant.id, email: authorized.applicantEmail }, response, loaded.cycle,
    ),
    'A submission confirmation failed',
  ))
  return success(response)
}

/**
 * The application as a submission left it: the version the write froze, the
 * stage and flags SQL chose, and — on a resubmission — the revision requests
 * it resolved.
 */
const submittedApplication = (
  loaded: LoadedApplication,
  written: SubmittedHead & { referenceNumber: string },
  submission: { resubmission: boolean; applicationCategory: Application['snapshot']['applicationCategory']; now: Date },
): Application => {
  const { application } = loaded
  const { now } = submission
  return applicationAfterWrite(loaded, {
    head: {
      currentVersion: application.currentVersion + 1,
      statusVersion: application.statusVersion + 1,
      status: 'IN_PIPELINE',
      referenceNumber: application.referenceNumber ?? written.referenceNumber,
      firstSubmittedAt: application.firstSubmittedAt ?? now,
      currentStageKey: written.currentStageKey,
      statusFlags: written.statusFlags,
      updatedAt: now,
    },
    version: {
      version: application.currentVersion + 1,
      changeType: submission.resubmission ? 'RESUBMISSION' : 'SUBMISSION',
      createdAt: now,
      declarationAcceptedAt: now,
      applicationCategory: submission.applicationCategory,
      answers: application.answers,
    },
    revisionRequests: submission.resubmission
      ? application.revisionRequests.map((request) =>
        request.resolvedAt === null && request.cancelledAt === null
          ? { ...request, resolvedAt: now }
          : request)
      : application.revisionRequests,
  })
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
 * Behind a session, like the rest of the `seb` namespace — but any session,
 * not only an applicant's. "How this works" is read by the programme office as
 * well, and a staff account holding no applicant role was shown a guide with
 * no statuses in it. The catalogue is fixed wording that names nobody, so
 * reading it needs no authority beyond being signed in.
 */
export const applicationStatusExplanations = async (
  context: ApplicationOperationContext,
): Promise<SebResult<{ statuses: ApplicationStatusGuideEntry[] }>> => {
  if (!await getCurrentSession(context)) return failure(AUTH_REQUIRED_MESSAGE)
  return success({ statuses: applicationStatusGuide })
}

/**
 * The form one of this applicant's applications is filled against.
 *
 * Its own operation rather than a field on the application, because the two
 * have opposite lifetimes: the application changes on every save and the
 * form does not change at all once the cycle version is pinned.
 */
export const applicationFormTemplate = async (
  applicationId: string,
  context: ApplicationOperationContext,
): Promise<SebResult<ApplicationFormTemplate>> => {
  const owned = await ownedApplication<ApplicationFormTemplate>(applicationId, context)
  if ('refusal' in owned) return owned.refusal
  const rules = owned.pinnedCycleVersion === null
    ? null
    : await pinnedFormReader(context.loaders)(owned.application.programmeCycleId, owned.pinnedCycleVersion)
  return rules
    ? success({ ...rules.template, grantCeilingPaise: applicationGrantCeiling(rules.policy) })
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
  const changes = await findDraftChanges(context.db, pinnedFormReader(context.loaders), owned.application)
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
