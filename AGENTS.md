# Repository working agreement

This file applies to every change in this repository, whether the work adds a
feature, fixes a defect, changes a business rule, improves security, refactors
code, or updates configuration.

## Roadmap review is required

Before implementing a change, read [`docs/ROADMAP.md`](docs/ROADMAP.md) and
identify the roadmap items, product rules, dependencies, and unresolved policy
decisions affected by the work.

After implementing the change, review the roadmap again and update it whenever
the delivered behaviour or remaining work has changed. In particular:

- Check an item only when the exact behaviour described by that checkbox is
  implemented and independently verifiable.
- Do not check a broad parent capability merely because its foundation or one
  supporting component exists.
- Add a new checkbox when the change introduces a meaningful product capability,
  limitation, prerequisite, follow-up, or policy decision that the roadmap does
  not already describe.
- Rewrite a roadmap item when the agreed behaviour changes; do not leave the old
  rule beside the new implementation.
- Keep unresolved decisions explicit. State the precise decision required, who
  must make it, and what behaviour applies until it is resolved.
- Preserve the roadmap's business focus. Describe what users or programme staff
  can do and how it behaves, not internal implementation tasks.

A change is not complete while its roadmap status or description is stale.

## Documentation must remain current

Every implementation, fix, refactor, and configuration change requires a
documentation-impact review.

1. Search the existing root README, `docs/`, service READMEs, and schema README
   for descriptions affected by the change.
2. Update the existing focused document when one already owns the subject. Do
   not create a competing guide that repeats the same responsibility.
3. Create a new focused document only when the feature introduces a distinct
   workflow or subject that has no suitable existing home.
4. Link a new guide from the nearest relevant existing guide and from the root
   README when it is useful to repository users.
5. Remove or rewrite exclusions, assumptions, examples, setup steps, security
   notes, and “future work” statements that the change has made obsolete.
6. Ensure commands, environment-variable names, endpoint names, response
   examples, roles, lifecycle states, validation rules, and failure behaviour
   match the implementation exactly.
7. Keep sensitive values out of examples. Use clear placeholders and state how
   secrets are provisioned and removed.

Documentation should explain intent, user-visible behaviour, important rules,
failure cases, and operational use in plain language. Avoid comments or prose
that merely repeat names without explaining why the behaviour exists.

## Completion checklist

Before handing off any change:

- Confirm the roadmap was reviewed and updated where required.
- Confirm all existing documentation affected by the change was updated.
- Confirm no document still describes removed behaviour as current or delivered
  behaviour as future work.
- Confirm any new guide is linked and does not duplicate an existing guide.
- Confirm code comments explain non-obvious business, security, concurrency, and
  lifecycle decisions.
- Run the checks appropriate to the change, including documentation whitespace
  checks for documentation-only work.
- Report the roadmap and documentation changes in the final handoff.

If a change truly has no roadmap or documentation impact, leave the files
unchanged, but make that conclusion only after completing the review above.
