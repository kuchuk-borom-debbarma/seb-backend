# Database schema and application lifecycle

This directory is the living design guide for the Mission SEP database. It
explains how an applicant's real application journey becomes tables, where the
authoritative data lives, and which assumptions must be revisited as policy and
features evolve.

The primary business source is the TTAADC Mission SEP policy and application
form. The UI/UX flow guide informs screen order and user experience, but it does
not override the policy form. Product decisions agreed during implementation
are recorded under [Current assumptions](#current-assumptions).

## How an application works

An authenticated `core_user` is the portal account. The account may own several
enterprises because one promoter can operate more than one business. Each
`seb_enterprise` has exactly one portal owner today and stores the enterprise's
current canonical profile.

Each enterprise has one long-lived `seb_funding_case`. The case is the complete
Mission SEP funding history for that enterprise across policy years. It groups
the initial application, any later expansion applications, awards,
disbursements, and assessments.

```text
core_user
  └── seb_enterprise (one user may own many)
        └── seb_funding_case (exactly one per enterprise)
              ├── seb_application: INITIAL, phase 1
              │     └── seb_funding_award
              │           ├── seb_disbursement
              │           └── seb_award_assessment
              └── seb_application: EXPANSION, phase 2 or greater
                    └── links to one qualifying earlier award

seb_programme_cycle
  └── identifies the policy/application window for each application
```

The expected application lifecycle is:

1. The applicant signs up and verifies their email.
2. They create or select an enterprise. A new enterprise also receives its one
   Mission SEP funding case.
3. They start an application in an open programme cycle. The first application
   is `INITIAL` with phase `1`; later applications are `EXPANSION` with phase
   `2` or greater.
4. Meaningful saves create complete immutable `seb_application_version`
   snapshots, including the exact programme-cycle version and phase
   classification. Draft form fields remain nullable until submission
   validation runs.
5. Documents occupy stable logical slots in `seb_application_document`.
   Replacements create new immutable file versions with new R2 object keys.
6. Submission creates an append-only `seb_application_submission` and
   `seb_application_submission_document` rows pointing to the exact form and
   file versions reviewed by TTAADC.
7. Review transitions and applicant-visible messages are recorded in
   `seb_application_event`. A correction request is added as a
   `seb_revision_request`; an incorrect request is cancelled and replaced, not
   edited.
8. Assignment, desk review, offline bank evidence, and TTM meeting/decision
   records retain the complete administrative path without editing older facts.
9. A sanctioned application receives one `seb_funding_award`. Releases and
   compensating reversals are recorded in the append-only disbursement ledger,
   while utilization, performance, and audit results accumulate as assessments.
10. Every release creates a separate 180-day utilization obligation. A
   cancelled award with retained funds may open a versioned recovery case whose
   entries remain append-only.
11. An expansion application links to one authoritative earlier award through
   `seb_application_qualifying_award`. Corrections and cancellations create
   immutable `seb_application_qualifying_award_version` rows, so an incorrect
   association is never overwritten or deleted. The future application service
   derives eligibility from the preceding phase, retained disbursement dates,
   and competing applications rather than trusting a manual
   Phase-II flag.

## Why the schema has both current rows and versions

Mutable business roots—enterprise, programme cycle, funding case, application,
document, award, and qualifying-award link—store stable IDs and the small
set of current fields needed for fast lists, ownership checks, uniqueness, and
optimistic concurrency. Each root also has a dedicated immutable version table
containing the complete state accepted at that version.

This intentional duplication serves two different questions:

- The root answers, “What is current now?”
- The version answers, “What was true when this save, submission, or decision
  happened?”

For example, `seb_enterprise.current_name` may change after a legal-name update,
but an older `seb_application_version.business_name` never changes. Reviewers
therefore always see the form that was actually submitted, not today's
enterprise profile.

Version rows, submissions, events, disbursements, and assessments are
append-only contracts. Service/query modules must expose no update or delete
functions for them. Database triggers are intentionally not used; the service
layer will guard version creation and use `current_version` or `status_version`
for optimistic concurrency.

## Domain inventory

### `core`: reusable identity and audit

- `core_user`: verified portal identity, password hash, and soft deletion. Roles
  are intentionally not copied onto the identity row.
- `core_user_role_grant`: retained assignments for the fixed `APPLICANT`,
  `ADMIN`, and `SUPER_ADMIN` roles. A partial unique index allows one active
  grant per user/role while preserving revoked and re-granted history.
- `core_session`: short-lived login sessions. This is the only table whose rows
  are intentionally hard-deleted on sign-out, revocation, user deletion, or
  expiry.
- `core_signup_challenge`: retained OTP challenge lifecycle without raw OTPs or
  tokens.
- `core_audit_event`: append-only security and administrative audit trail. It
  must never contain credentials, OTPs, tokens, digests, or document contents.
  Two rules make that structural rather than a matter of care: `changes_json` is
  written as `NULL` unconditionally by every builder, and metadata is typed as a
  flat `Record<string, string | number | boolean | null>`, so a form object
  cannot be logged by accident. `action` comes from a closed catalogue of names
  rather than a free string, so audit queries cannot be defeated by a typo.

### `seb`: enterprise and application workflow

- `seb_enterprise` / `seb_enterprise_version`: canonical business identity and
  complete immutable profile history.
- `seb_programme_cycle` / `seb_programme_cycle_version`: versioned Mission SEP
  policy/application windows such as 2026 and later cycles.
- `seb_programme_cycle_document_rule`, `…_assessment_rule`,
  `…_identifier_rule`: what one cycle version demands. All three carry a
  composite foreign key on `(programme_cycle_id, programme_cycle_version)`, so a
  rule belongs to a *version* and editing a cycle cannot change what an
  already-submitted application is judged by.

  The identifier rules carry **two independent settings**, which is the point of
  the table. `requirement` is `REQUIRED_ON_PASS`, `OPTIONAL` or `OFF`;
  `duplicate_policy` is `CHECKED` or `NOT_CHECKED`. A bank account can be
  collected without a match ever blocking anybody — joint and family accounts
  are real — and a certificate can be compared without being demanded when its
  check is `NOT_APPLICABLE`. A `CHECK` enforces that `REQUIRED_ON_PASS` names a
  real desk-review check and that nothing else names one, because only a
  requirement conditional on a check has a moment at which it applies.

  **No rows means the cycle demands nothing and compares nothing.** That is the
  honest default for a table that did not exist yesterday, and it is what keeps
  cycles created before it working unchanged.
- `seb_funding_case` / `seb_funding_case_version`: the enterprise's single
  long-running Mission SEP funding chain.
- `seb_application` / `seb_application_version`: current workflow head and full
  immutable copies of the application form.
- `seb_application_submission`: formal submission/resubmission history tied to
  exact application versions.
- `seb_application_submission_document`: exact logical slots and immutable file
  versions frozen into each submission.
- `seb_application_document` / `seb_application_document_version`: logical
  evidence slots and immutable R2 upload/replacement history.
- `seb_application_document_scan`: append-only scanner outcomes; the latest
  result must be accepted before staff download.
- `seb_revision_request`: immutable reviewer correction requests and their
  resolution or cancellation metadata.
- `seb_application_event`: append-only applicant-facing workflow timeline.
- `seb_application_assignment_event`: append-only history of who a file passed
  to; the head keeps only the most recent for fast queues. **Advisory, not a
  lock** — nothing reads it to decide whether a write is allowed, and it is
  written as a side effect of the work rather than as a step before it.
- `seb_application_internal_note`: staff-only append-only notes and corrections.
- `seb_desk_review` / `seb_desk_review_check`: frozen submission outcome and
  fixed initial scrutiny checklist. `conflict_acknowledged` records whether the
  reviewer declared the application was their own — permitted with disclosure,
  and the disclosure is kept beside the judgement it qualifies.
- `seb_desk_review_identifier`: append-only record of the numbers a reviewer
  read off the documents a check passed. Stores a normalized value for public
  instruments and a keyed digest for identity and bank numbers, never the whole
  number — only the last four digits, so a reviewer can confirm by eye.
  Carries a copy of `funding_case_id` so the duplicate question is one seek
  rather than a walk through reviews and applications; the copy cannot drift
  because an application's funding case is fixed when it is created.
- `seb_partner_bank_referral` / version / outcome: offline bank identity,
  referral lifecycle, feedback, and superseding corrections.
- `seb_ttm_meeting` / version / agenda / decision: formal meetings, pinned
  evidence, agenda changes, and append-only programme decisions. A decision
  carries its own `conflict_acknowledged`, and so does each superseding
  correction, because each is a separate act by a possibly different officer.

### `seb`: awards and derived expansion eligibility

- `seb_funding_award` / `seb_funding_award_version`: the authoritative sanction
  created for one application.
- `seb_application_qualifying_award` /
  `seb_application_qualifying_award_version`: the current earlier-award link and
  immutable link/correction/cancellation history for an expansion application.
- `seb_disbursement`: positive release and reversal ledger entries; corrections
  use compensating reversals, never updates.
- `seb_utilization_obligation`: one 180-day evidence deadline per release.
- `seb_award_assessment`: retained utilization, performance, and financial-audit
  results. The highest assessment number for each award and type is current.
- `seb_recovery_case` / version / entry: current recovery state, immutable
  lifecycle history, and append-only demands, receipts, waivers, and reversals.

## How the application form maps to snapshots

`seb_application_version` is a complete snapshot because the policy form is a
legal/business record. Its nullable draft fields are grouped as follows:

- Classification: exact programme-cycle version, initial/expansion type, and
  phase number. These remain historical even if the current heads are corrected.
- Enterprise: business name, establishment date, CIN/Udyam details, GSTIN,
  sector, Category A/B, and majority-ownership confirmation.
- Applicant/promoter: name, designation, birth date, gender, business address,
  phone, and email.
- Financial proposal: project cost, requested seed fund, proposed bank loan,
  and promoter contribution.
- Prior funding and credit: applicant-declared government funding and bank
  credit details.
- Expansion facts: prior sanction order/date, net retained disbursement, and
  continuous-operation months are derived by the backend from the qualifying
  award and append-only ledger, then frozen into the submitted snapshot.
- Declaration: relationship, related person, acceptance time, and place.
- Evidence: documents live in their own versioned tables rather than inside the
  form snapshot.

There is deliberately no ST certificate number column. ST evidence remains a
supported document type. There is also no `is_phase_two` or
`is_expansion_funding` Boolean: `application_type`, `phase_number`, the funding
case, and the qualifying award express the relationship without contradictory
state.

## Integrity rules

Composite foreign keys enforce ownership and domain boundaries even if a future
query is wrong:

- An application's applicant must be the portal owner of its enterprise.
- An application's funding case must belong to that same enterprise.
- An award's application must belong to the award's funding case.
- A qualifying application and qualifying award must belong to the same case.
- A qualifying-award correction retains its previous award in an immutable
  version; cancellation clears only the current unique pointer.
- A reversal can reference only a disbursement from the same award.
- Submissions, revisions, and events can reference records only from their own
  application.

Foreign keys use `RESTRICT`/`NO ACTION`; none use `CASCADE`. Business roots are
soft-deleted with `deleted_at`, `deleted_by_user_id`, and `delete_reason`, so an
email, enterprise, application, document slot, sanction order, or historic link
cannot silently be reused. Sessions are the deliberate exception and are
physically removed to prevent unbounded accumulation.

Some rules require an atomic multi-row decision and therefore belong to guarded
services, not one row-level check. Expansion eligibility verifies the preceding
phase, same enterprise/case, the target cycle’s calendar wait, every required
latest utilization/performance/financial-audit result, and no competing active
application. Award creation verifies the latest effective TTM approval. Ledger
writes enforce sanction limits and prevent over-reversals; recovery balances
and zero-balance closure are recalculated inside write predicates.
Closed awards retain whether releases were complete or a remainder was
deliberately not released. Recovery cases may be cancelled only while their
append-only ledger is empty; after the first entry, corrections and zero-balance
closure preserve the accounting trail.

Cycle document, assessment, and reason rules are normalized rather than stored
as arbitrary JSON. This makes each pinned policy version queryable and gives
D1 explicit uniqueness and value constraints. JSON text remains reserved for
small allow-listed audit/event metadata.

## Versions and concurrency

Every write in this system is optimistic: the caller says which version it read,
and the write refuses if that is no longer true. There are **six kinds of
version column**, deliberately separate so that unrelated concurrent work does
not collide.

| Column | On | Guards |
| --- | --- | --- |
| `current_version` | every versioned head | content edits |
| `status_version` | `seb_application` | workflow transitions |
| `assignment_version` | `seb_application` | who worked it last |
| `ledger_version` | `seb_funding_award`, `seb_recovery_case` | money entries |
| `row_version` | `core_user` | identity edits |
| sequence numbers | every append-only table | ordering, unique-indexed |

Separating them is what lets two officers work without fighting: noting who
worked a file bumps `assignment_version` and nothing else, so it cannot
invalidate a colleague's in-flight desk review, and recording a payment bumps
`ledger_version` without manufacturing an award-policy version for an accounting
entry.

These surface at the API as mandatory `expectedVersion`,
`expectedStatusVersion`, `expectedLedgerVersion`, `expectedReferralVersion` and
`expectedDocumentVersion` inputs. `assignment_version` is deliberately **not**
among them: nothing asks a caller to have seen a particular assignment, because
the assignment does not gate anything.

### The guarded-write shape

One `db.batch`, which D1 executes as one transaction:

1. `UPDATE … WHERE current_version = :expected` on the head, plus every term
   that must still hold — the owner, the status, the lifecycle.
2. Each dependent row as `INSERT … SELECT … WHERE EXISTS (…)`, where the
   predicate proves the head reached the new version at this exact timestamp.
3. The first statement's result decides the outcome.

A losing request therefore writes nothing at all — no half-applied referral,
no orphaned audit row — and is told `The record changed. Reload and try
again.`

The audit row doubles as the operation's unique identity: dependent writes
require its exact ID rather than correlating on `updated_at`, because two
independent requests may legitimately share the same millisecond.

Some rules cannot be a row-level check because they are a decision across many
rows — expansion eligibility, sanction limits, over-reversal, zero-balance
closure. Those live in the guarded service predicates, described in
[the services README](../../services/README.md).

## Searching

Three expression indexes support prefix search on the fields a person actually
types: `lower(seb_enterprise.current_name)` scoped by owner,
`lower(seb_application.reference_number)`, and
`lower(seb_programme_cycle.cycle_code)`.

Queries use `GLOB` rather than `LIKE` because only `GLOB` can use a
`BINARY`-collated expression index — `LIKE` falls back to a full scan.
Confirmed with `EXPLAIN QUERY PLAN` rather than assumed.

Search is therefore **prefix-only**, and the interface says so. Full-text search
would need an FTS5 virtual table, which `drizzle-kit export` cannot emit and the
byte-exact schema check would reject.

## D1 conventions

- IDs are opaque `TEXT` values generated by the application.
- Timestamps are integer Unix milliseconds and use Drizzle's `timestamp_ms`
  mode.
- Date-only business values use ISO `YYYY-MM-DD` text.
- Money uses integer paise. Floating-point currency is never stored.
- JSON text is limited to safe audit/event metadata, not form fields or files.
- SQLite enum declarations are compile-time help only, so explicit `CHECK`
  constraints protect runtime writes.
- Race-sensitive service operations use guarded statements and D1 batches. A
  batch must remain comfortably below D1's statement limit; large maintenance
  work is paginated rather than placed in one unbounded batch.

## Current assumptions

- Mission SEP is the only programme in this domain; cycles model policy years
  without introducing a generic programme table.
- One portal user may own many enterprises. Each enterprise currently has one
  portal owner; a future membership table may add partners without replacing
  that primary owner.
- Each enterprise has exactly one long-lived Mission SEP funding case.
- The first application is phase 1 and later phases are generic, not limited to
  Phase II.
- Application versions are full snapshots made on meaningful saves, not on
  every keystroke.
- The TTAADC policy/application form is authoritative when it differs from the
  supporting UI/UX guide.
- The conflicting seed-fund ceiling in the supplied material is not hard-coded.
  A resolved policy can later be represented in programme-cycle policy data and
  submission validation.
- No programme cycle is seeded by the base schema.
- Administrative cycle, intake, desk review, offline-bank, TTM, award, release,
  assessment, recovery, and role-management services exist. Account recovery, a
  production scanner, notification delivery, and payment integration remain
  public-launch blockers.
- `database/schema.sql` is the whole schema and is safe to re-apply. Nothing is
  deployed, so a change to an existing table is made in the Drizzle files and
  regenerated; `database/migrations/` is empty until a database exists that
  cannot be recreated.
- `core_user_role_grant.role` accepts five values: `APPLICANT`, `REVIEWER`,
  `APPROVER`, `ADMIN`, `SUPER_ADMIN`. The vocabulary is fixed in TypeScript and
  enforced by a `CHECK`, so adding a role is a schema change rather than a
  production data edit.
- `core_audit_event` carries five indexes, and the fifth is the one worth
  knowing about. `core_audit_event_created_idx` on `(created_at, id)` exists
  because every other index leads with a filter column, so the unfiltered
  newest-first read — the likeliest query against the largest table — scanned
  and sorted. That pair is exactly the keyset cursor, so the seek and the
  ordering share one index.
- `seb_document_upload_intent.size_bytes` is capped at 5 MB by a `CHECK`, the
  same limit the service and the browser apply. Left wider, the database would
  permit what the programme forbids.

## Base-schema workflow

Drizzle TypeScript files in this directory are the source of truth. After a
schema change, regenerate and verify the canonical empty-database SQL:

```sh
npm run db:schema:generate
npm run db:schema:check
npm test -- test/schema.test.ts
```

To initialize a workspace-local D1 database:

```sh
npm run db:setup:local
```

Re-running it is safe: every statement in `database/schema.sql` is guarded with
`IF NOT EXISTS`, so a second apply is a no-op and a half-created database
recovers rather than erroring partway through. `db:setup:local` also records
every migration as applied, because the baseline already contains their effect —
with none to record it finds nothing, and it stays so that the first one added
is stamped rather than applied a second time.

Keep this README's inventory, lifecycle, assumptions, and current state
synchronized whenever tables or application rules change.

### Changing a table that already exists

Today, in the Drizzle schema alone. `database/schema.sql` is the whole schema:
no database exists that anybody has to keep, so regenerating the baseline is the
entire change and [`database/migrations/`](../../../database/migrations/README.md)
is empty. Nothing there is deferred work.

**This reverses the day a database exists that cannot be thrown away**, and the
reason is worth carrying until then. The guard on the baseline is not a
migration: `IF NOT EXISTS` only ever helps an object that does not exist yet, so
against a database whose table is already there in an older shape the statement
is skipped and **reported as success**, leaving the schema on the old definition
while the code assumes the new one. SQLite sharpens it further, because it
cannot `ALTER` a `CHECK` constraint at all — changing one means creating a new
table, copying every row, dropping the old and renaming, four statements no
generator can infer.

From then on changes to existing tables are ordered files in that directory,
applied by `npm run db:migrate` and recorded in `core_schema_migration` — the
ledger row written in the same batch as the migration it records, so a crash
cannot leave a database migrated but unaware of it.

One database already survives a change today: the local one behind
`npm run local`, which persists in `.wrangler` and is skipped silently by the
same `IF NOT EXISTS`. A positional insert then supplies the wrong number of
values. Recreate it rather than repairing it:

```sh
rm -rf .wrangler
npm run db:setup:local
```

`npm run db:schema:check` proves what it can. It always proves the baseline
parses and re-applies to no effect — nothing else in the repo applies it twice.
It compares the baseline against the migration chain only when a chain exists,
because with none the two sides are built from the same file and the comparison
would pass whatever it contained.
