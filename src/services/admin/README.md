# Administrative service

This service implements programme-cycle governance, intake, desk review,
offline bank evidence, TTM decisions, awards, releases, assessments, and
operational recovery. The plain-language staff journey lives in the
[administrator workflow guide](../../../docs/admin-workflow-guide.md).

## Organization

- `controllers/programme-cycle.ts` validates policy input and cycle lifecycle.
- `controllers/intake.ts` owns queues, assignment, notes, scans, and desk review.
- `controllers/decision.ts` owns bank referrals/outcomes and TTM meetings,
  agendas, decisions, and append-only corrections.
- `controllers/funding.ts` owns awards, release/reversal evidence, assessments,
  and recovery.
- `queries/*` contains Drizzle reads and guarded writes.
- `document-scanner.ts` is the internal append-only scanner callback contract;
  it has no HTTP or GraphQL exposure.

GraphQL SDL remains in `.graphql` files and resolvers only delegate arguments.
There are no service classes or interfaces.

## Authorization and operation context

Every public controller calls the live administrator guard. It validates the
current D1 session and reloads active roles on every request; `ADMIN` or
`SUPER_ADMIN` succeeds. Revoking a role therefore stops the next operation even
when the browser session remains active.

The request-scoped context supplies Drizzle D1, bindings, request headers/URL,
and response headers. It is passed into each operation; no mutable request state
is stored in a singleton.

## Concurrency and bounded transitions

Mutable heads expose `current_version`, `status_version`, `assignment_version`,
or `ledger_version`. A mutation receives the version the staff member viewed.
Its first guarded statement verifies role-sensitive ownership, lifecycle, and
that version. Dependent evidence inserts use the winning state as a predicate.
D1 batches remain bounded: meetings permit at most 20 active agenda items and
scheduled cycle closing processes at most 20 cycles per run.

This design makes claims, workflow transitions, releases, reversals, and ledger
entries first-writer-wins. A stale request returns a safe failure with no partial
history. Accounting limits and recovery closure are recalculated inside the
write predicate, not trusted from an earlier application read.

Award closure requires an explicit disposition: either releases are complete
or the programme will not release the remaining sanction. An empty recovery
case opened by mistake may be cancelled with a retained reason; once it has a
ledger entry, corrections use reversals and closure requires a derived zero
balance.

## Pagination and queues

Intake and cycle lists use opaque timestamp-plus-ID cursors, default to 20, and
cap at 100. Intake reads the latest formal submission and its frozen snapshot;
drafts are excluded. Supported orderings are oldest waiting, newest submission,
and last activity. The cursor column changes with the selected ordering, so a
client must not reuse a cursor with different filters/order.

Beyond ad-hoc filters, the queue accepts a named `queue` key and
`admin.intake.queues` returns the count waiting in each one, as a single grouped
aggregate rather than one query per queue. Most keys map to a status, but new
submissions and revision responses are both `SUBMITTED` and are separated by
submission number, which is why the keys are their own vocabulary rather than a
reuse of `ApplicationStatus`. `queue` and `status` are mutually exclusive:
supplying both is refused rather than intersected into a silently empty page.

## Frozen documents and scans

Each submission pins logical document ID plus immutable file version. Staff
download uses that pin, never the current document head. The latest appended
scan for the file must be `ACCEPTED`; missing, pending, rejected, and errored
states fail closed. Only the future trusted scanner may call
`recordDocumentScanResult`. Never add a public scan-acceptance mutation.

## Transcribed identifiers and duplicate detection

A passed desk-review check also records the number on the document it was read
from (`identifiers.ts`). Without it a review is an attestation with nothing
behind it — it cannot be asked *which* certificate was seen, and so cannot be
asked whether the same one has been seen before.

- `ST_ELIGIBILITY`, `IDENTITY_KYC` and `DOCUMENT_COMPLETENESS` each require
  their number when the check is passed. A failed or not-applicable check
  requires nothing. `BUSINESS_REGISTRATION` is accepted but never demanded,
  because an unregistered enterprise has none.
- Values compare with case and separators stripped, so one certificate written
  two ways is one certificate.
- `IDENTITY_DOCUMENT` and `BANK_ACCOUNT` are stored as an HMAC digest, never in
  the clear, with the last four digits kept so a reviewer can confirm by eye.
- A value found on a different **funding case** refuses the write and names both
  the identifier and the application it was found on. The reviewer either fails
  the check or states why it is not the same claim; that answer is retained.

### Configuration

- `IDENTIFIER_SECRET` is **required** and must contain at least 32 bytes. It
  keys the digest of identity and bank numbers, and is deliberately not
  `AUTH_SECRET`: rotating session signing must never silently stop the duplicate
  check from matching what is already recorded.
- It is effectively **set once**. Every stored digest was made with it, so a new
  value stops matching everything recorded under the old one — and the check
  would then pass everything, quietly. Changing it means re-transcribing every
  document.
- It is read at first use rather than at startup, so a deployment missing it
  looks healthy until the first desk review is completed, which then fails.
  Provision it with the rest of the secrets, not afterwards.

## Safe audit construction

Audit events contain public record IDs, fixed actions/outcomes, request ID,
network metadata, and small allow-listed lifecycle values. Never put form
answers, applicant-safe messages, internal notes, correspondence, filenames,
URLs, R2 keys, checksums, money, passwords, cookies, tokens, or hashes into
audit JSON. Applicant-visible messages belong only in the appropriate workflow
event or business record.

## Tests

Run:

```sh
npm test -- test/admin.test.ts
npm test -- test/schema.test.ts
npm run test:coverage
npm run db:schema:check
```

Tests must assert business outcomes and persisted invariants: live role loss,
cycle pinning, frozen documents, scan fail-closed access, assignment and status
races, decision correction locks, release limits, utilization obligations,
assessment scoping, and recovery accounting. New controller/query/resolver code
belongs in the enforced Istanbul coverage set.

## Public-launch limitations

The first administrator signs in with the shared email/password login, which
accepts any active role. Further administrators are provisioned through the
`access` namespace in the authentication service. Invitations and account
recovery are not yet available. A production malware scanner, rate limits,
approved privacy/access rules, and resolved TTAADC ceiling/jurisdiction
decisions are also missing.
Administrative operations must not be publicly launched until those roadmap
blockers are complete.
