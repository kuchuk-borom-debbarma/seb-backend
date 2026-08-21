# seb-backend

Cloudflare Worker API built with Hono, GraphQL Yoga, Drizzle, D1, R2, and Queues.

## Local development

The checked-in `.env.example` is intentionally empty, and `.env` stays empty and gitignored. Pass local values to Wrangler without writing an environment file:

```sh
npm install
npm run db:migrate:local
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

Apply D1 migrations before deploying a Worker version that uses them:

```sh
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

The D1, R2, and Queue bindings in `wrangler.jsonc` use Cloudflare automatic provisioning. An hourly cron removes expired signup challenges and sessions outside public request paths. `wrangler.test.jsonc` contains local-only placeholder resource metadata for the Cloudflare Vitest runtime.

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

Do not expose this version publicly until request and notification rate limiting is implemented.
