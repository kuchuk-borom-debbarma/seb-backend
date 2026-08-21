# External notification service

This service is the boundary between business workflows and outbound delivery.
Its current implementation is deliberately small: callers import and invoke the
exported `sendEmail` function directly.

## Contract

```ts
sendEmail({
  to: string,
  subject: string,
  text: string,
}): Promise<void>
```

A resolved promise means the transport accepted the message. A rejection means
delivery could not be initiated and the caller must apply its own failure
policy. The service does not know about signup challenges, applicants, D1, or
GraphQL.

There is intentionally no class or interface at this stage. The function is the
replacement seam and `index.ts` is the only public entry point.

## Current console transport

`controllers/external-notification.ts` logs the recipient, subject, and text.
This makes a local signup OTP visible to a developer without requiring an email
provider.

The console transport is not production-safe because OTP text appears in Worker
logs. It must never be used in a public deployment.

## Signup failure behavior

The authentication service first stores a pending challenge and then calls
`sendEmail`. If the promise rejects, authentication marks only that new
challenge `DELIVERY_FAILED` and writes a safe audit event. Sibling challenges
remain valid. Raw OTPs and message bodies are never stored in D1 or audit
metadata.

The transport should throw only when it cannot accept the notification. A
provider-specific retry policy must distinguish transient errors from permanent
recipient errors without exposing provider details to GraphQL clients.

## Replacing the implementation

A production implementation may call an email provider directly or enqueue a
small delivery command through Cloudflare Queues. A Queue-backed transport is
preferred when signup latency and provider outages should be isolated from the
request path.

When replacing the console function:

1. Keep the public `sendEmail` input and promise behavior stable.
2. Keep provider credentials in Cloudflare secrets, never env files or source.
3. Avoid logging message text, OTPs, full recipient addresses, provider tokens,
   or authorization headers.
4. Use an idempotency key or delivery identifier before enabling retries.
5. Define whether “accepted by queue/provider” counts as success; asynchronous
   terminal failures require a callback/consumer that can invalidate the
   associated challenge.
6. Add request and notification rate limits before public signup is enabled.
7. Add transport tests for success, rejection, retry, and redacted logging.

If Queue delivery is introduced, the queued payload must have a bounded schema
and retention policy. Do not place password data, token digests, session tokens,
or unrelated applicant/application data in the message.

## Deployment rule

Do not publicly deploy while `sendEmail` writes OTP-bearing messages to the
console. Replace it with a production transport and add rate limiting first.
