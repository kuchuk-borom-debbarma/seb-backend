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
4. Meaningful saves create immutable `seb_application_version` rows pinning
   the exact programme-cycle version and phase classification. The answers
   themselves are sparse `seb_application_version_answer` rows keyed by the
   template's field keys — one row per answered value, no row at all for an
   unanswered question.
5. Documents occupy stable logical slots in `seb_application_document`.
   Replacements create new immutable file versions with new storage object keys.
6. Submission creates an append-only `seb_application_submission` and
   `seb_application_submission_document` rows pointing to the exact form and
   file versions reviewed by TTAADC.
7. Review transitions and applicant-visible messages are recorded in
   `seb_application_event`. A correction request is added as a
   `seb_revision_request`; an incorrect request is cancelled and replaced, not
   edited.
8. Assignment, desk review, offline bank evidence, and programme decision
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
  `REVIEWER`, `APPROVER`, `ADMIN`, and `SUPER_ADMIN` roles. A partial unique
  index allows one active grant per user/role while preserving revoked and
  re-granted history.
- `core_session`: short-lived login sessions. This is the only table whose rows
  are intentionally hard-deleted on sign-out, revocation, user deletion, or
  expiry.
- `core_signup_challenge`: retained OTP challenge lifecycle without raw OTPs or
  tokens.
- `core_account_challenge`: the same lifecycle for an account that already
  exists — resetting a forgotten password, and confirming a new email address.
  `purpose` is part of every lookup, so a code issued for one cannot authorise
  the other. Separate from the signup challenge because that one has no user
  yet and this one always does, which no constraint could express in a single
  nullable column.
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
- `seb_programme_cycle_assessment_rule`, `seb_programme_cycle_identifier_rule`:
  what one cycle version demands. Both carry a
  composite foreign key on `(programme_cycle_id, programme_cycle_version)`, so a
  rule belongs to a *version* and editing a cycle cannot change what an
  already-submitted application is judged by. There is deliberately no
  document-rule table: which documents a cycle demands is expressed by `FILE`
  fields in the form template below, and a document slot names its `field_key`.

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
- `seb_programme_cycle_form_stage`, `seb_programme_cycle_form_field`,
  `seb_programme_cycle_form_field_option`,
  `seb_programme_cycle_form_field_condition`: the application form itself, as
  configuration. A stage is one step of the form; a field is one question with
  its validation rules as columns and its presentation tokens as closed-set
  columns; an option is one choice (or, for a `FILE` field, one accepted
  content type); a condition is one comparison deciding visibility or
  requiredness — rows sharing a `group_number` are ANDed, separate groups are
  ORed. All four are pinned to `(programme_cycle_id, programme_cycle_version)`
  and copied forward on every version bump, so an application always renders
  against the exact form it was filled on. Single-row rules are `CHECK`s here;
  the cross-row rules — a `CONDITIONAL` field needs a `REQUIRED_WHEN` rule, the
  visibility graph is acyclic, the answer byte budget — are refused at
  authoring time by `formTemplateProblem` in
  [`form-template-input.ts`](../../services/admin/form-template-input.ts), and
  the reusable-structure guards by
  [`group-definitions.ts`](../../services/admin/group-definitions.ts). The
  narrative lives in
  [the form template guide](../../../docs/form-template-guide.md).
- `seb_programme_cycle_form_group_definition`, `…_member`, `…_member_option`:
  a reusable structure a cycle defines once ("an Owner is a name, a date of
  birth, a share") and any repeated group can use by name. Members are
  materialised into ordinary field rows under `USE__MEMBER` qualified keys at
  authoring time, so the engine, answer storage, and renderer never read these
  tables; they exist for the authoring round trip, which strips the derived
  rows and shows the definition instead.
- `seb_programme_cycle_reason` / `seb_programme_cycle_event`: the cycle
  version's decision-reason catalogue, and the append-only cycle lifecycle
  timeline.
- `seb_funding_case` / `seb_funding_case_version`: the enterprise's single
  long-running Mission SEP funding chain.
- `seb_application` / `seb_application_version`: current workflow head and
  immutable per-save rows pinning the cycle version, classification, expansion
  facts, and the server-computed category.
- `seb_application_version_answer`: what the applicant answered, one sparse row
  per value. Composite foreign keys make an answer for a question the pinned
  cycle version never asked impossible in SQL; `entry_index` addresses repeated
  group entries and `value_ordinal` the selections of a multiple choice.
- `seb_application_submission`: formal submission/resubmission history tied to
  exact application versions.
- `seb_application_submission_document`: exact logical slots and immutable file
  versions frozen into each submission.
- `seb_application_document` / `seb_application_document_version`: logical
  evidence slots and immutable upload/replacement history in object storage.
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
- `seb_programme_decision`: append-only decisions on an application, each
  pinning the submission and bank outcome that were in front of the decider. A
  decision carries its own `conflict_acknowledged`, and so does each superseding
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

The questions are not columns. A cycle version declares them as rows in the
four form-template tables, and a save stores what was answered as rows in
`seb_application_version_answer` — so adding a question to next year's cycle
is an authoring act, not a schema change. What `seb_application_version`
itself still carries as typed columns is only what the server owns:

- Classification: exact programme-cycle version, initial/expansion type, and
  phase number. These remain historical even if the current heads are
  corrected.
- Expansion facts: prior sanction order/date, net retained disbursement, and
  continuous-operation months, derived by the backend from the qualifying
  award and append-only ledger — an applicant must never be able to assert
  them, so they are never answers.
- Declaration acceptance time, and the `application_category` (`CATEGORY_A` or
  `CATEGORY_B`) the server computes at submission from the enterprise's
  establishment date against the cycle's threshold.

Everything an applicant types — every answer to a template question — is a
sparse answer row keyed by the field key the template declared. A field never
answered has no row. Enterprise identity (name, sector, district,
establishment date, registration numbers) is not frozen into the application
at all: it is read live from `seb_enterprise` / `seb_enterprise_version`,
which keep their own immutable history.

Evidence lives in its own versioned document tables rather than inside any
snapshot; a document slot names the `FILE` field it satisfies by `field_key`.

There is deliberately no `is_phase_two` or `is_expansion_funding` Boolean:
`application_type`, `phase_number`, the funding case, and the qualifying award
express the relationship without contradictory state.

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
application. Award creation verifies the latest effective decision. Ledger
writes enforce sanction limits and prevent over-reversals; recovery balances
and zero-balance closure are recalculated inside write predicates.
Closed awards retain whether releases were complete or a remainder was
deliberately not released. Recovery cases may be cancelled only while their
append-only ledger is empty; after the first entry, corrections and zero-balance
closure preserve the accounting trail.

Cycle rules — the form template, assessment and reason rules — are normalized
rows rather than a JSON document, and the reason survives any engine: **a
document cannot be a foreign-key target**, and the template's entire job is to
be referenced. A document slot names a file field, a revision request names a
stage, an option belongs to a field, an answer names the question it answers.
Against a JSON column every one of those becomes an assertion in application
code. Rows also make cross-row uniqueness a one-line index and let two cycle
versions be diffed in SQL. JSON text remains reserved for small allow-listed
audit and event metadata.

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

One data-modifying statement, which is implicitly atomic:

1. `UPDATE … WHERE current_version = :expected` on the head, plus every term
   that must still hold — the owner, the status, the lifecycle — returning the
   row it changed.
2. Each dependent row as `INSERT … SELECT … FROM` that result, so a losing
   update leaves them nothing to select. This is stronger than matching on a
   timestamp: it is the same tuple, not a value that two requests could share.
3. The update's row count decides the outcome.

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

All three are declared `text_pattern_ops`, which is what lets
`lower(column) LIKE 'term%'` use them. Under the default operator class the same
query is a sequential scan — right answers, quietly linear, nothing failing.
Confirmed with `EXPLAIN`, not assumed.

The consequence to know: an index with that operator class answers prefix
matches and equality, and **cannot** serve an ordering or a range over the same
expression. These three exist only for the prefix match, and nothing sorts by a
lowercased reference number.

Search is **prefix-only**, and the interface says so. That is now a choice
rather than a limitation — `pg_trgm` would index substring search, and would
genuinely help on a business name where the distinguishing word sits in the
middle. Until it is enabled the interface must go on saying "starts with".

## Column conventions

- IDs are opaque `TEXT` values generated by the application.
- Instants are `timestamptz`, never a bare `timestamp`: a bare one drops the
  offset, so two instants an hour apart compare equal after a clock change, and
  every deadline here is a comparison against `now()`.
- Calendar days are `date`. A date of birth does not move when the reader is in
  another zone.
- Money is `bigint` paise with a ceiling `CHECK` at `2^53-1`. The ceiling exists
  because Drizzle reads it into a JavaScript number, which is exact only that
  far — a value that could not be read back is refused at write time rather than
  read back wrong.
- Booleans are real booleans. Every `IN (0, 1)` check went with the change.
- **Enums stay `text` + `CHECK`, deliberately.** A value cannot be removed from
  a Postgres enum type without a full table rewrite, and this schema has already
  removed two whole vocabularies. Widening a `CHECK` is online and
  transactional, and `text(x, { enum: [...] })` gives the identical TypeScript
  union either way.
- A `CHECK` passes when its result is NULL, not only when it is true. Any
  constraint over a nullable column needs an explicit `IS NOT NULL`, or it
  silently accepts the row it was written to refuse.
- Deletion is a predicate, not a key column: indexes serving live rows are
  partial, `WHERE deleted_at IS NULL`. The planner uses one only when it can
  prove the predicate, so dropping that term from a query silently falls back to
  a scan.
- A composite foreign key needs a unique **constraint**, not a unique index; see
  "Changing a table that already exists" below for why.
- JSON text is limited to safe audit/event metadata, not form fields or files.

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
- Administrative cycle, intake, desk review, offline-bank, decision, award,
  release, assessment, recovery, and role-management services exist, as do
  account self-service (password reset, email change), a malware scanner
  behind a swappable seam (Cloudmersive; a permissive transport until its key
  is configured), and best-effort email notification with PDF attachments.
  Payment integration remains a public-launch blocker.
- `database/schema.sql` is the whole schema and is generated, never hand-edited.
  Nothing is deployed and no database holds anything worth keeping, so applying
  it means recreating rather than patching. The day a database exists that
  cannot be thrown away, that reverses and changes to existing tables become an
  ordered migration chain instead.
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
- `seb_document_upload_intent.size_bytes` is capped at 5 MB by a `CHECK`. That
  is a **backstop, deliberately wider than the rule**: the service and the
  browser both refuse at 2 MB, which is what the malware scanner accepts. The
  `CHECK` is left wider rather than tracking the rule, because the rule's home
  is `MAX_DOCUMENT_BYTES` in the application service and a second spelling of
  it would have to be migrated in lockstep — a bound wider than the rule costs
  nothing, and what would be wrong is a bound *narrower* than it.

## Base-schema workflow

Drizzle TypeScript files in this directory are the source of truth. After a
schema change, regenerate and verify the canonical empty-database SQL:

```sh
npm run db:schema:generate
npm run db:schema:check
npm test -- test/service/schema.test.ts
```

To initialize a local database:

```sh
npm run db:setup:local
```

`npm run db:setup:local` drops the public schema and rebuilds it from
`database/schema.sql`.

Keep this README's inventory, lifecycle, assumptions, and current state
synchronized whenever tables or application rules change.

### Changing a table that already exists

Change the Drizzle schema and run `npm run db:schema:generate`.
`npm run db:schema:check` regenerates and fails on any difference, naming the
tables that moved — which is what keeps `database/schema.sql` a description of
the schema rather than a second copy of it.

`npm run db:setup:local` drops the public schema and rebuilds it. It recreates
rather than patches, deliberately: guarding every statement with
`IF NOT EXISTS` would make a re-run *look* successful against a table already
present in an older shape, leaving the database on the old definition while the
code assumes the new one.

**One ordering rule is not obvious.** A composite foreign key needs its
referenced columns covered by a unique **constraint**, and generated DDL
declares foreign keys before it creates indexes — so a key pointing at a
`uniqueIndex(...)` fails with *"there is no unique constraint matching given
keys"*. Use `unique(...)` for any column set another table references; twenty-three
of them here exist for that reason. A **partial** unique index can never be a
foreign-key target at all.
