# First super administrator bootstrap

This guide explains the one exceptional authentication operation that is not
available through GraphQL. It promotes one existing verified applicant to the
first `SUPER_ADMIN` through a direct command-line HTTP request.

Bootstrap is deliberately narrow:

- it can target only `FIRST_SUPER_ADMIN_EMAIL`;
- it requires that account's current password;
- it requires a separate temporary bearer-safe secret containing 32 through 512
  ASCII characters;
- it works only before any `SUPER_ADMIN` grant has ever existed; and
- it creates `SUPER_ADMIN`, not a redundant `ADMIN` grant.

The promoted person's `APPLICANT` grant is revoked in the same transition, so
their only active role afterwards is `SUPER_ADMIN`. Both role events are
retained in grant history.

Bootstrap therefore requires a dedicated account and enforces it: a candidate
who owns any enterprise is refused, because losing `APPLICANT` would strand
that enterprise and its applications with no operation able to grant the role
back. The check counts soft-deleted enterprises too, since those are
restorable.

Bootstrap also deletes every session the promoted account already held. Those
sessions were issued to an applicant; letting them survive would hand full
administrative authority to an existing cookie without the holder re-proving
their password. The new administrator signs in again.

## 1. Create and verify the applicant

The intended administrator must first complete normal applicant signup using
the email that will be configured as `FIRST_SUPER_ADMIN_EMAIL`. This proves
email control, creates the password, and grants `APPLICANT`.

Do not continue until signup verification succeeds. Bootstrap does not create a
user, verify an email, restore a deleted account, or replace a password.

## 2. Configure the temporary values

Generate a random secret, for example:

```sh
openssl rand -hex 32
```

For local development, place the email and generated value in the gitignored
`.env.local` file:

```dotenv
FIRST_SUPER_ADMIN_EMAIL=administrator@example.com
FIRST_SUPER_ADMIN_SECRET=replace-with-the-generated-value
```

`.env.example` is the checked-in template and documents both values; it never
holds one. Never commit `.env.local`. Note that a leftover `.dev.vars` beats
these files entirely — see [configuring the Worker](../README.md#configuration).

For a deployed Worker, provision both values temporarily through Cloudflare:

```sh
npx wrangler secret put FIRST_SUPER_ADMIN_EMAIL
npx wrangler secret put FIRST_SUPER_ADMIN_SECRET
```

The configured email is normalized by trimming whitespace and lowercasing it.
The secret must contain 32 through 512 bearer-safe ASCII characters: letters,
digits, `.`, `_`, `~`, `+`, `/`, `=`, or `-`. The recommended hexadecimal
generator satisfies this rule and should be run independently for each
environment.

## 3. Run the curl bootstrap

The route is:

```text
POST /internal/bootstrap/first-super-admin
```

It is not part of the GraphQL schema, does not accept browser CORS requests,
and does not require a session cookie. The configured applicant's current
password is the only JSON field. The bootstrap secret goes in the bearer header.

To avoid placing either credential directly in shell history, prompt for them
and use `jq` to encode every valid password safely:

```sh
# `read -rs` + printf rather than bash's `read -rsp`: macOS defaults to zsh,
# where `-p` reads from a coprocess and the prompt form silently sets nothing.
printf 'Applicant password: ' && read -rs ADMIN_PASSWORD && echo
printf 'Bootstrap secret: ' && read -rs ADMIN_BOOTSTRAP_SECRET && echo

jq -n --arg currentPassword "$ADMIN_PASSWORD" '{currentPassword: $currentPassword}' \
  | curl --fail-with-body --silent --show-error \
      --request POST \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $ADMIN_BOOTSTRAP_SECRET" \
      --data-binary @- \
      http://localhost:9999/internal/bootstrap/first-super-admin

unset ADMIN_PASSWORD ADMIN_BOOTSTRAP_SECRET
```

Replace `http://localhost:9999` with the deployed HTTPS API origin when
bootstrapping a deployed environment. Do not add an `Origin` header; the route
rejects browser-originated requests.

A successful response is:

```json
{
  "success": true,
  "message": null,
  "response": {
    "userId": "public-user-id",
    "roles": ["SUPER_ADMIN"]
  }
}
```

Expected failures use HTTP `403` and the same safe response regardless of which
credential or availability check failed:

```json
{
  "success": false,
  "message": "First administrator bootstrap is unavailable or the supplied credentials are invalid.",
  "response": null
}
```

Malformed or non-JSON requests use HTTP `400` with the same body. Requests over
1 KiB use HTTP `413`; the operation accepts only the current password and never
needs a larger payload.

## 4. Recovering a lost SUPER_ADMIN grant

Role administration now prevents this from happening through the portal: the
last usable `SUPER_ADMIN` grant cannot be revoked, and a super administrator
cannot revoke their own. Promote a second super administrator through
`access.grantRole` as soon as bootstrap completes, and this section becomes
unnecessary.

There is deliberately no script for this. One existed, and it wrote a verified
account with grants naming no granting actor — which is the right shape for a
local database and the wrong thing to keep within reach of a deployed one. What
follows is the manual route, and its length is the point: this is not a step
anybody should take casually.

It applies if the sole account is lost some other way — a forgotten
password, or a soft deletion applied directly to the database. Sign-in requires at least
one active role, and bootstrap stays permanently closed once any historical
`SUPER_ADMIN` grant exists — including a revoked one — so this route cannot
promote a replacement. Restoring access then requires direct database access:

```sh
psql "$DATABASE_URL" -c "
  INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
  SELECT gen_random_uuid()::text, id, 'SUPER_ADMIN', 'MANUAL_RECOVERY', now()
  FROM core_user WHERE email = 'administrator@example.com'
  ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING
"
```

The `ON CONFLICT … DO NOTHING` targets the partial unique index on active
grants, so this is a no-op if an active `SUPER_ADMIN` grant already exists and
it is safe to run when unsure. Record
the recovery outside the portal: unlike every other role change, it leaves no
audit event.

## 5. Remove the temporary configuration

After success, remove both lines from the local `.env.local`. For a deployed
Worker:

```sh
npx wrangler secret delete FIRST_SUPER_ADMIN_EMAIL
npx wrangler secret delete FIRST_SUPER_ADMIN_SECRET
```

Removing the configuration reduces exposure, but it is not the one-time lock.
Role grants are retained forever, including revoked grants. Once any historical
`SUPER_ADMIN` grant exists, bootstrap can never succeed again in that database.
Revoking the first administrator therefore does not reopen this route.

## Security and audit behaviour

- The request cannot choose an email, user, or role.
- The temporary secret is checked before database lookup or password hashing.
- The current password is verified against the configured active applicant.
- The final write rechecks the email, password hash, verified/non-deleted user,
  active `APPLICANT` grant, absence of any owned enterprise, and absence of all
  historical `SUPER_ADMIN` grants.
- Concurrent requests are first-writer-wins and create only one grant.
- The `SUPER_ADMIN` grant and the `APPLICANT` revocation share one guarded
  transaction. A request that loses the race writes neither, so an account can
  never be left holding no active role and therefore unable to sign in.
- The revocation matches the person and role at write time rather than a grant
  identifier read earlier, so a grant replaced mid-request is still revoked.
- The promoted account's existing sessions are deleted in the same transaction,
  so no cookie survives the privilege change.
- Successful role-grant, role-revocation, and bootstrap audit events share the
  guarded transition.
- Bootstrap audit rows omit caller-controlled request IDs, IP labels, and user
  agents so credentials cannot be smuggled into retained history through HTTP
  headers.
- After bootstrap closes, later requests fail before memory-hard password
  verification. The guarded write still repeats the permanent-lock check so
  concurrent first attempts remain atomic.
- Passwords, configured email, bootstrap secret, password hash, and session
  credentials never enter audit metadata.
- The endpoint intentionally does not identify itself by accepting a special
  curl user agent. User-Agent values are forgeable; the two credentials and
  one-time database rule provide authorization.

Sign-in accepts any person holding at least one active role, so the promoted
administrator can sign in normally with the same email and password.

This operation does not provide account recovery or later administrator
invitations. Those capabilities must be added before administrative business
operations are publicly launched.

## Troubleshooting

The generic failure intentionally does not identify the failed condition. Check
these items locally and without printing secrets:

1. The applicant completed OTP verification.
2. The configured email exactly identifies that active applicant after trim and
   lowercase normalization.
3. The supplied password is current.
4. The configured and supplied bootstrap secrets match and contain 32 through
   512 bearer-safe ASCII characters.
5. No `SUPER_ADMIN` grant has ever existed in the target database.
6. The request uses JSON, a bearer header, no `Origin`, and the correct API URL.

Items 1, 2, and 5 can be confirmed read-only against the target database,
without touching the endpoint or any secret:

```sh
psql "$DATABASE_URL" -c "
  SELECT email,
         email_verified_at IS NOT NULL AS verified,
         deleted_at IS NULL AS active
  FROM core_user WHERE email = 'administrator@example.com';

  SELECT role, revoked_at IS NULL AS active
  FROM core_user_role_grant g JOIN core_user u ON u.id = g.user_id
  WHERE u.email = 'administrator@example.com';

  SELECT count(*) AS super_admin_grants_ever
  FROM core_user_role_grant WHERE role = 'SUPER_ADMIN';
"
```

The candidate should show `verified` and `active` as true with exactly one
active `APPLICANT` grant, and the last count must be zero — any historical
`SUPER_ADMIN` grant, revoked or not, means the route is permanently closed.
