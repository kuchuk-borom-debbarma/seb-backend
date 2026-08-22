# Mission SEP administrator workflow

This guide explains the staff journey in business language and connects it to
the current administrative API. It complements the [application guide](application-guide.md),
the [policy crosswalk](policy-alignment.md), and the [RBAC guide](admin-rbac.md).

## Access after sign-in

Staff use the existing email/password sign-in. The portal reloads active roles
from D1 on every request. A current `ADMIN` or `SUPER_ADMIN` grant opens the
`admin` GraphQL namespace; revocation takes effect on the next request.
`SUPER_ADMIN` includes ordinary administrative capability. Sign-in requires
only one active role of any kind, so the bootstrapped first administrator holds
`SUPER_ADMIN` alone and signs in normally.

A super administrator provisions further administrators under the separate
`access` namespace, described in the
[administrator RBAC guide](admin-rbac.md#role-administration). Account recovery
remains a launch blocker.

Every mutation uses one action below `mutation.admin`. Expected role loss,
stale versions, invalid transitions, and policy failures return the normal
`BaseResponse` failure envelope. They do not partially complete a workflow.

## Programme cycles: the policy window

A programme cycle is one published application window, for example “Mission
SEP 2026”. It is not an application batch or an applicant account. It contains
the opening/closing times, guidance, bank-roster text, jurisdiction, age and
category rules, expansion wait, required assessments, document conditions,
reason catalogue, and funding-ceiling state.

Example: Rina starts phase 1 while cycle version 2 is open. Her draft pins
version 2. Staff may later correct public guidance or extend the closing time,
creating version 3, but Rina’s eligibility and evidence rules remain version 2.

Staff create and revise a draft, publish it with `open`, change only public
guidance or a future closing time after publication, then close and eventually
archive it. Closing stops new drafts; it does not strand existing submissions
or official revisions. The scheduled handler closes at most 20 expired cycles
per run. Opened cycles cannot be deleted.

## Intake queues and claiming

Drafts never appear in intake, and claiming one is refused the same way an
unknown application is. The queue exposes the latest formal submission,
reference, enterprise, applicant, pinned cycle, phase/type, category, sector,
status, assignee, submission time, and activity time. Staff may filter by those
dimensions and order by oldest waiting, newest submission, or last activity.
Pagination uses a stable timestamp-and-ID cursor.

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
| `TTM_REVIEW` | `TTM_REVIEW` |
| `APPROVED` / `REJECTED` / `SANCTIONED` / `DISBURSED` | the matching status |

The first two queues are why this is its own vocabulary rather than a reuse of
`ApplicationStatus`: a first submission and an answer to a revision request are
both `SUBMITTED` and need completely different handling. `CANCELLED` belongs to
no queue, because nobody works from it.

`queue` and `status` are mutually exclusive. Supplying both is refused rather
than silently intersected, which would return an empty page instead of the
queue that was asked for. Both accept an optional `cycleId`.

Claiming is mandatory because it answers “who owns the next decision?” and is
the concurrency lock for workflow actions. Two simultaneous claims are
first-writer-wins. Release and reassignment use a reason approved by the pinned
cycle and retain immutable assignment history.

If the assignee is also the applicant, they must explicitly acknowledge the
conflict. The selected product rule permits the action but retains the
acknowledgement. TTAADC still needs to decide whether a second approval is
required before public launch.

## Frozen evidence and document safety

A submission freezes one application version and the exact version of every
document slot. Replacing the current GST file tomorrow cannot change the GST
file reviewed yesterday.

Every finalized file begins with a `PENDING` scan result. A future trusted
scanner calls an internal function to append `ACCEPTED`, `REJECTED`, or `ERROR`;
there is deliberately no GraphQL “accept scan” mutation. Staff download fails
closed unless the latest scan for the exact submitted file is `ACCEPTED`, and
the staff member currently owns the assignment.

The scanner provider is not connected. Therefore staff document access and
public launch remain blocked even though the fail-closed contract exists.

## Desk review and revisions

Starting review moves `SUBMITTED` to `DESK_REVIEW`. Completion records exactly
one result for each fixed check: identity/KYC, ST evidence, majority ownership,
jurisdiction, form completeness, document completeness, answer/document
consistency, DPR feasibility, and expansion evidence. An initial application
uses `NOT_APPLICABLE` only for expansion evidence; all applicable checks must
pass before bank referral. Submitted files must also have accepted scans.

A financial inconsistency might produce a `FINANCIAL` revision request with an
approved reason and safe instruction: “Correct the requested amount to match
the DPR.” Only that section becomes editable. Resubmission creates a new frozen
submission, resolves every open request, clears the former assignment, and
returns to intake. A mistaken request is cancelled with a reason and retained;
if no requests remain, the application returns to desk review.

Internal notes are append-only and staff-only. Correcting “Branch is Agartala”
means adding a note that references the original. Neither note enters applicant
events or general audit metadata.

## Offline bank evaluation

After a passing desk review, the assignee freezes the bank name, branch,
referral reference/date, exact submission, and completed review. Only one open
referral exists. An incorrect referral can be cancelled with an approved reason
and replaced without deleting history.

Staff append `RECOMMENDED`, `NOT_RECOMMENDED`, or
`MORE_INFORMATION_REQUIRED`. Both positive and negative feedback proceed to
TTM. More information creates section revision requests. Before TTM acts, a
mistake is corrected with a superseding outcome and a correction reason; after
a TTM decision, bank evidence is locked.

## TTM meetings and decisions

A draft meeting has a unique reference, time, venue, description, and at most
20 active agenda items. An agenda item pins the application, submission, and
latest bank outcome. Staff may reorder or remove items only while the meeting
is draft. Starting the meeting locks evidence. Finalization succeeds only when
no active item lacks an outcome; cancellation retains meeting and agenda
history while releasing active applications for a later agenda.

TTM records one of:

- `APPROVED`: positive amount no greater than the submitted request, reference,
  date, conditions, and safe message;
- `REJECTED`: approved reason and safe message;
- `DEFERRED`: approved reason and next programme action; or
- `REVISION_REQUIRED`: approved reason plus unique editable sections.

A correction appends a superseding decision. It is blocked after an award or
after a rejected phase has already been retried, because downstream facts then
require an award or recovery action rather than rewriting the programme
decision.

## Awards, releases, and assessments

An award is created only from the latest effective approval. It copies the
approved amount, requires a unique sanction order/date, and moves the
application to `SANCTIONED`. Amendments create immutable award versions, cannot
exceed the approval, and cannot reduce the amount below net releases.
Suspension blocks releases; cancellation is terminal and may lead to recovery.
Closing records whether all planned funds were released or whether the
programme deliberately decided not to release the remainder. That disposition
is retained in the current award and every immutable award version.

One release action records both the TTM release approval and payment: amount,
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
TTM result/conditions, sanction status, release/reversal message, assessment
summary, and recovery message.

Internal only: correspondence notes, desk-check notes, deliberations, internal
assessment notes, R2 keys, checksums, filenames, download URLs, and security
data. General audit records contain public IDs and fixed lifecycle values—not
form contents, money, bank correspondence, notes, or credentials.

## Expected failures

- “Administrator access is required.”: no live administrative role.
- “The record changed. Reload and try again.”: expected version, assignment, or
  lifecycle lost a race.
- “Claim the application…”: the actor is not the current assignee.
- Scan failure: the exact submitted file’s latest result is not accepted.
- Invalid transition: the current status or prerequisite evidence does not
  permit the requested next state.
- Constraint conflict: duplicate reference, active claim, agenda position,
  sanction order, or accounting external reference.

## Public-launch blockers

Do not publicly launch administrative operations until account recovery, a
production malware scanner, rate limits, privacy/access approval, and the
unresolved TTAADC policy decisions in the
[policy alignment guide](policy-alignment.md) are complete. Role management is
delivered.
