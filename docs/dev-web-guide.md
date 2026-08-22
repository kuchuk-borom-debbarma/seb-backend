# Development web client

`dev-web/` is a browser client for the Mission SEP API. It exists so the
programme can be demonstrated and exercised by hand rather than only through
tests and curl, and it is built to production standards — but it is a
development tool, not a deployed portal.

## The rule it is built on

**If it is on screen, it works.** There is no fixture data, no decorative
control, and no screen that cannot be driven end to end against a running
Worker. Concretely:

- Every button, link and field maps to a real GraphQL operation or route.
- Navigation mirrors capability twice over. Roles are read live, so a revoked
  role removes its section on the next navigation; and a link appears only once
  its screen exists. An entry that leads nowhere is a defect, and the
  end-to-end suite asserts it.
- Disabled and hidden states come from real data — `editableSections` decides
  which form sections are open, `expansionEligibility.reasons` decides whether
  an expansion can start.
- Money is rendered from the `Money` scalar, which is a decimal string of
  **paise**, not rupees and not a number.

## Running it

Two terminals:

```sh
npm run local                  # the Worker, on http://localhost:9999
cd dev-web && npm run local    # the client, on http://localhost:9990
```

The client's `local` script sets `SEB_API_URL` to the Worker's port, so the two
stay wired together with no further configuration.

`npm run local` reads `.dev.vars`, which is gitignored and must be created
locally. It needs:

```ini
AUTH_SECRET = "at least thirty-two bytes of local-only randomness"
AUTH_COOKIE_SAME_SITE = "lax"
FRONTEND_ORIGINS = "http://localhost:9990"
FIRST_SUPER_ADMIN_EMAIL = "founder@example.com"
FIRST_SUPER_ADMIN_SECRET = "a temporary local-only bootstrap secret"
```

Never put a production secret in that file. Production values are provisioned
as Cloudflare secrets, and the two bootstrap values are removed after use.

### First run

The database starts empty and there is no administrator, by design. Create one
the same way a real deployment does:

1. `npm run db:setup:local` applies the canonical schema.
2. Sign up at `/sign-up` with the address in `FIRST_SUPER_ADMIN_EMAIL`.
3. Read the six-digit code from the Wrangler console (see the limitation
   below) and finish signing up.
4. Run the curl promotion in the
   [bootstrap operator guide](first-super-admin-bootstrap.md). It is absent from
   GraphQL deliberately, so it can never be a screen.
5. Sign in. The account now holds `SUPER_ADMIN` alone, because bootstrap swaps
   the applicant grant rather than adding to it.

## How it reaches the API

Every operation goes through one backend-for-frontend route rather than the
browser calling the Worker directly.

The Worker issues an `HttpOnly` session cookie. The client's server forwards the
incoming cookie to the Worker and relays any `Set-Cookie` back out, so the
browser only ever sees its own origin. That means no preflight, no credentialed
CORS to keep in step, and `AUTH_COOKIE_SAME_SITE` can stay `lax`. During server
rendering the same forwarding runs in-process, so it costs one local call rather
than a round trip through our own HTTP server.

`FRONTEND_ORIGINS` is therefore not needed by this client at all. It stays
configured for anyone calling the Worker directly from a browser.

## Types come from the Worker's own schema

`npm run codegen` inside `dev-web` reads the same SDL files the Worker loads at
runtime and generates types for every operation. An operation that asks for a
field the API does not expose fails `npm run typecheck` rather than in front of
a user. Re-run it after changing anything under `src/graphql/`.

The generated output is gitignored, so run it once after cloning.

## Known limitations

These are inherited from the API and are surfaced honestly in the interface
rather than hidden:

- **Signup codes are printed to the console.** Notification delivery is a
  `console.log` transport until roadmap §18 is built, so the verify screen says
  to read the code from the Wrangler output. It does not claim an email was
  sent.
- **Uploading evidence needs R2 credentials.** `services/application/uploads.ts`
  requires `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and
  `R2_SECRET_ACCESS_KEY`. The evidence screen is built for the real flow and
  performs it: it checksums the file, asks the Worker to authorize an object,
  and would put the bytes straight into the bucket. Without credentials the
  Worker refuses at the signing step, and the screen shows what it answered.
  Note that the Worker masks that particular error — a missing configuration is
  an operator's problem and is not described to an applicant — so the message
  is the generic one, and the specific cause is in the Worker's own output.

  With a bucket configured, it must also allow `PUT` from the client's origin:
  the browser uploads directly to the presigned URL, which is the one request
  in the whole client that does not go through the backend-for-frontend.

  Everything else on that screen works without credentials — listing what is
  required, removing a document and putting it back.
- **The workspace does not report its cycle's id**, only its code. Every write
  that names a reason — releasing a claim, reassigning, requesting a correction
  — needs a reason category defined by the programme cycle, so the client finds
  the cycle by code before it can read the catalogue. That costs two extra
  cached requests. `AdminWorkspace.programmeCycleId` would remove both.
- **Scheduled work does not run.** Wrangler does not fire cron triggers in local
  development, so the session sweep and expired-upload cleanup need
  `wrangler dev --test-scheduled` and a request to `/__scheduled`.

## What is built

Built:

- **Authentication** — sign in, sign up with the console code, sign out, and
  signed-in devices with per-session and bulk revocation.
- **The applicant portal** — enterprises, starting an initial or expansion
  application, the six-section draft form with autosave, the evidence screen,
  the validation report and submission or resubmission, the timeline, the
  funding view, and the cycles an applicant can apply in.
- **Programme cycle administration** — the list, the dense policy form, and
  every transition the API exposes.
- **Intake** — the queue console with counts for every named queue, one queue
  per page with the API's filters and ordering held in the address, reference
  lookup, and the application workspace: assignment, internal notes, desk
  review, and withdrawal of a correction request.
- **Access** — exact-address lookup, the complete role history, and grant and
  revoke with the operator's own password as a step-up.

Not built yet:

- **Decisions and funding** — bank referral and outcomes, committee meetings,
  agenda and decisions, awards, releases, assessments and recovery.

A screen that is not built is not in the navigation. There are no placeholder
pages, and no control that does not do what it says.

## End-to-end tests

```sh
cd dev-web && npm run e2e
```

The suite owns its whole environment: its own Worker on port 9899 with an
isolated database that is wiped each run, and its own web server on 9880. It
never collides with `npm run local` and never reads or writes the data you are
looking at.

It runs against the built artifact rather than the dev server, because Vite's
dependency optimizer pre-bundles on first request and a cold server raced with
the first navigation leaves the page unhydrated.

Seeding uses the product's own paths — signup, the real six-digit code read from
the Worker's output, the curl bootstrap — so the documented setup procedure
above is itself under test. If the first-administrator flow breaks, the suite
fails there with a clear message rather than mysteriously later.

## Relationship to the Worker's own checks

`dev-web` is a separate package with its own dependency tree. The Worker's
`npm run check` excludes it from TypeScript, Vitest and `fallow`, so the
backend's 100% coverage gate and dead-code analysis continue to cover only the
Worker.

See the [combined application guide](application-guide.md) for what the
applicant screens are doing, and the
[administrator workflow guide](admin-workflow-guide.md) for the programme-office
side.
