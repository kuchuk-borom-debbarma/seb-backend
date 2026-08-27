# Services

Nine services hold every business rule in the Worker. GraphQL resolvers are
thin adapters above them and hold none.

Four of them own a domain. The other five exist to be *swapped*: each is an
interface the programme states in its own words, with one file per
implementation (a `transports/` directory) and a factory that picks by
environment. That is what lets the whole portal run on a developer's machine
with nothing configured.

Sizes are deliberately not listed — they were, and every figure was stale
within a month of being written. `wc -l` answers the question the moment it is
asked.

| Service | Owns |
| --- | --- |
| [`application/`](application/README.md) | Everything an applicant owns — enterprises, drafts, the form engine, evidence, submission |
| [`admin/`](admin/README.md) | Programme cycles, form authoring, and the whole post-submission staff workflow |
| [`auth/`](auth/README.md) | Identity, sessions, signup, account self-service, capabilities, and role administration |
| [`audit/`](audit/README.md) | Reading the history of who changed what |
| [`storage/`](storage/README.md) | Where documents live: a bucket, a provider, or this Worker |
| [`external-notification/`](external-notification/README.md) | Getting a message to a person |
| [`document-scanner/`](document-scanner/README.md) | Whether a stored document is safe to open |
| [`queue/`](queue/README.md) | Work handed off to be done after the response |
| [`rate-limit/`](rate-limit/README.md) | Refusing a flood before the handler pays for it |

## The layering rule

Every service is `controllers/` over `queries/` over `support.ts`. This is not
separation of concerns in the usual sense — the two layers deliberately check
the same things twice, and understanding why is the single most important thing
about this codebase.

**A controller decides what to tell a person. A query decides what happens.**

```
controllers/   authorization, input validation, orchestration,
               response envelopes, and the friendly refusal message
      │
queries/       all Drizzle SQL, all statement boundaries — and every
               authorization, lifecycle and version term repeated
               inside the write predicate
      │
support.ts     each service's own refusal messages, its audit-row builder,
               and its error-classification helpers
      │
envelope.ts    the one response envelope, shared by every service
```

### Why the checks are repeated

A controller reads, decides, and then writes. Between the read and the write,
the world can change — and the window is not theoretical. From
`auth/controllers/access.ts:5-11`:

> Every mutation requires a fresh password confirmation, and every authorization
> term is repeated inside the guarded write, because scrypt runs outside the
> database and takes long enough for the caller's own authority to change while
> it runs.
>
> Friendly refusals are decided by controller reads so an operator learns which
> rule stopped them; the write predicates in `queries/access.ts` are what decide
> concurrent attempts. **The two are deliberately redundant.**

So the controller's check exists to produce a *useful message*, and the query's
predicate exists to produce a *correct outcome*. Remove the controller's and
every refusal becomes "the record changed". Remove the query's and two
concurrent requests can both succeed.

The clearest worked example is the last-super-administrator guard
(`auth/queries/access.ts:268-272`):

> A read-then-write version loses to a concurrent revocation: two operators
> could each observe two super administrators and each remove one, leaving the
> portal with none and no way to create another, because bootstrap has
> permanently closed.

### The guarded-write shape

Every mutation is one statement, and it always looks like this:

1. An `UPDATE … WHERE current_version = :expected` on the head row, plus every
   term that must still hold — the owner, the status, the lifecycle — returning
   the row it changed.
2. Each dependent `INSERT … SELECT … FROM` that result, so a losing update
   leaves them nothing to select.
3. The row count of the first statement decides the outcome.

Written as one data-modifying CTE it is implicitly atomic and costs a single
round trip. A losing request writes nothing at all — no partial referral, no
orphaned audit row. The caller gets
`'The record changed. Reload and try again.'`

The audit row doubles as the operation's claim
(`application/queries/application.ts:1636-1639`):

> This append-only audit row is the transition's unique claim. All writes in the
> same statement select from the guarded update itself, which is stronger than
> correlating them through `updated_at`: independent requests may legitimately
> share the same timestamp.

### One rule, one definition

Where two code paths must agree about a rule, the rule gets exactly one
function. This is not tidiness — each was written after the two copies
disagreed in production-shaped ways:

| Rule | One definition | What went wrong with two |
| --- | --- | --- |
| Which documents a submission requires | `application/form/engine.ts` | A cycle asking for fewer documents validated as complete, then the write refused it with a message about the application having changed |
| Which column a queue cursor seeks | `admin/queries/intake.ts:127` | Encode and decode derived it separately; when they disagreed the cursor seeked the wrong column and returned a wrong page with no error |
| Which form stages changed | `application/form/answers.ts` | Three copies existed — a whole-draft `JSON.stringify`, a per-section one, and a field-by-field walk with a `Date` case only one of them had — so they could and did disagree |
| Which questions are on screen | `application/form/conditions.ts`, mirrored in `dev-web/.../formTemplate.ts` | The client must decide this without a round trip per keystroke, so there are deliberately two. `test/service/client-parity.test.ts` runs both over the same templates and asserts they agree — a fixture of expected values would go on passing while both drifted the same wrong way |
| The session token digest label | `auth/crypto.ts:124-128` | Creation, authentication and sign-out would stop recognising each other's sessions |
| What "another usable super administrator" means | `auth/queries/access.ts:176` | The guard could be satisfied by an account that could not actually sign in |

## Shared pieces

**`search.ts`** belongs to no single service. It turns typed text into an
index-usable prefix pattern: `prefixPattern` normalizes and escapes, and
`prefixMatch` emits `lower(column) LIKE 'term%' ESCAPE '\\'`, which uses an
index because the three search indexes are declared `text_pattern_ops` — proved
with `EXPLAIN`, not assumed.

**The escaping is the security-relevant half.** `%`, `_` and `\\` are `LIKE`'s
metacharacters, and a single unescaped `%` as a search term matches every row in
the table, inside a page whose count claims to describe the filter. That is
measured, not theoretical, and `test/service/search.test.ts` asserts it against a
real database.

Prefix only is now a choice rather than a limit — `pg_trgm` would serve
substring search — and the interface still has to say "starts with", because a
control that offers "search" and silently means something narrower is a lie
whether the narrowing was forced or chosen.

**`support.ts` holds what is genuinely one service's**: its refusal messages,
its capability preamble, its audit-row builder. Not the envelope — `success` and
`failure` were once defined identically in four support modules, which is one
decision copied rather than four decisions taken. They live in `envelope.ts`,
and each service keeps only its own type alias so a call site still says which
service is answering.

**`ownership.ts`** in the application service is a documented exception to the
layering: it needs the query layer, and `support.ts` is what the query layer
imports, so it cannot live there (`application/ownership.ts:10-11`).

## The one architectural exception

`admin/index.ts:6` re-exports `queries/funding` publicly — the only query
module exposed outside its own service. The applicant's funding view reads
administrative money records, and the alternative was duplicating the ledger
fold. Nothing else crosses this boundary.

## Guards

Three, all defined in `auth/controllers/auth.ts`:

| Guard | Accepts | Used by |
| --- | --- | --- |
| `authenticatedApplicant` | `APPLICANT` only | every `seb.*` operation |
| `authenticatedWithCapability` | whichever roles `capabilities.ts` says hold the named capability | every `admin.*` operation, via `currentStaff` |
| `authenticatedSuperAdministrator` | `SUPER_ADMIN` only | the `access.*` operations |

Sign-in accepts anyone holding at least one active role, so the narrower
applicant check is what keeps applicant operations closed to an administrator
who holds no applicant grant. `SUPER_ADMIN` implies `ADMIN` everywhere except
role administration — the one capability a plain administrator must not
inherit (`auth/controllers/auth.ts:218-220`).

Roles are joined live on every request rather than copied into the session, so a
revocation takes effect on the very next one.

## Elsewhere

- [Database schema](../db/schema/README.md) — tables, constraints, and the
  version columns these writes guard on
- [GraphQL layer](../graphql/README.md) — how operations reach these services,
  and what bounds a request
- [Documentation rules](../../docs/rules/documentation.md) — the shape these
  READMEs follow
