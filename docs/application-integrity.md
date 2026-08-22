# Application integrity and failure recovery

This guide explains the non-obvious safeguards behind applicant application
transitions. It complements the broader [application guide](application-guide.md):
that guide describes the business journey, while this one describes how the
implementation remains correct when requests overlap or external storage
temporarily fails.

## The core pattern: explain first, guard at write time

Controllers perform readable checks so they can return useful client messages.
Those checks are not the final authority because another request can change D1
between the read and the write. Every important transition therefore repeats
its decisive conditions in the guarded SQL executed by the atomic D1 batch.

For example, expansion creation first calculates eligibility for a clear
response. Its insert guard then verifies the same award, phase, sanction facts,
net disbursement, and first retained release immediately before inserting. A
concurrent reversal or award suspension makes the guarded statement affect no
rows, and the whole transition is treated as a conflict.

Soft-delete, restore, and document state changes also write a uniquely keyed
audit event as the transition claim. Other statements in the batch depend on
that claim. This turns a zero-row optimistic update into a detectable conflict
instead of allowing a partial success.

## Draft restoration

Deleting a draft releases its place in the active application chain. Restoring
it is therefore a new eligibility decision, not merely clearing `deleted_at`.
The guarded restore requires all of the following to still be true:

- the enterprise belongs to the applicant and is not deleted;
- its funding case exists, is open, and is not deleted;
- no other non-rejected, non-deleted application occupies the same phase;
- for an expansion, its qualifying-award link can be reclaimed atomically;
- the award is active, belongs to the same case, and belongs to the immediately
  preceding phase; and
- the award still has the exact positive net disbursement and first retained
  release that the controller evaluated.

Consequently, an old phase-1 draft cannot be restored after a replacement has
started, and an expansion cannot be restored using eligibility invalidated by a
reversal. Initial drafts use the same parent and competing-phase safeguards even
though they have no qualifying award.

## Expansion evidence

Expansion eligibility is derived from authoritative award and ledger records;
applicant-supplied prior-award values are never trusted.

```text
net disbursed = total RELEASE amounts - total REVERSAL amounts
```

The relevant anniversary starts at the earliest release that still retains a
positive amount after its reversals. Eligibility begins when that release's UTC
calendar anniversary plus the target cycle’s pinned waiting period has passed. This is calendar arithmetic,
not a fixed number of milliseconds.

The atomic guard pins both the calculated net amount and that exact release
timestamp. Checking both matters: a concurrent release and reversal could leave
the same total while changing which release establishes the anniversary. Draft
saves and formal submissions repeat this evidence check so a previously valid
expansion cannot proceed on stale financial history.

Expansion loads the target cycle’s pinned assessment rules. Every positively
retained release must have a latest passed utilization result, while the award
must have latest passed performance and financial-audit results when required.
Each unmet result is reported separately; a query refactor must not silently
weaken these gates.

## Signed R2 uploads

The upload-intent request validates the declared file size before issuing a URL.
The presigned PUT then binds these values into the AWS signature:

- `Content-Length` (maximum 10 MB);
- `Content-Type` (PDF, JPEG, or PNG);
- `Content-Disposition`;
- `If-None-Match: *`; and
- `x-amz-checksum-sha256`.

`aws4fetch` is configured with `allHeaders: true` because its default signing
policy excludes content headers. Without that option, a client could send a
different body length while retaining a valid URL. Browser code must upload a
`Blob` of the declared size; browsers derive `Content-Length` from the body and
do not allow JavaScript to set that header manually.

Finalization does not trust the signed request alone. It reads object metadata
and bytes from the private bucket and verifies ownership, intent state, expiry,
size, MIME type, SHA-256 checksum, and PDF/JPEG/PNG magic bytes before atomically
creating the immutable document version.

## Retryable cleanup

Cleanup uses a claim-before-delete state machine:

```text
ISSUED -> CLEANUP_PENDING -> EXPIRED
REJECTED -> CLEANUP_PENDING -> REJECTED
```

Claiming prevents finalization from racing object deletion. If an R2 delete
fails, that intent remains `CLEANUP_PENDING` for a later retry. The worker logs
only the public upload-intent ID, never the object key. Each object is handled
independently, so one failed delete does not prevent the rest of the bounded
cleanup batch from progressing.

## Regression cases that must remain covered

Tests should continue proving these outcomes:

- an initial draft cannot be restored after a replacement starts or its parent
  enterprise is deleted;
- expansion creation, save, submission, and restoration fail when award or
  ledger evidence changes concurrently;
- a signed PUT includes `content-length` in `X-Amz-SignedHeaders`;
- finalization rejects size, MIME, checksum, and magic-byte mismatches;
- a failed R2 cleanup leaves that intent retryable and continues with later
  intents; and
- unsuccessful guarded transitions leave no partial version, event, document,
  or audit records.

Run the complete enforced suite before changing these paths:

```sh
npm run check
git diff --check
npx wrangler deploy --dry-run
```

## Deliberate limits

These safeguards do not replace rate limiting, malware scanning, administrator
authorization, or a production notification transport. Those remain separate
features. Until rate limiting and malware scanning exist, this backend and its
document-download paths must not be exposed publicly.
