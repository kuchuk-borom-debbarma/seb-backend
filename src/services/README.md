# Services

Eight services hold every business rule in the Worker. GraphQL resolvers are
thin adapters above them and hold none.

Three of them own a domain. The other five exist to be *swapped*: each is an
interface the programme states in its own words, with one file per
implementation and a factory that picks by environment. That is what lets the
whole portal run on a developer's machine with nothing configured.

| Service | Owns | Size |
| --- | --- | --- |
| [`application/`](application/README.md) | Everything an applicant owns — enterprises, drafts, evidence, submission | 6,414 lines |
| [`admin/`](admin/README.md) | Programme cycles and the whole post-submission staff workflow | 5,792 lines |
| [`auth/`](auth/README.md) | Identity, sessions, signup, capabilities, and role administration | 3,269 lines |
| [`storage/`](storage/README.md) | Where documents live: a bucket, or this Worker | 517 lines |
| [`audit/`](audit/README.md) | Reading the history of who changed what | 450 lines |
| [`external-notification/`](external-notification/README.md) | Getting a message to a person | 264 lines |
| [`document-scanner/`](document-scanner/README.md) | Whether a stored document is safe to open | 168 lines |
| [`queue/`](queue/README.md) | Work handed off to be done after the response | 161 lines |

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
queries/       all Drizzle SQL, all D1 batch boundaries — and every
               authorization, lifecycle and version term repeated
               inside the write predicate
      │
support.ts     the response envelope, the audit-row builder, and the
               error-classification helpers, mirrored in all three
```

### Why the checks are repeated

A controller reads, decides, and then writes. Between the read and the write,
the world can change — and the window is not theoretical. From
`auth/controllers/access.ts:5-11`:

> Every mutation requires a fresh password confirmation, and every authorization
> term is repeated inside the guarded write, because scrypt runs outside D1 and
> takes long enough for the caller's own authority to change while it runs.
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

Every mutation is one `db.batch`, and it always looks like this:

1. An `UPDATE … WHERE current_version = :expected` on the head row, plus every
   term that must still hold — the owner, the status, the assignee.
2. Each dependent `INSERT … SELECT … WHERE EXISTS (…)`, where the
   predicate proves the head moved to the new version at this exact timestamp.
3. `d1ChangedExactlyOne(result)` on the first statement decides the outcome.

A batch is one D1 transaction, so a losing request writes nothing at all — no
partial referral, no orphaned audit row. The caller gets
`'The record changed. Reload and try again.'`

The audit row doubles as the operation's claim
(`application/queries/application.ts:1636-1639`):

> This append-only audit row is the transition's unique claim. All writes in the
> same D1 batch require its exact ID, which is stronger than correlating them
> through `updated_at`: independent requests may legitimately share the same
> millisecond timestamp.

### One rule, one definition

Where two code paths must agree about a rule, the rule gets exactly one
function. This is not tidiness — each was written after the two copies
disagreed in production-shaped ways:

| Rule | One definition | What went wrong with two |
| --- | --- | --- |
| Which documents a submission requires | `application/validation.ts:679` | A cycle asking for fewer documents validated as complete, then the write refused it with a message about the application having changed |
| Which column a queue cursor seeks | `admin/queries/intake.ts:127` | Encode and decode derived it separately; when they disagreed the cursor seeked the wrong column and returned a wrong page with no error |
| Which form sections changed | `application/sections.ts:60` | A second copy could omit a field and report "no change" for an edit that really happened |
| The session token digest label | `auth/crypto.ts:124-128` | Creation, authentication and sign-out would stop recognising each other's sessions |
| What "another usable super administrator" means | `auth/queries/access.ts:176` | The guard could be satisfied by an account that could not actually sign in |

## Shared pieces

**`search.ts`** belongs to no single service. It turns typed text into an
index-usable prefix pattern: `prefixPattern` normalizes and escapes, and
`prefixMatch` emits `lower(column) GLOB 'term*'`. `GLOB` rather than `LIKE`
because only `GLOB` can use a `BINARY`-collated expression index — proved with
`EXPLAIN QUERY PLAN`, not assumed.

The header states the product constraint it carries (`search.ts:10-13`):

> Prefix only. That is a real limit and the interface says so: a control that
> offers "search" and silently means "starts with" is a lie.

**`support.ts` is mirrored, not shared** (`auth/support.ts:2-7`). Each of the
three real services has its own, deliberately alike, so the controllers cannot
drift to different failure envelopes or different audit metadata rules.

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
| `authenticatedAdministrator` | `ADMIN` or `SUPER_ADMIN` | every `admin.*` operation |
| `authenticatedSuperAdministrator` | `SUPER_ADMIN` only | the four `access.*` operations |

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
