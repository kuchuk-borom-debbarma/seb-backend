# Code

How this repository is built, so that a decision has somewhere to live other
than the file that happens to embody it.

Every rule here names the thing that made it necessary. A rule with a scar
attached is followed; an abstract one is deleted by the next person who finds it
inconvenient.

## The layering rule

Every service is `controllers/` over `queries/` over `support.ts`.

| Layer | Decides |
| --- | --- |
| `controllers/` | authorization, input validation, orchestration, and the friendly refusal |
| `queries/` | all Drizzle SQL, all D1 batch boundaries, and every authorization, lifecycle and version term **repeated inside the write predicate** |
| `support.ts` | the response envelope, the audit-row builder, the error classification |

**The two layers deliberately check the same things twice**, and this is the
single most important thing about the codebase. A controller reads, decides,
then writes; between the read and the write the world can change. The
controller's check exists to produce a *useful message*; the query's predicate
exists to produce a *correct outcome*. Remove the first and every refusal
becomes "the record changed". Remove the second and two concurrent requests can
both succeed.

The worked example is the last-super-administrator guard in
[`auth/queries/access.ts`](../../src/services/auth/queries/access.ts): two
operators could each observe two super administrators and each remove one,
leaving the portal with none and no way to create another.

## Transport services

Five services exist to be swapped: notification, storage, queue, the document
scanner, and any that follows. They all take the same shape.

```
service/
  types.ts              the interface, in the programme's words
  index.ts              the factory that picks by ENVIRONMENT
  transports/<name>.ts  one file per implementation
```

- **No vendor vocabulary escapes `transports/`.** Pingram's `type`, `html` and
  `trackingId` are Pingram's words. The interface says `to`, `subject`, `body`.
  If a provider concept has to reach a caller, the interface is wrong and the
  interface changes.
- **No domain vocabulary enters them either.** The storage service does not know
  what a programme document is, which content types are acceptable, or how large
  one may be. That ignorance is what keeps the dependency one-way: a storage
  service importing the application's content-type union puts the two back into
  the cycle the extraction removed.
- **Unset `ENVIRONMENT` means local**, because an unconfigured machine is a
  developer's and a deployed environment is always told what it is.
- **A deployed environment that cannot do the real thing refuses**, rather than
  quietly doing something else. A missing notification key throws instead of
  falling back to printing one-time codes; a missing bucket refuses instead of
  accepting documents nowhere durable.
- **Where a permissive implementation exists, it says so in the record.** The
  scanner accepts unexamined files on `local` and `develop` and writes
  `NO_SCANNER_CONFIGURED` against the document. A clean-looking result would be
  worse than no scanner, because it would read as evidence.

## Construction is per call, never a singleton

Transports, storage backends, scanners and loaders are built when they are
needed. `src/index.ts` states the reason for the Worker's own configuration:
parsed on demand *"so tests and local Wrangler overrides can supply different
bindings without global mutable configuration"*. The suite also runs
`singleWorker: true`, so a cached instance is shared by every test in the run.

## Loaders are per request. This one is not about performance

A loader is a cache. One built at module scope is shared by every request the
isolate ever serves — so one applicant's data answers another's query, and a
revoked role keeps reading as held. That is a **data leak**, not a stale cache.

`createLoaders` is called only from the one context builder in `src/index.ts`,
which makes "new every time" structural rather than remembered at four call
sites. A test asserts that two requests in the same isolate do not share
answers.

**Authorization never goes on a loader.** `getCurrentSession` re-reads roles
live so a revocation takes effect on the caller's next action. Caching it inside
one request would in fact be safe — a request is one instant — but the guard
would then look cacheable, and the next person to widen it would be widening a
security check.

## Batching: about size, not count

`db.batch` sends many statements as one binding call. That is a large win and a
large loss, depending on what is in it. Both numbers were measured, and are
asserted in [`test/batching.test.ts`](../../test/batching.test.ts):

| | |
| --- | --- |
| Five small fan-outs batched | unit suite **232s → 145s** |
| The workspace's twelve **collection** reads batched | journey test **5.0s → 34.7s** |

A batch is a transaction whose whole combined result is materialised at once, so
a pile of collections costs far more than the calls it saves. **Batch a handful
of small reads; never a pile of large ones.** The same applies to the crons:
fifty single-row claims batch well.

### The trap that fails silently

**`db.batch` reads results back by column name; an awaited query maps them
positionally.** A statement whose output has two columns of the same name — any
join of two tables that both have `id`, which is most joins here — comes back
with every value shifted one place left and the last one dropped. Nothing
throws.

```
direct   {id: <event>, actorId: <user>,    email: <address>}
batched  {id: <user>,  actorId: <address>}
```

So only single-table reads and aggregates go in a batch. A joined read that must
be batched has to alias every colliding column to a unique name first, and one
missed alias is a wrong answer rather than an error.

## Every list is keyset paginated

Pages seek by `(timestamp, id)` rather than counting rows, so page ten costs
what page one costs and a row inserted mid-walk cannot shift the window.

**A cursor records which column it was ordered by.** The administrative queue
can order by any of three timestamps, and a cursor that did not say which one it
came from was accepted under a different ordering and silently seeked against
the wrong column — a wrong page with no error. Naming the key makes that a
refusal.

`totalCount` is counted with the same predicates minus the cursor, so a screen
can say "1–20 of 143" and tell an empty filter from an empty list.

## One `db.batch` per transition, with the version inside the predicate

A guarded write and its audit row go in one batch, because one batch is one D1
transaction and the pair must never be observable half-applied. The expected
version is a term in the `WHERE`, not a value read beforehand.

Where a write is stateless by design — the role invitation is the only one — the
*precondition* goes in the predicate instead, which is what makes a token that
is never stored single-use.

## A shared preamble must not name its own capability

An authorization helper serving more than one operation takes the capability as
an argument. It must never choose one for itself.

`administratorWithApplication` served a read (opening a document) and a write
(claiming), and named `STAFF_READ` for itself. The write inherited the read's
answer, so a reviewer — who may change nothing — could claim an application. The
guard looked present at both call sites and was doing its job at neither.

Two things that followed from the same shape are worth knowing:

- **A sweep for a guard has to be per-predicate.** Removing the assignment
  terms, the same check existed under two variable names — `input.actorId` and
  `input.actorUserId`. Searching for the first reported "none remain" while five
  of the second were still live. Only the concurrency test caught it.
- **Removing a check can remove a second thing it was quietly doing.** The
  ownership check on document reads was also refusing drafts, because a draft
  has no assignee. Taking it out leaked the existence of drafts until they were
  refused explicitly.

## Schema changes: the baseline is not a migration

`database/schema.sql` is guarded with `IF NOT EXISTS`, which makes re-running it
harmless and does **nothing** for a table that already exists in an older shape
— the statement is skipped and reported as success. SQLite cannot `ALTER` a
`CHECK` at all, so changing one is a four-statement table rebuild.

Changes to existing tables go in `database/migrations/`. `db:schema:check`
builds a database from the baseline and another from the migration chain and
compares them, because nothing else makes the two agree.

## A test that cannot fail is worse than no test

Assert on something only the behaviour under test produces. The way to know is
to break the code and watch the test go red — reading it is not enough, because
a vacuous assertion reads exactly like a real one.

Three specs asserted a desk review had completed with
`getByText('Partner bank')`. The guide's route diagram draws that desk label on
every workspace screen, so all three passed whether the API accepted the review
or refused it — one of them matched four elements. They were only found by
making `readIdentifiers` refuse unconditionally and noticing nothing went red.

The rule that follows: **a new test earns its place by failing first.** For a
regression, run it against the unfixed code. For a new behaviour, break the
behaviour. Prefer a locator tied to state — a status badge, a specific
message — over any text that a layout, a guide or a navigation might also
render.

## Comments

- **Say why, never what.** The name says what it is.
- **Every non-obvious guard names what goes wrong without it.**
- **Every module opens with what it is for and what it assumes.**
- **No comment describes what changed.** "Now batched" is true the day it is
  written and misleading forever after.

## Related

- [Documentation](documentation.md) — who owns which subject
- [Security](security.md) — what must never reach a log, and how guards fail
- [Services](../../src/services/README.md) — the layering rule, in full, with
  the worked examples
