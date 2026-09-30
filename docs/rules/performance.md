# Performance

How work is shaped so that it stays fast as the programme grows, without
freezing the code into the shape that happened to be fast.

These are standing rules, not advice. Each one says what breaks without it,
because every one of them was learned by measuring something slow.

## The cost model

**The unit of cost is the sequential round trip.** On the server it is a
statement sent to Postgres; in the browser it is a request sent to the server.
Everything else — CPU, parsing, JSON size — is noise next to it at the scale this
service runs, and optimising it first is optimising the wrong thing.

Two facts about this stack make the model sharper than it looks:

- **One request holds one connection with one query in flight.** The driver
  sends a statement, waits for its answer, then sends the next. So
  `Promise.all` over queries is sequential on the wire — it reads as parallel
  and costs the same as a loop. It is not a performance tool here, and writing
  it as one misleads the next reader into thinking the cost is paid once.
- **A transaction adds two round trips** (`BEGIN`, `COMMIT`) and saves none.
  Grouping five statements in `batch` costs seven hops, not one.

The only thing that removes a round trip is **not sending the statement**:
folding it into another, reusing what was already read, or not needing it.

The distances are real. A request from the browser reaches the edge in about
110 ms; a statement from the Worker to Neon costs 20–55 ms. An operation that
issues 40 statements spends one to two seconds waiting, however little each
statement does.

## Rule 1 — An operation's cost does not grow with what it is about

The number of round trips an operation makes must not depend on how many
documents, fields, owners, permissions, effects or history entries it touches.
Taking a stage action costs three round trips whether it has one effect or six;
that is the shape everything should have.

A loop that awaits a statement per item is the obvious breach, and the less
obvious one is a helper that reads "its" piece of an aggregate: call it once per
item and the operation has become N+1 without a loop in sight.

**Instead:** one statement that takes the whole set — a multi-row `INSERT`, an
`INSERT … SELECT`, an aggregate over a join, `= ANY($1)` — or a loader that
collects keys and answers them together.

## Rule 2 — Read a thing once per request, then pass it down

A request reads each piece of data at most once. Once read, it travels **down**
as a value. A lower layer never re-derives what an upper layer already holds.

This is also the decoupling rule, not only the speed rule:

- **A function that needs X takes X, not an id to fetch X.** It becomes pure
  over its inputs, testable without a database, and unaware of how X is stored.
- **It takes the narrowest shape it needs**, a `Pick<>` or a small named type,
  not the whole loaded aggregate. Otherwise every change to the aggregate ripples
  into every function that received it whole.
- **The one place that reads is the one place that knows the tables.** A
  controller calls `loadX`; it never composes three partial reads of its own,
  because then it has learned the schema and the next reshaping has to find it.

A helper that quietly fetches "just what it needs" is the most common way this
codebase came to read the same form definition three times in one save.

## Rule 3 — Treat data by how often it changes

Where data may be cached, and for how long, follows from its volatility, never
from which screen or service happens to need it.

| Kind | Examples | May be reused | Must not be |
| --- | --- | --- | --- |
| **Immutable by key** | a pinned form template `(cycle, version)`; a published pipeline version; the permission and workflow catalogues | anywhere, forever, keyed by the immutable identity | keyed by anything that can change underneath it (a cycle id without its version) |
| **Per-request authority** | the session, roles, owned stages | within one request | across requests: a revoked role must stop working on the very next action |
| **Shared and mutable** | an application head, a stage queue, a cycle draft | nowhere; read in the statement that uses it, or guarded by a version | cached and trusted as current |

Immutable-by-key data is the cheapest win there is, because reusing it is always
correct. A reuse cache that outlives the request is allowed only for data that
is **immutable by its key and holds nothing specific to a user**; everything
else is per request, through the loaders, because a cross-request cache of user
data is a leak (see [Code](code.md#loaders-are-per-request-this-one-is-not-about-performance)).

## Rule 4 — The write returns the truth

A write statement returns the state it produced — `RETURNING`, or a final CTE
member that selects it — and **both** the server's response and the browser's
cache are built from that.

- The server does not reload an aggregate after writing it. The reload is a
  second copy of the write's answer, fetched at full price, and it can disagree
  with the write if anything slipped in between.
- The browser does not refetch the thing it just changed. It writes the
  mutation's response into its cache.

A mutation that cannot return what the screen needs has an incomplete response
type; the fix is to widen the response, not to add a round trip after it.

## Rule 5 — A transaction is for a decision, not for grouping

Use an interactive transaction only where application code must decide between
a read and a write (`SELECT … FOR UPDATE`, decide, write). Everything else is one
statement: a guarded write and its dependents, audit row included, are one
data-modifying `WITH`, as [Code](code.md#one-statement-per-transition-with-the-version-inside-the-predicate)
describes for transitions.

**A read-only transaction is almost always wrong.** Under READ COMMITTED each
statement takes its own snapshot anyway, so it buys no consistency and costs
two round trips. If several reads must agree, they must be one statement.

## Rule 6 — Latency we do not own stays off the response path

An email provider, an object store or a scanner is not ours to make fast. It
stays off the path between the user's action and the answer, unless the answer
depends on its result.

- **Must happen, may be late:** the queue, which retries.
- **Should happen, may be lost:** `waitUntil`, with its own connection, because
  the request's connection is closed by then.
- **Only if the caller must know the outcome now** (a sign-up code the user is
  waiting to type): awaited, and said so where it happens.

## Rule 7 — Budgets are part of an operation's contract

Every operation has a declared round-trip budget, asserted by a test with the
driver-level counter in `test/support/round-trips.ts`. A change that exceeds it
fails the build. Raising a budget is a reviewed decision with the reason written
beside the number, never an edit to make a test pass.

The default budgets, which an operation meets unless its test says why not:

| Shape | Budget |
| --- | --- |
| Read one aggregate (a file, a cycle, an application) | session + 1, **plus 1** if it needs immutable config not already loaded |
| Guarded write | session + 1 context read + 1 write |
| One page of a list | session + page + count, plus one per distinct loader |
| Sign-in and other credential checks | as above, plus the hash — which is CPU, not a round trip |

**Budget tests assert counts, never SQL text.** That is what keeps refactoring
free: a statement can be split, folded, reordered or rewritten from the ground up,
and the test holds as long as the cost does. A test pinned to query text would
make the code slow to change, which is the opposite of the point.

**A performance claim in a comment is a claim, and claims get tests.** A comment
here once said "one transaction, not seven round trips" about code that made
fourteen. Where a comment states a cost, a budget test states it too.

## The browser

The same model holds with the browser request as the unit, and each request
costs a network trip, a session read and whatever the operation costs on top.

### A screen's entry costs one wave

Everything a screen cannot render without is fetched **by its route loader, in
parallel**. A `useQuery` in a component, for data the screen needs to paint,
starts only after the loader has finished and the component has mounted — a
second wave the user sees as a slow page. Component-level queries are for what
the screen can show without: below the fold, behind a toggle, after an action.

Where several of a screen's needs live under one namespace, they are one GraphQL
document built from fragments. Each component owns the fragment for what it
renders, which keeps components independent, and the route composes them into
the one request.

### Decide each query's freshness on purpose

A query's `staleTime` is a decision about its volatility (Rule 3), not a default
left in place:

- **Immutable by key** (a pinned template): `Infinity`. Keep it as its own
  query, not embedded in a document that is refetched after every write, or it
  is re-downloaded with every unrelated change.
- **The viewer's own working copy**, updated from mutation responses (Rule 4):
  long; it changes only when this viewer changes it.
- **Shared, edited by others** (a queue, a file several officers act on): short,
  but never zero.

**A loader-fed query at `staleTime: 0` is fetched twice on every entry** — once
by the loader and once when the component mounts — and again on every tab
focus. Zero is allowed only where a test or comment says why a copy from one
second ago is wrong.

### A mutation's response updates the cache

- Write the mutation's response into the cache for what it changed.
- Invalidate only what the response cannot answer, by exact key rather than a
  broad prefix.
- Never await an invalidation to unblock the UI. The server has already
  confirmed the write; the screen moves on, and anything else refreshes behind
  it.

### A list row renders from the list

A row in a list renders from the list's own payload. If a row needs more, the
list API gains a field. A per-row request turns a page of twenty into forty-one
requests, and it hides, because each row looks cheap on its own.

### Refusals are answers

Retry transport failures, never refusals. A refusal is the server's decided
answer, and retrying it only delays the same answer by the retry's back-off.

### Preload what is cheap to be wrong about

Hover preloading spends a request the user may never want. It pays for itself on
a navigation that is likely and light, and costs real load on lists of heavy
rows. Opt out per link where the target is heavy and the hover is incidental.

## Measuring

- **Count locally, time in production.** Round trips are deterministic and are
  counted in the service suite against the local database. Latency depends on
  distance, so it is measured against the deployed Worker, on a warm
  connection, and reported as the server's share rather than the browser's
  total.
- **Plans against scale.** Postgres scans a small table sequentially whatever
  indexes exist, so a plan taken against a hundred rows says nothing about a
  hundred thousand. Take plans on a seeded fixture.
- **Measure before and after.** A change made for speed states what it measured
  and what it measures now, in the commit.

## Where the code stands

Measured on 30 September 2026, round trips per operation against the local
database:

| Operation | Round trips | Default budget |
| --- | --- | --- |
| Submit an application | 53 | ~5 |
| Resubmit | 50 | ~5 |
| Save a draft | 36–39 | 3–4 |
| Start an application | 29 | 3–4 |
| Read an officer's file (workspace) | 23 | 3 |
| Validate an application | 21 | 3 |
| Take a stage action | 3 | 3 — meets its budget |

The causes are the ones these rules name: the pinned form read up to three times
per request (Rules 2, 3), the aggregate reloaded after every write (Rule 4),
writes grouped in transactions instead of folded (Rule 5), and emails awaited
before the response (Rule 6). Stage actions are the reference implementation of
every rule here. Closing this gap is tracked in the
[roadmap](../ROADMAP.md#192-every-operation-within-its-round-trip-budget).

## Related

- [Code](code.md): folding, one statement per transition, per-request loaders
- [Security](security.md): why authority is re-read on every request
- [Pipeline service](../../src/services/pipeline/README.md#performance): the
  budgets the stage operations are held to
