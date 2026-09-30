# Frontend

How the client asks the API for things, so a screen opens in one request and
stays correct after every write.

The cost model is [Performance](performance.md)'s, with the browser request as
the unit: each one is a trip from the browser to our server, from there to the
Worker, and a connection, a session read and the operation's own statements
once it arrives. Against Neon from a developer's machine that is over a second
before any work is done. A screen that asks five times in a row takes five
seconds to show what one request would have shown in one.

GraphQL was chosen so a screen could ask for everything it needs at once. These
rules are what it takes to actually do that.

## A screen opens in one request

Everything a screen shows on entry is asked for **together**, by its route
loader, and leaves as one request. `gql()` (`dev-web/src/lib/graphql.ts`)
collects the queries issued in the same task and sends them as one batch; the
Worker answers the batch over one connection, reading the session once and
sharing its per-request loaders, so a form or a pipeline two queries both need
is read once.

What that asks of a screen:

- **Every query the page renders on entry is in the loader.** A component that
  mounts and asks for something the loader did not starts a second request,
  after the first has come back — the screen waits twice. `prefetchQuery` in
  the loader for what a component reads; the component's `useQuery` then finds
  it in the cache.
- **No query waits on another's answer.** A query `enabled` on the result of
  another is a second request by construction. What a screen needs to derive
  from one record belongs on that record, served by the API: the application
  page ran a whole eligibility check for the kinds only to print one kind's
  label, until the application carried `applicationKindLabel` itself.
- **Each component still asks for exactly what it renders**, through its own
  document and cache key. Coalescing happens in the transport, so screens do
  not share one giant document and a component can be moved or removed without
  touching another's query.
- **Only in the browser.** The server renders for every visitor at once, and a
  queue there could put two people's queries into one request under one
  person's cookie. Server-side loaders send each query alone.
- **Mutations go alone.** The Worker allows one per request, and a write must
  never wait for a read that happened to be issued beside it.

Check it by opening the screen with the network panel open: one
`executeBatch` (or `execute`) call per screen entry, none after it until the
user does something.

## Decide each query's freshness on purpose

A query's `staleTime` is a decision about its volatility (Performance, rule 3),
not a default left in place:

- **Immutable by key** (a pinned template): `Infinity`. Keep it as its own
  query, not embedded in a document that is refetched after every write, or it
  is re-downloaded with every unrelated change.
- **Shared, and written with a version** (an application, a cycle, an
  officer's file, a pipeline draft): `JUST_LOADED` (`dev-web/src/lib/freshness.ts`).
  Never `0`. Zero refetches the query the moment its component mounts,
  milliseconds after the loader fetched it — a second request on every screen,
  guarding nothing, because a write built on a version that has since moved is
  refused by the server anyway.
- **The viewer's own, changed only by them**: long, and kept current by
  mutation responses.

**An explicit "load the latest" asks the server, whatever the freshness.**
`fetchQuery` returns a cached copy still inside its window, so a reload after a
refused stale write passes `staleTime: 0` — otherwise it hands back the very
copy the server just refused.

## A write answers with what it changed, and the cache takes it

Every mutation that changes a record selects the **same fragment** as the query
that reads it (`ApplicationFields` for an application), and its `onSuccess`
writes the response into that query's cache with `setQueryData`.

- **Never invalidate-then-navigate for what the response carries.** Marking a
  query stale without waiting leaves the old copy in the cache, and the next
  screen's loader — which only fetches when nothing is cached — serves it. After
  a submission this showed "Where it is now: Draft" and no reference number for
  an application the office already had.
- **Invalidate only what the response cannot answer**, by exact key, and do not
  await it. A read derived elsewhere (the comparison with the last submission)
  is removed rather than invalidated when the next screen must not show the old
  one even for a moment.
- **A mutation whose response is too thin to update the cache has an
  incomplete response type.** Widen the response to the fragment; do not add a
  refetch after it.

## A list row renders from the list

A row in a list renders from the list's own payload. If a row needs more, the
list API gains a field. A per-row request turns a page of twenty into forty-one
requests, and it hides, because each row looks cheap on its own.

## Refusals are answers

Retry transport failures, never refusals. A refusal is the server's decided
answer, and retrying it only delays the same answer by the retry's back-off.

## Preload what is cheap to be wrong about

Hover preloading spends a request the user may never want. It pays for itself
on a navigation that is likely and light, and costs real load on lists of heavy
rows. Opt out per link where the target is heavy and the hover is incidental.

## Related

- [Performance](performance.md): the round-trip cost model and the server's budgets
- [GraphQL](graphql.md): describing what the schema offers
