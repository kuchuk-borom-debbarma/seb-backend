# External notification service

This service is the boundary between business workflows and outbound delivery.
The programme says *who* to tell and *what to say*; this decides who carries it,
and that decision is the only thing here that varies.

Nothing outside `transports/` names a provider. The interface is expressed in
what the programme wants to say — a recipient, a subject, a body — which every
provider satisfies and none of them owns.

## What it assumes

- **Delivery is best-effort and never blocks a workflow.** A signup whose
  notification fails still records the challenge; the applicant is told to try
  again rather than being left with an account in an unknown state.
- **The caller has already decided the message is safe to send.** This service
  does not redact. Whatever is handed to it is written verbatim by the console
  transport, which is exactly why that transport must never be deployed.
- **The environment is told what it is.** `ENVIRONMENT` unset means a
  developer's machine, because a deployed one is always configured. Nothing
  infers the environment from anything else.
- **A transport is cheap to build.** It is constructed on every call rather than
  cached, so a test or a local override can supply different bindings without
  global mutable configuration — the same position `src/index.ts` takes for the
  Worker's own configuration, and necessary here because the suite runs
  `singleWorker: true`, where a cached transport would be shared by every test.

## The interface

```ts
type Notification = {
  to: string
  subject: string
  body: string
  attachments?: readonly { filename: string; contentType: string; bytes: Uint8Array }[]
}
type Delivery = { reference: string | null }

type NotificationTransport = {
  readonly name: string
  send(notification: Notification): Promise<Delivery>
}
```

A resolved promise means the transport accepted the message. `reference` is an
opaque handle support can quote when the transport has one, and `null` when it
does not — never invented, because a made-up reference lets a caller believe a
message is traceable. A rejection means delivery could not be initiated and the
caller applies its own failure policy.

`body` is plain text, as the domain has it. A transport that needs another
format derives it; the caller never learns which. That is the line that keeps
the interface agnostic — the words `type`, `html` and `trackingId` are the
provider's, and they appear in exactly one file.

`attachments` are bytes with a name, which passes the interface's own printer
test: any carrier can do something honest with them — a printer prints them, a
postal service encloses them. A URL instead would name a place only one
transport could reach, and would leak where the programme keeps things. The
console transport logs **names and byte counts only**, never content — logs
are readable in CI on a public repository — and omits the key entirely when
nothing is attached, so a message without attachments prints exactly the line
it always has. The provider adapter encodes each attachment's bytes as base64
in its request body. The three callers today attach one PDF each: the
submission confirmation, the approval notice, and the sanction notice — see
[`confirmation.ts`](../application/confirmation.ts).

## How each operation flows

### `notificationTransport(env)` — choosing who delivers

| | |
| --- | --- |
| **Entry** | `notificationTransport(env)` in `index.ts` |
| **Guard** | none; it is configuration, not a request |
| **Refuses** | a delivering environment with no `PINGRAM_API_KEY` or no `PINGRAM_NOTIFICATION_TYPE` |
| **Writes** | nothing |
| **Guarded by** | `ENVIRONMENT`, trimmed and lowercased |
| **Fails** | `Notification delivery is not configured for the <environment> environment.` |

`develop` and `production` deliver for real. Everything else — including unset,
empty, and whitespace — prints.

The refusal is the point. A deployed environment missing its credentials must
not degrade to the console transport, because that writes live one-time codes
into logs. Throwing takes the caller's existing failure path, which invalidates
the challenge and tells the applicant the code could not be sent — which is
true.

### `sendNotification(notification, env)` — sending one

| | |
| --- | --- |
| **Entry** | `sendNotification(notification, env)` in `index.ts` |
| **Guard** | none; the caller has already decided the message is safe |
| **Refuses** | whatever the chosen transport refuses |
| **Writes** | nothing here; the transport may reach the network |
| **Guarded by** | nothing — there is no concurrency to lose |
| **Fails** | by rejecting, carrying the transport's sanitised message |

The one entry point the rest of the programme calls.

## The transports

| | Delivers | Needs | Reference |
| --- | --- | --- | --- |
| `console` | nothing; prints one marked line, attachments as name and size only | nothing | always `null` |
| `pingram` | `POST <base>/email`, attachments inline as base64 | an API key and a notification type | the provider's tracking id, when readable |

### The console transport and its sentinel

The line is prefixed `DEV_EMAIL` and carries a single-line JSON payload, so the
end-to-end suite finds the code by *where it is* rather than by what it looks
like. It previously scraped the Worker's whole log for the last run of six
digits, which silently returns the wrong code the moment anything else logs six
consecutive digits — a request id, a timestamp fragment, a provider reference.

It must be one line. Logging the object directly made the runtime pretty-print
it across several lines, putting the marker and the code on different lines and
leaving the harness with nothing anchored to read.

### The provider adapter and its sanitised failure

The adapter throws an error naming the status and nothing else:

```
The notification provider did not accept the message (401).
```

This is not caution for its own sake. A rejected `fetch` carries the request it
was making, and a provider's error body can echo the request straight back —
recipient, subject, and the one-time code. The caller writes a line to the
Worker log when delivery fails, and on a public repository those logs are
readable. A test asserts the thrown message contains neither the key, nor the
recipient, nor the code.

A malformed body on a `200` yields `{ reference: null }` rather than a failure.
The provider took the message; only the reference is unavailable, and treating
that as a delivery failure would invalidate a live code.

## Configuration

| Variable | Read when | Provisioned as |
| --- | --- | --- |
| `ENVIRONMENT` | always | a var |
| `PINGRAM_API_KEY` | `develop`, `production` | a secret |
| `PINGRAM_NOTIFICATION_TYPE` | `develop`, `production` | a secret |
| `PINGRAM_BASE_URL` | `develop`, `production` | a var |
| `PINGRAM_FROM_NAME`, `PINGRAM_FROM_ADDRESS` | `develop`, `production` | vars |

`PINGRAM_NOTIFICATION_TYPE` identifies the provider's own template. It is
required by the provider, not by the programme.

`PINGRAM_BASE_URL` names the region the account lives in. Unset means the
provider's default, and a key issued against another region is refused there
rather than delivering somewhere unexpected. The from-name and from-address are
optional and left to the account when absent; both are provider concepts, which
is why they are configuration here rather than anything a caller passes.

Keep credentials in Cloudflare secrets, never in an env file that is checked in
or in source.

## Signup failure behaviour

The authentication service first stores a pending challenge and then calls
`sendNotification`. If the promise rejects, it marks only that new challenge
`DELIVERY_FAILED` and writes a safe audit event. Sibling challenges remain
valid. Raw OTPs and message bodies are never stored in the database or audit metadata.

## Rules for any future transport

1. Nothing provider-specific may leave `transports/`. If a concept has to reach
   a caller, the interface is wrong and the interface changes.
2. Never log message text, OTPs, full recipient addresses, provider tokens, or
   authorization headers — and never throw an error carrying any of them.
3. Throw only when the message could not be accepted. Provider-specific retry
   policy distinguishes transient from permanent without exposing provider
   detail to a GraphQL client.
4. Use an idempotency key or delivery identifier before enabling retries.
5. Decide whether "accepted" means accepted by the provider or delivered. An
   asynchronous terminal failure needs a callback or consumer that can
   invalidate the associated challenge.
6. Add request and notification rate limits before public signup is enabled.

A queue-backed transport is preferred when signup latency and provider outages
should be isolated from the request path. It is a transport like any other, so
introducing one changes this directory and no caller. A queued payload must
have a bounded schema and retention policy, and must not carry password data,
token digests, session tokens, or unrelated applicant data.

## Deployment rule

Do not deploy publicly while the console transport is the selected one. The
factory is what keeps this true: a delivering environment cannot reach it.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `Notification` | `types.ts` | What the programme wants to say |
| `Delivery` | `types.ts` | What came back, if anything can be quoted |
| `NotificationTransport` | `types.ts` | The interface every transport satisfies |
| `notificationTransport` | `index.ts` | Returns the transport for this environment |
| `sendNotification` | `index.ts` | Sends one through it; the caller's entry point |
| `consoleTransport` | `transports/console.ts` | Prints; for local work only |
| `DEV_EMAIL_PREFIX` | `transports/console.ts` | Marks the line the harness reads |
| `pingramTransport` | `transports/pingram.ts` | The one file that knows Pingram exists |
| `PingramConfiguration` | `transports/pingram.ts` | Its key and notification type |

## Elsewhere

- [Layering rule](../README.md) — why this service has no `queries/`
- [Auth service](../auth/README.md) — signup, recovery and password-change
  notices
- [Application service](../application/README.md) — the submission, approval
  and sanction confirmations, each attaching a PDF
- [Storage seam](../application/README.md) — the same pattern, for documents
