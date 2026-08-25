# Storage service

Where an applicant's documents are kept, and who receives the bytes.

The programme needs three things from storage: authorize an upload the browser
performs itself, authorize a download, and answer questions about an object that
arrived. That is the whole interface, and it names no vendor — S3, R2, Azure and
Google all satisfy it, and so does this Worker.

## What it assumes

- **The environment is told what it is.** `ENVIRONMENT` unset means a
  developer's machine, because a deployed one is always configured.
- **It knows nothing about programme documents.** Which content types are
  acceptable, how large a file may be, what a filename may contain — all of that
  is the application service's, and stays there. This service takes a MIME type
  as a plain string and does not care what it is.
- **The caller has already decided the upload is allowed.** Ownership, lifecycle
  and version checks happen before anything here is called.
- **An object is immutable once written.** Nothing here replaces or edits one; a
  new document version is a new object.

## Three backends, differing in one thing

| | Receives the upload | Needs | Selected when |
| --- | --- | --- | --- |
| `local` | this Worker, which writes to the `STORAGE` binding | nothing | `ENVIRONMENT` is unset or `local` |
| `r2` | the bucket, straight from the browser | the four `R2_*` values | deployed, and `STORAGE_TRANSPORT` is unset or `r2` |
| `cloudinary` | this Worker, which relays to the provider | the three `CLOUDINARY_*` values | deployed, and `STORAGE_TRANSPORT` is `cloudinary` |

All three return the same grant shape, so the client cannot tell which it is
talking to. Only the host in the URL differs. `STORAGE_TRANSPORT` defaults to
`r2` so an environment already configured for it does not change store by
upgrading, and refuses any other value rather than picking one.

**Why Cloudinary relays rather than granting.** Its upload API takes a signed
multipart `POST` — signed *form fields*, not a signed URL with headers. A
direct-to-provider grant would therefore change `UploadGrant` and every client
that follows it, so the bytes come here instead and this forwards them. The cost
is bounded: a document is held in memory once, and the programme caps one at
2 MB.

**Why its objects are `authenticated`.** A default Cloudinary upload is served
to anyone who knows the URL. This evidence includes identity and bank documents,
so assets are stored as `authenticated` and downloads are relayed too — no
Cloudinary URL, signed or otherwise, ever reaches a browser.

**Why the local one exists.** Signing addresses `r2.cloudflarestorage.com` for
real, so the direct-to-bucket path needs credentials and a bucket. The `STORAGE`
binding does not: the development runtime provides it with no account feature
and no keys. So locally the bytes come here and this writes them, and uploads
work on a machine that has nothing configured.

## How each operation flows

### `authorizeUpload` — where the browser should send the file

| | |
| --- | --- |
| **Entry** | `storage(env, requestUrl).authorizeUpload(request)` |
| **Guard** | none; the caller has already decided |
| **Refuses** | a deployed environment missing any of the four `R2_*` values |
| **Writes** | nothing |
| **Fails** | `R2 signing configuration is required.` |

Deployed, the signature binds `Content-Type`, `Content-Disposition`,
**`Content-Length`**, `If-None-Match: *` and `x-amz-checksum-sha256`, signed
with `allHeaders: true` because these are security constraints rather than
hints. Binding the length makes the bucket reject a payload differing from the
applicant's declaration — browsers generate that header from the body, so a
caller sends a body of exactly that size rather than trying to set it.

### `authorizeDownload` — a link that expires

Valid five minutes, and **always forced to attachment**. The disposition is
overridden on every signed `GET` so even an object stored without disposition
metadata stays attachment-only. A PDF or an image rendered inline is a
script-execution surface on the portal's own origin.

### `describe` and `readPrefix` — what arrived

`describe` reports size, content type and checksum; `readPrefix` returns the
first bytes. Both report rather than judge: deciding whether an object is
acceptable is a programme rule, and it lives in
[`application/uploads.ts`](../application/README.md). This is what lets the
application check a file without ever holding a bucket.

### The relaying route — receiving bytes

`route.ts` accepts the `PUT` when the selected backend relays rather than
sending the browser to a provider — `local` and `cloudinary`.

| | |
| --- | --- |
| **Entry** | `handleLocalStorageRequest(request, { db, env })` |
| **Guard** | **refuses unless the selected backend relays** |
| **Refuses** | an unknown or spent upload id, a size or type that disagrees, a checksum that does not match |
| **Writes** | one object, through `objectStore` — the `STORAGE` binding, or the provider |
| **Fails** | `403` for an unusable authorization, `400` for a payload that disagrees |

That first check is the entire security boundary of the file. It comes first and
there is no way past it — a deployed environment sends the browser to the
bucket, and this path must never become a second way in.

Authorization is possession of the upload id, exactly as it is possession of a
signed URL. A missing intent and a spent one are refused identically, so the
path cannot be used to discover which ids exist.

**The declared length is checked before the body is read.** Reading first and
measuring afterwards means an oversized payload has already been held in memory
by the time it is rejected. A streamed body declares nothing, so the buffered
length is measured too — that is what actually binds it.

It verifies the SHA-256 digest and stores it against the object, which is what
the bucket would do. Without that a document would verify locally and fail once
deployed, which is the worst kind of difference to have.

## Exports

| Symbol | File | Does |
| --- | --- | --- |
| `storage` | `index.ts` | The backend for this environment |
| `usesLocalStorage` | `index.ts` | Whether documents are kept by the Worker itself |
| `relaysThroughWorker` | `index.ts` | Whether uploads arrive here rather than at the provider |
| `objectStore` | `index.ts` | Where the relaying route puts and gets the bytes |
| `UPLOAD_TTL_SECONDS` | `policy.ts` | How long an upload authorization lasts |
| `StorageBackend`, `UploadGrant`, `DownloadGrant`, `UploadRequest`, `ObjectFacts`, `RequiredHeader` | `types.ts` | The interface and its shapes |
| `handleLocalStorageRequest` | `route.ts` | Receives bytes locally; closed everywhere else |
| `StorageRouteContext` | `route.ts` | The little the route needs — one row, one object |
| `r2Transport`, `requireR2Configuration` | `transports/r2.ts` | The only file that knows R2 exists |
| `localTransport` | `transports/local.ts` | The Worker standing in for a bucket |
| `cloudinaryTransport`, `cloudinaryObjectStore`, `requireCloudinaryConfiguration` | `transports/cloudinary.ts` | The only file that knows Cloudinary exists |
| `attachmentHeader`, `base64FromBytes`, `DOWNLOAD_TTL_SECONDS`, `LOCAL_STORAGE_PATH` | `policy.ts` | How an object is served |

## Elsewhere

- [Application service](../application/README.md) — the upload rules: types,
  size, filenames, magic bytes
- [Code rules](../../../docs/rules/code.md) — the transport-service shape
- [Security rules](../../../docs/rules/security.md) — why object keys are never
  logged, and what a public route must state
- [`.env.example`](../../../.env.example) — the four `R2_*` values
