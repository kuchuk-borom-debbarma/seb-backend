# Mission SEP web client

A browser client for the Mission SEP API, built with TanStack Start. It exists
so the programme can be demonstrated and exercised by hand rather than only
through tests and curl, and it is built to production standards — but it is a
development tool, not a deployed portal.

The Worker it talks to is the repository root; start there for what the
programme is and what each role can do.

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

The Worker reads its configuration from `.env.local`; the client needs none of
its own. See [configuring the Worker](../README.md#configuration).

### First run

The database starts empty and there is no administrator, by design. Create one
the same way a real deployment does:

1. `npm run db:setup:local` applies the canonical schema.
2. Open `/login`, choose **Create Account**, and use the address in
   `FIRST_SUPER_ADMIN_EMAIL`.
3. Read the six-digit code from the Wrangler console (see the limitation
   below) and finish signing up.
4. Run the curl promotion in the
   [bootstrap operator guide][bootstrap]. It is absent from
   GraphQL deliberately, so it can never be a screen.
5. Sign in. The account now holds `SUPER_ADMIN` alone, because bootstrap swaps
   the applicant grant rather than adding to it.

## Two build targets

| Script | Preset | Produces |
| --- | --- | --- |
| `npm run build` | `node-server` | `.output/server/index.mjs`, run with `node` |
| `npm run build:cf` | `cloudflare-module` | the same path, but a Worker module |

They are separate on purpose. The end-to-end suite runs the built artifact with
`node .output/server/index.mjs`, and a Cloudflare build exports an object with a
`fetch` handler instead — which `node` loads happily and then exits from without
ever listening. One command that means different things depending on an
environment variable would make that failure look like a flake.

### Why `wrangler.jsonc` is in this directory

Nitro's Cloudflare preset generates `.output/server/wrangler.json` by merging
the nearest wrangler config it finds walking *up* from here, and it only
overrides `main` and `assets`. Everything else in the file it finds survives.

Without [`wrangler.jsonc`](wrangler.jsonc) the walk reaches the repository root
and finds the **API Worker's** config, so the client builds as `seb-backend`
carrying the API's D1 binding, its R2 bucket, its queue producer and consumer,
and its hourly cron. Deploying that would replace the API Worker with the
server-rendered client.

That is not a theory about the code; it is what the build does with the file
removed. The file exists to be found first.

The generated config is what `wrangler` deploys, reached through a redirect at
`.wrangler/deploy/config.json`, so **deploy from this directory rather than
from `.output/server`** — that path has both a config and the redirect and
refuses as ambiguous.

`SEB_API_URL` has no value in that file yet, because the API Worker is not
deployed and there is no honest one to put there. It has to be set before the
client is, or every server-side request it makes goes nowhere.

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

- **Authentication and settings** — `/login` gives applicants and programme
  staff one role-aware sign-in screen. Applicant signup requests a code first,
  then verifies that code while choosing a password; it does not create a
  session until the applicant signs in. Signing out, including revoking every
  session from Security, returns to the public site at `/`. Account identity is
  read-only at `/settings/general`, and `/settings/security` lists signed-in
  devices with per-session and bulk revocation.
- **The applicant portal** — enterprises, starting an initial or expansion
  application, categorized enterprise and application journeys, autosave,
  evidence, validation and submission or resubmission, the timeline, the
  funding view, and the cycles an applicant can apply in.
- **Programme cycle administration** — the list, the dense policy form, and
  every transition the API exposes.
- **Programme-office dashboard and intake** — the actionable and total queue
  counts, reference lookup, latest committee meetings, capability-gated quick
  actions, one queue per page with the API's filters and ordering held in the
  address, and the application workspace: assignment, internal notes, desk
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

## Public site and two portals

The public programme site and both signed-in portals share one institution.

- **`/` — the public programme site.** The landing page, programme information,
  eligibility guidance, and links to `/login`; it requires no session.
- **`/dashboard` — the applicant portal.** Dashboard, applications,
  enterprises, and the cycles available to the applicant. Needs the
  `APPLICANT` role.
- **`/admin` — the programme office.** Dashboard, applications and committee
  meetings for every account with `STAFF_READ`, followed by administration
  links gated independently by `STAFF_WRITE`, `ROLE_INVITE`, `ROLE_ADMIN`, and
  `AUDIT_READ`.
- **Shared** — How this works at `/guide` and Settings at
  `/settings/general` and `/settings/security`, reachable from either usable
  portal. `/settings` redirects to General, and the old `/account/sessions`
  address redirects to Security so bookmarks continue to work.

Signing in lands each account in the portal its roles fit, so an officer with no
applicant grant never has to read a refusal after every sign-in. On the combined
login screen, an account that can use both portals follows the Applicant or
Administrator selection. Opening a portal you cannot use **refuses in place**
rather than redirecting: the screen names the roles the account does hold, links
to the portal it can use, and when it holds none, gives the exact sentence to
send a super administrator.

The navigation beside a refusal is the one that *works*. If an applicant opens
`/admin`, the sidebar shows the applicant portal — listing four office links
that would every one of them refuse is exactly what this interface does not do.

**Two densities, one system.** Locally bundled Inter Variable, Lucide's
16-pixel line icons, the neutral palette and every component are shared. Four
custom properties differ, set by `data-portal` on the shell:
`--page-measure`, `--body-size`, `--card-padding` and `--title-size`. An
applicant applying once in their life gets room; an officer working forty
applications a day gets density. Note that the shell — not `body` — reads
`--body-size`, because custom properties inherit downwards only.

The shell follows the interaction pattern of the
[OpenAI Platform project navigation][platform-projects] without using OpenAI
branding or assets: a 260-pixel desktop sidebar can collapse to an icon rail,
and only that presentation preference is stored. The Mission SEP portal label
acts as a switcher only for an account that can use both portals; for a
single-portal account it is static. The account button opens email, roles,
Settings, an available portal switch, and Sign out.

### Dashboards

The applicant Dashboard composes one operation from existing API fields. It
shows linked totals for applications and enterprises, the currently available
cycle count, the nearest closing time, and requested revisions before saved
drafts. The main action is chosen from live state: register an enterprise,
start an application, continue at the earliest reachable category, or view the
application list. Empty enterprise, application and open-cycle states are
stated explicitly.

### Categorized applicant forms

Enterprise registration and editing use the same four-category journey:
enterprise details, registration and tax, business location, then contact
details. Values stay in component state as the applicant moves back and forward;
the complete profile reaches GraphQL only from the last category. Nothing is
written to browser storage. Cancel confirms before discarding changed answers,
while the create or update mutation remains authoritative for uniqueness and
concurrent-edit failures.

Application setup has two categories. The first holds the enterprise and
programme cycle, and the second presents initial and expansion as described
selection cards. Expansion stays disabled unless `expansionEligibility` says it
is eligible, and all of that operation's reasons and eligible date are shown.
The draft is created only from the second category. Registration opened from
setup uses the validated `returnTo=application` context and an optional cycle
id; arbitrary return addresses are never accepted.

An application then shares one journey frame across its form, evidence and
review routes. Its ordered categories are enterprise details, about you,
project cost and funding, previous support and credit, evidence requirements,
declaration, attach evidence, and review and submit. On desktop a sticky rail
names the current, complete, blocked, error and read-only states with icons and
text. At 52rem and below it becomes a Step X of Y selector. The sticky action
footer has enough trailing clearance for 360–390 pixel screens, and the frame
inherits the portal's keyboard focus, screen-reader announcements and
reduced-motion behavior.

`/applications/$id/form?section=APPLICANT_PROFILE` is the linkable form-category
shape. Unknown section values are discarded. A plain `/form` address opens the
earliest incomplete category; complete and fully read-only forms start at the
first. Existing `/form#fieldName` bookmarks still resolve the field's category,
scroll to the control and focus it. Validation-report links are the deliberate
exception to normal forward gating: they include both `section` and the field
hash so they can open the exact later question that needs work.

Typing keeps the existing debounced autosave and stale-write protection. Next
cancels the pending timer, flushes changed answers immediately, fetches a fresh
server validation report, and advances only when the active category has no
issues. Required missing files are assigned to Attach evidence, not to the NOC
question category; they prevent moving to Review, while optional documents do
not. Revision categories outside the request are readable and marked read only,
and every category remains browsable when the whole application is read only.

The programme-office Dashboard retains the intake queue and reference lookup,
adds an actionable total and a total across the named queues, and links every
count to the matching filtered list. It reads the five latest scheduled
committee meetings from the existing connection. Quick actions are shown only
when the signed-in user's published capabilities allow them; it invents no
reporting totals or charts.

**The gates are not the security boundary.** They decide what is *offered*.
Every operation is still refused server-side by `currentApplicant` or by
`currentStaff`, which asks for the capability that operation needs.

The client asks the same question the API does — "may they do this?" — using the
capabilities published on the signed-in user, rather than matching role names.
The office holds four roles now: a screen checking for `ADMIN` would hide itself
from an approver entitled to use it, and one listing every acceptable role would
be a second copy of a policy that lives in `auth/capabilities.ts`.

A control somebody cannot use is **absent, not disabled**. A button that cannot
work should not be drawn; offering it and refusing is worse than not offering
it.

And a screen they cannot reach gets a capability refusal rather than the portal
one. "This part of Mission SEP is for the programme office" is right for an
applicant who wandered in and wrong for a reviewer, who *is* the programme
office and is standing in it — they are not in the wrong place, they are in a
room they do not have the key to.

## The guidance layer

The client is a demonstration as well as a client, so it leads people through
itself.

**How this works** (`/guide`) is kept with the shared utilities after the
portal's operational and administrative navigation. It opens
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

Three rules gained a fourth: **a route says who it is for.** Audience is a
required field on the tour itself, so a route that forgot to say cannot compile.
It used to be a lookup table beside the page that read it, keyed by a loose
string — and a tour missing from that table fell through to applicant-only and
vanished from the office with nothing failing.

**The file in hand.** Most office screens exist only for one particular
application, meeting or cycle, so their address carries an id a tour cannot
know. The guide watches the address and remembers the last one opened; a step
naming such a screen follows it. With nothing in hand the step does not
navigate at all — the rail says what to open, and offers to take you there once
you have. It never invents an id, and never picks a record at random: both
would be the demonstration lying about what it knows.

`Explain` attaches a short answer to a word whose name does not give one. It is
kept sparse — at most one per card, and only where the meaning is genuinely not
guessable, because an icon beside every label teaches nothing and doubles the
reading. One sits on the application form. Eight sit in the programme office,
which is where the vocabulary is hardest: an applicant reads "Submitted" and
knows what it means, while an officer reads two queues that both hold
`SUBMITTED` and has to be told why they are separate.

Office copy lives in `src/features/admin/officeGuidance.ts`, in one module
reviewable as copy, each entry naming the section of the
[administrator workflow guide][office] it is drawn from. It is
deliberately **not** a rendering of `features/admin/states.ts`: those doc
comments are a maintainer's gloss, uneven in coverage and free to say things a
reader should not be told. The office's description of a thing is not a
paraphrase of the applicant's — the same distinction `RouteDiagram` already
draws one level up.

The desk review asks for the numbers on the documents as the checks they
evidence are passed, so the fields appear beside the work rather than before it,
and a check that is failed withdraws its question instead of greying it out. A
value already recorded on another file is refused with the reason field that
answers it — the guidance calls that a question rather than a verdict, because
the same promoter legitimately returns for a later phase.

**Every screen opens with a lede.** `PageHeader` takes `description` for what
the screen is for and `meta` for the identity that completes the title. Three
office screens had been spending the lede slot on metadata and so had no lede
at all; folding the two together would have buried the identity in a muted
paragraph.

**The first visit knows which desk it is.** The strip is portal-aware and
remembered once per portal, because the two welcomes say different things about
different work — one key for both would silence the only line that ever explains
the second.

## Lists

Every list is cursor-paginated, filtered from the address, and reports a total.

**Search is prefix matching, and the labels say so** — "Name starts with",
"Reference or enterprise starts with", "Code starts with". The API matches an
indexed prefix, which is what makes it a range seek rather than a table scan; a
control labelled "Search" that quietly meant "starts with" would be discovered
by somebody typing a word from the middle of a name and getting nothing.

**Filters live in the URL**, so a narrowed view can be bookmarked or sent to a
colleague and comes back with the same rows. Changing a filter clears the cursor
— it points into a differently-filtered set. Search is debounced, because a
request per keystroke is both wasteful and slower to settle than one after the
pause.

**Empty means two different things** and the screens distinguish them: "Nothing
matches" with a way to clear the filters, or "Nothing here yet" with the real
first action. Knowing the total is what makes that distinction possible.

Shared controls live in `src/components/ListControls.tsx` — `SearchBox` and
`Pager`. The pager reports `1–20 of 143` rather than an unlabelled Next button,
and says "continued" past the first page because a keyset cursor cannot know
which page number it is on.

## What bounds a request

The client is built to stay well inside the server's limits — its largest
operation selects 114 fields at depth 7, and its largest request is under 16 KB,
against limits of 500, 12 and 64 KB.

Those limits, and why a document-wide field limit exists at all, belong to the
Worker: see [the GraphQL layer](../src/graphql/README.md#what-bounds-a-request).

## The quality floor

Held by tests rather than asserted in a document:

- **The guide never covers the product.** Asserted: while a tour runs, the
  screen under discussion is still visible and its controls still editable.
- **Every mark a route declares is registered on a real screen.** Asserted
  without a browser, by reading the sources: a step marking an element nobody
  registered brackets nothing, the rail polls for thirty frames and silently
  scrolls to the top instead, and the failure survives review. One step was in
  that state until the check was written.
- **Narrow screens.** Below 60rem a compact top bar opens the sidebar as a
  modal drawer. Escape and the backdrop dismiss it, focus stays inside while
  it is open and returns to the trigger afterwards, background scrolling is
  blocked, and the page body never scrolls sideways. The behavior is asserted
  at 360px and 390px.
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

That artifact and Nitro's intermediate files live under the ignored
`dev-web/.playwright/` directory. A normal `npm run build` can therefore run in
another terminal without replacing hashed assets while the suite is serving
them.

Seeding uses the product's own paths — signup, the real six-digit code read from
the Worker's output, the curl bootstrap — so the documented setup procedure
above is itself under test. If the first-administrator flow breaks, the suite
fails there with a clear message rather than mysteriously later.

## Relationship to the Worker's own checks

`dev-web` is a separate package with its own dependency tree. The Worker's
`npm run check` excludes it from TypeScript, Vitest and `fallow`, so the
backend's 100% coverage gate and dead-code analysis continue to cover only the
Worker.

See the [combined application guide][applicant] for what the
applicant screens are doing, and the
[administrator workflow guide][office] for the programme-office
side.

[bootstrap]: ../docs/first-super-admin-bootstrap.md
[office]: ../docs/admin-workflow-guide.md
[applicant]: ../docs/application-guide.md
[platform-projects]: https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects
