# Applicant application service

Everything an applicant owns: their enterprises, their draft applications, the
evidence attached to them, submission, and their own view of the award that
follows. The administrative service owns every write behind that award; this
service adds one thing to reading it — proof that the caller owns the
application before any funding fact leaves the server.

The plain-language applicant journey is the
[application guide](../../../docs/application-guide.md). This document is how
the code implements it. The breaking form-contract and baseline changes are in
[Application form backend changes](../../../docs/application-form-backend-changes.md).

## What it assumes

- **Ownership is resolved before anything else is read.** An opaque identifier
  belonging to somebody else must be indistinguishable from one that never
  existed, so every read that reaches past the application row starts at
  `ownership.ts`.
- **A cycle's rules are pinned, not looked up.** A snapshot records the exact
  policy version it was started under, so a later correction to that cycle
  cannot silently change old eligibility.
- **Prior-award facts are derived, never supplied.** Expansion eligibility comes
  from the authoritative award and ledger; what an applicant typed about a
  previous award is never trusted.
- **A verified applicant always holds the `APPLICANT` role.** The signup write
  rolls back entirely if the role insert fails, so an account without it cannot
  exist.
- **`undefined` and SQL `NULL` are different things** to D1. `sqlNullable` is
  the single conversion point.

## Layout

| Path | Owns |
| --- | --- |
| `controllers/enterprise.ts` | Enterprise create, edit, soft-delete, restore |
| `controllers/application.ts` | Cycle discovery, starts, drafts, validation, submission |
| `controllers/document.ts` | Upload authorization, finalization, download, cleanup |
| `controllers/funding.ts` | The applicant's read of their own award |
| `queries/*` | Drizzle reads and every guarded write |
| `validation.ts` | Pure form normalization and policy rules — no D1, no R2 |
| `uploads.ts` | The upload rules — types, size, keys, object verification |
| `ownership.ts` | The ownership preamble every read starts from |
| `ledger.ts` | The release/reversal fold |
| `sections.ts` | Which form sections differ between two snapshots |
| `status-guide.ts` | Plain-language explanation of every status |
| `pagination.ts` | Cursors, page size, and `MAX_COLLECTION_ROWS` |
| `support.ts`, `types.ts` | Envelope, audit builder, shared shapes |

## Flows

### Saving a draft

| | |
| --- | --- |
| **Entry** | `seb.application.saveDraft` |
| **Guard** | applicant, and owns this application |
| **Refuses** | a stale `expectedVersion` or `expectedStatusVersion`; a status that is neither `DRAFT` nor `REVISION_REQUIRED`; a registered email different from the verified caller; any alteration to copied name, establishment, registration, GSTIN, or sector; in `REVISION_REQUIRED`, any section that was not asked for; expansion evidence that has since changed |
| **Writes** | a new immutable form version plus the audit row, one batch |
| **Guarded by** | both versions, the status, the revision scope, and the pinned expansion evidence |
| **Fails** | `The record changed. Reload and try again.` |

`editableSections` is derived from the same rule the write enforces, so the API
can never advertise an edit the write path would refuse.

Normalization accepts common separators in a contact number but the resulting
value must contain exactly ten digits and cannot carry a country prefix.
District is limited to Dhalai, Gomati, Khowai, North Tripura, Sepahijala, South
Tripura, Unakoti, or West Tripura. A government-support sanction year is an
integer from 1900 through 2026 inclusive. Declaration data is not part of the
draft, snapshot, validation, submission, or revision vocabulary.

### Submitting

| | |
| --- | --- |
| **Entry** | `seb.application.submit`, `seb.application.resubmit` |
| **Guard** | applicant, and owns this application |
| **Refuses** | any validation issue against the cycle's pinned rules; a missing required document |
| **Writes** | status, the frozen submission, the exact document versions pinned to it, the timeline event, and — on a first submission — the reference number |
| **Guarded by** | both versions, the status, and the required-document set recomputed at write time |
| **Fails** | the first validation issue, or `The record changed.` |

**The validator and the write must ask the same function** which documents are
required. When they derived it separately, a cycle asking for fewer documents
validated as complete and was then refused with a message about the application
having changed — which it had not. One definition:
`requiredDocumentTypes` in `validation.ts`.

Resubmission clears the assignment, because a resubmission is fresh intake work.

### Restoring a deleted draft

Deleting a draft releases its place in the phase chain, so restoring it is a new
eligibility decision rather than clearing `deleted_at`. The guarded restore
requires all of this to still be true:

- the enterprise belongs to the applicant and is not deleted;
- its funding case exists, is open, and is not deleted;
- no other non-rejected, non-deleted application occupies the same phase;
- for an expansion, the qualifying-award link can be reclaimed atomically;
- the award is active, in the same case, and from the immediately preceding
  phase; and
- the award still has the exact positive net disbursement and first
  retained release the controller evaluated.

So an old phase-1 draft cannot be restored once a replacement has started, and
an expansion cannot be restored on eligibility a reversal has invalidated.

### Expansion eligibility

Derived from authoritative records only:

```text
net disbursed = total RELEASE amounts - total REVERSAL amounts
```

The anniversary starts at the **earliest release that still retains a positive
amount after its reversals**. Eligibility begins when that release's UTC
calendar anniversary plus the target cycle's pinned waiting period has
passed — calendar arithmetic, not a fixed number of milliseconds.

The guard pins both the net amount *and* that exact release timestamp. Both
matter: a concurrent release and reversal could leave the same total while
changing which release establishes the anniversary.

Every unmet assessment rule is reported separately rather than collapsed, and
award status is classified rather than filtered in SQL — "never sanctioned",
"award suspended" and "nothing actually paid out" are three different things
for an applicant to act on.

## Documents and storage

This service is the single owner of the upload rules.

| | |
| --- | --- |
| Types | PDF, JPEG, PNG |
| Maximum | 5 MB |
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
timeline events, notes, assignment history. They are bounded by real work rather
than by anything a caller sends, but "bounded by real work" is not bounded, and
a file worked on for years should not make one request read ten thousand rows.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `myEnterprises`, `enterpriseById`, `createEnterprise`, `updateEnterprise`, `softDeleteEnterprise`, `restoreEnterprise` | `controllers/enterprise.ts` | The enterprise lifecycle; deletion names its blockers individually so the applicant can act |
| `availableProgrammeCycles` | `controllers/application.ts` | The only list a "start application" action may be offered from |
| `myProgrammeCycles` | `controllers/application.ts` | Read-only history, including closed cycles |
| `myApplications`, `applicationById`, `applicationTimeline` | `controllers/application.ts` | Reads |
| `startInitialApplication`, `startExpansionApplication` | `controllers/application.ts` | Starts |
| `saveApplicationDraft`, `validateApplication`, `softDeleteApplicationDraft`, `restoreApplicationDraft` | `controllers/application.ts` | The draft |
| `submitApplication`, `resubmitApplication` | `controllers/application.ts` | Submission |
| `expansionEligibility` | `controllers/application.ts` | Every unmet rule, reported separately |
| `applicationStatusExplanations`, `applicationDraftChanges` | `controllers/application.ts` | Guidance and what this draft changes |
| `issueDocumentUpload`, `finalizeDocumentUpload`, `documentDownloadUrl`, `softDeleteApplicationDocument`, `restoreApplicationDocument` | `controllers/document.ts` | Evidence |
| `cleanupExpiredDocumentUploads` | `controllers/document.ts` | Hourly cron; at most 50 objects per run |
| `applicationFunding` | `controllers/funding.ts` | Ownership proof plus one query |
| `requiredDocumentTypes`, `validateSubmissionSnapshot`, `normalizeDraftInput` | `validation.ts` | The rules, with no I/O |
| `foldDisbursementLedger` | `ledger.ts` | Pairs reversals to releases; one definition so no two views disagree |
| `changedSections` | `sections.ts` | Which sections differ between snapshots |
| `ownedApplication`, `ownedApplicationAtVersion` | `ownership.ts` | The ownership preamble |
| `pageSize`, `encodeCursor`, `decodeCursor`, `MAX_COLLECTION_ROWS` | `pagination.ts` | Paging |
| `verifyUploadedObject`, `extensionMatchesContentType`, `createDocumentObjectKey`, `sanitizeFilename` | `uploads.ts` | The upload rules |

## Elsewhere

- [Application guide](../../../docs/application-guide.md) — the journey in the
  applicant's own terms
- [Layering rule](../README.md) — why controllers and queries both check
- [Schema](../../db/schema/README.md) — tables, versions, constraints
- [Policy crosswalk](../../../docs/policy-alignment.md) — which rules came
  from the programme itself
- [Storage service](../storage/README.md) — where a document physically goes
- [Queue](../queue/README.md) and [scanner](../document-scanner/README.md) —
  what happens to it after finalization
