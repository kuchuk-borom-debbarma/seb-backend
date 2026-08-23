# Documentation

How this repository writes things down.

The rule this exists to enforce: **every subject has exactly one owner.** When
two documents describe the same thing, both are wrong within a few months,
because a change only ever gets made in one of them.

## Who owns what

| Layer | Owns | Lives in |
| --- | --- | --- |
| **Programme** | What the rules *are*, what the office promises an applicant, what TTAADC has still to decide | `docs/*.md` |
| **Engineering** | How the code implements those rules — the flow, the guards, the SQL, the invariants, the failure | `src/**/README.md` |
| **Client** | The browser client and its own conventions | `dev-web/README.md` |
| **Rules** | How this repository is written and built | `docs/rules/*.md` |

Where both layers need the same fact, one states it and the other links. Never
both in full. A link that says "the rules are in X" is not duplication; a
paragraph that restates them is.

The test for which layer owns something: **would a programme officer need to
read this?** If yes it is a programme document, even when the answer involves
the database. If only somebody changing the code would read it, it belongs
beside the code.

## The shape of a service README

Every service and the schema follow the same five parts, so a reader who has
read one knows how to read the next.

1. **What this is for.** One paragraph, taken from the module's own doc
   comments rather than composed afresh.
2. **What it assumes.** The conditions the service takes for granted and does
   not re-check, because something upstream already did. These are what make a
   service readable — and in this repository they are currently scattered
   through comments rather than collected anywhere. State them as facts:
   *"an application's funding case is fixed when it is created and never
   moves"*, not *"we assume the funding case does not change"*.
3. **How each operation flows.** For each one, in this order:

   | | |
   | --- | --- |
   | **Entry** | the GraphQL operation or exported function |
   | **Guard** | which role, and any ownership or assignment check |
   | **Refuses** | what it rejects and why — the interesting half |
   | **Writes** | what lands, and that it is one batch |
   | **Guarded by** | the predicate that decides a concurrent race |
   | **Fails** | the message a caller actually sees |

4. **Every export.** A table of symbol, file, and one line. This is an index,
   not a reference: it says where a thing lives, never what its parameters are.
5. **Elsewhere.** Links out to whatever this document deliberately does not own.

## The shape of a programme document

Narrative, with worked examples using named people and real amounts. State the
rule, then why it exists, then what happens when somebody hits it. Tables for
anything enumerable. No code.

## The shape of a rule

Imperative and short. Say what to do, and name the incident that made the rule
necessary — a rule with a scar attached is followed; an abstract one is not.

## Conventions

- **Hard wrap at 80 columns.** Matches every existing document and keeps diffs
  readable. Three things cannot be wrapped and are exempt: table rows, fenced
  code, and reference-link definitions.
- **Tables** for anything enumerable — states, roles, operations, constraints.
  Prose lists of more than four items should be a table.
- **Mermaid** for sequence and state. Rendered by GitHub; there is precedent in
  [`../application-guide.md`](../application-guide.md).
- **Relative links only.** Never an absolute filesystem path. This repository
  has already shipped a link to `/Users/<somebody>/Downloads/…` in a
  committed document,
  which is broken for every other reader and leaks a home directory.
- **Every claim checked against the code**, not memory. Ports against
  `package.json`, environment variables against `src/bindings.ts`, roles against
  `src/db/schema/core/auth.ts`, tables against `database/schema.sql`.
- **No changelog sentences.** *"Role management now exists"* is true on the day
  it is written and misleading forever after. Describe what is, not what
  changed. If something is genuinely not built, say so in the present tense and
  say what is missing.

## What must never be written twice

These are the four the repository has actually accumulated, kept here as the
worked example rather than an abstract warning:

| Subject | Was in | Now owned by |
| --- | --- | --- |
| Upload rules — MIME types, 5 MB, the signed headers, the cleanup retry | four places | `src/services/application/README.md` |
| Transcribed identifiers and the key-rotation warning | three places | `docs/admin-workflow-guide.md` for the rule, `src/services/admin/README.md` for the mechanism |
| The named-queue rationale | two places, near-verbatim | `docs/admin-workflow-guide.md` |
| What bounds a request | the client's guide, describing server limits | `src/graphql/README.md` |

Configuration files are the one exception. `.env.example` may restate a
one-line warning next to the variable it applies to, because somebody editing
it is not reading anything else.

## Retiring a document

1. **Find every inbound link first** — from other documents *and from code
   comments*. `dev-web/src/features/admin/officeGuidance.ts` cites
   `docs/admin-workflow-guide.md` by path and by nine section names; renaming
   either would break a contract that no link checker would catch.
2. Move the content to whichever layer owns the subject.
3. Update every inbound link in the same change.
4. Do not leave a stub that says "moved". A deleted file and a corrected link
   are cleaner than a redirect nobody removes.

## Pinned headings

Some headings are referenced by anchor and must not be renamed:

| Heading | Referenced by |
| --- | --- |
| `## Role administration` in [`../admin-rbac.md`](../admin-rbac.md) | three inbound anchor links |
| The nine sections of [`../admin-workflow-guide.md`](../admin-workflow-guide.md) cited in `officeGuidance.ts` | the client's office help text |
