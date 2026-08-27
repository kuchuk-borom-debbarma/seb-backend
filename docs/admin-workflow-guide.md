# Mission SEP administrator workflow

This guide explains the staff journey in business language and connects it to
the current administrative API. It complements the
[application guide](application-guide.md), the
[policy crosswalk](policy-alignment.md), and the
[RBAC guide](admin-rbac.md).

## Access after sign-in

Staff use the existing email/password sign-in. The portal reloads active roles
from the database on every request, so revocation takes effect on the next action.
Sign-in requires only one active role of any kind, so the bootstrapped first
administrator holds `SUPER_ADMIN` alone and signs in normally.

**Being able to read is what opens the office.** Four roles reach it, and what
each may then do differs:

| Role | In the office |
| --- | --- |
| Reviewer | Reads every screen here and changes nothing |
| Approver | Reads, and records or corrects the programme decision |
| Administrator | The whole workflow this guide describes |
| Super administrator | All of it, plus role administration and the history |

Each operation asks for the capability it needs rather than naming roles, so a
narrower role is refused by the operation rather than at the door. Where a
control is not available, the interface does not draw it — a button that cannot
work is worse than an absent one.

New staff arrive one of two ways. A super administrator grants a role directly,
or anybody who may invite sends an invitation the person accepts themselves, in
which case their applicant access is exchanged for the staff role. Both are
described in the
[administrator RBAC guide](admin-rbac.md#role-administration). A staff member
who forgets their password recovers it themselves from the sign-in screen,
proved by a code sent to their mailbox, and a reset ends every open session.

Every mutation uses one action below `mutation.admin`. Expected role loss,
stale versions, invalid transitions, and policy failures return the normal
`BaseResponse` failure envelope. They do not partially complete a workflow.

## Programme cycles: the policy window

A programme cycle is one published application window, for example “Mission
SEP 2026”. It is not an application batch or an applicant account. It contains
the opening/closing times, guidance, bank-roster text, jurisdiction, age and
category rules, expansion wait, required assessments, the application form
itself — its stages and questions, where a required document is a `FILE`
question like any other and may carry the same show-when conditions — the
reason catalogue, and funding-ceiling state.

Example: Rina starts phase 1 while cycle version 2 is open. Her draft pins
version 2. Staff may later correct public guidance or extend the closing time,
creating version 3, but Rina’s eligibility and evidence rules remain version 2.

Staff create and revise a draft, publish it with `open`, change only public
guidance or a future closing time after publication, then close and eventually
archive it. Closing stops new drafts; it does not strand existing submissions
or official revisions. The scheduled handler closes at most 20 expired cycles
per run. Opened cycles cannot be deleted.

## Authoring the application form

The questions a cycle asks are part of the cycle, authored on the cycle
editor's form screen and changed only while the cycle is a **draft** — once a
cycle opens, its form is frozen with everything else, and a change of question
means a new cycle version. Editing the form is `CYCLE_ADMIN` work, which only
a super administrator holds.

The form is a sequence of **stages**, each a titled step of the applicant's
journey, and each stage holds **questions**: text of several shapes, dates,
amounts, choices, attestations, statements the applicant only reads, document
uploads, and repeatable groups ("add each owner"). A question can carry
validation limits, presentation hints (a placeholder, an inline note, a width,
a prefix such as ₹), and conditions — "ask this only when that earlier answer
says so". A cycle can also define a **reusable structure** once — an Owner is
a name, a date of birth, a share — and use it in any repeated group, so the
same set of questions is never maintained twice.

Every edit is one mutation under `mutation.admin.formTemplate`
— add, update or remove a stage or a question, put or remove a structure, or
replace the whole form — and every one of them re-checks the **entire** form
before anything is saved, so a removal that would orphan a rule elsewhere is
refused with a sentence naming the question that would have been left
unanswerable. How the whole system works — the question types, the conditions,
the structures, the limits, and what the applicant's side does with it — is
the subject of the [form template guide](form-template-guide.md).

## Intake queues

Drafts never appear in intake, and asking for one by id is refused the same way
an unknown application is. The queue exposes the latest formal submission,
reference, enterprise, applicant, pinned cycle, phase/type, category, sector,
status, who holds it, submission time, and activity time. Staff may filter by
those dimensions and order by oldest waiting, newest submission, or last
activity.

Whoever worked a file last is named rather than left as an identifier, because
somebody looking at one another officer has touched is usually about to go and
ask them about it.

Staff may also search by the start of a reference number or an enterprise name.
It is a prefix match, not a free-text search, and the interface says so — a box
labelled "search" that silently means "starts with" would be discovered by
somebody typing a word from the middle of a name and getting nothing.

Pagination uses a stable timestamp-and-ID cursor, and every list reports how
many results there are in total, so a page can say where it sits in the set and
"nothing matches these filters" can be told apart from "nothing here yet".

### Named queues

Beyond ad-hoc filtering, `admin.intake.queue` accepts a `queue` key naming the
work list staff actually operate from, and `admin.intake.queues` returns the
count waiting in each. Every queue is reported, including empty ones, so the
chips stay stable rather than appearing and disappearing.

| Queue | Applications |
| --- | --- |
| `NEW_SUBMISSIONS` | `SUBMITTED`, submission number 1 |
| `REVISION_RESPONSES` | `SUBMITTED`, submission number above 1 |
| `DESK_REVIEW` | `DESK_REVIEW` |
| `PARTNER_BANK_EVALUATION` | `PARTNER_BANK_EVALUATION` |
| `AWAITING_DECISION` | `AWAITING_DECISION` |
| `APPROVED` / `REJECTED` / `SANCTIONED` / `DISBURSED` | the matching status |

The first two queues are why this is its own vocabulary rather than a reuse of
`ApplicationStatus`: a first submission and an answer to a revision request are
both `SUBMITTED` and need completely different handling. `CANCELLED` belongs to
no queue, because nobody works from it.

`queue` and `status` are mutually exclusive. Supplying both is refused rather
than silently intersected, which would return an empty page instead of the
queue that was asked for. Both accept an optional `cycleId`.

Nothing is reserved before it is worked on. Anybody holding the right role may
act, and two officers acting at once are settled by the version guard on the
transition itself: one succeeds and the other is told the record changed. The
screen says who was here last so the second can decide whether to duplicate the
effort, but it forbids nothing and disables nothing.

There used to be a mandatory claim, and it was removed because it was never
what made a write safe. It also had a cost: reading a document was gated on
holding the file, and a reviewer — the role whose entire job is reading
casework — could not hold anything, so the people who most needed to read
could not. The record of who worked a file survives as history, written as a
side effect of the work rather than as a step before it.

What replaced it as a gate is stronger. Advancing a stage requires transcribing
the numbers off the documents just read, which is evidence of having read them
in a way that pressing a button never was — see “What the reviewer
transcribes”.

If the officer acting is also the applicant, they must acknowledge it on the
transition that decides something: completing a desk review, or recording a
decision. The selected product rule permits the action and retains the
acknowledgement. TTAADC still needs to decide whether a second approval is
required before public launch.

## Analytics and filtering

`admin.analytics.summary` answers "what does the intake look like right now":
one filtered set of applications, counted along each dimension the office
reports on — status, category, sector, district, cycle — plus the requested
seed-fund total and average and a month-by-month submission series.

It takes **the queue's own filters**, so the summary always describes exactly
the set the queue would list: whatever combination of cycles, statuses,
categories, sectors, and districts is chosen, the numbers and the list agree.
Those filters accept several values at once — "Category A in West Tripura or
Khowai" is one query, not three.

The dimensions read live rows, not a reporting copy: sector and district come
from the enterprise's current profile, category from the pinned application
version, and the requested amount from the submitted answers. Dedicated
indexes on submission time, sector, and district keep the grouped counts a
seek rather than a scan.

## Frozen evidence and document safety

A submission freezes one application version and the exact version of every
document slot. Replacing the current GST file tomorrow cannot change the GST
file reviewed yesterday.

Every finalized file begins with a `PENDING` scan result and a queued request to
scan it. A trusted consumer appends `ACCEPTED`, `REJECTED` or `ERROR`; there is
deliberately no GraphQL "accept scan" mutation. Staff download fails closed
unless the latest scan for the exact submitted file is `ACCEPTED`. Any staff
role that can read casework can then open it — a download is a read, and it is
deliberately not tied to holding the file; only a draft is refused, identically
to an application that does not exist.

**A real scanner exists, and which one runs is configuration.** With
`SCANNER_TRANSPORT` set to `cloudmersive` and its API key configured, every
finalized file is genuinely examined before it becomes openable. Where no
scanner is configured — a developer's machine, or a deployment whose key has
not been issued yet — documents are accepted without being examined and the
scan history records `NO_SCANNER_CONFIGURED` against each one, so anybody
looking can tell an unexamined file from a checked one. Production refuses the
unexamined mode outright. See the
[document scanner service](../src/services/document-scanner/README.md).

Until the production key is issued and configured, staff document access in
production stays effectively closed even though the fail-closed contract and
the scanner both exist.

## Desk review and revisions

Starting review moves `SUBMITTED` to `DESK_REVIEW`. Completion records exactly
one result for each fixed check: identity/KYC, ST evidence, majority ownership,
jurisdiction, form completeness, document completeness, answer/document
consistency, DPR feasibility, and expansion evidence. An initial application
uses `NOT_APPLICABLE` only for expansion evidence; all applicable checks must
pass before bank referral. Submitted files must also have accepted scans.

### What the reviewer transcribes

A result alone is an attestation with nothing behind it: "I saw a valid
certificate" cannot afterwards be asked *which* certificate. So a passed check
also records the number on the document it was read from — the Scheduled Tribe
certificate for `ST_ELIGIBILITY`, the identity document for `IDENTITY_KYC`, and
the bank account with its branch code for `DOCUMENT_COMPLETENESS`. A business
registration number is accepted but never demanded, because an unregistered
enterprise has none. A check that is failed or not applicable asks for nothing.

Values are compared after case and separators are stripped, so
`tr/st/2019-004471` and `TR-ST-2019-004471` are one certificate. Identity and
bank numbers are stored as a keyed digest and never rendered back; the reviewer
confirms against the last four digits. The key is set once — every stored
digest was made with it, so changing it would silently stop the check matching
anything already recorded.

If a value already exists on a **different funding case**, the review is refused
and names both the identifier and the application it was found on. This is a
question, not a verdict: a second-phase expansion by the same promoter is
expected, so the reviewer either fails the check or states why it is not the
same claim, and that answer is retained beside the value that raised it.

Before this, the only identity-based duplicate guard in the programme was the
unique index on an enterprise's GSTIN — which an unregistered enterprise does
not have, so one person could carry two enterprises and two funding cases with
nothing linking them.

A financial inconsistency might produce a `FINANCIAL` revision request with an
approved reason and safe instruction: “Correct the requested amount to match
the DPR.” Only that stage becomes editable. Resubmission creates a new frozen
submission, resolves every open request, clears the former assignment, and
returns to intake. A mistaken request is cancelled with a reason and retained;
if no requests remain, the application returns to desk review.

Internal notes are append-only and staff-only. Correcting “Branch is Agartala”
means adding a note that references the original. Neither note enters applicant
events or general audit metadata.

## Offline bank evaluation

After a passing desk review, staff freeze the bank name, branch,
referral reference/date, exact submission, and completed review. Only one open
referral exists. An incorrect referral can be cancelled with an approved reason
and replaced without deleting history.

Staff append `RECOMMENDED`, `NOT_RECOMMENDED`, or
`MORE_INFORMATION_REQUIRED`. Both positive and negative feedback go on to be
decided. More information creates stage revision requests. Before the decision,
a mistake is corrected with a superseding outcome and a correction reason; once
a decision exists, bank evidence is locked.

## The programme decision

An application that clears the bank stage waits in `AWAITING_DECISION` and is
decided directly. There is no meeting to schedule and no agenda to build: the
gate is holding `DECIDE`, and the decision records which submission and which
bank outcome were read, so the file still shows what was in front of whoever
decided it.

The decision records one of:

- `APPROVED`: positive amount no greater than the submitted request, reference,
  date, conditions, and safe message;
- `REJECTED`: approved reason and safe message; or
- `REVISION_REQUIRED`: approved reason plus unique editable stages, each one a
  stage the application's own cycle declares.

A correction appends a superseding decision, and only to the application's most
recent one. It is blocked after an award or after a rejected phase has already
been retried, because downstream facts then require an award or recovery action
rather than rewriting the programme decision.

## Awards, releases, and assessments

An award is created only from the latest effective approval. It copies the
approved amount, requires a unique sanction order/date, and moves the
application to `SANCTIONED`. Amendments create immutable award versions, cannot
exceed the approval, and cannot reduce the amount below net releases.
Suspension blocks releases; cancellation is terminal and may lead to recovery.
Closing records whether all planned funds were released or whether the
programme deliberately decided not to release the remainder. That disposition
is retained in the current award and every immutable award version.

One release action records both the release approval and payment: amount,
unique external reference, occurrence time, verified bank account, executed
performance agreement, and physical verification when required. It cannot
exceed the remaining sanction. The first release makes the application
`DISBURSED`. Each release creates a separate utilization obligation due 180
UTC calendar days later.

Example: an award of ₹10 lakh has releases of ₹4 lakh and ₹3 lakh. It has two
utilization deadlines. A ₹1 lakh reversal against the first release leaves net
release of ₹6 lakh; it does not alter the second obligation. A reversal cannot
exceed the unreversed portion of its own release.

Utilization assessments belong to one release obligation. Performance and
financial-audit assessments belong to the award. Reassessment increments the
scope’s number. For expansion, every positively retained release’s latest
utilization result, plus the latest performance and financial-audit results,
must all be `PASSED` when required by the target cycle.

## Cancellation and recovery

Recovery may open only for a cancelled award with positive net funds and an
official decision reference. Staff append principal demands, externally
calculated penal-interest demands, receipts, waivers, and reversals of mistakes.
The portal does not calculate an interest rate.

Balances are derived from retained entries. A reversal may reference only a
same-case, same-component non-reversal entry and cannot over-reverse it.
Receipts and waivers cannot exceed their component’s outstanding balance.
Closure is guarded by a zero balance at write time, so a concurrent entry cannot
race a stale read and close a non-zero case.

If staff opened a recovery case in error and its ledger is still empty, they
may cancel it with a retained reason. Once any demand, receipt, waiver, or
reversal exists, cancellation is unavailable: staff correct the ledger with
compensating entries and close the case at zero balance.

## Visible versus internal information

Applicant-visible: cycle notices, revision instructions, bank status summary,
decision result/conditions, sanction status, release/reversal message, assessment
summary, and recovery message.

Internal only: correspondence notes, desk-check notes, deliberations, internal
assessment notes, R2 keys, checksums, filenames, download URLs, and security
data. General audit records contain public IDs and fixed lifecycle values—not
form contents, money, bank correspondence, notes, or credentials.

## Expected failures

- “Administrator access is required.”: no live administrative role.
- “The record changed. Reload and try again.”: the expected version or the
  lifecycle lost a race. This is the ordinary answer when two officers act on
  one file at the same moment, and it means nothing was overwritten.
- “Acknowledge that you are acting on your own application.”: the officer is
  the applicant and has not said so.
- Scan failure: the exact submitted file’s latest result is not accepted.
- Invalid transition: the current status or prerequisite evidence does not
  permit the requested next state.
- Constraint conflict: duplicate reference, sanction order, or
  accounting external reference.

## Public-launch blockers

Do not launch administrative operations to the public until the production
malware-scanner key is configured, privacy and access approval is obtained,
and the unresolved TTAADC policy decisions in the
[policy alignment guide](policy-alignment.md) are complete.

Role management, the narrower staff roles, invitations, the activity history,
account recovery, and rate limiting are all delivered. The scanner is a
**configuration** blocker rather than a missing feature: the seam, its
consumer and a real provider exist, and the development environments are
usable because they record plainly when nothing examined a file.
