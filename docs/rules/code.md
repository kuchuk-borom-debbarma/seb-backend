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
| `queries/` | all Drizzle SQL, all transaction and statement boundaries, and every authorization, lifecycle and version term **repeated inside the write predicate** |
| `support.ts` | this service's refusal messages, its audit-row builder, its error classification |

**The two layers deliberately check the same things twice**, and this is the
single most important thing about the codebase. A controller reads, decides,
then writes; between the read and the write the world can change. The
controller's check exists to produce a *useful message*; the query's predicate
exists to produce a *correct outcome*. Remove the first and every refusal
becomes "the record changed". Remove the second and two concurrent requests can
both succeed.

**The response envelope is shared, not mirrored.** `success` and `failure` were
once defined identically in four `support.ts` files, alongside four identical
result types. Four copies of one decision are not four decisions: a change to
how a refusal is shaped would have had to be made in each, with nothing to say
the fourth had been missed. They live in
[`services/envelope.ts`](../../src/services/envelope.ts); each service keeps
only its own type alias, so a call site still says which service is answering.

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

## Round trips, not statement counts

A statement is a network hop. That is the whole cost model, and it is different
from the one this section used to describe: batching many small reads no longer
buys anything by itself, because the batch still crosses the network once per
statement unless it is genuinely one statement.

So the win is **folding**, not batching. Several reads keyed on the same row
become one query with a lateral aggregate per collection; a guarded write and
its dependent inserts become one data-modifying CTE. Both go from N hops to one,
and the CTE is atomic without a transaction.

**Never issue concurrent reads inside a transaction.** A transaction is bound to
one connection, so they queue on it — the code reads as parallel and costs the
same as sequential.

Numbers here have to be measured against a seeded database. Postgres sequentially
scans a small table whatever indexes exist, so a plan taken against a hundred
rows tells you nothing about a hundred thousand.

## Never cap a collection something adds up

Unpaginated child collections carry `MAX_COLLECTION_ROWS`, because *"bounded by
real work"* is not bounded. **The exception is any list that is folded into a
total**, and it is not a small exception — it is the difference between a short
list and a wrong number.

`foldDisbursementLedger` sums the disbursement rows into what an applicant is
told they have received. Capping that read would understate money paid, and a
total has no way to look truncated, so nothing downstream could notice. Both
reads of that ledger carry the warning at the query itself.

Before adding a cap, find what consumes the rows. If anything reduces them, the
cap belongs in SQL as an aggregate or nowhere at all.

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

## One statement per transition, with the version inside the predicate

A guarded write and its audit row must never be observable half-applied, and the
expected version is a term in the `WHERE`, not a value read beforehand.

Both are satisfied by a single data-modifying CTE: the `UPDATE` carries every
term that must still hold and returns the row it changed, and each dependent
insert selects `FROM` that result. A losing writer updates nothing, so the
dependents select nothing, so the whole statement writes nothing. Under the
default READ COMMITTED, an update that blocks on a concurrent writer
re-evaluates its predicate against the committed row and yields no rows — which
is exactly the refusal wanted, and is why hardening the isolation level would
make things worse rather than better by turning a clean refusal into a retry.

Reserve an interactive transaction for a decision made in application code
between a read and a write; there, `SELECT … FOR UPDATE` before the read is the
tool.

**A transition opens its own `BEGIN`; it does not call `transaction()`.**
Because a driver's `transaction()` may hand the callback a *different*
connection, and every guarded write here builds its statements from the outer
handle. node-postgres given a `Client` reuses the same session and forgave it;
PGlite checks out a second one, and the statement then queues behind a
transaction that is waiting for it — a deadlock, found the first time the suite
ran on PGlite rather than D1. Both driver behaviours are legitimate; code whose
atomicity depends on which one a driver chose is not. `batch` therefore opens the
transaction on the handle the statements were built from, and `openDatabase`
refuses a pool so that handle is always one connection.

**A dependent insert has no column list, so its arity is checked.** Drizzle's
`.insert(t).select(sql...)` matches the select to the table **by position**, and
the select is a template string, so TypeScript sees nothing. One expression too
many is refused by Postgres — at run time, on whichever path reaches that insert.
One too few is *accepted*, and the trailing columns take their defaults: a
decision written with `conflict_acknowledged` defaulted to false reads exactly
like an honest one. `check:insert-arity` applies the generated schema to a real
Postgres and counts. Adding a column to a table is what breaks every insert into
it at once, which is why the count comes from the schema rather than a list.

Where a write is stateless by design — the role invitation is the only one — the
*precondition* goes in the predicate instead, which is what makes a token that
is never stored single-use.

## A predicate over rows you do not write is not a guard

Version-in-the-`WHERE` works because two writers contend for *the same row*: the
loser blocks, re-reads the committed row under READ COMMITTED, and its predicate
fails. A predicate that reads rows the statement does not write has none of that.
Nothing blocks, every reader evaluates against a snapshot taken before the others
committed, and every one of them succeeds.

Three of these were found in one pass, and none of them by a test:

- **The last-super-administrator guard.** Two operators revoking *different*
  grants touch no common row. Two cannot actually reach zero — each actor is
  also the other's subject, so the separate "actor still holds the role" term
  catches whoever commits second — but **three, in a cycle, can**: A closes B's,
  B closes C's, C closes A's, and every actor is live at their own snapshot.
  Demonstrated against three raw sessions held at a barrier; the table was left
  with no super administrator, which bootstrap cannot undo. Fixed by locking the
  whole live roster with `SELECT … FOR UPDATE` as the transaction's first
  statement, so the three contend after all and the second finds a roster that
  includes the first's revocation.
- **The bootstrap absence check and the role-grant "already holds it" check.**
  Both are decisions about whether a row exists *anywhere*, which no predicate
  can make safely — an uncommitted row is invisible by definition. The unique
  index is the only authority, and the predicate exists to make the *ordinary*
  case a clean refusal rather than a caught violation. Both wrap the write in
  `constraintSafe`, so a genuine dead heat reads as `false` like every other lost
  race instead of reaching the caller as an unhandled error.

The old justification for those two said the unique index never had to raise
because D1 serialized writers. It did, and Postgres does not, and the sentence
outlived the engine it described.

**Where you cannot lock, catch.** `constraintSafe` matches SQLSTATE 23505 and
23503 and deliberately not the rest of class 23: a CHECK violation is a bug in
the layer above and must never read as "try again".

## Beware a CHECK whose result can be NULL

`false OR NULL` is NULL, and **a CHECK passes when its result is NULL** — not
only when it is true. So a disjunction of the shape `(type <> 'X' AND …) OR
(type = 'X' AND col > 0)` accepts every row where `col` is null: the first arm
is false, the second is unknown, and Postgres lets it through.

Four constraints on `seb_programme_cycle_form_field` were doing nothing for this
reason — the repeat bounds, the file size cap, and the money floor before it.
`greatest(NULL, 1)` returning `1` rather than NULL hid one of them further, by
keeping the neighbouring comparison true.

Every arm that names a column must say `col IS NOT NULL` explicitly, or spell
out the null case as its own alternative where null is legitimate. Reaching the
right outcome by accident is not the same as enforcing it: the file cap's null
case *was* the behaviour wanted, and the same expression would have accepted a
zero or an over-ceiling value identically.

`text(col, { enum: [...] })` emits **no constraint at all** — it is a TypeScript
union and nothing more. Every closed set needs its own `IN (…)` written out.

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

## The schema file is generated, and that is checked

`database/schema.sql` is the whole schema. A change is made in `src/db/schema/`
and regenerated; `npm run db:schema:check` regenerates and fails on any
difference, which is what keeps the file a description rather than a second
copy that can drift.

A deployed database exists now, so changes to it travel as an ordered chain
under `database/migrations/`: `npm run db:generate` diffs the Drizzle schema
against the chain and writes the next file, `npm run db:migrate` applies what
the database `DATABASE_URL` names has not seen. The chain began after the
first deployment, so its `0000_baseline` describes what was already there and
was marked applied with `npm run db:baseline` rather than run.
**`IF NOT EXISTS` is not a migration**: against a table already present in an
older shape the statement is skipped and reported as success, leaving the
database on the old definition while the code assumes the new one. That is why
`db:setup:local` still drops and rebuilds a local scratch database instead of
guarding — recreating is cheaper than migrating where nothing has to survive,
and cannot leave an old shape behind.

**One ordering rule survives either way.** A composite foreign key needs its
referenced columns covered by a unique *constraint*, not a unique index, because
generated DDL declares foreign keys before it creates indexes.

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

**Two suites, split by what they actually need.** `test/service/` runs in Node
against PGlite — a real Postgres, hermetic and fast — and holds everything that
is logic against a database, including the HTTP-driven tests: `src/index.ts` is
imported whole and only `withDatabase` is mocked, so Hono, the CORS rules, the
body limit, the validation rules and every resolver run as written.
`test/runtime/` runs in workerd and holds only what workerd alone provides — R2,
the queue's message handles, `waitUntil`, and the edge limits — because each
entry there costs the whole runtime to test.

**The runtime suite must keep at least one test that opens a real connection
through the Hyperdrive binding.** Nothing else runs in workerd any more, so a
missing `nodejs_compat` flag, an import workerd cannot resolve, or an unwired
binding would otherwise be found at deploy. Those tests skip — loudly, naming the
reason — when no Postgres is listening, because a connection test that quietly
passes without connecting is worse than none.

**The D1 fixture API is shimmed, not rewritten.** Four hundred fixture statements
used `prepare(...).bind(...)` with `?`, integer booleans and epoch milliseconds.
Rewriting them by hand would have been four hundred chances to transpose two
binds, and a transposed bind in a fixture is a green test asserting the wrong
thing. So `?` becomes `$n` in order — preserved by construction — and values are
marshalled from the parameter types **Postgres itself reports**, never guessed
from the value: a `size_bytes` of 1,700,000,000 looks exactly like an epoch-second
timestamp.

**Some things only a browser can be wrong about.** A stage of the form is
memoised and re-renders only when an answer it reads changes — and it handed
changes back as the answer map *as of its own last render*, so answering a
question in one stage discarded everything answered in another since. Both
halves were correct alone; no unit test can see it, because nothing but a real
browser re-renders selectively. A component that reports an event must report
*what happened* — the field and its value — and never a whole state rebuilt from
what it happens to be holding. Merging belongs where the current state is.

**PGlite is the default; Neon is the gate.** `npm run test:neon` runs the
identical file set against a real Postgres. PGlite proves SQL, constraints and
isolation; it does not prove connection pooling, Hyperdrive's reuse, or anything
version-specific. **A divergence between the two is a finding, never a flake** —
the instinct on the first red `test:neon` against a green `npm test` is to re-run
it, and that is the one response that loses the information. It has already paid
for itself twice: the schema-per-worker isolation that silently pointed every
foreign key at another worker's tables, and a bootstrap race that leaves the
loser with an unhandled 500 and cannot be reproduced where one connection is
shared.

**Some things cannot be tested here, and the test says so rather than pretending.**
A race needing several transactions open at once cannot be reached through HTTP,
where nothing can hold one there. Where that is the case the test asserts the
*invariant* — so a later change that loses it is caught — and its own comment
states plainly that it would pass against the unfixed code, with a pointer to
where the demonstration lives. An honest gap beats a green test that proves
nothing, and beats a stand-in proving itself.

**`it.each` for a table, deliberately.** The repository had none, and its one
hand-rolled table loop put every row inside a single `it()`, so the first
failure hid the rest — unusable at a hundred and eighty rows. Assert the row
count explicitly beside the table, or a bug that collapses it to zero rows looks
identical to a fast green run.

**The same applies to a guardrail script.** `check:audit` exists because three
recovery actions were declared and never written, so the activity history
contained no recovery at all while the catalogue read as coverage. Its first
version then repeated the mistake one file along: it accepted the action name
*anywhere* in a source file, so a name left in a comment, a refusal message or a
piece of prose counted as a write. It now looks only where an audit row is
actually built — an `…action:` property, or a column inside an insert into
`coreAuditEvent` — with comments stripped first. Demonstrated by moving one live
action into a comment and watching the build go red.

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
