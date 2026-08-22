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

The selected person keeps `APPLICANT`, so their final active roles are normally
`APPLICANT` and `SUPER_ADMIN`.

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
`.env` file:

```dotenv
FIRST_SUPER_ADMIN_EMAIL=administrator@example.com
FIRST_SUPER_ADMIN_SECRET=replace-with-the-generated-value
```

`.env.example` intentionally remains empty. Never commit `.env`.

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
read -rsp "Applicant password: " ADMIN_PASSWORD
echo
read -rsp "Bootstrap secret: " ADMIN_BOOTSTRAP_SECRET
echo

jq -n --arg currentPassword "$ADMIN_PASSWORD" '{currentPassword: $currentPassword}' \
  | curl --fail-with-body --silent --show-error \
      --request POST \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $ADMIN_BOOTSTRAP_SECRET" \
      --data-binary @- \
      http://localhost:8787/internal/bootstrap/first-super-admin

unset ADMIN_PASSWORD ADMIN_BOOTSTRAP_SECRET
```

Replace `http://localhost:8787` with the deployed HTTPS API origin when
bootstrapping a deployed environment. Do not add an `Origin` header; the route
rejects browser-originated requests.

A successful response is:

```json
{
  "success": true,
  "message": null,
  "response": {
    "userId": "public-user-id",
    "roles": ["APPLICANT", "SUPER_ADMIN"]
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

## 4. Remove the temporary configuration

After success, remove both lines from the local `.env`. For a deployed Worker:

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
  active `APPLICANT` grant, and absence of all historical `SUPER_ADMIN` grants.
- Concurrent requests are first-writer-wins and create only one grant.
- Successful role and bootstrap audit events share the guarded transition.
- Bootstrap audit rows omit caller-controlled request IDs, IP labels, and user
  agents so credentials cannot be smuggled into retained history through HTTP
  headers.
- After bootstrap closes, later requests fail before memory-hard password
  verification. The guarded D1 write still repeats the permanent-lock check so
  concurrent first attempts remain atomic.
- Passwords, configured email, bootstrap secret, password hash, and session
  credentials never enter audit metadata.
- The endpoint intentionally does not identify itself by accepting a special
  curl user agent. User-Agent values are forgeable; the two credentials and
  one-time database rule provide authorization.

This operation does not provide administrator-only sign-in, MFA, account
recovery, or later administrator invitations. Those capabilities must be added
before administrative business operations are publicly launched.

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
