# Administrative service

Everything that happens to an application after it is submitted: programme-cycle
governance, the intake queues, desk review, offline bank evidence, programme
decisions, awards and payments, and operational recovery.

The plain-language staff journey — what the rules *are*, and why — is the
[administrator workflow guide](../../../docs/admin-workflow-guide.md). This
document is how the code implements it.

## What it assumes

- **An application reaching this service has been formally submitted.** Drafts
  never appear in a queue, and a non-draft application always has at least one
  submission. That is a database invariant, so the workspace read asserts it
  rather than handling its absence.
- **A submitted application always has a reference number**, because submission
  is what mints one. Code that needs it asserts rather than defaulting — a
  quiet fallback would hide a broken invariant behind a plausible message.
- **An application's funding case is fixed when it is created and never moves.**
  This is what lets `seb_desk_review_identifier` carry a copy of the case ID and
  answer the duplicate question with one indexed seek.
- **Roles are joined live on every request.** A revoked role stops the next
  operation even though the browser session is still valid, so nothing here
  re-checks a role it was handed.
- **Evidence is frozen, never current.** A review reads the exact submission and
  the exact file versions pinned to it, so replacing a document tomorrow cannot
  change what was reviewed yesterday.

## Layout

| Path | Owns |
| --- | --- |
| `controllers/programme-cycle.ts` | Policy input and cycle lifecycle |
| `controllers/form-template.ts` | Authoring the questions a draft cycle asks — the nine `formTemplate` mutations |
| `controllers/intake.ts` | Queues, notes, desk review, the workspace |
| `controllers/analytics.ts` | The intake analytics summary |
| `controllers/decision.ts` | Bank referrals and outcomes, and the programme decision |
| `controllers/funding.ts` | Awards, releases, reversals, assessments, recovery |
| `queries/*` | Drizzle reads and every guarded write; `queries/analytics.ts` groups the queue's own filtered set |
| `form-template-input.ts` | Refusing an incoherent form before a cycle can carry one |
| `group-definitions.ts` | Reusable structures: the grammar guards, and expansion into qualified keys |
| `identifiers.ts` | Normalizing and hashing what a reviewer transcribes |
| `revisions.ts` | Validating a revision request against the cycle's own stages |
| `document-scanner.ts` | The internal scanner callback — no HTTP or GraphQL exposure |
| `support.ts` | Response envelope, audit builder, the reasoned-transition preamble |
| `types.ts`, `pagination.ts` | Shared shapes; `pagination.ts` re-exports the applicant's |

`index.ts` also re-exports `queries/funding` publicly — the one place a query
module crosses a service boundary, because the applicant's funding view reads
these records. See [the layering rule](../README.md).

## Flows

### Who worked a file, and why it is not a lock

There is no claim. `assigned_to_user_id`, `assigned_at` and the append-only
`seb_application_assignment_event` history remain, but nothing reads them to
decide whether a write is allowed — they are a record of who worked a file,
written as a side effect of the work itself. Starting a desk review stamps the
actor; so does completing one, and so does recording a decision.

The claim was removed because it was never what made a write safe. Every write
that carried `assigned_to_user_id = actor` also carried `status_version`, and
*that* is what serialises concurrent writers.

It also cost something concrete. Reading a document was gated on holding the
file, and claiming required `STAFF_WRITE`, so a reviewer could never open a
single piece of the evidence they existed to review. Gating a read on ownership
was the wrong shape.

Two officers on one file is now possible rather than prevented. One finishes
and the other is refused on the version guard, which is wasted effort and not
corruption. The workspace names whoever was there last so the second can decide
whether to go and ask them; it disables nothing.

### Completing a desk review

| | |
| --- | --- |
| **Entry** | `admin.intake.completeDeskReview` |
| **Guard** | `STAFF_WRITE` |
| **Refuses** | a missing or duplicated check; an expansion check that disagrees with the application type; a value for an identifier this cycle does not collect; a passed check with no transcribed number where the cycle demands one; an identifier already recorded on another funding case and not explained; reviewing your own application without `conflictAcknowledged`; for `ADVANCE_TO_BANK`, any submitted document whose latest scan is not `ACCEPTED` |
| **Writes** | status, the immutable review including whether the reviewer declared it was their own application, its nine checks, the transcribed identifiers, any revision requests, the applicant-visible event, the audit row, and a `SEB.SELF_REVIEW_DISCLOSED` row where there was something to declare — one batch |
| **Guarded by** | `status_version` and the current status |
| **Fails** | the specific refusal, or `The record changed.` |

The nine checks and the outcome are one write, not a wizard, so a review cannot
be left half-recorded.

### Acting on your own application

Permitted, with disclosure. A small office has officers who are also applicants,
so this is expected rather than suspect — but `docs/policy-alignment.md` records
the permission as conditional on saying so, and TTAADC has yet to decide whether
recusal or a second approval should replace it. Until they do, the disclosure is
the whole control.

It is therefore kept, on the act it qualifies:

| Act | Column | Also writes |
| --- | --- | --- |
| `completeDeskReview` | `seb_desk_review.conflict_acknowledged` | `SEB.SELF_REVIEW_DISCLOSED` |
| `recordDecision` | `seb_programme_decision.conflict_acknowledged` | `SEB.SELF_REVIEW_DISCLOSED` |
| `correctDecision` | the superseding row's own column | `SEB.SELF_REVIEW_DISCLOSED` |

Three properties are worth stating because none is accidental.

**It is on the act, not the assignment.** An assignment event is written only
when a decision releases the file, which happens on rejection — so an approved
self-review would have kept nothing.

**A correction discloses for itself.** An acknowledgement given when the
original decision was recorded says nothing about who is superseding it, perhaps
months later.

**The answer is the caller's own.** `undisclosedSelfReview` refuses an absent
acknowledgement; it does not verify one. The value of the record is that it
exists and is attributable, not that it was independently checked.

### Transcribed identifiers

A result alone is an attestation with nothing behind it: "I saw a valid
certificate" cannot afterwards be asked *which* certificate. So a passed check
also records the number on the document behind it.

`identifiers.ts` does three things:

- **Normalizes** — uppercase, strip everything but letters and digits. An ST
  certificate written `tr/st/2019-004471` and `TR-ST-2019-004471` is one
  certificate, and a check that missed that would report a clean file and be
  believed.
- **Folds a bank destination** — account number and branch code identify a
  destination only together, so they compare as one value.
- **Hashes what must not be readable** — identity and bank numbers become a
  keyed HMAC-SHA-256 digest; only the last four digits are kept, so a reviewer
  can confirm by eye. Keyed rather than plain because twelve digits is 10¹²,
  an afternoon's work: a plain digest column would be a lookup table, not a
  protection.

A match against a **different funding case** refuses the write and names both
the identifier and the application it was found on — a reviewer cannot judge a
match without being able to go and look, and staff already see every
application in the queue. The rule that a match is a question rather than a
verdict, and the four identifiers themselves, belong to the workflow guide's
[transcription section][transcribes].

### Configuration

`IDENTIFIER_SECRET` is required and must be at least 32 bytes.

It is deliberately **not** `AUTH_SECRET`: rotating session signing must never
silently stop the duplicate check matching what is already recorded. And it is
effectively **set once** — every stored digest was made with it, so a new
value stops matching everything recorded under the old one, and the check
would then pass everything, quietly.

It is read at first use rather than at startup, so a deployment missing it looks
healthy until the first desk review is completed, which then fails. Provision it
with the rest of the secrets, not afterwards.

### Money

Releases and reversals are an append-only ledger. Amounts are always positive;
direction comes from the entry type, and a correction is a compensating entry
that names the one it corrects. Sanction limits, over-reversal, and zero-balance
closure are recomputed **inside the write predicate**, never trusted from an
earlier read.

Award closure states its disposition explicitly: either the releases were
complete, or the programme decided not to release the remainder. A recovery case
opened in error can be cancelled while its ledger is empty; after the first
entry it must be corrected with reversals and closed at a derived zero balance.

The disbursement ledger and recovery entries are read **uncapped**, unlike every
other child collection. The totals are folded from exactly those rows, so a cap
would report a wrong figure rather than a short list.

## Queues and lists

Cursors are opaque `[sortKey, timestamp, id]`, default 20, cap 100. The cursor
records which column it was ordered by, so one presented under a different
ordering is refused rather than silently seeking the wrong column.

Nine named queues; `NEW_SUBMISSIONS` and `REVISION_RESPONSES` both hold
`SUBMITTED` and are separated by submission number. `queue` and `status` are
mutually exclusive and supplying both is refused rather than intersected into an
empty page. Every queue is reported including empty ones, so the counts stay
stable. Search is an indexed prefix — see
[the schema README](../../db/schema/README.md#searching).

Every list also returns `totalCount`, computed with the same predicates as the
page, so a client can say "1–20 of 143" and tell "no results" apart from "no
data yet".

## Documents

Staff download **fails closed**: the latest scan for that exact submitted file
must be `ACCEPTED`. It needs `STAFF_READ` and nothing more — a draft is refused
identically to an application that does not exist, so the path cannot be used
to discover which drafts exist. There is no
GraphQL mutation to accept a scan and there must never be one —
`recordDocumentScanResult` is called only by the queue consumer, which builds
whatever scanner `SCANNER_TRANSPORT` names. Cloudmersive genuinely examines the
file; unset means accepted-but-recorded-as-unexamined, which production
refuses. See the
[document scanner service](../document-scanner/README.md).

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `intakeQueue`, `intakeQueues`, `intakeByReference`, `intakeWorkspace` | `controllers/intake.ts` | The queue page, the chip counts, exact reference lookup, the whole case file |
| `addInternalNote` | `controllers/intake.ts` | Append-only staff note; a correction points at what it replaces |
| `startDeskReview`, `completeDeskReview`, `cancelRevisionRequest` | `controllers/intake.ts` | The review itself |
| `adminDocumentDownloadUrl` | `controllers/intake.ts` | Fail-closed signed download of a pinned file |
| `referApplicationToBank`, `recordBankOutcome`, `cancelBankReferral`, `correctBankOutcome` | `controllers/decision.ts` | The offline partner-bank stage |
| `recordDecision`, `correctDecision` | `controllers/decision.ts` | The programme's verdict; a correction supersedes |
| `fundingByApplication`, `createFundingAward`, `changeFundingAward` | `controllers/funding.ts` | The award |
| `recordFundingRelease`, `reverseFundingRelease` | `controllers/funding.ts` | The money ledger |
| `recordFundingAssessment` | `controllers/funding.ts` | Utilization, performance, financial audit |
| `recoveryById`, `openRecoveryCase`, `recordRecoveryEntry`, `closeRecoveryCase`, `cancelRecoveryCase` | `controllers/funding.ts` | Recovery |
| `createProgrammeCycle`, `openProgrammeCycle`, `closeProgrammeCycle`, `archiveProgrammeCycle` and the rest | `controllers/programme-cycle.ts` | Cycle lifecycle |
| `replaceFormTemplate`, `addFormStage`, `updateFormStage`, `removeFormStage`, `addFormQuestion`, `updateFormQuestion`, `removeFormQuestion`, `putFormGroupDefinition`, `removeFormGroupDefinition` | `controllers/form-template.ts` | The nine form-authoring mutations; every one re-validates the whole form |
| `analyticsSummary` | `controllers/analytics.ts` | The filtered intake, grouped along every reporting dimension |
| `formTemplateProblem` | `form-template-input.ts` | A template in, `null` or one refusal sentence out |
| `expandGroupDefinitions` | `group-definitions.ts` | Materialises structure members as `USE__MEMBER` fields, or names the first fault |
| `closeExpiredProgrammeCycles` | `controllers/programme-cycle.ts` | Hourly cron; at most 20 cycles per run |
| `recordDocumentScanResult` | `document-scanner.ts` | Appends a scan outcome. Not exposed |
| `identifierMatches` | `queries/intake.ts` | Which transcribed values exist on another case |
| `calculateRecoveryBalance` | `queries/funding.ts` | The pure accounting fold |
| `currentStaff`, `authorizeReasonedTransition`, `adminAudit`, `constraintSafe` | `support.ts` | The shared preamble every transition uses. `constraintSafe` is re-exported from `services/constraints.ts`, where it sits beside the rule that decides which failures mean *try again* — `services/auth` needs it too, and reaching into this package for it would make one service's helper another's dependency |

## Tests

`test/service/admin.test.ts` covers the workflow end to end;
`test/service/schema.test.ts` covers the constraints; the form authoring has
its own suites (`form-authoring.test.ts`, `form-authoring-refusals.test.ts`,
`group-definitions.test.ts`, `analytics.test.ts`, `cycle-admin.test.ts`). All
run under `npm run check`, whose coverage thresholds are a ratchet set just
below what the suite holds — see `vitest.service.config.ts`.

## Elsewhere

- [Workflow guide](../../../docs/admin-workflow-guide.md) — the rules in staff
  language
- [Layering rule](../README.md) — why controllers and queries both check
- [Schema](../../db/schema/README.md) — tables, versions, search indexes
- [RBAC](../../../docs/admin-rbac.md) — roles and grants

[transcribes]: ../../../docs/admin-workflow-guide.md#what-the-reviewer-transcribes
