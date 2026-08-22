# Applicant application service

This service implements the applicant-owned part of Mission SEP. It is split
into direct exported controller functions and Drizzle query functions; there is
no service class or dependency-injection interface.

## Responsibilities

- `controllers/enterprise.ts` owns enterprise create, edit, soft-delete, and
  restore use cases.
- `controllers/application.ts` owns cycle discovery, initial and expansion
  starts, full-snapshot draft saves, validation, submission, resubmission, and
  the applicant timeline.
- `controllers/document.ts` owns private R2 upload intents, finalization,
  download authorization, logical deletion, restoration, and cleanup.
- `queries/*` contain Drizzle persistence. Race-sensitive transitions use
  guarded writes inside bounded D1 batches.
- `validation.ts` normalizes drafts and applies submission rules.
- `uploads.ts` signs R2 requests and verifies finalized object metadata and
  magic bytes.

Resolvers in `src/graphql/resolvers/seb` only map GraphQL arguments to these
functions. Every operation receives a request-scoped context containing D1,
R2, request headers/URL, and response headers.

## Important invariants

- Every operation requires an authenticated, non-deleted `APPLICANT`.
- IDs are always checked through an ownership-scoped query.
- Draft saves replace the complete snapshot. Omitted nullable keys are invalid;
  explicit `null` clears a value.
- Enterprise and application versions are immutable. A no-op save reuses the
  current version.
- Optimistic `current_version` and `status_version` predicates make concurrent
  mutations first-writer-wins.
- Multi-row state changes use D1 batches and make dependent statements
  conditional on the guarded root write.
- Applicants can change only `DRAFT` data, or sections named by unresolved
  revision requests while status is `REVISION_REQUIRED`.
- Draft creation and validation use the immutable cycle version pinned at
  start; later cycle guidance cannot rewrite older eligibility rules.
- Formal submissions pin the exact form and logical-document file versions.
  Replacing a current file cannot alter evidence already sent to staff.
- Resubmission clears the former assignment and returns to intake.
- Expansion applies target-cycle assessment rules to every retained release’s
  utilization and to award-level performance and financial audit.
- Audit metadata contains only public IDs and allow-listed lifecycle values. It
  never contains form data, filenames, R2 keys, URLs, or checksums.

## R2 configuration

The private `STORAGE` bucket binding is used for object inspection and cleanup.
Presigned browser URLs additionally require `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Use bucket-scoped credentials
that can access only the application-document bucket.

Bucket CORS must allow the frontend origins, `PUT` and `GET`, and the signed
headers `Content-Type`, `Content-Disposition`, `If-None-Match`, and
`x-amz-checksum-sha256`. Do not make the bucket public. Download URLs last five
minutes and force attachment disposition.

Uploads are limited to PDF, JPEG, or PNG and 10 MB. Finalization appends a
`PENDING` scan result for the immutable file. The signed PUT binds content
length, MIME, SHA-256, and `If-None-Match: *`; finalization independently verifies
size, MIME, checksum, and file signature. Browsers generate `Content-Length`
from the request body, so the frontend must upload a Blob of the declared size
instead of attempting to set that forbidden header manually. A fail-closed
administrator download guard exists, but a production scanner is not connected;
staff access must remain disabled for public deployment until it is connected.

Expired/invalid intents are first changed to `CLEANUP_PENDING`. That state
prevents finalization while allowing cron to retry an R2 deletion that failed.
The row also retains whether cleanup must end in `EXPIRED` or `REJECTED`, so a
retry cannot erase why the upload was discarded.
A deletion failure leaves only that intent pending; cleanup continues through
the rest of the bounded batch and retries the failed intent on a later run.

## Deliberate exclusions

Programme-cycle administration, reviewer revisions, bank/TTM decisions,
awards, disbursements, assessments, and recovery now live in the administrator
service. Notifications, idempotency storage, rate limiting, production malware
scanning, admin-only sign-in, and MFA remain excluded.

See the [combined application guide](../../../docs/application-guide.md) for the
business journey, examples, entity glossary, field rules, and GraphQL usage.
The [administrator workflow guide](../../../docs/admin-workflow-guide.md)
explains what follows submission, while the
[policy crosswalk](../../../docs/policy-alignment.md) records source differences.
The focused [integrity guide](../../../docs/application-integrity.md) documents
the guarded-write, restoration, expansion-evidence, signed-upload, and cleanup
guarantees that must remain true during concurrent requests and R2 failures.
