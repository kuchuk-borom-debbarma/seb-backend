# Mission SEP

TTAADC's Mission SEP gives seed funding to first-generation Scheduled Tribe
entrepreneurs in Tripura's autonomous district areas. This repository is the
API that runs it, plus a browser client for demonstrating and exercising it.

One idea holds the whole system together: **an application is a file, and at
every moment somebody is holding it.** It carries one reference number from the
day it is submitted until the last rupee is accounted for, and every screen and
every operation answers the same question — whose turn is it now?

## The route a file takes

Four desks, eleven states.

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> SUBMITTED: applicant submits
    SUBMITTED --> DESK_REVIEW: officer starts the review
    DESK_REVIEW --> REVISION_REQUIRED: corrections asked for
    REVISION_REQUIRED --> SUBMITTED: applicant resubmits
    DESK_REVIEW --> PARTNER_BANK_EVALUATION: referred to a bank
    DESK_REVIEW --> REJECTED: closed at the desk
    PARTNER_BANK_EVALUATION --> AWAITING_DECISION: the bank has answered
    PARTNER_BANK_EVALUATION --> REVISION_REQUIRED: bank wants more
    AWAITING_DECISION --> APPROVED: the programme approves
    AWAITING_DECISION --> REJECTED: the programme rejects
    AWAITING_DECISION --> REVISION_REQUIRED: the programme wants more
    APPROVED --> SANCTIONED: sanction order issued
    SANCTIONED --> DISBURSED: first instalment released
    DISBURSED --> CANCELLED: award cancelled
    REJECTED --> [*]
    DISBURSED --> [*]
```

| Desk | Holds |
| --- | --- |
| **Applicant** | `DRAFT`, `REVISION_REQUIRED` |
| **Programme office** | `SUBMITTED`, `DESK_REVIEW`, `APPROVED`, `SANCTIONED`, `DISBURSED`, `REJECTED`, `CANCELLED` |
| **Partner bank** | `PARTNER_BANK_EVALUATION` |
| **Decider** | `AWAITING_DECISION` |

---

## What an applicant can do

In the order they do it. Every action names the operation that performs it, and
all of them require the `APPLICANT` role.

| # | What they do | Operation |
| --- | --- | --- |
| 1 | Sign up with an emailed one-time code, then set a password | `auth.startApplicantSignup`, `auth.verifyApplicantSignup` |
| 2 | Register the enterprise the application is for | `seb.enterprise.create` |
| 3 | See which programme cycles are open to apply in | `seb.application.availableProgrammeCycles` |
| 4 | Start an application — a first one, or a later phase | `seb.application.startInitial`, `startExpansion` |
| 5 | Answer the questions the cycle asks, saved as they type | `seb.application.saveDraft` |
| 6 | Attach evidence, uploaded straight to storage | `seb.application.issueDocumentUpload`, `finalizeDocumentUpload` |
| 7 | Check what is still missing before sending | `seb.application.validate` |
| 8 | Submit, which freezes a copy and issues the reference number | `seb.application.submit` |
| 9 | Watch where it is, in plain language | `seb.application.byId`, `statusGuide`, `timeline` |
| 10 | Answer a correction request — only the named stages unlock | `seb.application.saveDraft`, then `resubmit` |
| 11 | See the award, what has been paid, and what is still to come | `seb.application.funding` |
| 12 | Check whether they qualify for a later phase | `seb.application.expansionEligibility` |

They can also edit or remove an enterprise, delete and restore a draft, and see
their own signed-in devices. What they **cannot** reach is anything under
`admin` or `access` — an applicant opening the programme office is refused, and
told which portal their account can use.

## What the programme office can do

The office composes its own roles. A role is a name, a purpose, and a set of
**permissions** — a resource and an act on it, such as `application`/`read` or
`decision`/`record` — and a super administrator decides what each one holds.

The permissions themselves are fixed in code, in
[`auth/catalog.json`](src/services/auth/catalog.json): twelve resources,
twenty-three acts, thirty-eight pairs. The office may combine them freely but
cannot invent one, so a permission nothing enforces cannot be composed into a
role and read as coverage.

Roles are **not ranked** and do not contain one another. Two roles overlap or
they do not, and somebody holding both holds the union. Each operation names the
*permission* it needs rather than a role, so renaming or re-scoping a role
changes what people can do without any operation changing.

Holding the permission is the whole of it: there is nothing to reserve before
acting on a file. Two officers acting at once are settled by a version guard on
the transition, so one succeeds and the other is told the record changed. What
gates a stage is what the reviewer **types** — the numbers off the documents
they have just read — rather than a button they pressed beforehand.

Two authorities are decided in code rather than composed:

| Authority | What it is |
| --- | --- |
| `APPLICANT` | Applies for funding. Created only by verified signup, and nothing can grant it back. |
| `SUPER_ADMIN` | Everything the portal can do, and the only authority that composes a role or hands one out. |

A super administrator's access is the **wildcard**: a permission added to the
catalogue is theirs the moment it is added, with no migration and nothing to
backfill. That is why it is not a role — a row could be edited empty or retired,
and bootstrap closes permanently after the first grant, so the programme would
be locked out of its own administration with no way back.

Composing a role, and granting or revoking one, are absent from the catalogue
entirely. A role able to hand out roles could hand its own holder everything, so
the authority is one that cannot be written down and therefore cannot be granted
by mistake.

### What a role can be given

| Resource | Acts |
| --- | --- |
| `application` | `read` `note` `review` `refer` |
| `decision` | `record` `correct` |
| `funding` | `read` `award` `release` `reverse` `assess` |
| `recovery` | `read` `open` `record` `cancel` `close` |
| `programme_cycle` | `read` `create` `update` `open` `close` `archive` `delete` |
| `form_template` | `update` |
| `policy_document` | `read` `upload` |
| `announcement` | `read` `create` `update` `publish` `remove` `reorder` |
| `audit` | `read` `export` |
| `user` | `read` |
| `role` | `read` `invite` |
| `analytics` | `read` |

Reading a file and deciding it are different jobs, and so are deciding an
application and administering the programme it belongs to — but the office
decides where those lines fall by composing the roles it wants, rather than
living with a split the code chose.

### The operational workflow

| Stage | What they do | Operation |
| --- | --- | --- |
| Intake | Work the nine named queues | `admin.intake.queue`, `queues` |
| | See the filtered intake summarized for reporting | `admin.analytics.summary` |
| | Write a note nobody outside the office sees | `admin.intake.addInternalNote` |
| Desk review | Start it | `admin.intake.startDeskReview` |
| | Record nine checks, transcribe the numbers on the documents, and choose an outcome | `admin.intake.completeDeskReview` |
| | Withdraw a correction request made in error | `admin.intake.cancelRevision` |
| Bank | Refer the file to a partner bank | `admin.decision.referToBank` |
| | Record what the bank wrote back | `admin.decision.recordBankOutcome` |
| | Correct that record without erasing it | `admin.decision.correctBankOutcome` |
| Decision | Decide the application | `admin.decision.recordDecision` |
| | Supersede a decision recorded wrongly | `admin.decision.correctDecision` |
| Money | Issue the sanction order | `admin.funding.createAward` |
| | Release an instalment | `admin.funding.recordRelease` |
| | Correct a payment with a reversal | `admin.funding.reverseRelease` |
| | Record how the money was used | `admin.funding.recordAssessment` |
| | Open, work and close a recovery case | `admin.funding.openRecovery`, `recordRecoveryEntry`, `closeRecovery` |

Programme cycles are absent deliberately: writing a policy year and its form is
`programme_cycle` and `form_template` work, and shaping the programme is an
authority to hand out separately from working its casework.

### Shaping the programme

Separate permissions from working its casework, because a cycle's policy and
form decide who is eligible and for how much:

| What they do | Operation |
| --- | --- |
| Write a programme year's policy as a draft, revise it, and open it | `admin.programmeCycle.create`, `updateDraft`, `open` |
| Author the form a draft cycle asks — stages, questions, reusable structures | the nine mutations under `admin.formTemplate` |
| Change the closing time or the guidance an open cycle shows | `admin.programmeCycle.changeClosingTime`, `updateOpenGuidance` |
| Close, archive, soft-delete or restore a cycle | `admin.programmeCycle.close`, `archive`, `softDeleteDraft`, `restoreDraft` |
| Look somebody up by their exact address | `access.userByEmail`, `access.userById` |
| Read the history of who changed what | `audit.events`, `audit.actions` |

### Super administrator

Everything above, held as the wildcard rather than granted — and the operations
that cannot be granted at all:

| What they do | Operation |
| --- | --- |
| Compose a role, and say what it may do | `access.createRole`, `access.updateRole` |
| Retire a role, closing every grant of it | `access.deleteRole` |
| Grant a role, confirming with their own password | `access.grantRole` |
| Revoke a named grant, confirming with their own password | `access.revokeRole` |

The form a cycle asks is configuration, not code — see the
[form template guide](docs/form-template-guide.md).

An administrator who could create administrators would be a super administrator
by another name, which is why granting and revoking stay here.

### Bringing somebody into the office

Anybody who can invite — a holder of `role`/`invite`, or a super administrator
— names a person and a role. That person gets a link and **accepts it
themselves**, so the record always shows they agreed. Their applicant access is
exchanged for the staff role rather than added to it.

An invitation cannot exceed its issuer's authority: you may offer only a role
whose permissions you already hold yourself. A super administrator holds the
wildcard, so every role is theirs to offer — and nobody is ever invited to
super administrator. Nothing about the invitation is stored — it travels sealed
in the link, and what makes it single-use is that it only applies while the
person is still an applicant.

Three rules make this safe: `APPLICANT` can never be granted, because only
verified signup creates it and one revocation would otherwise strip somebody
permanently; the last usable super administrator cannot be revoked; and there is
deliberately no way to list accounts, so the namespace cannot be used to
enumerate them.

---

## Running it

```bash
npm install
cp .env.example .env.local          # then fill in the required values
psql postgresql://postgres:postgres@localhost:5432/postgres -c 'CREATE DATABASE seb_backend'   # once
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/seb_backend npm run db:migrate      # builds the schema
npm run local                       # the Worker, on http://localhost:9999
cd dev-web && npm install && npm run local   # the client, on :9990
```

GraphQL is at `http://localhost:9999/graphql`. The client points at the Worker
automatically.

### Configuration

`.env.example` is the checked-in template and documents every variable. Wrangler
loads `.env` then `.env.local`, the later winning, and both are gitignored.

**A leftover `.dev.vars` beats both.** Wrangler reads it first and ignores the
`.env` files entirely when it exists — the first thing to suspect when a change
appears to do nothing.

`AUTH_SECRET` and `IDENTIFIER_SECRET` are required, at least 32 bytes each. The
second is read at first use rather than at startup, so a deployment missing it
looks healthy until the first desk review is completed, which then fails.

`ENVIRONMENT` decides two things: where documents go, and whether one-time
codes are really sent. Unset means local — a deployed environment is always told
what it is — and locally uploads are written by the Worker itself and signup
codes are printed to its log on a line marked `DEV_EMAIL`. Nothing else needs
configuring for either to work.

Set it to `develop` and both want the real thing: four `R2_*` values for a
bucket, and `PINGRAM_API_KEY` with `PINGRAM_NOTIFICATION_TYPE` for delivery.
Missing either, the affected path refuses and says so, rather than quietly
falling back — a deployed system must not write live one-time codes to a log,
and must not accept documents it cannot durably keep.

### The first administrator

The database starts with no administrator, by design. Create one the way a real
deployment does — see the
[bootstrap guide](docs/first-super-admin-bootstrap.md). Once that one-time
route has been used it is closed permanently, so a database whose bootstrap is
already spent needs a `SUPER_ADMIN` row written directly — the guide says how,
and why nothing in this repository does it for you.

### Scripts

| Script | Does |
| --- | --- |
| `local` | The Worker on port 9999 |
| `check` | Typecheck, tests with coverage, `fallow`, every `check:*` guardrail, and the schema check |
| `typecheck` | `tsc --noEmit` |
| `test`, `test:coverage` | The service suite: Vitest on Node against a hermetic Postgres |
| `test:runtime` | What genuinely needs workerd — storage, queue handles, edge limits — in the Workers pool |
| `test:neon` | The service suite against a Postgres named by `TEST_DATABASE_URL` |
| `fallow` | Dead code, duplication and complexity |
| `test:worker` | The isolated Worker the end-to-end suite drives |
| `test:e2e-db` | Drops, recreates and migrates the suite's own database — `test:worker` runs it first |
| `db:generate` | Writes the next migration from the Drizzle schema's diff against the chain |
| `db:migrate` | Applies pending migrations to the database `DATABASE_URL` names |
| `db:schema:generate` | Rewrites `database/schema.sql` from the Drizzle schema |
| `db:schema:check` | Fails if the two have diverged, or if the schema will not re-apply |
| `check:sdl` … `check:scanner` | Ten focused guardrails: SDL descriptions, audit actions, the permission catalogue, client permission gates, insert arity, untyped comparisons, SQL aliases, rate-limit coverage, the document size limit, scanner and deploy configuration |
| `cf-typegen` | Regenerates `worker-configuration.d.ts` |
| `deploy` | Checks the deploy configuration, then `wrangler deploy --minify` |

`database/schema.sql` is generated, never hand-edited: change the Drizzle schema
and run `db:schema:generate`.

`check:client-gates` is the client half of `check:catalog`. That one fails when
a catalogue pair is enforced nowhere on the server; this one fails when a screen
can send two differently-guarded operations and never asks about one of them —
which is how a role composed to record a decision came to be offered a
correction the API refuses. It pairs with `noUnusedLocals`: this proves the
permission is asked for, and the compiler proves the answer is used, because a
flag that stops gating a control becomes an unread binding.

It covers **mutations only**, and that limit is deliberate rather than
forgotten. Guarded reads belong in it too, but a screen imports
`managedUserQuery` from a `*Queries` module rather than naming the document, so
proving which reads a screen makes means resolving which *export* it imported.
Attributing every document in a module to every importer was tried and reported
four screens for reads they do not make — and a check that over-reports gets
switched off.

`fallow` gates dead code, duplication and complexity, and its thresholds live in
[`.fallowrc.json`](.fallowrc.json) with a written reason beside each override —
a raised limit with no sentence explaining it is indistinguishable from one
nobody thought about. One rule is deliberately a warning rather than a gate:
`private-type-leaks` reports an exported signature naming a type nothing imports
directly, and this repository has a handful on purpose. Four are the alphabet
`AnswerMap` is written in and the engine types two application controllers
return; declaring either locally would put a second copy of the form vocabulary
in a second file. The rest are the auth service's own authorization vocabulary —
`Authority`, `ManagedRole`, `Permission`, `PermissionCatalogue` — named by the
guards and role operations that return them, and consumed by GraphQL resolvers
that are one-line delegations naming no types by design. It stays on as a
warning so a genuinely leaked type is still reported.

---

## Where everything is written down

Four layers, and each subject has exactly one owner. The rule is
[`docs/rules/documentation.md`](docs/rules/documentation.md).

**The programme — what the rules are**

- [Application guide](docs/application-guide.md) — the applicant's journey
- [Administrator workflow guide](docs/admin-workflow-guide.md) — the office's
- [Form template guide](docs/form-template-guide.md) — the dynamic application
  form, end to end
- [RBAC](docs/admin-rbac.md) — roles, grants, and the bootstrap
- [Bootstrap runbook](docs/first-super-admin-bootstrap.md) — the first
  administrator
- [Policy crosswalk](docs/policy-alignment.md) — which rules came from TTAADC,
  which are product decisions, and what is still undecided
- [Roadmap](docs/ROADMAP.md) — what is built and what is not

**The code — how it implements them**

- [Services](src/services/README.md) — the layering rule, and why two layers
  check the same things
- [Applicant service](src/services/application/README.md)
- [Administrative service](src/services/admin/README.md)
- [Authentication service](src/services/auth/README.md)
- [Audit](src/services/audit/README.md) — reading who changed what
- [Storage](src/services/storage/README.md) — a bucket, or this Worker
- [Notifications](src/services/external-notification/README.md)
- [Queue](src/services/queue/README.md) — work done after the response
- [Document scanner](src/services/document-scanner/README.md) — whether a file
  is safe to open
- [GraphQL layer](src/graphql/README.md) — the API surface and its limits
- [Database schema](src/db/schema/README.md) — tables, versions, constraints

**The client** — [dev-web](dev-web/README.md)

**The rules** — [docs/rules](docs/rules/README.md): how documentation is
owned, [what good code looks like here](docs/rules/code.md), and
[what it must protect](docs/rules/security.md)

## How it is built

Cloudflare Workers, Hono, GraphQL Yoga, Drizzle over Neon Postgres through
Hyperdrive, R2 or Cloudinary for documents, and a Queue carrying document-scan
requests. The
Worker has three entrypoints: `fetch`, an hourly `scheduled` handler running
three cleanup jobs, and a `queue` consumer that scans a finalized document.

Five of the nine services exist to be **swapped** — notification, storage,
queue, the document scanner, and the rate limiter. Each is an interface
stated in the programme's own words, with one file per implementation and a
factory that picks by environment. That is what lets the whole portal run on a
machine with nothing configured: documents are written by the Worker itself,
one-time codes are printed rather than sent, and scan requests are drained after
the response.

Everything is refused server-side. The client asks the same permission question
the API does, but only to decide what is *offered*; it is never the security
boundary.

The working agreement for changing any of this is [`AGENTS.md`](AGENTS.md).
