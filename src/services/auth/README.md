# Applicant authentication service

This service implements the project's custom applicant authentication. It does
not use Better Auth and does not mount authentication REST routes. GraphQL
resolvers call the exported functions directly.

## Authentication flow

### Signup

1. `startApplicantSignup` trims and lowercases the email.
2. It creates an independent 256-bit challenge token and six-digit OTP with a
   ten-minute expiry.
3. D1 stores HMAC digests, never the raw challenge token or OTP.
4. The OTP is passed to the external-notification service. Existing emails
   receive an unstored decoy challenge with the same public response shape and
   no notification, which avoids account enumeration.
5. `verifyApplicantSignup` validates the password before reading the challenge.
   A correct OTP atomically creates a verified user with an active `APPLICANT`
   role grant, consumes the winning challenge, cancels pending siblings, and
   writes safe user/role audit events. Signup does not create a login session.

Repeated signup starts create independent pairs. A wrong OTP decrements only its
own pair, so one challenge cannot invalidate a sibling. D1 guards and unique
constraints decide concurrent redemption; exactly one request can claim the
normalized email.

### Password sign-in

`signInApplicant` requires an active `APPLICANT` role, normalizes the email,
verifies the scrypt password hash, and creates a random session token. Only the
token digest is stored in D1. The raw token is returned to the browser in an
HttpOnly cookie and is never exposed in a GraphQL response.

The browser cookie has no persistent `Max-Age`, while the D1 session has a
seven-day server expiry. Current-session and session-list responses expose only
public session IDs and request metadata.

### Session deletion

Sessions are intentionally hard-deleted:

- Sign-out removes the current session and clears its cookie.
- Revoke-one verifies ownership before deleting the selected session.
- Revoke-other preserves the current session and cookie.
- Revoke-all removes every session and clears the current cookie.
- The scheduled cleanup deletes expired sessions.
- Soft-deleting a user must also hard-delete that user's sessions.

All other persistent authentication records retain lifecycle or soft-deletion
history.

## Module layout

- `controllers/auth.ts`: validation, authentication policy, response envelopes,
  cookies, and orchestration. Each use case is a directly exported function.
- `queries/auth.ts`: Drizzle statements, guarded writes, ownership checks, and
  D1 batch boundaries.
- `crypto.ts`: challenge/OTP/session generation, HMAC digests, and scrypt
  password hashing/verification.
- `cookies.ts`: cookie parsing, creation, and clearing.
- `types.ts`: operation context and public response types.
- `index.ts`: the service's public exports.

There is intentionally no service class or interface. The direct-function
structure keeps the workflow traceable while preserving a strict boundary
between policy and persistence.

## Operation context

Every operation receives a request-scoped `AuthOperationContext` containing:

- the Drizzle D1 client;
- Cloudflare bindings and configuration;
- request headers and URL;
- a response-header sink used to forward `Set-Cookie` through GraphQL Yoga.

The module holds no request state in globals, so one Worker isolate can safely
serve concurrent requests.

## GraphQL integration

Authentication lives below the `auth` query and mutation namespaces. Resolvers
are adapters only; they do not contain validation, cryptography, or SQL.

Expected authentication failures use the common envelope:

```graphql
{
  success
  message
  response
}
```

They do not become GraphQL errors. Invalid GraphQL documents and unexpected
server faults do. Validation also rejects a document with more than one field
under `mutation.auth` before either field executes.

Responses never expose passwords, OTPs, raw challenge/session tokens, or their
digests. The sole exception is the one-time signup `challengeToken`, which the
client must return with its OTP.

## Audit behavior

Authentication records fixed, allow-listed action names for challenge creation,
notification failure, OTP failure, user creation, sign-in success/failure,
role grants, sign-out, revocation, and bulk revocation. When practical, a state
change and its successful audit event share one D1 batch.

Audit metadata may contain public entity IDs and small operational values. It
must never contain passwords, password hashes, OTPs, challenge/session tokens,
token digests, cookie values, or sensitive response bodies.

## Configuration

- `AUTH_SECRET` is required and must contain at least 32 bytes. It keys HMAC
  domains for signup challenges, OTPs, and sessions.
- `FRONTEND_ORIGINS` is the comma-separated credentialed-CORS allowlist.
- `APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT` is optional, defaults to `5`, and must
  be an integer from `1` through `20`.
- `AUTH_COOKIE_SAME_SITE` defaults to `lax`. `none` is allowed only over HTTPS
  and produces a Secure cookie.

Keep `.env` and `.env.example` empty. Supply local values to Wrangler and
provision production values as Cloudflare secrets.

## Security invariants

- Applicant role and verified-email time are server controlled.
- Roles are retained grants, not a mutable field on the user. Public signup can
  create only `APPLICANT`.
- Active roles are loaded from D1 on every request rather than cached in the
  session, so revocation is immediately authoritative.
- Email normalization is trim plus lowercase; passwords are not normalized.
- Existing and soft-deleted emails remain reserved.
- Deleted users cannot sign in and their sessions cannot authenticate.
- Credential comparison uses a dummy hash when the account is absent to reduce
  account-enumeration timing differences.
- Race-sensitive signup and session mutations use guarded D1 statements and
  bounded batches.
- Session cookies are HttpOnly and use the configured SameSite/Secure policy.

Integration coverage lives in `test/applicant-auth.test.ts`. Run it with:

```sh
npm test -- test/applicant-auth.test.ts
```

See the [administrator RBAC guide](../../../docs/admin-rbac.md) for the fixed
role hierarchy, retained grant lifecycle, and future provisioning boundary.

## Known limitation

Request, resend, and notification rate limiting are not implemented. CAPTCHA,
password reset, MFA, account deletion APIs, and production email delivery are
also out of scope. Do not publicly deploy applicant signup with the current
console notification transport or without rate limiting.
