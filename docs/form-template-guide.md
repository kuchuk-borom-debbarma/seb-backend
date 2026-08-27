# The form template

How Mission SEP's application form works: what a cycle may ask, how it is
authored, how the applicant's answers are judged and kept, and why an
application always renders against the exact form it was filled on.

The application form is **configuration, not code**. A programme cycle
declares its questions the way it declares its opening time, and the software
enforces whatever the cycle declared. Adding a question to next year's cycle
is an authoring act by a super administrator, not a deploy — and that is the
point of everything described here.

This guide complements the
[administrator workflow guide](admin-workflow-guide.md) (the office's journey)
and the [application guide](application-guide.md) (the applicant's). The code
behind it lives mainly in `src/db/schema/seb/form-template.ts` (the tables),
`src/services/admin/form-template-input.ts` and
`src/services/admin/group-definitions.ts` (the authoring checks), and
`src/services/application/form/` (the engine).

## What a template is, and who owns it

A template is the complete set of questions one **cycle version** asks: its
stages, its fields, their choices, and the conditions deciding when each is
shown or required. It is stored as ordinary database rows pinned to
`(programme_cycle_id, programme_cycle_version)`, never as a JSON blob —
because the template's entire job is to be *referenced*: an answer names the
question it answers, a document slot names the `FILE` question it satisfies,
a revision request names a stage, and a document cannot be a foreign-key
target.

Editing the form is `CYCLE_ADMIN` work, which only a super administrator
holds, and it is possible **only while the cycle is a draft**. Once a cycle
opens, its questions are frozen with everything else; asking differently means
a new cycle version. Every application pins the cycle version it started
under, so:

> Rina starts her application while cycle version 2 is open. An officer later
> rewords a question, creating version 3. Rina's form, her validation, and the
> review of her submission all still read version 2 — the form she actually
> answered.

## Stages

A stage is one step of the applicant's journey: a heading, an optional
introduction (up to 500 characters), an optional icon for the stepper rail,
and an optional "takes about N minutes" hint (1–120). Stages are ordered, and
every question belongs to exactly one stage. The client draws them as the
`FormJourney` stepper, one stage per screen, with a review step at the end.

Stages are also the unit of **revision**: a correction request names one
stage, and only the named stages unlock when an application is returned for
correction.

## The fourteen field types

| Type | The applicant gives | Notes |
| --- | --- | --- |
| `TEXT` | a line of text | |
| `LONG_TEXT` | paragraphs | drawn as a textarea; may set its row count |
| `EMAIL` | an address | normalized to lowercase |
| `PHONE` | a phone number | formatting characters are stripped |
| `DATE` | a calendar date | `YYYY-MM-DD`, leap days included |
| `INTEGER` | a whole number | |
| `MONEY_PAISE` | an amount | exact integer paise, never floating point |
| `BOOLEAN` | yes or no | "no" is a complete answer |
| `ATTESTATION` | their agreement | one acceptable answer; unticked is a refusal, not a gap |
| `STATEMENT` | nothing | prose the applicant reads — a disclaimer or notice; the engine refuses any answer addressed to it |
| `SINGLE_CHOICE` | one option | options are template rows |
| `MULTI_CHOICE` | several options | each selection is stored separately |
| `FILE` | a document | its options are the accepted content types |
| `REPEAT_GROUP` | a list of entries | "add each owner" — see below |

`BOOLEAN` and `ATTESTATION` are deliberately different types: a yes/no
question has three states an applicant can be in — yes, no, and not yet asked
— while an attestation has one acceptable answer. Conflating them once meant a
required yes/no question could not be answered "no" at all.

`STATEMENT` exists so disclaimers belong to the template like every other part
of the form; without it they end up hardcoded in the client, which is exactly
what the template exists to avoid. A statement cannot be required, cannot
carry a role, and cannot sit inside a repeated group.

## What an answer must satisfy

Each field carries its own validation rules as columns — there is at most one
length range, one pattern, one numeric range and one date range per field, so
they are columns rather than a child table, and `max >= min` is a single-row
database `CHECK` instead of a cross-row invariant.

| Rule | Applies to | Means |
| --- | --- | --- |
| `min_length`, `max_length` | `TEXT`, `LONG_TEXT`, `EMAIL`, `PHONE` | character bounds |
| `min_length`, `max_length` | `MULTI_CHOICE` | how few and how many selections |
| `pattern`, `pattern_message` | `TEXT`, `LONG_TEXT`, `EMAIL`, `PHONE` | a regular expression, with the cycle's own refusal sentence |
| `min_value`, `max_value` | `INTEGER`, `MONEY_PAISE` | numeric bounds |
| `min_date`, `max_date` | `DATE` | fixed calendar bounds |
| `relative_date_bound` | `DATE` | `NOT_FUTURE` or `NOT_PAST`, resolved against the moment of the write |
| `max_file_bytes` | `FILE` | a per-document size cap; the programme-wide 2 MB upload cap applies regardless |
| `repeat_min`, `repeat_max` | `REPEAT_GROUP` | how few and how many entries; both required, at most 20 |
| `requirement` | every type but `STATEMENT` | `REQUIRED`, `OPTIONAL`, or `CONDITIONAL` (which needs a rule saying when — see conditions) |

Patterns are treated as hostile input, in four layers: at most 200 characters,
a nested-quantifier heuristic refuses the shapes that make an expression
catastrophic, any patterned field must also carry a `max_length`, and the
engine anchors the expression when the template is resolved.

## How a question is drawn

Presentation is columns too, and every one is a **closed set** — an
unrecognised value would fall back silently in a renderer, and a silent
fallback is a typo nobody finds, so a typo is refused at authoring and again
by a database `CHECK`.

| Column | On | The renderer draws |
| --- | --- | --- |
| `help_text` | any field | the "Why this is asked" popover beside the label |
| `placeholder` | typing controls (`TEXT`, `LONG_TEXT`, `EMAIL`, `PHONE`, `DATE`, `INTEGER`, `MONEY_PAISE`) | ghost text inside the control, ≤200 chars |
| `note` | any field | the inline hint under the control, ≤500 chars |
| `tone` | any field with a note or notice | `INFO`, `WARNING`, `SUCCESS`, `DANGER`; null is neutral |
| `width_hint` | any field | GOV.UK's set — fluid spans `FULL`, `TWO_THIRDS`, `ONE_HALF`, `ONE_THIRD`, plus character-sized `CHAR_2`, `CHAR_4`, `CHAR_10`, `CHAR_20` for answers whose length is known |
| `prefix_text`, `suffix_text` | `TEXT`, `INTEGER`, `MONEY_PAISE` | decoration beside the value — `₹` before an amount, `yrs` after a count; 1–8 characters, a unit not prose |
| `autocomplete_hint` | `TEXT`, `LONG_TEXT`, `EMAIL`, `PHONE`, `DATE`, `INTEGER` | the HTML autofill token (WCAG 1.3.5), from a 14-token subset a grant application plausibly asks for |
| `show_char_count` | `TEXT`, `LONG_TEXT` with a `max_length` | a live character counter — only where there is a limit to count against |
| `textarea_rows` | `LONG_TEXT` | the textarea height, 2–20 rows |
| `choice_style` | choice fields | `RADIO`, `DROPDOWN`, `SEGMENTED`, `CARD` for a single choice; `CHECKBOX_LIST`, `MULTISELECT` for a multiple one; null means the renderer's default |

Options carry presentation of their own: an `option_description` (≤200 chars,
the sentence under a choice card's title) and an `icon_name`. Stages carry a
description, an icon and the estimated minutes, as above. Icons everywhere are
a kebab-case *name* into the client's whitelisted icon registry — never
markup, so a template cannot inject anything drawable.

## Conditions: shown when, required when

A condition is one comparison against another answer, stored as a row:

- `VISIBLE_WHEN` decides whether the question is asked at all;
- `REQUIRED_WHEN` decides whether an asked question must be answered.

Rows sharing a `group_number` are **ANDed**; separate groups are **ORed**.
Two integers rather than an expression string, because an expression string is
the opaque blob these tables exist to avoid — and because an unstated
combinator is exactly what a server and a client would each guess differently.
There is deliberately no `IN` operator: two rows in different groups say the
same thing in the vocabulary already here.

The operators are `EQUALS`, `NOT_EQUALS`, `GREATER_THAN`,
`GREATER_OR_EQUAL`, `LESS_THAN`, `LESS_OR_EQUAL`, `IS_PRESENT`, `IS_ABSENT`.
A presence test carries no comparison value; every other operator must.

What may be a **source** is constrained: a repeated group has no value of its
own, so it can never be a source; a `FILE` answers only presence tests; the
ordering operators apply only to `INTEGER`, `MONEY_PAISE` and `DATE` — because
ordering a text answer is a comparison nobody meant to write. A field cannot
depend on itself, and the visibility graph must be **acyclic**: a cycle
deadlocks a form permanently, so it is refused at authoring, not discovered by
an applicant.

Visibility runs to a fixed point. A hidden question is never required, and its
answer is cleared rather than stored — so hiding a question also hides
whatever depended on it. The client evaluates the same rules itself (a
question must appear the moment the answer above it changes), which makes two
implementations of one grammar; `test/service/client-parity.test.ts` runs both
over the same templates and asserts they agree on every operator and every
grouping.

## The two roles, and why only two

Most code never names a question — it walks the template. But a little code is
not template-aware and still has to find its input: the administrative queue
filters across many cycles at once, so there is no single pinned template to
resolve a key from, and the decision's amount bound has the same problem. A
**role** is how such code finds its input.

| Role | Pinned key | Why it exists |
| --- | --- | --- |
| `SEED_FUND_REQUESTED_PAISE` | yes — the key must be `SEED_FUND_REQUESTED_PAISE` | the queue's cross-cycle amount filter and the decision's bound read it as a literal in SQL |
| `APPLICANT_DATE_OF_BIRTH` | no — any key, and it may live inside the owners group | the age rule resolves it per template; no SQL path reads it, which is what a pin is for |

There used to be six. The business name, sector, establishment date and
category stopped being answers at all — they are read live from the enterprise
entity, and the category is computed by the server at submission — so the
questions that duplicated them left the template, and their roles left with
them. The cost of a pin, stated plainly: a role-bound field with a canonical
key **cannot be renamed**.

A template must bind each role exactly once. Authoring refuses the gap by
name (*"This cycle has no question the programme can read as …"*), and
`resolveFormTemplate` refuses to resolve a template with an unbound role at
all — so a cycle can never reach the state where its form cannot be read
back.

## Repeated groups

A `REPEAT_GROUP` is a question whose answer is a list of entries — the worked
example throughout the system is **owners**:

> The cycle asks for the enterprise's owners. `OWNERS` is a repeated group
> with `repeat_min = 1`, `repeat_max = 10`; its members are a name, a date of
> birth and a share. Rina adds two entries: herself and her brother.

Members are ordinary fields carrying `parent_field_key = 'OWNERS'`. Groups do
**not** nest — an answer inside a nested group would need two indices to
address, and an issue path carries one. A member sits in its group's stage,
because a group is drawn as entry cards inside one stage. A group may allow at
most 20 entries, and a member may not be a `REPEAT_GROUP`, a `FILE` (a
document has its own versioned row and cannot repeat per entry), or a
`STATEMENT` (the same prose n times is noise).

The one role allowed inside a group is `APPLICANT_DATE_OF_BIRTH` — the age
rule walks the group's entries for it (see the pipeline below).

## Reusable structures

A cycle can define a structure once and use it wherever a repeated group needs
it:

> "An **Owner** is a name, a date of birth, a share." The cycle defines the
> structure `OWNER` with those three members, then declares the group `OWNERS`
> using it — and if a later stage needs guarantors with the same shape, the
> group `GUARANTORS` uses the same structure, and the questions are never
> maintained twice.

The definition is the authoritative, editable thing. At authoring time,
`expandGroupDefinitions` (`src/services/admin/group-definitions.ts`)
**materialises** each member as an ordinary field row under a qualified key —
`USE__MEMBER`, so `OWNERS__DOB`, `GUARANTORS__DOB` — placed directly after its
use. Everything downstream (the engine, answer storage, issue paths, the
renderer, the parity suites) sees the flat model it already proves; the
authoring read strips the derived rows and shows the definition again, so an
officer edits the structure, never its expansion. The `group_definition_key`
kept on the use is provenance, not behaviour.

The guards, each with its number and its refusal sentence:

| Guard | Refusal |
| --- | --- |
| at most **16** definitions per cycle | *"A cycle may define at most 16 reusable structures."* |
| at most **24** members per definition | *"The structure OWNER may have at most 24 members."* |
| at most **20** entries per group | *"OWNERS may allow at most 20 entries."* |
| at most **200** questions, counted after expansion | *"A cycle may ask at most 200 questions."* |
| at most **20** stages | *"A cycle may ask at most 20 stages of questions."* |
| **one** level of nesting — a member is never a group | *"A member of OWNER cannot be a repeated group, a document, or a statement."* |
| no conditions on members, in this version | *"OWNERS__DOB belongs to a structure: rules on structure members are not supported yet."* — a condition among members would need the definition to say it, or the next re-expansion would silently drop it |
| a qualified key stays a valid key (≤64 chars) | *"Expanding OWNERS makes the key OWNERS__…, which is longer than a key may be."* |
| no collision with a declared question | *"Expanding OWNERS collides with a question called OWNERS__NAME."* |
| a use declares no members of its own | *"OWNERS uses a structure and cannot declare members of its own."* — a hand-declared extra would drift from what the next edit re-expands |

## How answers are stored

One row per answered value, in `seb_application_version_answer`
(`src/db/schema/seb/answer.ts`) — **rows, not a document**, because the
composite key onto the form-field table makes an answer for a question the
pinned cycle version never asked *impossible in SQL*, not merely refused by
whichever code path remembered to check.

- **Sparse.** A question never answered, or whose answer was cleared, has no
  row. Absent and empty are one state.
- **`entry_index`** is 0 for an ordinary field and 1..n inside a repeated
  group. **`value_ordinal`** is 0 for a single value and 1..n for each
  selection of a multiple choice. Between them they carry repetition and
  multi-value without a third table.
- **Entry markers.** Storage writes one row per group entry — the group's own
  key, the entry's index, empty text — meaning "this entry exists" and nothing
  more. Without it, an entry whose members were all blank wrote nothing, the
  entry count shrank, and every entry after it shifted down, silently
  reassigning answers between owners.
- **One text column**, read through the field's declared type. The trade is
  deliberate: the database cannot tell an amount from prose (the engine can),
  but rows buy the referential integrity above, which a JSON document could
  not have at any price.

The whole answer set is bounded at **32 KB** (`MAX_ANSWER_BYTES` in
`src/services/application/form/engine.ts`). The engine refuses a save beyond
it — and authoring refuses a *template* whose questions, answered at their own
declared limits, could not fit: the worst case is computed at three bytes per
character, which is what Bengali or Kokborok costs, counting every member once
per permitted entry. Refused at authoring or not at all — otherwise the first
applicant to fill the form is told to shorten answers they cannot shorten,
because it is the form that is too large.

## Issue paths

A validation issue names the control that produced it, so the client can link
the refusal straight to something on screen. The path grammar
(`issuePath` in `src/services/application/form/codes.ts`):

| Path | Points at |
| --- | --- |
| `PROJECT_COST` | an ordinary field |
| `OWNERS[2].DOB` | the member `DOB` of the second `OWNERS` entry |
| `OWNERS[2]` | the entry as a whole, when the fault is the entry rather than any question in it |

Each issue also carries its stage key (so refusals group by step) and a closed
`ValidationIssueCode` — an enum, not a string, so a code the engine emits that
the schema does not publish is a loud serialization error rather than a quiet
mystery in the client.

## Versioning and copy-forward

Every change to a cycle — its policy or its form — creates a new cycle
version, and the version bump copies **ten rule tables** forward with
`INSERT … SELECT`: the four form tables (stages, fields, options, conditions),
the three structure tables (definitions, members, member options), and the
identifier rules, assessment rules and reason catalogue
(`src/services/admin/queries/programme-cycle.ts`). A rule table missed here
would silently empty the first time a cycle changed version — for the form
tables that loses the entire questionnaire — which is why the copy is written
as a block and commented as one.

Children name their parent by **key**, never by row id: the copy mints fresh
ids as it goes, and a copy that mints ids cannot rewrite id-based child
pointers in the same statement. Keying on
`(programme_cycle_id, programme_cycle_version, field_key)` is what makes the
copy-forward plain statements instead of an id-remapping exercise.

An application pins the version it started under, and its answers are pinned
to the same version by a second composite key — so a submission stays
permanently readable against the exact form it was filled on, whatever the
cycle does next.

## Authoring

Nine mutations under `mutation.admin.formTemplate`
(`src/services/admin/controllers/form-template.ts`):

| Mutation | Does |
| --- | --- |
| `replace` | the whole form at once |
| `addStage`, `updateStage`, `removeStage` | one step |
| `addQuestion`, `updateQuestion`, `removeQuestion` | one field, its options and its conditions |
| `putGroupDefinition`, `removeGroupDefinition` | one reusable structure |

All nine funnel through one editing path: `CYCLE_ADMIN`, a required change
reason, **draft cycles only** (*"A cycle's questions can only be changed while
it is a draft."*), then structures expand, and then the **entire** form —
never just the changed part — is re-checked by `formTemplateProblem`
(`src/services/admin/form-template-input.ts`). A template goes in; either a
template comes out or one refusal sentence does, naming the question to fix.
A removal that would orphan a condition elsewhere is refused with the name of
the question that would have been left unanswerable. The write is the same
guarded cycle-version write every other cycle change uses.

The same checks exist three times over, deliberately: the authoring pass (a
useful sentence), the database CHECKs (a correct outcome whatever the code
does), and the resolve step (a template read back is verified before any
applicant sees it).

The office edits all of this on the cycle editor's form screen in the client —
stages, questions, presentation, structures — described in the
[administrator workflow guide](admin-workflow-guide.md#authoring-the-application-form).

## The applicant's pipeline

1. **Resolve.** `resolveFormTemplate`
   (`src/services/application/form/template.ts`, read via
   `src/services/application/queries/form-template.ts`) turns the pinned
   version's rows into a usable form: it verifies both roles are bound,
   anchors patterns, and strips derived-structure bookkeeping. It is the one
   door from rows to a form.
2. **Render.** The client's `FormRenderer` walks the template and draws one
   control per question — labels, help, choices, bounds and conditions are all
   the cycle's own. Visibility is evaluated client-side with the same grammar
   the server uses, proven equal by the parity suite.
3. **Normalize.** A save replaces the whole answer set. `normalizeAnswers`
   coerces each value against its declared type; an unknown key is refused
   rather than dropped, hidden answers are pruned, and answers addressed to a
   `STATEMENT` or to a server-derived field are refused.
4. **Validate.** `validateAnswersForSubmission` applies every field's rules
   and conditions, then the three **policy rules** that read cycle scalars
   rather than template rows, finding their inputs through the roles:
   - **Age** — at least one owner's date of birth must fall in the cycle's
     band (default 18–60). Deliberately "at least one": a firm with a founder
     of 30 and a retired parent as co-owner is eligible, and the issue
     attaches to the owners group, a real control.
   - **Category** — computed, never asked: `CATEGORY_A` when the enterprise
     has been trading at least the cycle's threshold (default 24 months) at
     submission, `CATEGORY_B` when younger. An enterprise with no
     establishment date cannot be sorted, so submission is refused with
     `ESTABLISHMENT_DATE_MISSING`, pointing at the enterprise screen where
     the fix lives.
   - **Ceiling** — the requested amount is refused above the cycle's funding
     ceiling, where the cycle has one resolved; unresolved means no ceiling
     is enforced.
5. **Submit.** Submission freezes an application version, writes the sparse
   answer rows against the pinned template, stamps the computed category on
   the version row, freezes the exact version of every document, mints the
   reference number — and then, best-effort and after the write has already
   succeeded, emails a confirmation with a PDF copy of the application
   (`src/services/application/confirmation.ts`).

## Elsewhere

- [Administrator workflow guide](admin-workflow-guide.md) — authoring in the
  office's language, and everything after submission
- [Application guide](application-guide.md) — the applicant's journey the
  form sits inside
- [Database schema](../src/db/schema/README.md) — the tables, keys and CHECKs
  behind all of this
- [Applicant service](../src/services/application/README.md) — the engine's
  flows and exports
- [Administrative service](../src/services/admin/README.md) — the authoring
  flows and exports
- [Roadmap §5](ROADMAP.md) — what the form system delivers and what is still
  open
