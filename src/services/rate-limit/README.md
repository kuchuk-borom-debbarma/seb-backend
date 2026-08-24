# Rate limiting

How often one caller may do one thing.

The interface names no vendor: a limit is a **bucket** — a named allowance
counted along one dimension — and a transport is anything that can spend from
one and say whether there was anything left. The platform's rate-limiting
binding, a Durable Object, Redis and an in-process map all satisfy it.

## What it assumes

- **A document reaching the plugin has been validated.** Execution runs after
  validation, so a fragment cycle, an unknown fragment and a missing required
  argument cannot arrive — the walker carries no guard against any of them.
- **One side-effecting field per mutation.** The single-mutation validation
  rules in [`../../graphql/validation.ts`](../../graphql/validation.ts)
  guarantee it, so the first field the policy names is the only one.
- **`CF-Connecting-IP` is the platform's own header.** `X-Forwarded-For`
  arrives from the caller and can say anything, so keying on it would let one
  attacker occupy as many buckets as they liked.
- **An allowance is spent by asking.** There is no way to look at one without
  spending it, which is why every attempt costs — see below.

## Three dimensions

| Dimension | Protects | Available |
| --- | --- | --- |
| `IP` | the shared resource from one source | whenever the platform supplies the header |
| `SESSION` | an account from its own session being driven hard | once signed in |
| `SUBJECT` | the account being *acted on* | where the operation names one |

`SUBJECT` is what catches credential stuffing: an `IP` limit cannot see a
botnet, and there is no session yet. A bucket whose dimension a request cannot
supply is **skipped**, because refusing on a missing dimension would stop signup
working at all.

## Every attempt spends, including the ones that succeed

Counting only failed sign-ins would be kinder and cannot be done. An allowance
spent *after* a failure is never consulted *before* the next attempt, so it
fills up and refuses nothing — that was built first, and the test caught it.

So the limits accommodate legitimate repetition instead: five sign-in attempts a
minute against one address is a handful of devices for a real person.

## Every window is a minute, and that is a real weakness

The platform's binding accepts a period of **ten seconds or sixty, and nothing
else**. An allowance that ought to be measured in hours therefore cannot be:
"three signups an hour for one address" — seventy-two messages a day — is
expressible only as "two a minute", which is nearly three thousand.

What these limits stop is bulk abuse: a script hammering one address, a flood
from one source. **What they do not stop is a patient attacker trickling
requests.** A Durable Object counts any window and is the way out; it is a
roadmap item, and the seam means swapping to it changes one transport file and
the numbers in the policy — no caller, and no enforcement point.

## How each operation flows

### Applying a limit to a GraphQL operation

| | |
| --- | --- |
| **Entry** | the plugin in [`../../graphql/rate-limit.ts`](../../graphql/rate-limit.ts), on every mutation |
| **Guard** | none of its own — it runs before the operation's |
| **Refuses** | an allowance with no room, and a limiter that cannot answer |
| **Writes** | nothing. It spends allowances and returns |
| **Guarded by** | the transport's own atomicity: `consume` asks and decrements in one step |
| **Fails** | `Too many attempts. Wait a few minutes and try again.`, inside the operation's own envelope |

The refusal is an envelope rather than a GraphQL error because every expected
failure in this API is — `errors` means the request was malformed or the server
broke, and the client raises on it. A refusal delivered as an error would have
surfaced as a generic thrown error in place of the written one.

### Applying the request budget

| | |
| --- | --- |
| **Entry** | `requestBudget` in [`../../index.ts`](../../index.ts), on `/graphql` and `/internal/*` |
| **Guard** | none. It runs before anything is parsed |
| **Refuses** | an address that has spent the budget |
| **Writes** | nothing |
| **Guarded by** | the same atomicity |
| **Fails** | HTTP 429 with the same message, shaped like every other envelope |

Coarse on purpose. It cannot tell one operation from another — `/graphql` is a
single POST — so it guards volume, and the operation limits are what make the
sensitive paths hard.

## Failing closed

A transport that throws could not answer. That is treated as a refusal, never as
permission. The cost is real and chosen: a limiter outage refuses signup rather
than leaving it unprotected, and the message is identical either way so a caller
cannot tell a spent allowance from a broken limiter.

## The numbers live in two places, and are checked

The platform's limiter takes its limit and period from configuration rather than
from the call, so [`policy.ts`](policy.ts) names a binding and restates the
numbers — for the in-process transport, and so a reader can see what is
permitted. `npm run check:rate-limits` fails when the two disagree, and when a
deployed configuration switches counting off.

Unchecked this would be the worst kind of drift: the limiter fails closed, so a
policy naming a binding the configuration does not declare would refuse
everything that binding covers rather than quietly permitting it.

## The suites do not count

Both suites run with the `unlimited` transport. The browser suite signs in
dozens of times in three minutes, which is not a usage pattern any real limit
should accommodate — **numbers chosen so a test suite fits are numbers too loose
to be worth having.**

Off is a named transport rather than a flag inside another one, so it is visible
in the seam and something a test can assert about. Two independent things stop
it reaching a real environment: the factory refuses to build it when
`ENVIRONMENT` is production, and `check:rate-limits` refuses it in the deployed
configuration.

`test/rate-limit.test.ts` turns counting back on for itself, and drives the
plugin through `handleGraphQLRequest` rather than `SELF.fetch` — the worker
behind `SELF` reads its configuration once, and mutating the imported `env` does
not reach it.

**What this costs:** no browser test covers what a refusal looks like on screen.
The behaviour is proven in the Worker suite, including that it arrives as an
envelope the client's existing `messageFor` renders, but nothing asserts the
rendering.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `rateLimiter` | `index.ts` | The transport this environment should use |
| `enforce` | `index.ts` | Spends every allowance one operation needs |
| `usesLocalRateLimiter` | `index.ts` | Whether this environment counts in process |
| `RATE_LIMITED_MESSAGE` | `index.ts` | What a refused caller is told |
| `REQUEST_BUDGET`, `bucketsFor`, `allBuckets` | `policy.ts` | The policy, and lookups into it |
| `callerAddress`, `operationSubject`, `requestIdentity` | `identity.ts` | Turning a request into what is counted |
| `memoryRateLimitTransport` | `transports/memory.ts` | Counts in this isolate; development only |
| `cloudflareRateLimitTransport` | `transports/cloudflare.ts` | The binding. The only file that knows it exists |
| `unlimitedRateLimitTransport` | `transports/unlimited.ts` | Counts nothing, for test runs |

## Elsewhere

- [What bounds a request](../../graphql/README.md) — the other four limits, and
  where this one sits among them
- [Security](../../../docs/rules/security.md) — why a key is a digest and never
  a session token
- [Services](../README.md) — the layering rule these files follow
