# GraphQL layer

The API surface. Everything here is an adapter: it parses, validates, bounds,
and delegates. No business rule lives in this directory.

## What it assumes

- **A resolver never decides anything.** Authorization, validation and the
  guarded write all belong to [the services](../services/README.md). A resolver
  that grows an `if` is a rule in the wrong place.
- **Every operation returns an envelope, never an error.** `BaseResponse` is
  `{ success, message }` plus a nullable `response`. A refused business
  operation is a successful HTTP request carrying `success: false`, so a client
  can show the message. Only genuine faults become GraphQL errors.
- **The SDL is the source of truth for types.** The client generates from these
  exact files, so an operation asking for a field the API does not expose fails
  `npm run typecheck` rather than failing in front of a user.

## Layout

Ten `.graphql` files, loaded as text modules by a Wrangler rule and stitched
together in `index.ts`:

```
schema.graphql            the root Query/Mutation and BaseResponse
queries/<ns>/<ns>.graphql     one per namespace
mutations/<ns>/<ns>.graphql   one per namespace
resolvers/<ns>/<ns>.ts        thin delegation to a service
```

The five namespaces are `auth`, `seb` (applicant), `admin` (staff — itself
nesting `programmeCycle`, `formTemplate`, `intake`, `analytics`, `decision`
and `funding`), `access` (role management) and `audit` (query-only history).
Each is a nested field returning a namespace object, so
`mutation { admin { intake { startDeskReview(…) } } }` rather than a flat
`adminIntakeStartDeskReview`. That nesting is what the single-mutation rules
below depend on.

## Scalars

Four, all declared in `index.ts`. Every scalar is mapped deliberately — the
client's codegen runs with `strictScalars`, so an unmapped one is a build error.
**A build error it reports while still writing output**, which is worth knowing:
codegen prints "Generate outputs" and leaves the previous files in place, so an
unmapped scalar reads as a clean run while every generated type silently stays
stale. Check the exit code, not the log.

| Scalar | Wire format | Why |
| --- | --- | --- |
| `DateTime` | ISO 8601 string | — |
| `Date` | `YYYY-MM-DD` string | Date-only business values have no timezone |
| `Money` | decimal string of paise | A number would be a precision bug in every award and payment |
| `JSON` | bounded object | The answer map, where a keyed object is the honest shape and a list of `{fieldKey, value}` pairs would be a list pretending not to be one |

## The refusal codes

`ValidationIssue.code` is `ValidationIssueCode!`, a closed enum of 34 values, and
not a `String!`. The difference is what happens when the two sides disagree: a
code the engine emits that the schema does not publish is a **serialization
error**, where a string would have travelled quietly to a client that has no
branch for it.

The set is declared once, in `services/application/form/codes.ts`, and
`test/service/issue-codes.test.ts` compares the published schema against it
directly — not against a fixture, which would only record what somebody believed
when they wrote it and would go on passing while both sides drifted the same
wrong way. Adding a member to either without the other is meant to go red.

Worth knowing why this needed saying: `codes.ts` had described this arrangement
in its own header since the first commit, and **neither the enum nor the test
existed**. It is the same species as `INVALID_EMAIL` — vocabulary written, the
mechanism not.

**`JSON` is bounded on the way in, and that is not optional.** The body limit and
the document-cost limit below both count *structure*; neither can see one
enormous value, so a single unbounded argument walks past both. `parseValue`
therefore enforces what the document rule enforces for fields: at most 64 KB
encoded, 500 keys, 100 entries in a repeated group, 8192 characters in any one
value, and one level of nesting. Keys must match the field-key shape, which is
also what refuses `__proto__`. `NaN` and `Infinity` are refused rather than
encoded as `null`, which would be indistinguishable from a deliberate blank.

The engine checks a byte budget again over the coerced answers. That is not
redundancy: this is a *transport* bound applied before anything is parsed, and
the engine's is a *storage* bound applied to what will be written.

## What bounds a request

Layered so that the cheapest refusal happens first. Every number was measured
against the real client rather than chosen by taste — its largest operation,
`IntakeWorkspace`, selects **174 fields at depth 8**, and its largest request
is **about 4 KB**.

| Bound | Value | Refused at |
| --- | --- | --- |
| Requests per address | 600 a minute | Hono, before parsing |
| Request body | 64 KB | Hono, before parsing |
| Fields per document | 500 | validation, before any resolver |
| Selection depth | 12 | validation |
| Introspection | exempt from both | validation |
| Attempts at one operation | per the policy | execution, by the rate-limit plugin |
| `first` on any connection | 1–100, default 20 | the service |
| Un-paginated child collections | 500 rows | the query |

**Introspection is exempt, and only introspection.** The two document limits
exist because one request can make the server do unbounded work; an
introspection query does none — it is answered from the schema already in
memory. It is also unavoidably deep, around fifteen levels, so a limit tuned to
this programme's own operations refuses every schema fetch, which is the first
thing a client developer meets. The exemption applies to a document whose root
selections are all `__`-prefixed; mix in one real field and the whole document
is measured again.

The first and the sixth are the same mechanism at two depths, and they have to
be: `/graphql` is a single POST, so the HTTP layer cannot tell one operation
from another. How much each operation is allowed, and why some are counted
against the account rather than the address, is owned by
[the rate-limit service](../services/rate-limit/README.md).

### Why a document-wide field limit exists

`first` is already clamped, so no single list can be asked for a million rows.
What that does not stop is asking for a modest list many times in one document,
because an alias makes a field repeatable:

```graphql
query { admin { intake {
  a: workspace(applicationId: "…") { …ten collections… }
  b: workspace(applicationId: "…") { …ten collections… }
  …five hundred more…
} } }
```

Each `workspace` is a dozen database reads. Five hundred of them is one HTTP
request costing thousands, from an account that is allowed to make it. A
per-field limit cannot see this; only the whole document can.

The rule counts at validation, before a single resolver runs — the cost has to
be refused before it is paid, not measured while it is being paid. Fragment
spreads are expanded so the limit cannot be evaded by moving selections into a
fragment, and each spread is counted at every place it is used, because that is
how many times the server will resolve it.

`documentCostRule` is registered **first**, so an oversized document is refused
before the other rules walk it.

### Collections without a cursor

An application's notes, its events and its assignment history are capped at 500
rows, read newest-first so the cap keeps the recent end. Signed-in devices are
capped at 100 — the one collection a person can inflate on purpose.

**Two are deliberately uncapped**: the disbursement ledger and a recovery
case's entries. Their totals are folded from exactly those rows, so truncating
them would report a wrong figure rather than a short list. They are bounded by
the instalments the programme office actually pays, which no caller controls.

## The single-mutation rules

Four rules — one per namespace — refuse a mutation document that selects
more than one field beneath a namespace. Two writes in one request would share a
transaction boundary the services do not define, and the second's guard would
read state the first had already changed.

## Deliberate omissions

- **Batching is off.** Yoga disables it by default and it stays off; it would
  reopen the amplification the cost rule closes.
- **Yoga does not handle CORS** (`cors: false`). Hono owns the origin allowlist
  and rejects a disallowed origin *before* the body is parsed, so an untrusted
  caller never reaches the schema.
- **The response headers are a side channel.** Yoga returns an immutable
  `Response`, so `GraphQLContext` carries a separate `responseHeaders` sink that
  `src/index.ts` merges afterwards. That is how `Set-Cookie` reaches the
  browser.

## Elsewhere

- [Services](../services/README.md) — where every rule these operations reach
  actually lives
- [Database schema](../db/schema/README.md) — the tables behind them
- The complete operation list, by role, is in the
  [root README](../../README.md)
