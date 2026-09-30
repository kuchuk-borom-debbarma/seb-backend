# Applicant application service

Everything an applicant owns: their enterprises, their draft applications, the
evidence attached to them, which kinds of application they may start, and
submission — the moment a file enters its pipeline. What happens after that is
the [pipeline service](../pipeline/README.md); this service touches the
pipeline in exactly two writes, the first submission and a resubmission.

The plain-language applicant journey is the
[application guide](../../../docs/application-guide.md). This document is how
the code implements it.

## What it assumes

- **Ownership is resolved before anything else is read.** An opaque identifier
  belonging to somebody else must be indistinguishable from one that never
  existed, so every read that reaches past the application row starts at
  `ownership.ts`.
- **A cycle's rules are pinned, not looked up.** A snapshot records the exact
  policy version it was started under, so a later correction to that cycle
  cannot silently change old eligibility.
- **Eligibility is derived, never supplied.** Whether an enterprise may start a
  kind of application is the cycle's configured rules evaluated over the
  enterprise's recorded history — its earlier applications, their flags, when
  each flag was added, what they recorded. Nothing an applicant types feeds it.
- **The pipeline version is pinned at start.** An application copies its
  cycle's pinned pipeline version when it is started, so the version a file is
  worked in is decided before it is submitted and never changes after.
- **A verified applicant always holds the `APPLICANT` role.** The signup write
  rolls back entirely if the role insert fails, so an account without it cannot
  exist.
- **`undefined` and SQL `NULL` are different things.** `sqlNullable` is the
  single conversion point.
- **The questions are the cycle's, not the schema's.** Which questions exist,
  what they are called and when they are asked all come from the form template
  frozen with the cycle version an application pins. Nothing in this service
  names a question except through a role binding.

## Layout

| Path | Owns |
| --- | --- |
| `controllers/enterprise.ts` | Enterprise create, edit, soft-delete, restore |
| `controllers/application.ts` | Cycle discovery, kinds and eligibility, starts, drafts, validation, submission |
| `controllers/document.ts` | Upload authorization, finalization, download, cleanup |
| `queries/*` | Drizzle reads and every guarded write |
| `form/*` | The template engine: resolution, coercion, rules, conditions — pure |
| `form/cross-field/*` | Rules about several answers at once, one file per rule type — pure |
| `eligibility/*` | Eligibility rules for a kind of application, one file per rule type — pure |
| `validation.ts` | What is still the software's rather than a cycle's: the enterprise profile rules, the default submission policy, and date parsing — pure |
| `enterprise-policy.ts` | How many enterprises one applicant may hold, and what makes two of them the same |
| `text.ts` | One definition of what counts as empty typed text, shared by the profile and the form engine |
| `confirmation.ts` | The application as one PDF an applicant can keep; content can never make it throw |
| `uploads.ts` | The upload rules — types, size, keys, object verification |
| `ownership.ts` | The ownership preamble every read starts from |
| `status-guide.ts` | Plain-language explanation of the two statuses the code owns |
| `pagination.ts` | Cursors, page size, and `MAX_COLLECTION_ROWS` |
| `support.ts`, `types.ts` | Envelope, audit builder, shared shapes |

## Flows

### Saving a draft

| | |
| --- | --- |
| **Entry** | `seb.application.saveDraft` |
| **Guard** | applicant, and owns this application |
| **Refuses** | a stale `expectedVersion` or `expectedStatusVersion`; a submitted application with no open revision request; an answer the form does not ask, or one it does ask left out; after submission, any stage no open revision request names |
| **Writes** | a new immutable form version plus the audit row, one batch |
| **Guarded by** | both versions, the status, and the revision scope |
| **Fails** | `The record changed. Reload and try again.` |

`editableStageKeys` is derived from the same rule the write enforces, so the
API can never advertise an edit the write path would refuse: a draft may edit
every stage its template declares, and a submitted file only the stages named
by open revision requests. Only a stage action's `REQUEST_REVISION` effect
opens one, so "revision is required" is a fact about those rows rather than a
status of its own.

**An unrecognised answer key is refused, never dropped.** A browser holding a
form from an older cycle version would otherwise be told the save succeeded and
watch its answers disappear — the worst outcome available, because nothing tells
the applicant their work was discarded. **A hidden question's answer is cleared**
rather than merely ignored, on both sides and run to a fixed point: hiding a
question can hide the one that depended on it, and a single pass leaves the
third answer behind.

### Submitting

| | |
| --- | --- |
| **Entry** | `seb.application.submit`, `seb.application.resubmit` |
| **Guard** | applicant, and owns this application |
| **Refuses** | any validation issue against the cycle's pinned rules; a missing required document; on a first submission, a kind whose eligibility rules no longer hold; on a resubmission, no open revision request |
| **Writes** | the frozen submission, the exact document versions pinned to it, the timeline event, the head's pipeline state, and — on a first submission — the reference number |
| **Guarded by** | both versions, the status, and the required-document set recomputed at write time |
| **Fails** | the first validation issue, or `The record changed.` |

**The validator and the write must read the same resolved template.** Submission
resolves it once and hands the same object to both. When they derived the
required documents separately, a cycle asking for fewer validated as complete and
was then refused with a message about the application having changed — which it
had not. One definition: `requiredDocumentFieldKeys` in `form/engine.ts`, over
the template the validator just used.

**The two writes that touch the pipeline** are expressed in SQL over the
application's own pinned pipeline version, so neither can disagree with the
version the file is worked in:

- a **first submission** moves the head from `DRAFT` to `IN_PIPELINE`, puts it
  at the pinned version's initial stage (the one row of
  `seb_pipeline_version_stage` marked initial), stamps the time it arrived,
  clears the trail, and sets the flags the definition's `onSubmit` adds;
- a **resubmission** leaves the stage where it is — `REQUEST_REVISION` never
  moves a file, so it is still at the stage that asked — resolves every open
  revision request through this submission, and removes every held flag the
  pinned definition declares `REVISION_SCOPED`, keeping the order of the rest.
  That is the same as "the flag the revision added": the validator lets only
  `REQUEST_REVISION` add such a flag, and no action is offered while one is
  held, so at most one can be.

### Starting, and which kinds may be started

| | |
| --- | --- |
| **Entry** | `seb.application.applicationKinds`, `seb.application.start` |
| **Guard** | applicant, and owns the enterprise |
| **Refuses** | an enterprise that is not theirs or whose funding case is not open; a cycle that is not open; a kind the cycle does not declare; a kind whose rules do not all hold, with every reason |
| **Writes** | the head (kind, phase, the cycle's pinned pipeline version), the first version, the audit row |
| **Fails** | every failing rule's reason, joined |

Each kind's verdict comes from its configured rules alone (`eligibility/`); the
code knows no kind by name. The open cycle, its current version's kinds and
the history are one statement (`findOpenCycleEligibility`). The history is
every application of the enterprise across every cycle, with its kind, whether
it is a draft or finished, its flags, when each was last added (from the
stage-action history), and its recorded values. The rules are pure over that,
so the reasons an applicant is shown are exactly what was evaluated. All rules
are evaluated rather than the first to fail, and a stored rule whose parameters
this build no longer accepts refuses rather than passing.

**`phaseNumber`** is one more than the enterprise's applications of the kinds
declared before this one on the cycle, so a first application is phase 1.

The rules are asked again when a removed draft is restored and at the first
submission (`kindStillEligible`), because the history the draft was started
against may have moved. The application itself is left out of the history, so
"no open application of this kind" does not count itself. A resubmission is
the same attempt and is not re-asked.

## Documents and storage

This service is the single owner of the upload rules.

| | |
| --- | --- |
| Types | PDF, JPEG, PNG |
| Maximum | 2 MB — set by what the malware scanner accepts, not by storage; see [`uploads.ts`](uploads.ts) |
| Upload URL | valid 10 minutes |
| Download URL | valid 5 minutes, always forced to attachment |

Finalization verifies size, MIME type, checksum and magic bytes against the
stored object. **It never makes a file staff-readable**: it queues the immutable
object for the scanner, and administrative download fails closed until an
`ACCEPTED` result is appended.

An upload intent moves `ISSUED → FINALIZED | REJECTED | CLEANUP_PENDING →
EXPIRED`. A failed delete leaves the row `CLEANUP_PENDING` rather than starving
the batch, so cleanup can span cron runs. Object keys are never logged — a
storage identifier is sensitive.

### Where the file physically goes is not decided here

That is the [storage service](../storage/README.md), which owns the interface,
its two backends, and the local route that receives bytes when there is no
bucket. It knows nothing about programme documents — not the acceptable content
types, not the size limit, not what a filename may contain. Those are the rules
above, and they stay here.

The seam is why an upload works on a machine with no credentials: deployed, the
browser sends the file straight to the bucket; locally the bytes come to the
Worker, which applies the same size, type and checksum checks the bucket would.
The client cannot tell the two apart.

`verifyUploadedObject` takes that interface rather than a bucket. The backend
reports what an object *is*; deciding whether that is acceptable is a programme
rule and belongs where the rule lives. After the extraction this service never
names a bucket.

### Scanning is requested here and answered elsewhere

Finalization writes a `PENDING` scan row and queues a
`DOCUMENT_SCAN_REQUESTED` message. It does not wait: scanning is somebody
else's work and however long it takes must not be time the applicant spends
waiting.

A failure to queue is deliberately swallowed. The document is already
finalized and the upload genuinely succeeded, so reporting failure would be
untrue and would invite a second upload. What the unscanned document cannot do
is be opened by staff — administrative download fails closed until an
`ACCEPTED` result is appended — so the consequence of a lost message is a
document nobody can read, not a document nobody checked.

See the [queue](../queue/README.md) and
[document scanner](../document-scanner/README.md) services.

## Bounds

Pages default to 20 and cap at 100. Cursors carry the column they were ordered
by, so one reused under a different ordering is refused rather than seeking the
wrong column.

`MAX_COLLECTION_ROWS = 500` caps child collections that have no cursor —
timeline events, notes, revision requests. They are bounded by real work rather
than by anything a caller sends, but "bounded by real work" is not bounded, and
a file worked on for years should not make one request read ten thousand rows.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `myEnterprises`, `enterpriseById`, `createEnterprise`, `updateEnterprise`, `softDeleteEnterprise`, `restoreEnterprise` | `controllers/enterprise.ts` | The enterprise lifecycle; deletion names its blockers individually so the applicant can act |
| `availableProgrammeCycles` | `controllers/application.ts` | The only list a "start application" action may be offered from |
| `myProgrammeCycles` | `controllers/application.ts` | Read-only history, including closed cycles |
| `myApplications`, `applicationById`, `applicationTimeline`, `applicationFormTemplate`, `submittedApplicationCopy` | `controllers/application.ts` | Reads |
| `applicationKindEligibility` | `controllers/application.ts` | Every kind the cycle declares, judged for one enterprise, with every reason |
| `startApplication` | `controllers/application.ts` | Starts an application of one kind |
| `saveApplicationDraft`, `validateApplication`, `softDeleteApplicationDraft`, `restoreApplicationDraft` | `controllers/application.ts` | The draft |
| `submitApplication`, `resubmitApplication` | `controllers/application.ts` | Submission, and the file's entry into its pipeline |
| `applicationStatusExplanations`, `applicationDraftChanges` | `controllers/application.ts` | Guidance and what this draft changes |
| `cyclePolicyDocumentDownloadUrl` | `controllers/application.ts` | The policy a cycle implements |
| `issueDocumentUpload`, `finalizeDocumentUpload`, `documentDownloadUrl`, `softDeleteApplicationDocument`, `restoreApplicationDocument` | `controllers/document.ts` | Evidence |
| `cleanupExpiredDocumentUploads` | `controllers/document.ts` | Hourly cron; at most 50 objects per run |
| `normalizeAnswers`, `validateAnswersForSubmission`, `requiredDocumentFieldKeys` | `form/engine.ts` | The rules, with no I/O |
| `resolveFormTemplate` | `form/template.ts` | The one door from rows to a usable form |
| `visibleFields`, `isRequiredWhenVisible` | `form/conditions.ts` | Which questions are asked, and which must be answered |
| `holdsGroups`, `compareValue` | `form/conditions.ts` | The one condition combinator and comparison, shared with pipeline conditions |
| `formRuleEvaluators`, `defineFormRule` | `form/cross-field/` | Rules about several answers, one evaluator per catalogue rule type |
| `eligibilityOf`, `eligibilityEvaluators`, `defineEligibility` | `eligibility/` | Whether a kind may be started, and every reason it may not |
| `normalizeEnterpriseProfile` | `validation.ts` | The enterprise record, which is the portal's own rather than a cycle's |
| `changedStageKeys`, `pinnedFilesOf`, `answersEqual`, `pruneHidden` | `form/answers.ts` | Which stages differ — by their answers, and for the two "what changed" views by the files each side pinned too — and clearing what is no longer asked |
| `ownedApplication`, `ownedApplicationAtVersion` | `ownership.ts` | The ownership preamble |
| `pageSize`, `encodeCursor`, `decodeCursor`, `MAX_COLLECTION_ROWS` | `pagination.ts` | Paging |
| `verifyUploadedObject`, `extensionMatchesContentType`, `createDocumentObjectKey`, `sanitizeFilename` | `uploads.ts` | The upload rules |
| `buildApplicationPdf` | `confirmation.ts` | The PDF the submission confirmation attaches |
| `maxEnterprisesPerUser`, `enterpriseLimitReached`, `comparableEnterpriseName` | `enterprise-policy.ts` | The enterprise cap and duplicate-name rule |
| `cleanText`, `cleanLongText`, `cleanUpper`, `cleanLower`, `cleanPhone` | `text.ts` | Text normalization, one spelling of "empty" |

## Elsewhere

- [Application guide](../../../docs/application-guide.md) — the journey in the
  applicant's own terms
- [Layering rule](../README.md) — why controllers and queries both check
- [Schema](../../db/schema/README.md) — tables, versions, constraints
- [Policy crosswalk](../../../docs/policy-alignment.md) — which rules came
  from the programme itself
- [Pipeline service](../pipeline/README.md) — everything after submission
- [Form template guide](../../../docs/form-template-guide.md) — kinds,
  eligibility rules and cross-field rules in the office's terms
- [Storage service](../storage/README.md) — where a document physically goes
- [Queue](../queue/README.md) and [scanner](../document-scanner/README.md) —
  what happens to it after finalization
