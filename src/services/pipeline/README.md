# Pipeline service

Configured pipelines: authoring them, and working a submitted file through
their stages. An application's route after submission is data — stages owned
by roles, actions that ask the officer for inputs, effects that change the file
— and this service is the code that validates that data and carries it out.
Nothing here knows a stage's name.

Two families of operation live here and share only `support.ts`:

- **Authoring** changes a pipeline's shape and who works its stages, behind the
  `pipeline` resource.
- **Casework** works a file through a stage, behind the `stage` resource *and*
  stage ownership.

The model in the office's terms — stages, owners, actions, effects, flags, the
worked Mission SEP route — is the
[pipeline guide](../../../docs/pipeline-guide.md). This document is how the code implements it.

## What it assumes

- **A pipeline version's document is valid whenever it is read.** Every save,
  publish and load parses it with `parseDefinition` against the generated
  catalogue. A stored document naming something this build no longer has fails
  to parse and is treated as "this pipeline cannot be worked", never as an
  empty one.
- **A published version never changes.** Every write predicate names
  `status = 'DRAFT'`, so the version a cycle pinned — and every application in
  it — is the version it will be worked in to the end.
- **The file's state is read once, and decided on in pure code.** The engine
  takes the head's stage, trail, flags and recorded values, the referenced
  answers, and the officer's inputs, and returns a plan or a refusal. It never
  touches the database, so the write can only carry out a decision the engine
  made.
- **Authority is live.** The session query returns permissions *and* owned
  stages in one statement on every request; nothing is cached between requests.
- **What an action costs comes from the catalogue.** An action's permission
  pairs are the union of its effects' declared pairs (`permissionsFor`), never
  something the author wrote.

## Layout

| Path | Owns |
| --- | --- |
| `definition.ts` | The document's syntax: the zod schema for a version — stages, actions, inputs, effects, conditions, flags, recorded values — built from the generated catalogue's unions |
| `validate.ts` | The document's meaning: `pipelineProblems` (reachability, an ending, exclusivity, references, permissions) and `pipelinePinProblems` (whether a cycle's form can carry it). Every problem at its path, all at once |
| `registry.ts` | The three registries' shapes and their `define…('KEY', …)` constructors: effects, parameter kinds, condition sources |
| `effects/` | One file per effect — its strict parameter schema, its permission, its document checks and its pure `plan` — and `effects/index.ts`, the registry keyed by the catalogue's union |
| `param-kinds.ts` | How each kind of parameter is checked: that a `STAGE_KEY` names a stage, a `STATUS_FLAG_KEY` a declared flag |
| `condition-sources.ts` | Where each condition source reads — an answer, a flag's presence, a recorded value, an input — and the type to compare it as |
| `inputs.ts` | An action's inputs adapted into a one-stage form and run through the application form's own engine |
| `engine.ts` | `planAction`: the fired effects merged into one plan, and the rules no configuration can break |
| `permissions.ts` | The `stage` and `application` pairs answered through literal `holdsPermission` calls |
| `example.ts` | The Mission SEP route as a definition: the editor's starting point, the test suites' fixture, the guide's worked example |
| `support.ts` | The context type, the refusal messages, `pipelineAudit` |
| `queries/`, `controllers/` | Authoring (create, save a draft, validate, publish, discard, retire, set a stage's owners) and casework (the stages a person owns, a stage's queue, one file's state and the actions offered on it, taking an action, withdrawing a revision request, and the read scope repeated inside SQL) |

The vocabulary itself — every effect, input type, condition source, parameter
kind, form rule and eligibility rule — is
[`catalogue/workflow.json`](../catalogue/workflow.json), generated into
`workflow.generated.ts`.

## Flows

### Planning an action

`planAction` evaluates each effect's `when` against the file and the inputs,
asks each fired effect's handler for its fragment, and merges them. It returns a
refusal — never a partial plan — when any handler refuses or when the fragments
together break a rule:

1. **A file is at one stage, or none.** At most one fired effect may move it,
   and moving and waiting for the applicant are exclusive.
2. **A return goes where the file came from** — the last entry of its own
   trail, which is popped; a forward move pushes the stage it left.
3. **Presence flags follow the stage.** A stage's presence flags are removed
   when the file leaves and the destination's are added when it arrives.
4. **An ending leaves no stage.** A terminal flag sets the destination to none.

The plan carries the destination, the trail operation, the flags added and
removed and the resulting set, the recorded values, the revision flag, the
notifications and the notes — everything the write needs and nothing it has to
decide.

### Validating a document

`pipelineProblems` refuses what could loosen the applicant's lock or strand a
file: a stage no route reaches or no action leaves; no path to an ending; an
action that moves twice, or moves and hands the file to the applicant; an
editing flag added by anything but `REQUEST_REVISION`; a terminal flag added by
anything but an ending effect; a return from the initial stage; an action whose
effects need no permission; a choice route that misses an option; a presence or
submission flag that is not an ordinary flag; and any reference to a stage,
flag, input or recorded value that does not exist. `INPUT` conditions are
refused in `availableWhen`, because whether an action is offered cannot depend
on what the officer has not yet typed.

`pipelinePinProblems` is the cross-check against one cycle's frozen form: every
answer the pipeline reads is a top-level question of the type it expects, an
answer used to bound money is a number, and a pre-filled choice cannot arrive
with an option its input does not offer.

### Taking an action

| | |
| --- | --- |
| **Entry** | `admin.stage.takeAction` |
| **Guard** | every pair `permissionsFor` the action returns, **and** ownership of the stage (`ownsStage`); a super administrator passes both |
| **Refuses** | a file not at the stage the officer was looking at, or a stale status version; an action not offered for this file; invalid inputs, in the form engine's own issue shape; a plan an effect refuses, such as an amount above its bound |
| **Writes** | one data-modifying `WITH`: the guarded head update (stage, trail, flags, recorded values, status version), the stage-action row, revision requests, notes, the timeline event, and the audit row through `auditEventCteMember` |
| **Guarded by** | `status_version`, the current stage and the pinned pipeline version in the head's predicate, and `unique (application_id, status_version)` on the action row as a second guard |
| **Fails** | one refusal naming no role for anything the caller may not do; `The record changed.` for a lost race |

Notifications are sent after the write commits, best-effort. A failure is
recorded as its own audit action and never undoes the action.

### Resubmission

Not here: the applicant service's resubmission write leaves the file at the
stage that asked and removes the revision flag, over the same pinned version.
See its README.

## Invariants

| Invariant | Held by |
| --- | --- |
| **A losing writer writes nothing.** No action row, event, audit row, revision request or note | the head update is the first member of the `WITH` and every other member selects from it; `unique (application_id, status_version)` on the action row |
| **One stage at a time; an ending leaves none** | `planAction`'s exclusivity rules; the head's lifecycle `CHECK` |
| **The applicant's edit lock loosens only through a revision** | only `REQUEST_REVISION` may add a `REVISION_SCOPED` flag (validator and effect), no action is offered while one is held, only resubmission removes it, and only named form stages unlock |
| **Configuration is frozen once published** | `status = 'DRAFT'` in every write predicate; the cycle's and the application's pins |
| **Money bounds hold whatever is configured** | `SET_RECORDED_VALUE` enforces `atMostAnswer` and `atMostCycleCeiling` in its `plan`; money inputs are whole non-negative paise through the form engine |
| **An action costs what its effects cost** | `permissionsFor` over the catalogue; literal guards in `permissions.ts`; ownership checked in the controller and repeated in SQL |
| **Every change is recorded in the same statement** | authoring writes carry their audit row in the same batch; a stage action carries it in the same `WITH`; payloads are strict and never copy long text |
| **A reference to nothing is false, never true** | every condition source returns null for an unknown key, and a condition over null fails |

## Performance

A statement is a network hop, so the budget is round trips, and a plan taken
against a hundred rows says nothing about a hundred thousand. **These are
targets**, to be measured against a 100,000-application fixture with `EXPLAIN
(ANALYZE, BUFFERS)` and round-trip counters, and replaced here by the measured
figures.

| Operation | Round trips | DB p95 target at 100k | How |
| --- | --- | --- | --- |
| Session with owned stages | 1 (the existing session query) | < 3 ms | a subquery on the partial `seb_pipeline_stage_owner_role_idx` |
| A stage's queue page | 3 | page < 5 ms, count < 15 ms | `seb_application_stage_queue_idx` is the seek and the keyset order, so no sort |
| My stages, with counts | 2 | < 20 ms | the same index, grouped |
| Office-wide list by flags | 3 | < 50 ms | GIN on `status_flags` |
| One file's pipeline state | 3 | < 8 ms | one folded read; the definition from the per-request loader |
| Taking an action | **3, whatever the number of effects** | < 10 ms, engine < 2 ms | one folded context read, one data-modifying `WITH` |
| Eligibility at start | +0 | < 5 ms | folded into the start read |

A page naming applications from several pipeline versions resolves every
definition in **one** statement, through the `pipelineDefinition` loader in
`src/loaders/index.ts`, and parses each document once per request.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `pipelineDefinition`, `parseDefinition`, `PipelineDefinition` | `definition.ts` | The document schema, and parsing a stored or submitted one |
| `pipelineProblems`, `pipelinePinProblems`, `PipelineProblem` | `validate.ts` | Every problem with a document, and with pinning it to a form |
| `planAction`, `actionIsAvailable`, `permissionsFor`, `conditionsHold`, `awaitsApplicant`, `stageOf` | `engine.ts` | Deciding what an action does, and whether it is offered |
| `validateActionInputs`, `actionInputTemplate`, `actionInputRows`, `INPUT_STAGE_KEY` | `inputs.ts` | Inputs through the form engine, and the form a client renders them with |
| `holdsEvery` | `permissions.ts` | Whether a session holds an action's pairs |
| `defineEffect`, `defineParamKind`, `defineConditionSource` | `registry.ts` | Registration; the key is the marker `check:workflow-catalog` matches |
| `effectHandlers`, `effectHandler` | `effects/index.ts` | The effect registry |
| `paramKindHandlers` | `param-kinds.ts` | The parameter-kind registry |
| `conditionSourceHandlers` | `condition-sources.ts` | The condition-source registry |
| `examplePipeline` | `example.ts` | The worked Mission SEP definition |
| `pipelineAudit`, `PipelineOperationContext`, `NOT_FOUND_MESSAGE` | `support.ts` | Shared by both families |

## Adding to the vocabulary

A new effect, parameter kind or condition source is a catalogue entry and one
file:

1. Declare it in `catalogue/workflow.json` — for an effect, its parameters with
   their kinds and the permission pair it needs.
2. Run `npm run workflow-catalog:generate`.
3. Write its handler as one file with `define…('KEY', …)`: a strict parameter
   schema, document checks if any, and a pure `plan`.
4. Register it in its registry, which is keyed by the generated union and will
   not compile without it.
5. Add the client's editor control (`defineParamControl`) for a new parameter
   kind, and the value to the SDL enum.

`npm run check:workflow-catalog` fails naming anything missed on either side,
and `test/service/workflow-catalogue.test.ts` fails if a handler's parameters
differ from its declaration or an SDL enum from its catalogue set.

## Elsewhere

- [Pipeline guide](../../../docs/pipeline-guide.md) — the model in the office's
  terms, and the worked example
- [RBAC](../../../docs/admin-rbac.md) — the `stage` and `pipeline` resources,
  stage ownership and its ceilings
- [Code rules](../../../docs/rules/code.md) — the frozen document, the
  catalogue checks, one-statement stage writes
- [Schema](../../db/schema/README.md) — the pipeline tables and the head's
  pipeline columns
- [Applicant service](../application/README.md) — submission and resubmission,
  the two writes that touch the pipeline from the applicant's side
