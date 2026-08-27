# Rules

Rules that govern how this repository is written, so that a rule has somewhere
to live other than somebody's memory.

A rule belongs here when it is a standing decision about *how* work is done —
not what the programme's policy is, and not how one service happens to be
built. One file per subject.

| Rule | Governs |
| --- | --- |
| [Code](code.md) | The layering rule, transport services, batching, loaders, pagination, and comments |
| [Documentation](documentation.md) | Who owns which subject, the shape each kind of document takes, and what must never be written down twice |
| [GraphQL](graphql.md) | Describing the schema so that the people calling it can read it |
| [Security](security.md) | What must never reach a log, how guards fail, and what a public route must state about itself |

## Rules that do not exist yet

Named here because their absence has already cost something, and because an
empty row is more honest than silence.

- **Code formatting.** The Worker has no Prettier configuration, so its real
  style — single quotes, no semicolons, 90 columns — is written down
  nowhere. Running Prettier against it reformats it to that tool's defaults.
  This has happened twice: once to `src/graphql/validation.ts`, which acquired
  51 semicolons and had to be restored, and once across the whole of `src/`,
  which was caught before it was committed. `dev-web/.prettierrc.json` pins the
  client's style and has never had the problem. Until a configuration exists,
  **do not run a formatter over `src/`.**
- **Testing.** What must be covered, what a test is allowed to assume, and why
  the Worker's coverage thresholds are a ratchet set just below what the suite
  holds while the client is covered by end-to-end tests instead. Currently
  inferable only from `vitest.service.config.ts` and the suites themselves.

## Related

The working agreement in [`AGENTS.md`](../../AGENTS.md) covers *process* —
when the roadmap must be reviewed, what to confirm before handing work off.
These rules cover *standards*. Process says when; a rule says what good is.
