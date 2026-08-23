# Applicant application service

Everything an applicant owns: their enterprises, their draft applications, the
evidence attached to them, submission, and their own view of the award that
follows. The administrative service owns every write behind that award; this
service adds one thing to reading it — proof that the caller owns the
application before any funding fact leaves the server.

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
| `storage.ts` | The storage interface and its two backends |
| `local-storage-route.ts` | Receives uploaded bytes when there is no bucket |
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
| **Refuses** | a stale `expectedVersion` or `expectedStatusVersion`; a status that is neither `DRAFT` nor `REVISION_REQUIRED`; in `REVISION_REQUIRED`, any section that was not asked for; expansion evidence that has since changed |
| **Writes** | a new immutable form version plus the audit row, one batch |
| **Guarded by** | both versions, the status, the revision scope, and the pinned expansion evidence |
| **Fails** | `The record changed. Reload and try again.` |

`editableSections` is derived from the same rule the write enforces, so the API
can never advertise an edit the write path would refuse.

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

### The storage seam

`storage.ts` states what the programme needs — authorize an upload the browser
performs itself, authorize a download — and names no vendor. S3, R2, Azure and
Google all satisfy it, and so does this Worker. Both backends return the same
grant shape, so the client cannot tell which it is talking to; only the host in
the URL differs.

| Backend | Receives the upload | Needs | Selected when |
| --- | --- | --- | --- |
| `r2` | the bucket, straight from the browser | the four `R2_*` values | `ENVIRONMENT` is anything else |
| `local` | this Worker, which writes to the `STORAGE` binding | nothing | `ENVIRONMENT` is unset or `local` |

Deployed, uploads never pass through the Worker: it signs a URL and the browser
`PUT`s directly to the bucket. The signature binds `Content-Type`,
`Content-Disposition`, **`Content-Length`**, `If-None-Match: *` and
`x-amz-checksum-sha256`, and is signed with `allHeaders: true` because these are
security constraints rather than hints. Binding the length makes the bucket
reject a payload differing from the applicant's declaration — browsers generate
that header from the body, so a caller must send a body of exactly that size
rather than trying to set the header.

A deployed environment missing any of the four refuses with `R2 signing
configuration is required.` rather than accepting documents it cannot durably
keep. Configuration lives in [`.env.example`](../../../.env.example).

### Why a local backend exists

Signing addresses `r2.cloudflarestorage.com` for real, so the direct-to-bucket
path needs credentials and a bucket that exists. The `STORAGE` binding itself
does not: the development runtime provides it with no account feature and no
keys. So locally the bytes come to the Worker and it writes them, and uploads
work on a machine that has nothing configured.

`local-storage-route.ts` receives them. **It refuses unless the local backend is
the selected one** — that check is its entire security boundary, it comes first,
and there is no way past it. A deployed environment sends the browser to the
bucket, and this path must not become a second way in.

Authorization is possession of the upload id, exactly as it is possession of a
signed URL. The id is unguessable, and the route re-checks the retained
authorization before writing a byte: still `ISSUED`, unexpired, and matching on
size and content type. A missing intent and a spent one are refused
identically, so the path cannot be used to discover which upload ids exist.

It then verifies the SHA-256 digest against the applicant's declaration and
stores it against the object, which is what the bucket would do. That matters
more than it looks: without it a document would verify locally and fail once
deployed, which is the worst kind of difference to have.

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
| `verifyUploadedObject`, `createDocumentObjectKey`, `sanitizeFilename` | `uploads.ts` | The upload rules |
| `storage`, `createUploadAuthorization`, `createDownloadAuthorization` | `storage.ts` | Whichever backend this environment uses |
| `handleLocalStorageRequest` | `local-storage-route.ts` | Receives bytes locally; closed everywhere else |

## Elsewhere

- [Application guide](../../../docs/application-guide.md) — the journey in the
  applicant's own terms
- [Layering rule](../README.md) — why controllers and queries both check
- [Schema](../../db/schema/README.md) — tables, versions, constraints
- [Policy crosswalk](../../../docs/policy-alignment.md) — which rules came
  from the programme itself
