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
Mission SEP funding history for that enterprise across policy years: every
application it makes, of every kind.

```text
core_user
  └── seb_enterprise (one user may own many)
        └── seb_funding_case (exactly one per enterprise)
              ├── seb_application: kind INITIAL, phase 1
              │     └── seb_application_stage_action (its pipeline history)
              └── seb_application: kind EXPANSION, phase 2 or greater

seb_programme_cycle ── seb_programme_cycle_version
  ├── its form, its application kinds and their eligibility rules
  └── pins one published seb_pipeline_version when it opens

seb_pipeline
  ├── seb_pipeline_version (a frozen JSONB definition; one draft at a time)
  │     └── seb_pipeline_version_stage (its stages, as foreign-key targets)
  └── seb_pipeline_stage (a stage's identity across versions)
        └── seb_pipeline_stage_owner (which roles work it, with history)
```

The kinds are the cycle's own: `INITIAL` and `EXPANSION` above are what a
cycle might declare, not values the schema knows.

The expected application lifecycle is:

1. The applicant signs up and verifies their email.
2. They create or select an enterprise. A new enterprise also receives its one
   Mission SEP funding case.
3. They start an application of one of the kinds an open programme cycle
   declares, if its eligibility rules hold. The application records its kind,
   its phase number, and the pipeline version the cycle pinned.
4. Meaningful saves create immutable `seb_application_version` rows pinning
   the exact programme-cycle version, kind and phase. The answers themselves
   are sparse `seb_application_version_answer` rows keyed by the template's
   field keys — one row per answered value, no row at all for an unanswered
   question.
5. Documents occupy stable logical slots in `seb_application_document`.
   Replacements create new immutable file versions with new storage object keys.
6. Submission creates an append-only `seb_application_submission` and
   `seb_application_submission_document` rows pointing to the exact form and
   file versions the office reads. The head moves from `DRAFT` to
   `IN_PIPELINE`, enters its pinned pipeline version's initial stage, and gains
   the flags the pipeline adds on submission.
7. Every action an officer takes at a stage is one append-only
   `seb_application_stage_action` row, and the same statement updates the head:
   its stage, its trail of stages, its status flags and its recorded values.
   Applicant-visible messages go to `seb_application_event`. A correction
   request is a `seb_revision_request`; an incorrect request is cancelled and
   replaced, not edited.
8. A resubmission resolves the open requests, leaves the file at the stage
   that asked, and removes the flag that let the applicant edit.
9. A terminal flag ends the journey: the head keeps `IN_PIPELINE` and its flags,
   and sits at no stage.

## Why the schema has both current rows and versions

Mutable business roots—enterprise, programme cycle, funding case, application,
and document—store stable IDs and the small set of current fields needed for
fast lists, ownership checks, uniqueness, and optimistic concurrency. Each root
also has a dedicated immutable version table containing the complete state
accepted at that version.

This intentional duplication serves two different questions:

- The root answers, “What is current now?”
- The version answers, “What was true when this save, submission, or decision
  happened?”

For example, `seb_enterprise.current_name` may change after a legal-name update,
but an older `seb_application_version.business_name` never changes. Reviewers
therefore always see the form that was actually submitted, not today's
enterprise profile.

Version rows, submissions, events, stage actions, and published pipeline
versions are append-only contracts. Service/query modules must expose no update
or delete functions for them. Database triggers are intentionally not used; the service
layer will guard version creation and use `current_version` or `status_version`
for optimistic concurrency.

## Domain inventory

### `core`: reusable identity and audit

- `core_user`: verified portal identity, password hash, and soft deletion. Roles
  are intentionally not copied onto the identity row.
- `core_role`: a role the office composed — a key, a name, a purpose, and a
  version guarding its permission set. Soft-deleted, so a grant that named a
  retired role still renders.
- `core_role_permission`: one row per resource/act pair a role holds.
- `core_user_role_grant`: retained assignments. A row names its authority in
  exactly one place — `role` for the two decided in code (`APPLICANT`,
  `SUPER_ADMIN`), `role_id` for a composed one — and a `CHECK` enforces that.
  **Two** partial unique indexes allow one active grant of each, rather than
  one over the nullable pair: Postgres treats NULLs in a unique index as
  distinct, so a single index would accept two identical active grants of the
  same composed role while looking exactly like the guarantee it is not.
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
  **Two generations of row live in it**, told apart by `payload_version`:
  - `0` — written before each action declared its shape. What it recorded is
    in `metadata_json` as loose flat JSON text, and is read exactly as stored.
  - `1` — `payload` (`jsonb`) holds the action's declared payload, parsed
    against its strict schema in `services/audit-vocabulary` before the row was
    built; `metadata_json` is `NULL`. A `CHECK` refuses a row that mixes the
    two, so a reader can always say which column is the evidence.

  `metadata_json` is never rewritten into `payload`: the history does not edit
  itself. `subject_user_id` (who the event was about) and `application_id`
  (which application it belongs to, for its documents, review and money too)
  are denormalized so a person's or an application's history is one indexed
  read. `application_id` has no foreign key on purpose — `core_*` does not
  depend on `seb_*`, and an application's history outlives its row.
  `changes_json` is still written as `NULL` by the one builder, and `action`
  comes from a closed catalogue, so audit queries cannot be defeated by a typo.

### `seb`: enterprise and application workflow

- `seb_enterprise` / `seb_enterprise_version`: canonical business identity and
  complete immutable profile history.
- `seb_programme_cycle` / `seb_programme_cycle_version`: versioned Mission SEP
  policy/application windows such as 2026 and later cycles.
- `seb_programme_cycle_application_kind` /
  `seb_programme_cycle_application_kind_rule`: the kinds of application one
  cycle version accepts — a key, a label, an order — and the eligibility rules
  of each, as a rule type from the workflow catalogue with its parameters as a
  small bounded JSONB object. Pinned to the cycle version and copied forward
  like the form. The rule types are a `CHECK`; what their parameters mean is
  parsed by the rule's own evaluator in `services/application/eligibility`.
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
- `seb_programme_cycle_form_rule` / `seb_programme_cycle_form_rule_operand`:
  a form's rules about several answers at once — "a grant, a loan, or both",
  "the two banks differ". A rule has a type from the workflow catalogue, the
  stage its refusal is shown on, a message, and a limit only where its type
  takes one (a `CHECK` spells out both arms). Each operand is a composite
  foreign key onto `(cycle, version, field_key, field_type)`, so a rule cannot
  read a question the form does not ask, or read it as the wrong type.
- `seb_programme_cycle_event`: the append-only cycle lifecycle timeline.
- `seb_funding_case` / `seb_funding_case_version`: the enterprise's single
  long-running Mission SEP funding chain.
- `seb_application` / `seb_application_version`: current head and immutable
  per-save rows pinning the cycle version, kind, phase and the server-computed
  category. The head also carries where the file is in its pipeline — see
  [Pipelines](#seb-pipelines-and-the-stage-history) below.
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
- `seb_application_event`: append-only applicant-facing timeline. An event a
  stage action produced names it by `stage_action_id`, a composite foreign key
  that also proves it belongs to the same application.
- `seb_application_internal_note`: staff-only append-only notes and corrections.

### `seb`: pipelines and the stage history

The post-submission workflow is configured, not coded, so these tables hold
configuration and its history rather than one table per desk. The narrative is
the [pipeline guide](../../../docs/pipeline-guide.md).

- `seb_pipeline`: a pipeline's identity — key, name, description — and the
  version a cycle may pin today. Retired together or not at all: retirement
  time, actor and reason are one `CHECK` group.
- `seb_pipeline_version`: one version's whole shape as a **frozen JSONB
  document** (`definition`, at most 256 KB) — its stages, actions, inputs,
  effects, status flags and recorded values. `status` is `DRAFT` or
  `PUBLISHED`; a partial unique index allows one draft per pipeline, and
  `revision` guards the draft against two authors interleaving edits. A
  published version is never updated: every write predicate names
  `status = 'DRAFT'`, and a `CHECK` ties `published_at` and its publisher to the
  status.
- `seb_pipeline_stage`: a stage's identity across every version of its
  pipeline, created the first time a draft names the key, so owners can be set
  before publishing. `owners_version` guards the owner list.
- `seb_pipeline_stage_owner`: which roles work a stage, kept like grants —
  closed rather than deleted, with who and why. A partial unique index allows
  one live row per role and stage; a partial index on `role_id` serves the
  session query, which reads a person's owned stages with their permissions.
- `seb_pipeline_version_stage`: the stages of one published version,
  materialised from its document at publish so an application's stage and its
  action history are foreign keys rather than strings nothing checks. A partial
  unique index allows exactly one initial stage per version.
- `seb_application_stage_action`: every action taken on an application at a
  stage — the stage, the action, the actor, where the file went, what the
  officer entered (normalized by the form engine, at most 64 KB), the flags
  added and removed, the values recorded, the form stages sent back, and
  whether the actor disclosed acting on their own application. Append-only.
  `status_version` is the version the action produced, and it is unique per
  application: a second guard, beside the head's, that two racing actions
  cannot both land. An index on `(actor_user_id, application_id)` answers
  "files I have acted on".

**Why the definition is a document when the form is rows.** The rule stated
under [Integrity rules](#integrity-rules) — a document cannot be a foreign-key
target — decides both. The form's whole job is to be referenced: an answer, a
document slot, a revision request each name part of it. Of a pipeline, only the
stages are referenced (by an application, its actions, and a stage's owners),
so only the stages are rows. The rest is referenced by nothing, and rows would
add a join to every read without adding a guarantee. The document is
zod-parsed against the workflow catalogue on every save, publish and load, so
stored configuration naming an effect the code no longer has fails closed.

**The head carries its pipeline state.** On `seb_application`:

| Column | Holds |
| --- | --- |
| `pipeline_id`, `pipeline_version` | the version the application is worked in — its cycle's pin, copied when it starts |
| `current_stage_key`, `stage_entered_at` | where it is and since when; null before submission and after the journey ends |
| `stage_trail` | the stages it came through, newest last — what "send back" returns along |
| `status_flags` | the configured flags it holds now |
| `recorded_values` | values actions recorded, such as the approved grant, by their declared key |
| `application_kind` | which of its cycle's kinds it is |

`status` itself is reduced to `DRAFT` and `IN_PIPELINE`, the one line nothing
configurable may move: before the first submission the applicant owns the
form, after it the pipeline does. Everything an office would call a status is
a flag. A `CHECK` ties status to stage with every NULL arm spelled out — a
draft is at no stage; a file in its pipeline is at a stage with the time it
arrived, or at none because its journey ended.

**Flags and the trail are `text[]` on the head, not rows.** The guarded update
that moves a file changes its flags in the same row write, so keeping them on
the head costs no extra statement and needs no cross-row consistency; their
history is on the action rows. `CHECK`s bound them (at most 32 flags, 64 trail
entries, each a valid key, no NULL element) and `recorded_values` (an object of
at most 8 KB). A GIN index on `status_flags` serves "every file holding this
flag" across stages; `(pipeline_id, current_stage_key, stage_entered_at, id)`,
partial on live files at a stage, is the stage queue's seek and its keyset
order in one; `(pipeline_id, status, status_changed_at)` serves the
office-wide list.

**What went.** Migration `0003_pipelines.sql` dropped the fixed workflow's
tables — desk review with its checks and transcribed identifiers, the
partner-bank referral with its versions and outcome, the programme decision,
funding awards, disbursements, utilization obligations, award assessments,
recovery cases with their versions and entries, qualifying awards, assignment
events — and the cycle's assessment rules, identifier rules and reason
catalogue. It also dropped the head's assignment columns, the application
type, the expansion facts on the version row, and the cycle's partner-bank
guidance and expansion wait. It emptied every application and cycle, because
the data was QA-only and an application cannot be carried into a pipeline that
did not exist when it was worked; users, roles, grants, enterprises, funding
cases, announcements and the activity history were kept.

## How the application form maps to snapshots

The questions are not columns. A cycle version declares them as rows in the
four form-template tables, and a save stores what was answered as rows in
`seb_application_version_answer` — so adding a question to next year's cycle
is an authoring act, not a schema change. What `seb_application_version`
itself still carries as typed columns is only what the server owns:

- Classification: exact programme-cycle version, the application's kind, and
  phase number. These remain historical even if the current heads are
  corrected.
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
`application_kind`, `phase_number` and the funding case express the
relationship without contradictory state, and whether a kind may be started is
the cycle's eligibility rules over the enterprise's history.

## Integrity rules

Composite foreign keys enforce ownership and domain boundaries even if a future
query is wrong:

- An application's applicant must be the portal owner of its enterprise.
- An application's funding case must belong to that same enterprise.
- An application's pipeline version, and its current stage, must exist:
  `(pipeline_id, pipeline_version, current_stage_key)` references the
  published version's materialised stages, so a file cannot sit at a stage its
  version does not have.
- A stage action's stage, and the stage it sent the file to, must be stages of
  the same pinned version.
- A stage's owner must be a real stage of that pipeline, and a real role.
- Submissions, revisions, events and stage actions can reference records only
  from their own application.

Foreign keys use `RESTRICT`/`NO ACTION`; none use `CASCADE`. Business roots are
soft-deleted with `deleted_at`, `deleted_by_user_id`, and `delete_reason`, so an
email, enterprise, application, document slot, sanction order, or historic link
cannot silently be reused. Sessions are the deliberate exception and are
physically removed to prevent unbounded accumulation.

Some rules require an atomic multi-row decision and therefore belong to guarded
services, not one row-level check. A stage action's write repeats, inside its
predicate, the status version, the stage the officer was looking at, and the
pinned pipeline version. Eligibility is evaluated over the enterprise's whole
history in one read. What an action may do to a file — at most one move, a
return only along the file's own trail, a bound on an approved amount — is
decided by the pure engine in `services/pipeline` before the write, and the
write can only carry out that decision.

Cycle rules — the form template, its cross-field rules, and the application
kinds — are normalized rows rather than a JSON document, and the reason
survives any engine: **a document cannot be a foreign-key target**, and the
template's entire job is to be referenced. A document slot names a file field, a revision request names a
stage, an option belongs to a field, an answer names the question it answers.
Against a JSON column every one of those becomes an assertion in application
code. Rows also make cross-row uniqueness a one-line index and let two cycle
versions be diffed in SQL. JSON is reserved for what nothing references: audit
payloads, a pipeline definition (whose referenced part, its stages, is rows),
an eligibility rule's parameters, an action's inputs, and the values a file has
recorded — each bounded in size by a `CHECK`.

## Versions and concurrency

Every write in this system is optimistic: the caller says which version it read,
and the write refuses if that is no longer true. There are **six kinds of
version column**, deliberately separate so that unrelated concurrent work does
not collide.

| Column | On | Guards |
| --- | --- | --- |
| `current_version` | every versioned head | content edits |
| `status_version` | `seb_application` | submission and every stage action |
| `revision` | `seb_pipeline_version` | edits to a pipeline draft |
| `owners_version` | `seb_pipeline_stage` | who owns a stage |
| `row_version` | `core_user` | identity edits |
| sequence numbers | every append-only table | ordering, unique-indexed |

Separating them is what lets unrelated work proceed without fighting: an
applicant editing a draft bumps `current_version` and cannot invalidate an
action on the file's stage, and changing who owns a stage bumps
`owners_version` without touching the pipeline's draft or anybody's file.

These surface at the API as mandatory `expectedVersion`,
`expectedStatusVersion` and `expectedDocumentVersion` inputs, and their
pipeline equivalents.

### The guarded-write shape

One data-modifying statement, which is implicitly atomic:

1. `UPDATE … WHERE current_version = :expected` on the head, plus every term
   that must still hold — the owner, the status, the lifecycle — returning the
   row it changed.
2. Each dependent row as `INSERT … SELECT … FROM` that result, so a losing
   update leaves them nothing to select. This is stronger than matching on a
   timestamp: it is the same tuple, not a value that two requests could share.
3. The update's row count decides the outcome.

A losing request therefore writes nothing at all — no half-applied stage
action, no orphaned audit row — and is told `The record changed. Reload and try
again.`

The audit row doubles as the operation's unique identity: dependent writes
require its exact ID rather than correlating on `updated_at`, because two
independent requests may legitimately share the same millisecond.

Some rules cannot be a row-level check because they are a decision across many
rows — eligibility over an enterprise's history, where a stage action may send
a file, a bound on an approved amount. Those live in the guarded services,
described in [the services README](../../services/README.md).

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
- JSON is limited to what nothing references: audit payloads (the declared
  payloads of `services/audit-vocabulary`), pipeline definitions, eligibility
  rule parameters, stage-action inputs and recorded values — never the form's
  questions, answers or files, and always bounded by a `CHECK`.

## Current assumptions

- Mission SEP is the only programme in this domain; cycles model policy years
  without introducing a generic programme table.
- One portal user may own many enterprises. Each enterprise currently has one
  portal owner; a future membership table may add partners without replacing
  that primary owner.
- Each enterprise has exactly one long-lived Mission SEP funding case.
- The first application is phase 1 and later phases are generic, not limited to
  Phase II. Which kinds exist is each cycle's configuration.
- Application versions are full snapshots made on meaningful saves, not on
  every keystroke.
- The TTAADC policy/application form is authoritative when it differs from the
  supporting UI/UX guide.
- The conflicting seed-fund ceiling in the supplied material is not hard-coded.
  A resolved policy can later be represented in programme-cycle policy data and
  submission validation.
- No programme cycle is seeded by the base schema.
- Administrative cycle, intake, pipeline and role-management services exist,
  as do account self-service (password reset, email change), a malware scanner
  behind a swappable seam (Cloudmersive; a permissive transport until its key
  is configured), and best-effort email notification with PDF attachments.
  Money after approval — sanction, releases, assessments, recovery — is not
  tracked; payment integration remains a public-launch blocker.
- `database/schema.sql` is the whole schema and is generated, never hand-edited.
  Databases are built and changed by the ordered chain under
  `database/migrations/` — `db:generate` writes the next file from the
  Drizzle schema's diff, `db:migrate` applies what is pending, and the chain's
  single `0000_baseline` builds everything from nothing (the chain was
  collapsed to that one file during development, after every existing database
  was converged onto its shape). The service-test harness alone applies
  `schema.sql` directly, for speed.
- `core_user_role_grant.role` accepts `APPLICANT` and `SUPER_ADMIN` on any row,
  and one of the four removed fixed roles — `REVIEWER`, `APPROVER`, `ADMIN`,
  `ANNOUNCER` — **only where the row is already revoked**. That keeps an
  administrator's past acts readable without letting anything write a new grant
  in a vocabulary that no longer means anything. A plain widening would have
  allowed the second; narrowing to the two current values would have rejected
  the rows the migration exists to preserve.
- `core_role.key` refuses those six names outright, so no composed role can take
  one and make two different authorities read as one in retained history.
- **The permission catalogue is deliberately not a `CHECK`.** Every other closed
  set here is written out, but the catalogue is a code artifact that moves with
  the code: a `CHECK` would demand a migration for every catalogue edit, and the
  two would drift the first time somebody forgot. The resolution step intersects
  what is stored against the catalogue instead, so a row naming a resource that
  no longer exists grants nothing — which fails closed, and makes removing a
  resource take effect at once rather than pending a data migration.
- `seb_announcement` is the landing page's notice board and
  `seb_announcement_board` its one-row reorder guard: two reorders touch no
  common card row, so they contend on the board's version instead, and
  creating or removing a card bumps it too. The board row is seeded (by the
  baseline migration in any migrated database, by the service-test harness
  where one is built from `schema.sql`) so reads stay read-only. `sort_order`
  is deliberately not unique — in-place renumbering would transiently
  collide — and reads break ties by `(sort_order, created_at, id)`.
- `core_audit_event` carries seven indexes. `core_audit_event_created_idx` on
  `(created_at, id)` exists because every other index leads with a filter
  column, so the unfiltered newest-first read — the likeliest query against the
  largest table — scanned and sorted. That pair is exactly the keyset cursor, so
  the seek and the ordering share one index. The two newest,
  `core_audit_event_subject_idx` and `core_audit_event_application_idx`, lead
  with the person or the application and then follow the same cursor; both are
  **partial** (`IS NOT NULL`), because most rows have neither and an index of
  NULLs would cost every insert and serve no read.
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

To initialize a local database (create it once, then run the chain):

```sh
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/seb_backend npm run db:migrate
```

Keep this README's inventory, lifecycle, assumptions, and current state
synchronized whenever tables or application rules change.

### Changing a table that already exists

Change the Drizzle schema and run `npm run db:schema:generate`.
`npm run db:schema:check` regenerates and fails on any difference, naming the
tables that moved — which is what keeps `database/schema.sql` a description of
the schema rather than a second copy of it.

Then `npm run db:generate` writes the change as the chain's next migration,
and `npm run db:migrate` carries every database forward. Hand-harden the
generated file so it is **idempotent** — `IF EXISTS`, `IF NOT EXISTS`,
constraints guarded by a `pg_constraint` lookup, data changes guarded so a
second run is a no-op — name every destructive step in a comment, and add no
triggers. A guard alone could hide a table left in an older shape, which is why
`npm run check:migration` rehearses the chain over seeded data, runs it twice,
and asserts the destination is exactly `database/schema.sql`. The rule and its
reason are in [the code rules](../../../docs/rules/code.md).

**One ordering rule is not obvious.** A composite foreign key needs its
referenced columns covered by a unique **constraint**, and generated DDL
declares foreign keys before it creates indexes — so a key pointing at a
`uniqueIndex(...)` fails with *"there is no unique constraint matching given
keys"*. Use `unique(...)` for any column set another table references; twenty-three
of them here exist for that reason. A **partial** unique index can never be a
foreign-key target at all.
