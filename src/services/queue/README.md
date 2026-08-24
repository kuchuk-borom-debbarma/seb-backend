# Queue service

Work handed off to be done after the response.

The interface is one method, because that is genuinely all the programme needs
from a queue: hand over a message and be told it was accepted. It names no
vendor — Cloudflare Queues, SQS, a database table and an in-process array all
satisfy it.

## What it assumes

- **A message carries identifiers and nothing else.** A queued payload outlives
  the request that created it, may be retried, and is readable by whoever can
  read the queue. So it carries the id of something already stored and the
  consumer reads the rest for itself — never a one-time code, a document's
  contents, a session token, or an applicant's answers.
- **Losing a message must be safe.** Every current producer goes through
  `sendBestEffort`, which means the business operation already succeeded. That
  is only acceptable where the consequence of loss is safe — see below.
- **The environment is told what it is.** Unset means local.

## Two transports

| | Delivers | Selected when |
| --- | --- | --- |
| `memory` | nothing on its own; holds messages until drained | `ENVIRONMENT` is unset or `local` |
| `cloudflare` | the `QUEUE` binding | anything else |

**The local one is drained by `src/index.ts` after each request**, through
`executionCtx.waitUntil`. That is the closest honest equivalent of a real queue:
the work happens after the response rather than inside it, so the applicant is
not kept waiting for work that is not theirs. Draining is deliberately not the
transport's job — the one place that knows how to handle a message is the Worker
entry point that also serves the deployed consumer, so both paths run the same
code.

## How each operation flows

### `send` — hand over one message

| | |
| --- | --- |
| **Entry** | `queue(env).send(message)` |
| **Refuses** | by throwing, which is how a transport says it could not accept |
| **Writes** | nothing in the database |

### `sendBestEffort` — hand over, and carry on if you cannot

| | |
| --- | --- |
| **Entry** | `sendBestEffort(queue(env), message, description)` |
| **Returns** | whether it was accepted |
| **Logs** | `<description> could not be queued`, and nothing else |

Queued work is by definition not part of what the caller promised. A business
operation that already succeeded must not be reported as failed because the
follow-up could not be scheduled — the applicant's upload really did land, and
telling them otherwise invites them to do it again.

The error is deliberately not logged with the message: a transport failure can
carry the request it was making, and these payloads name stored objects.

**Only for work whose loss is safe.** It is safe for document scanning because
administrative download fails closed until a scan result is appended, so a lost
message yields a document nobody can read rather than a document nobody checked.
Anything without that property must handle its own failure.

## What is actually queued

One message kind: `DOCUMENT_SCAN_REQUESTED`, produced when a document is
finalized and consumed by the `queue()` handler in `src/index.ts`, which routes
it through the [document scanner](../document-scanner/README.md).

A closed union rather than an open payload, so a consumer can be exhaustive and
adding a kind is a compile error everywhere it must be handled.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `queue` | `index.ts` | The transport for this environment |
| `usesLocalQueue` | `index.ts` | Whether messages are held in process |
| `sendBestEffort` | `index.ts` | Sends work whose loss is safe |
| `drainMemoryQueue` | `transports/memory.ts` | Everything queued since the last drain |
| `QueueMessage`, `QueueTransport` | `types.ts` | The interface and the message union |
| `cloudflareQueueTransport` | `transports/cloudflare.ts` | The only file that knows the binding |
| `memoryQueueTransport` | `transports/memory.ts` | Holds messages for a local drain |

## Elsewhere

- [Document scanner](../document-scanner/README.md) — the one consumer
- [Application service](../application/README.md) — the one producer, at
  document finalization
- [Code rules](../../../docs/rules/code.md) — the transport-service shape
