# Administrative service

The programme office's side of the portal that is not casework: programme-cycle
governance and its policy document, authoring the questions a cycle asks, the
office-wide read of submitted files, staff notes, and the intake analytics.

Working a file through its stages — asking for a revision, approving a grant,
sending it to a bank — is not here. It is configured as a pipeline and carried
out by the [pipeline service](../pipeline/README.md), which owns every write to
a file after submission.

The plain-language staff journey — what the rules *are*, and why — is the
[administrator workflow guide](../../../docs/admin-workflow-guide.md). This
document is how the code implements it.

## What it assumes

- **An application reaching this service has been formally submitted.** Drafts
  never appear in the office's list, and a non-draft application always has at
  least one submission. That is a database invariant, so the workspace read
  asserts it rather than handling its absence.
- **A submitted application always has a reference number**, because submission
  is what mints one. Code that needs it asserts rather than defaulting — a
  quiet fallback would hide a broken invariant behind a plausible message.
- **Authority is joined live on every request.** A revoked role stops the next
  operation even though the browser session is still valid, so nothing here
  re-checks a role it was handed.
- **Evidence is frozen, never current.** The workspace reads the exact
  submission and the exact file versions pinned to it, so replacing a document
  tomorrow cannot change what was read yesterday.
- **A cycle's rules belong to a version.** Every rule table is pinned to
  `(programme_cycle_id, programme_cycle_version)` and copied forward on every
  version bump, so editing a cycle cannot change what an already-started
  application is judged by.

## Layout

| Path | Owns |
| --- | --- |
| `controllers/programme-cycle.ts` | Policy input, application kinds, the pipeline a cycle names, and the cycle lifecycle |
| `controllers/form-template.ts` | Authoring the questions a draft cycle asks — the nine `formTemplate` mutations |
| `controllers/policy-document.ts` | The order or circular a cycle implements, stored as a scanned PDF |
| `controllers/intake.ts` | The office-wide list, reference lookup, the workspace, notes, document download |
| `controllers/analytics.ts` | The intake analytics summary |
| `queries/*` | Drizzle reads and every guarded write; `queries/analytics.ts` groups the list's own filtered set |
| `form-template-input.ts` | Refusing an incoherent form — including its cross-field rules — before a cycle can carry one |
| `group-definitions.ts` | Reusable structures: the grammar guards, and expansion into qualified keys |
| `document-scanner.ts` | The internal scanner callbacks — no HTTP or GraphQL exposure |
| `support.ts` | The permission preamble, the audit builder, the refusal messages |
| `types.ts`, `pagination.ts` | Shared shapes; `pagination.ts` re-exports the applicant's |

## Flows

### Opening a cycle

| | |
| --- | --- |
| **Entry** | `admin.programmeCycle.open` |
| **Guard** | `programme_cycle` / `open` |
| **Refuses** | every missing policy field, named; a policy document not yet accepted by the scanner; a closing time already past; a form with no questions; no application kind; a pipeline never published |
| **Writes** | the next cycle version with status `OPEN`, pinning the pipeline's current published version, and the cycle event and audit row — one guarded write |
| **Guarded by** | the expected cycle version |
| **Fails** | the named refusal, or `The record changed.` |

**Opening pins the pipeline.** A cycle names its pipeline while it is a draft;
opening copies that pipeline's current published version onto the cycle
version (a `CHECK` makes the pin present on every non-draft version and absent
on a draft), and every application started in the cycle copies the same pin.
A pipeline never published has nothing to pin, and a cycle opened on it could
accept an application no stage could ever receive — so that is refused.

Whether the pipeline can read this cycle's form — every answer it reads a
top-level question of the right type — is `pipelinePinProblems` in the pipeline
service, and the rule is stated in the
[form template guide](../../../docs/form-template-guide.md#a-pipeline-reads-the-form).

### Application kinds and cross-field rules

A cycle declares the kinds of application it accepts, each with eligibility
rules, and its form may declare rules about several answers at once. Both are
cycle policy, so both are rows pinned to the cycle version and copied forward
with the form (`copyPolicyForward` in `queries/programme-cycle.ts` — **every
rule table must be there**, or the first version bump empties it). Both are
validated against the workflow catalogue when saved: an eligibility rule's
parameters by its evaluator's own schema, a form rule's operands by the types
and counts its catalogue entry declares (`formRuleProblem`). What each rule
*means* is the applicant service's — see its README.

### Archiving

A closed cycle is archived only when none of its applications is unfinished:
no draft, and no file still at a stage of its pipeline
(`unfinishedApplicationCount`). Archiving hides the cycle from the office's working set, which must not happen
while its files are still being worked.

### Acting on your own application

Permitted, with disclosure — and it is a stage action now, so the disclosure is
kept on the stage-action row and recorded as `SEB.SELF_REVIEW_DISCLOSED` by the
[pipeline service](../pipeline/README.md). TTAADC has yet to decide whether
recusal or a second approval should replace it; until they do, the disclosure is
the whole control.

## The office-wide list

The list the office reads across every pipeline, with exact reference lookup.
Cursors are opaque `[sortKey, timestamp, id]`, default 20, cap 100. The cursor
records which column it was ordered by (`intakeSortKey`), so one presented under
a different ordering is refused rather than silently seeking the wrong column.
Search is an indexed prefix — see
[the schema README](../../db/schema/README.md#searching).

Every list also returns `totalCount`, computed with the same predicates as the
page, so a client can say "1–20 of 143" and tell "no results" apart from "no
data yet". Filters that cannot mean anything — a range whose ends cross, a
negative amount — are refused by `intakeFilterProblem`, which the analytics
summary shares so the two screens cannot disagree about whether a request was
valid.

The fixed workflow's nine named queues went with it. What replaces them —
filters by pipeline, stage and status flag, and each officer's queue per stage
they own — is described in the
[pipeline guide](../../../docs/pipeline-guide.md); who may read which file is
stage ownership, stated in
[RBAC](../../../docs/admin-rbac.md#stage-ownership-is-scope-and-why-a-permission-is-not-enough).

## Documents

Staff download **fails closed**: the latest scan for that exact submitted file
must be `ACCEPTED`. A draft is refused identically to an application that does
not exist, so the path cannot be used to discover which drafts exist. There is
no GraphQL mutation to accept a scan and there must never be one —
`recordDocumentScanResult` is called only by the queue consumer, which builds
whatever scanner `SCANNER_TRANSPORT` names. Cloudmersive genuinely examines the
file; unset means accepted-but-recorded-as-unexamined, which production
refuses. See the
[document scanner service](../document-scanner/README.md).

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `intakeQueue`, `intakeByReference`, `intakeWorkspace` | `controllers/intake.ts` | The office-wide list, exact reference lookup, the whole case file |
| `intakeFilterProblem` | `controllers/intake.ts` | The filter refusals the list and the analytics share |
| `addInternalNote` | `controllers/intake.ts` | Append-only staff note; a correction points at what it replaces |
| `adminDocumentDownloadUrl` | `controllers/intake.ts` | Fail-closed signed download of a pinned file |
| `createProgrammeCycle`, `openProgrammeCycle`, `closeProgrammeCycle`, `archiveProgrammeCycle` and the rest | `controllers/programme-cycle.ts` | Cycle lifecycle |
| `replaceFormTemplate`, `addFormStage`, `updateFormStage`, `removeFormStage`, `addFormQuestion`, `updateFormQuestion`, `removeFormQuestion`, `putFormGroupDefinition`, `removeFormGroupDefinition` | `controllers/form-template.ts` | The nine form-authoring mutations; every one re-validates the whole form |
| `analyticsSummary` | `controllers/analytics.ts` | The filtered intake, grouped along every reporting dimension |
| `formTemplateProblem` | `form-template-input.ts` | A template in, `null` or one refusal sentence out |
| `expandGroupDefinitions` | `group-definitions.ts` | Materialises structure members as `USE__MEMBER` fields, or names the first fault |
| `closeExpiredProgrammeCycles` | `controllers/programme-cycle.ts` | Hourly cron; at most 20 cycles per run |
| `recordDocumentScanResult`, `recordPolicyDocumentScanResult` | `document-scanner.ts` | Append a scan outcome. Not exposed |
| `currentStaff`, `adminAudit`, `constraintSafe` | `support.ts` | The shared preamble. `constraintSafe` is re-exported from `services/constraints.ts`, where it sits beside the rule that decides which failures mean *try again* — `services/auth` needs it too, and reaching into this package for it would make one service's helper another's dependency |

## Tests

`test/service/admin.test.ts` covers the office's reads and notes;
`test/service/schema.test.ts` covers the constraints; the cycle and form
authoring have their own suites (`cycle-admin.test.ts`, `cycle-policy.test.ts`,
`form-authoring.test.ts`, `form-authoring-refusals.test.ts`,
`group-definitions.test.ts`, `analytics.test.ts`). All run under
`npm run check`, whose coverage thresholds are a ratchet set just below what the
suite holds — see `vitest.service.config.ts`.

## Elsewhere

- [Workflow guide](../../../docs/admin-workflow-guide.md) — the rules in staff
  language
- [Pipeline service](../pipeline/README.md) — everything done to a file after
  submission
- [Layering rule](../README.md) — why controllers and queries both check
- [Schema](../../db/schema/README.md) — tables, versions, search indexes
- [RBAC](../../../docs/admin-rbac.md) — roles, grants and stage ownership
