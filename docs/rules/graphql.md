# GraphQL

The schema is the API's documentation for everybody who calls it. These rules
are about keeping that true.

Every rule here names the thing that made it necessary.

## `"""` never `#`

**A `#` comment reaches nobody.** It is a lexer comment, discarded by the
parser, so it never appears in introspection, in GraphiQL, in a schema explorer,
or in the TypeScript the client generates. A `"""triple quoted"""` description
survives all four.

The scar: this repository accumulated **138 `#` comments and zero
descriptions**. Several said exactly the right thing. None of them reached a
single person calling the API, and the proof was
`dev-web/src/graphql/generated/schema.ts` — one JSDoc block in the entire file,
belonging to the generator.

Use `#` only for a note to whoever edits the SDL next, never for anything a
caller needs.

## Everything is described, and it is checked

Every named type, field, field argument, input field, enum and enum value.
`npm run check` fails otherwise, via the checker in
[`scripts/`](../../scripts/check-sdl-descriptions.mjs).

Total coverage is not thoroughness for its own sake — **it is what makes the
rule checkable.** A rule that applies to "the important ones" cannot be
enforced, so it decays to nothing. That is exactly what happened here.

The checker also rejects a description that only restates the field's own name.
`"""The application id."""` on `applicationId` passes a counter and helps
nobody, and it is what a coverage gate produces if nothing stops it.

## Say what it is for, then what will surprise them

The name carries the *what*. A description earns its place with what the name
cannot say:

- what the value is used for, and by which screen
- what a null means, when null is possible
- what the units are — `Money` is **paise**, and guessing rupees is a
  hundred-fold error in an award
- which refusals a caller has to draw something for
- what the caller must send back, and what happens if it is stale

```graphql
"""
Optimistic-concurrency token for this enterprise.

Read it with the record, send it back in `expectedVersion`, and a concurrent
edit refuses instead of silently overwriting. **Example:** read `3`, edit,
send `3`; the write succeeds and the version becomes `4`. Sending `3` again
refuses with *"The record changed. Reload and try again."*
"""
version: Int!
```

## Operations carry a use case and an example

A mutation says which screen calls it, what it does, and what it refuses:

```graphql
"""
Records the desk review and moves the application on.

**Use case:** the reviewer's form at `/admin/applications/$id`. The nine
checks, the transcribed identifiers and the outcome are one write, so a
review can never be half-recorded.

**Refuses:** a passed check with no identifier the cycle demands; an
identifier already on another funding case with no explanation; a stale
`expectedStatusVersion` when somebody else acted first.
"""
completeDeskReview(input: CompleteDeskReviewInput!): AdminWorkspaceResult!
```

## The schema owns the contract, never the mechanism

What a caller must send and what comes back belongs here. *How* a guard is
implemented — which predicate, which batch, which index — belongs in the
service README.

This is the one-owner rule from [Documentation](documentation.md) applied to the
schema. A description explaining that a write is guarded by `status_version`
inside the `WHERE` is a second copy of something
[`src/services/admin/README.md`](../../src/services/admin/README.md) owns, and
the two will disagree.

Say *"refuses if somebody else has acted since you loaded this"*. That is the
contract. The predicate is not.

## The security rules apply to the schema

Everything in [Security](security.md) about what must never reach a log applies
to a description, which is **more** exposed than a log: introspection is public
to anybody who can reach the endpoint.

Never describe an internal id scheme, the shape of a token, the contents of a
sealed payload, or which secret signs what.

## No changelog sentences

Same rule as every other document here. *"Now returns the frozen rules"* is true
the day it is written and misleading forever after. Describe what is.

## Related

- [Documentation](documentation.md) — who owns which subject
- [Code](code.md) — the layering rule, batching, and pagination
- [Security](security.md) — what must never be disclosed
- [`src/graphql/README.md`](../../src/graphql/README.md) — how the schema is
  assembled, and what bounds a request
