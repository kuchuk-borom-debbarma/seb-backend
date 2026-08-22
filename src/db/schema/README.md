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
   classification. Draft form fields remain nullable until submission validation runs.
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
document, award, and qualifying-award link—store stable IDs and the small set of
current fields needed for fast lists, ownership checks, uniqueness, and
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

### `seb`: enterprise and application workflow

- `seb_enterprise` / `seb_enterprise_version`: canonical business identity and
  complete immutable profile history.
- `seb_programme_cycle` / `seb_programme_cycle_version`: versioned Mission SEP
  policy/application windows such as 2026 and later cycles.
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
- `seb_application_assignment_event`: claim/release/reassignment and explicit
  self-review acknowledgement history; the application head keeps only the
  current assignee for fast queues.
- `seb_application_internal_note`: staff-only append-only notes and corrections.
- `seb_desk_review` / `seb_desk_review_check`: frozen submission outcome and
  fixed initial scrutiny checklist.
- `seb_partner_bank_referral` / version / outcome: offline bank identity,
  referral lifecycle, feedback, and superseding corrections.
- `seb_ttm_meeting` / version / agenda / decision: formal meetings, pinned
  evidence, agenda changes, and append-only programme decisions.

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
  assessment, and recovery services exist. Admin-only sign-in, MFA, role
  management, a production scanner, notifications, and payment integration
  remain public-launch blockers.
- The database is not deployed with production data, so `database/schema.sql`
  remains a replaceable canonical baseline rather than an incremental migration.

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

Do not add an incremental migration until a real deployed database requires an
upgrade path. Keep this README's inventory, lifecycle, assumptions, and current
state synchronized whenever tables or application rules change.

## Current state

The schema foundation, applicant authentication/application flow, private R2
uploads, programme-cycle governance, administrative intake/review, offline bank
evidence, TTM decisions, awards, releases, assessments, and recovery exist.
Admin-only authentication/MFA, a production malware scanner, notification
delivery, and public-launch protections remain future work. See the
[combined application guide](../../../docs/application-guide.md)
for the end-to-end business and API behavior, and the focused
[application integrity guide](../../../docs/application-integrity.md) for the
write-time race guards and failure-recovery rules built on this schema.
Administrative authorization is documented separately in the
[fixed-role RBAC guide](../../../docs/admin-rbac.md).
The [administrator workflow guide](../../../docs/admin-workflow-guide.md)
explains staff use, and the [policy crosswalk](../../../docs/policy-alignment.md)
records authoritative-source differences.
