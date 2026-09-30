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

**Being able to read a screen is what opens the office.** What each person may
then do is whatever the roles they hold add up to, and the office composes those
roles itself — so this guide describes the *work*, and
[`docs/admin-rbac.md`](admin-rbac.md) describes how somebody comes to be allowed
to do it.

A role holds **permissions**: a resource and an act on it, such as
`application`/`read` or `stage`/`decide`. A super administrator may do
everything, and is the only authority that composes a role or hands one out.

**Casework also depends on which stages your roles own.** A pipeline's stages
each list the roles that work them. You act at a stage only if one of your roles
owns it *and* you hold the permissions the action needs, so two bank officers
with identical permissions still see only their own bank's files.

Each operation asks for the permission it needs rather than naming a role, so a
narrower role is refused by the operation rather than at the door — and a role
renamed or re-scoped changes what people can do without any operation changing.
Where a control is not available, the interface does not draw it: a button that
cannot work is worse than an absent one.

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
SEP 2026”. It is not an application batch or an applicant account. It contains:
- the opening and closing times, guidance, jurisdiction, and age and category
  rules;
- the **pipeline** its applications are worked in, and the funding ceiling;
- the **kinds of application** it accepts, each with its eligibility rules;
- the application form itself: its stages and questions (a required document
  is a `FILE` question like any other), and its rules about several answers at
  once;
- the reason catalogue.

Example: Rina starts phase 1 while cycle version 2 is open. Her draft pins
version 2. Staff may later correct public guidance or extend the closing time,
creating version 3, but Rina’s eligibility and evidence rules remain version 2.

Staff create and revise a draft, publish it with `open`, change only public
guidance or a future closing time after publication, then close and eventually
archive it. **Opening pins the pipeline's current published version** and
refuses a form the pipeline cannot read: every answer the pipeline reads must be
a top-level question of the type it expects. Choosing a pipeline needs
`pipeline`/`read` as well as the cycle permission, and only a published,
unretired pipeline can be chosen. Closing stops new drafts; it does not strand existing submissions
or official revisions. The scheduled handler closes at most 20 expired cycles
per run. Opened cycles cannot be deleted.

## Authoring the application form

The questions a cycle asks are part of the cycle, authored on the cycle
editor's form screen and changed only while the cycle is a **draft** — once a
cycle opens, its form is frozen with everything else, and a change of question
means a new cycle version. Editing the form needs `form_template`/`update`,
which the office grants deliberately: the questions decide who is eligible and
for how much.

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

## Finding the files to work

Drafts never appear to the office, and asking for one by id is refused the same
way an unknown application is.

**My stages** is where an officer starts. It lists every stage their roles own,
with how many files wait at each; a super administrator sees every stage of
every published pipeline. Each opens that **stage's queue**: its files oldest
first, with how long each has waited, its flags and recorded values, filterable
by the flags a file holds.

**The office-wide list** (`admin.intake.queue`) is for searching rather than
working. What it shows depends on the reader:
- `application`/`read` lists every submitted file;
- `stage`/`read` lists the files at stages your roles own, and the files you
  have acted on;
- the total counts only what the reader may see.

It filters by cycle, kind, category, sector, district, submission dates, the
requested grant and loan, and by **pipeline, stage and flags** (a file must hold
every flag chosen). Each row shows its stage's name and its flags' labels from
the version it is worked in, and what was asked for. It orders by oldest
waiting, newest submission or last activity.

Staff may also search by the start of a reference number or an enterprise name.
It is a prefix match, not a free-text search, and the interface says so — a box
labelled "search" that silently means "starts with" would be discovered by
somebody typing a word from the middle of a name and getting nothing.

Pagination uses a stable timestamp-and-ID cursor, and every list reports how
many results there are in total, so a page can say where it sits in the set and
"nothing matches these filters" can be told apart from "nothing here yet".

Nothing is reserved before it is worked on. Anybody who may act, acts, and two
officers acting at once are settled by the version guard on the write itself:
one succeeds and the other is told the file changed and offered a reload.

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

## Working a stage

The application page's **stage panel** is the whole desk:
- where the file is, and what the applicant is told about that stage;
- the trail of stages it came through, its flags and its recorded values, such
  as the approved grant;
- open correction requests;
- its stage history: who took which action, when, and what they entered;
- **the actions offered to you.** An action you may not take is shown disabled,
  with the reason. The panel asks the same question the write does, so it never
  offers a button that will be refused.

Taking an action opens a dialog with the action's inputs — an amount, a bank, a
note, a date — pre-filled where the pipeline says so, such as the bank the
applicant chose first. The inputs obey the same rules as the applicant's form,
and a refused one is shown against its field. An amount above what the
applicant asked for, or above the cycle's ceiling, is refused and nothing is
written. What each action does is the pipeline's to say; see the
[pipeline guide](pipeline-guide.md).

**Corrections.** An action that asks the applicant for corrections names the
sections of their form that need changing, each with a note. The file stays at
the stage, the applicant can edit only those sections, and when they resubmit
the file **returns to the stage that asked**, not to the start. A request made
in error can be withdrawn with a reason; withdrawing the last one hands the file
back to the office at the same stage.

**Sending back.** A send-back returns the file to the stage it actually came
from, along its own trail. A file sent to the Tripura Gramin Bank and sent back
returns to Industries & Commerce, which may then route it to the State Bank of
India instead.

**Acting on your own application.** If the officer acting is also the
applicant, they must say so on the action. It is then recorded beside the
action in the history. TTAADC still needs to decide whether a second approval
is required before public launch.

**Notes.** A staff note is kept where an action asks for one, or added on its
own; nobody outside the office sees it.

Money after approval — the sanction order, instalments, assessments and
recovery — is not yet part of the portal; the
[roadmap](ROADMAP.md) tracks it.

## Visible versus internal information

Applicant-visible: cycle notices, correction instructions, the current stage's
applicant label and explanation, how the journey ended, and only the flags and
recorded values the pipeline marks applicant-visible.

Internal only: staff notes, officer inputs, flags and recorded values the
pipeline keeps from the applicant, storage keys, checksums, filenames, download
URLs, and security data. The activity history records what an action did and
what was entered as labelled values, but never long free text such as a note.

## Expected failures

- “You do not have permission to do that.”: no permission for the operation,
  or the stage is not one your roles own. It names no role on purpose.
- “The record changed. Reload and try again.”: the expected version or the
  lifecycle lost a race. This is the ordinary answer when two officers act on
  one file at the same moment, and it means nothing was overwritten.
- The acting-on-your-own-application refusal: the officer is the applicant and
  has not said so.
- An input refused against its field: the inputs break the action's rules, or
  an amount is above what was asked for or the cycle's ceiling.
- Scan failure: the exact submitted file’s latest result is not accepted.
- Not offered now: the action's conditions do not hold for this file, such as
  approving a grant that was already approved.
- Constraint conflict: a duplicate reference.

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
