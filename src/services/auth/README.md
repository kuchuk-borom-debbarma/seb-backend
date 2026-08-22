# Authentication service

This service implements the project's custom authentication. It does not use
Better Auth. Signup grants `APPLICANT` only; sign-in and session management
serve applicants and administrators alike. Operations are GraphQL-only; the
single exception is the direct curl route used once to promote the first super
administrator.

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

`signIn` requires at least one active role grant of any kind, normalizes the
email, verifies the scrypt password hash, and creates a random session token.
The role is deliberately not narrowed: an administrator who holds no
`APPLICANT` grant must be able to sign in, while a person whose every grant has
been revoked must not. Applicant capability is enforced separately, at the
applicant guard. Only the token digest is stored in D1. The raw token is
returned to the browser in an HttpOnly cookie and is never exposed in a GraphQL
response.

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
- Deactivation (losing every active role) hard-deletes that user's sessions.
- Promoting the first super administrator hard-deletes the promoted account's
  sessions, so administrative authority requires a fresh sign-in.

All other persistent authentication records retain lifecycle or soft-deletion
history.

### Deactivation

Revoking a person's last active role deactivates them. Because roles are joined
live, the very next request refuses the session — but refusal alone is not
enough, since the rows would survive until expiry and authenticate again the
moment any role is granted back. Deactivated sessions are therefore destroyed,
by two paths that cover each other:

- presenting the cookie deletes every session that account holds, audited as
  `AUTH.SESSIONS_REVOKED` with `reason: NO_ACTIVE_ROLE` and no actor, because
  the holder is the subject of the deletion rather than its authority; and
- the scheduled cleanup deletes sessions belonging to any account with no
  active grant, covering accounts that never present a cookie at all.

The second path matters because a deactivated person cannot reach
`revokeAllSessions` to clear their own sessions.

### Deploying the session rename

The session cookie (`seb_applicant_session` to `seb_session`) and the HMAC
purpose label (`applicant-session` to `user-session`) both changed, so every
`core_session` row predating the rename is unauthenticable. Browsers are
handled automatically: `clearSessionCookie` expires the superseded cookie name
alongside the current one. The stale rows are not, because a digest computed
under the old label is indistinguishable from a valid one — their owners still
hold active roles, so the deactivation sweep does not apply. Until they expire,
`auth.sessions` lists them as apparently active. Run once when deploying to any
environment that already has sessions:

```sh
npx wrangler d1 execute DB --command 'DELETE FROM core_session'
```

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
- `FIRST_SUPER_ADMIN_EMAIL` temporarily selects the one verified applicant that
  may be promoted by the curl bootstrap.
- `FIRST_SUPER_ADMIN_SECRET` is a temporary random secret containing 32 through
  512 bearer-safe ASCII characters (`A-Z`, `a-z`, digits, `.`, `_`, `~`, `+`,
  `/`, `=`, or `-`). Remove it together with the email after successful
  bootstrap.

Keep `.env.example` empty. `.env` is gitignored and may hold local-only values;
production values are provisioned as Cloudflare secrets.

## Security invariants

- Roles and verified-email time are server controlled.
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
- First-super-administrator bootstrap is absent from GraphQL, cannot choose its
  target email or role, and permanently closes after the first historical
  `SUPER_ADMIN` grant.
- Bootstrap exchanges `APPLICANT` for `SUPER_ADMIN` inside one guarded
  transaction. A losing request writes neither, so an account is never stranded
  with no active role and therefore no way to sign in.
- Bootstrap audits omit caller-controlled request labels so a password, email,
  or temporary secret cannot be copied into retained history through headers.
- Once bootstrap is permanently closed, requests fail before memory-hard
  password verification; the final D1 write still repeats the closure check to
  decide concurrent attempts atomically.

Integration coverage lives in `test/auth.test.ts`. Run it with:

```sh
npm test -- test/auth.test.ts
```

See the [administrator RBAC guide](../../../docs/admin-rbac.md) for the fixed
role hierarchy, retained grant lifecycle, and future provisioning boundary.

## Known limitation

Request, resend, and notification rate limiting are not implemented. CAPTCHA,
password reset, account deletion APIs, administrator account recovery, and
production email delivery are also out of scope. Do not publicly deploy
applicant signup with the current console notification transport or without
rate limiting. See the
[bootstrap operator guide](../../../docs/first-super-admin-bootstrap.md) for the
one-time curl procedure.
