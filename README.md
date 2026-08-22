# seb-backend

Cloudflare Worker API built with Hono, GraphQL Yoga, Drizzle, D1, R2, and Queues.

## Local development

The checked-in `.env.example` is intentionally empty. `.env` is gitignored and
may contain local-only secrets such as the temporary first-administrator
bootstrap values; never commit it. Regular local values may also be passed to
Wrangler without writing an environment file:

```sh
npm install
npm run db:setup:local
npx wrangler dev \
  --var AUTH_SECRET:replace-with-a-long-random-secret \
  --var FRONTEND_ORIGINS:http://localhost:3000
```

GraphQL is served at `http://localhost:8787/graphql`. Applicant authentication
uses GraphQL. The one-time first-super-administrator promotion is deliberately
available only through a direct curl endpoint documented below.

Useful checks:

```sh
npm run typecheck
npm test
npm run check
npx wrangler deploy --dry-run
```

## Development web client

`dev-web/` is a browser client covering the API, used to demonstrate and
exercise the programme by hand. It is a development tool, but it is not a mock:
every control maps to a real operation, and nothing appears on screen that does
not work.

```sh
npm run local                  # the Worker, on http://localhost:9999
cd dev-web && npm run local    # the client, on http://localhost:9990
```

It is a separate package with its own dependency tree, excluded from this
package's TypeScript, Vitest and `fallow` runs. See the
[development web client guide](docs/dev-web-guide.md) for first-run setup, the
session-forwarding design, and its end-to-end suite.

`npm run check` runs the typecheck, the coverage suite at a 100% threshold,
`fallow --type-aware`, and the D1 schema drift check. Duplication analysis is
configured with `minOccurrences: 3`: a *pair* of structurally parallel functions
— create/update, record/correct — is context-specific rather than copy-paste,
while a third copy is worth consolidating and still fails the check.

## Cloudflare configuration

Provision production values through Cloudflare rather than the empty env files:

```sh
npx wrangler secret put AUTH_SECRET
npx wrangler secret put FRONTEND_ORIGINS
npx wrangler secret put APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT
npx wrangler secret put AUTH_COOKIE_SAME_SITE
```

The first administrator temporarily also requires:

```sh
npx wrangler secret put FIRST_SUPER_ADMIN_EMAIL
npx wrangler secret put FIRST_SUPER_ADMIN_SECRET
```

Remove both values immediately after a successful bootstrap.

- `AUTH_SECRET` is required. It keys challenge, OTP, and session-token HMAC digests.
- `FRONTEND_ORIGINS` is a comma-separated allowlist used for credentialed CORS and origin validation.
- `APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT` is optional, defaults to `5`, and must be an integer from `1` through `20`.
- `AUTH_COOKIE_SAME_SITE` is optional and defaults to `lax`. `none` is accepted only for HTTPS requests and produces Secure cookies.

Initialize a new remote D1 database from the base schema before deploying:

```sh
npx wrangler d1 execute DB --remote --file=database/schema.sql
npm run deploy
```

The D1, R2, and Queue bindings in `wrangler.jsonc` use Cloudflare automatic provisioning. An hourly cron marks pending signup challenges as expired and hard-deletes expired sessions outside public request paths. `wrangler.test.jsonc` contains local-only placeholder resource metadata for the Cloudflare Vitest runtime.

## Database domains

Drizzle tables are grouped by responsibility under `src/db/schema`:

- `core` owns reusable users, transient sessions, signup challenges, and the shared audit trail.
- `seb` owns enterprises, programme cycles, funding cases, versioned
  applications/submissions/documents, administrative review and decisions,
  awards, releases, assessments, and recovery.

Physical SQLite table names use the same `core_` and `seb_` prefixes. Business records and signup challenges are retained through lifecycle or soft-deletion fields; sessions are deliberately hard-deleted on sign-out, revocation, and expiry. Version rows, submissions, audit/workflow events, disbursements, and assessments are append-only service contracts.

The checked-in `database/schema.sql` file is the canonical baseline for an empty database. It is intentionally not an incremental migration or an upgrade path for an existing deployment.

Read the [schema guide](src/db/schema/README.md) for persistence design and the
[combined application guide](docs/application-guide.md) for the complete
business journey, API behavior, validation, R2 flow, assumptions, and examples.

## Applicant authentication

Signup and session operations are under the GraphQL `auth` namespace
and return a typed envelope with `success`, optional `message`, and an
operation-specific `response`. Expected authentication failures remain in that
envelope; malformed GraphQL documents and unexpected faults use GraphQL errors.
The one-time administrator bootstrap is the documented direct-HTTP exception.

```graphql
mutation StartSignup {
  auth {
    startApplicantSignup(input: { email: "applicant@example.com" }) {
      success
      message
      response {
        challengeToken
        expiresAt
      }
    }
  }
}
```

The console external-notification service prints the six-digit OTP during development. Only HMAC digests of OTPs and challenge tokens are stored. Signup grants `APPLICANT` and does not create a session. Password sign-in accepts any person holding at least one active role, so an administrator who is not an applicant signs in through the same operation; it creates an HttpOnly browser-session cookie while the D1 session expires after seven days.

## Role administration

After the one-time bootstrap, a super administrator provisions and demotes
further administrators under the GraphQL `access` namespace. Grant and revoke
cover `ADMIN` and `SUPER_ADMIN` only, each requires a fresh password
confirmation and a retained reason, and the last usable `SUPER_ADMIN` grant
cannot be revoked. See the
[administrator RBAC guide](docs/admin-rbac.md#role-administration).

Focused implementation guides:

- [Mission SEP product roadmap](docs/ROADMAP.md)
- [Development web client](docs/dev-web-guide.md)
- [First super administrator bootstrap](docs/first-super-admin-bootstrap.md)
- [Authentication service](src/services/auth/README.md)
- [External notification service](src/services/external-notification/README.md)
- [Applicant application service](src/services/application/README.md)
- [Mission SEP business and technical guide](docs/application-guide.md)
- [Application integrity and failure recovery](docs/application-integrity.md)
- [Administrator identity and fixed-role RBAC](docs/admin-rbac.md)
- [Administrator workflow](docs/admin-workflow-guide.md)
- [TTAADC policy alignment](docs/policy-alignment.md)
- [Administrative service](src/services/admin/README.md)
- [Database schema](src/db/schema/README.md)

Do not expose this version publicly until request and notification rate limiting is implemented.
