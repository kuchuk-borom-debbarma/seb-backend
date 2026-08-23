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
- **An agenda item does not report which meeting it is on.** The API accepts a
  committee decision only while that meeting is in session, but an application's
  workspace cannot tell whether it is — so the screen states the rule and links
  to the meetings list rather than hiding a control it cannot decide about.
  `AdminAgendaItem.meetingId` would let it.
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
- **Decisions** — referral to a partner bank, recording and correcting its
  outcome, committee meetings with their agendas, and recording and correcting
  a committee decision.
- **Funding** — issuing the sanction order, the award ledger, releasing a
  payment with every prerequisite the API demands, reversing one, assessments,
  amending or closing an award, and recovery cases with their own ledger and
  balance.

Every operation the GraphQL schema exposes now has a screen.

A screen that is not built is not in the navigation. There are no placeholder
pages, and no control that does not do what it says.

## The whole programme, end to end

`e2e/journey.spec.ts` carries one application from signup to money in the bank:
submission, claim, desk review, referral to a partner bank, the bank's outcome,
a committee agenda and decision, the sanction order, and a payment — then signs
back in as the applicant and checks they can see their own award, and that
nothing the office keeps to itself has leaked into it.

It reaches all of that without a storage bucket by opening a cycle whose
document rules are all `OPTIONAL`. That is a legitimate policy the API accepts,
not a fixture: an application in such a cycle genuinely requires no files. Every
other cycle in the suite keeps the ordinary rules.

## Two portals

The client is two portals sharing one institution.

- **`/` — the applicant portal.** Overview, enterprises, applications and the
  cycles you can apply in. Needs the `APPLICANT` role.
- **`/admin` — the programme office.** Intake, committee meetings, cycle
  administration, and role management at `/admin/access`. Needs `ADMIN` or
  `SUPER_ADMIN`; the access screen needs `SUPER_ADMIN` specifically.
- **Shared** — `/guide` and `/account/sessions`, reachable from either.

Signing in lands each account in the portal its roles fit, so an officer with no
applicant grant never has to read a refusal after every sign-in. Opening a
portal you cannot use **refuses in place** rather than redirecting: the screen
names the roles the account does hold, links to the portal it can use, and when
it holds none, gives the exact sentence to send a super administrator.

The navigation beside a refusal is the one that *works*. If an applicant opens
`/admin`, the sidebar shows the applicant portal — listing four office links
that would every one of them refuse is exactly what this interface does not do.

**Two densities, one system.** The palette, the three faces and every component
are shared. Four custom properties differ, set by `data-portal` on the shell:
`--page-measure`, `--body-size`, `--card-padding` and `--title-size`. An
applicant applying once in their life gets room; an officer working forty
applications a day gets density. Note that the shell — not `body` — reads
`--body-size`, because custom properties inherit downwards only.

**The gates are not the security boundary.** They decide what is *offered*.
Every operation is still refused server-side by `currentApplicant`,
`currentAdministrator` or the super-admin check.

## The guidance layer

The client is a demonstration as well as a client, so it leads people through
itself.

**How this works** (`/guide`) is the first entry in the navigation. It opens
with the route a file takes: all eleven states, each placed under the desk that
holds it — applicant, programme office, partner bank, committee — numbered in
the order they happen. The office's description of each stop is this screen's
own; the applicant's plain-language wording is quoted beneath it from the API's
status guide, where the account is allowed to read it. That surface is
deliberately behind the applicant guard, so an administrator sees one and not
the other, and the page says which is which.

**Guided routes** walk the real screens. A route is a sequence of steps, each
with the desk that holds the work, a sentence about what happens, and where it
happens. Starting one docks a companion rail in a column of its own — the page
narrows, it does not disappear. A step that is about a particular control draws
a clay bracket in the margin beside it rather than dimming everything else: a
demonstration that hides the product to explain the product has it backwards.

Three rules the layer keeps:

- **Nothing is simulated.** Every step names a route that exists. A step that
  needs data the demonstration may not have says so under "To try this" instead
  of telling somebody to click a control that is not there.
- **Only what this account can do.** Routes are filtered by role, and the page
  states how many were withheld rather than silently omitting them.
- **It can be left.** Progress is remembered, so an interrupted demonstration
  carries on where it stopped, and ending a tour ends it for good.

`Explain` attaches a short answer to a question whose name does not give one.
Used once on the application form, on purpose — an icon beside every label
teaches nothing and doubles the reading.

## The quality floor

Held by tests rather than asserted in a document:

- **The guide never covers the product.** Asserted: while a tour runs, the
  screen under discussion is still visible and its controls still editable.
- **Narrow screens.** Below 60rem the sidebar becomes a bar across the top. The
  bar takes its own content height, wide content scrolls inside its own
  container, and the page body never scrolls sideways — all three are asserted
  at 360px.
- **Keyboard.** Every control is reachable by Tab and lands with a visible focus
  ring; nothing traps focus.
- **Reduced motion.** The stylesheet neutralizes animation and smooth scrolling,
  and the one place that scrolls from JavaScript reads the preference — an
  explicit `behavior` option overrides the stylesheet, so it has to.

## Formatting

`.prettierrc.json` pins the style the code was written in — single quotes, no
semicolons, 90 columns. It exists because Prettier's defaults are the opposite
on two of those, so running it without a config rewrites every file it touches
and buries the real change in a reformat.

```sh
npm run format        # write
npm run format:check  # verify
```

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
