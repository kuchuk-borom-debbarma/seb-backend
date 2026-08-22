# seb-backend

Cloudflare Worker API built with Hono, GraphQL Yoga, Drizzle, D1, R2, and Queues.

## Local development

The checked-in `.env.example` is intentionally empty, and `.env` stays empty and gitignored. Pass local values to Wrangler without writing an environment file:

```sh
npm install
npm run db:setup:local
npx wrangler dev \
  --var AUTH_SECRET:replace-with-a-long-random-secret \
  --var FRONTEND_ORIGINS:http://localhost:3000
```

GraphQL is served at `http://localhost:8787/graphql`. Authentication is exposed only through GraphQL.

Useful checks:

```sh
npm run typecheck
npm test
npm run check
npx wrangler deploy --dry-run
```

## Cloudflare configuration

Provision production values through Cloudflare rather than the empty env files:

```sh
npx wrangler secret put AUTH_SECRET
npx wrangler secret put FRONTEND_ORIGINS
npx wrangler secret put APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT
npx wrangler secret put AUTH_COOKIE_SAME_SITE
```

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
- `seb` owns enterprises, programme cycles, long-lived funding cases, versioned applications, submissions, documents, workflow history, awards, disbursements, and assessments.

Physical SQLite table names use the same `core_` and `seb_` prefixes. Business records and signup challenges are retained through lifecycle or soft-deletion fields; sessions are deliberately hard-deleted on sign-out, revocation, and expiry. Version rows, submissions, audit/workflow events, disbursements, and assessments are append-only service contracts.

The checked-in `database/schema.sql` file is the canonical baseline for an empty database. It is intentionally not an incremental migration or an upgrade path for an existing deployment.

Read the [schema guide](src/db/schema/README.md) for persistence design and the
[combined application guide](docs/application-guide.md) for the complete
business journey, API behavior, validation, R2 flow, assumptions, and examples.

## Applicant authentication

All operations are under the GraphQL `auth` namespace and return a typed envelope with `success`, optional `message`, and an operation-specific `response`. Expected authentication failures remain in that envelope; malformed GraphQL documents and unexpected faults use GraphQL errors.

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

The console external-notification service prints the six-digit OTP during development. Only HMAC digests of OTPs and challenge tokens are stored. Signup does not create a session; password sign-in creates an HttpOnly browser-session cookie while the D1 session expires after seven days.

Focused implementation guides:

- [Applicant authentication service](src/services/auth/README.md)
- [External notification service](src/services/external-notification/README.md)
- [Applicant application service](src/services/application/README.md)
- [Mission SEP business and technical guide](docs/application-guide.md)
- [Application integrity and failure recovery](docs/application-integrity.md)
- [Administrator identity and fixed-role RBAC](docs/admin-rbac.md)

Do not expose this version publicly until request and notification rate limiting is implemented.
