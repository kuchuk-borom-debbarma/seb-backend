# Security

The standing decisions about what this portal protects and how, so that each one
is written down once rather than rediscovered in the file that happens to
enforce it.

Every rule names what made it necessary.

## What must never reach a log

The repository is public and its CI output is readable by anyone. These are
never logged, on any path, including failures:

| Never logged | Because |
| --- | --- |
| One-time codes and message bodies | The code is the credential; the body contains it |
| Role-invitation tokens | The token *is* the authority to become staff |
| Object keys | A storage identifier is enough to ask for a file |
| Provider tokens and authorization headers | Self-evident, and easy to include by accident |
| Full recipient addresses | Personal data, and it identifies the mailbox to attack |

**The subtle half is errors.** A rejected `fetch` carries the request it was
making, and a provider's error body can echo the request straight back —
recipient, subject, and the one-time code. So a transport failure throws a
message naming the status and nothing else:

```
The notification provider did not accept the message (401).
```

and callers log the fact rather than the error object.
[`auth/controllers/auth.ts`](../../src/services/auth/controllers/auth.ts) says
so at the one place it happens. Tests assert the thrown message contains
neither the key, the recipient, nor the code.

## Secrets are separated by purpose

Three secrets exist and none is a synonym for another:

| Secret | Keys | Rotating it |
| --- | --- | --- |
| `AUTH_SECRET` | session and challenge signing | signs everybody out |
| `IDENTIFIER_SECRET` | the digest of transcribed identity numbers | **stops the duplicate check matching anything already recorded**, silently |
| `ROLE_INVITE_SECRET` | sealed role invitations | invalidates outstanding invitations; recoverable by reissuing |

They are separate precisely so that rotating one does not do the others' damage.
`IDENTIFIER_SECRET` is the dangerous one: it is effectively set once, because
every stored digest was made with it, and a new value makes the duplicate check
pass everything.

Deployed environments take secrets from `wrangler secret put`, never from a
checked-in file. `.env.example` holds names and never a value.

## Guards fail closed

- A missing configuration **refuses** rather than falling back to something
  weaker. A deployed environment with no notification key cannot send, so signup
  fails and says so — it does not print the code to a log instead.
- A scanner that cannot examine a file never reports it clean. Administrative
  download stays shut until an `ACCEPTED` result exists.
- Where a permissive implementation is deliberately allowed — `local` and
  `develop` have no malware scanner — **production refuses at construction**, so
  the permissive one cannot ship unnoticed. Failing when the Worker starts is
  loud; failing when the first document arrives is not.

## A public route states its whole trust basis at the top of its own file

Three routes are reachable without a session, and each one says, in its own
header comment, exactly what is standing between it and the world:

- **`/internal/bootstrap/first-super-admin`** — a bearer secret, an `Origin`
  check that denies browsers, and a permanent close once any `SUPER_ADMIN` grant
  has ever existed.
- **`/internal/storage/*`** — refuses unless the local storage backend is the
  selected one. That check is the entire security boundary, it comes first, and
  there is no way past it. A deployed environment sends the browser to the
  bucket, and this path must never become a second way in.
- **`acceptRoleInvite`** — takes no session by design. Possession of the sealed
  token is the credential, so everything protecting it is in what refuses:
  authenticated encryption so the payload cannot be edited, a 48-hour expiry,
  voiding if the account's address changed since it was sent, and a precondition
  that makes a stateless token single-use.

## Authenticated encryption, not a bare cipher

Anything sealed and handed to a person must be **tamper-evident**, not merely
unreadable. An unauthenticated ciphertext is malleable: somebody holding an
invitation to `REVIEWER` could flip bits and see what came out. AES-GCM
authenticates as it decrypts, so a modified byte fails instead of producing a
different invitation.

Encryption *as well as* signing, where the payload should not be readable: a
signed-but-plain token would put the invitee's address and the issuer's id into
a URL that ends up in mail archives.

## One refusal for every kind of failure

Where distinguishing failures would help an attacker more than a user, they get
the same answer. A missing upload authorization and a spent one are refused
identically, so the path cannot be used to discover which ids exist. Every way
an invitation can fail — wrong key, altered bytes, expired, already accepted —
returns "this invitation is not usable".

The staff refusal names no role, for the same reason: telling somebody which
role would have worked tells them which account to go looking for.

## Authority has a ceiling

An `ADMIN` may invite a `REVIEWER` or an `APPROVER`, and no more. Without that,
"an administrator may invite" is a privilege escalation — a plain administrator
could invite a second account to `ADMIN` and obtain through it exactly what they
are directly forbidden. Nobody is ever invited to `SUPER_ADMIN`.

The related rule the code already carried: granting and revoking authority
directly is the one capability a plain administrator must not inherit, because
an administrator who can create administrators is a super administrator by
another name.

## Uploads are checked three times, and the third is about the name

The MIME type is what the browser claims. The magic bytes are what the file is.
The **filename** is the one of the three that gets stored and served back later,
so it must not describe something the file is not.

`report.pdf.exe` passes both the others: the browser reports `application/pdf`
and the bytes begin `%PDF-`. The final extension has to agree with the declared
type, and a name with no extension is refused rather than waved through.

Documents are attachment-only on every path. A PDF or an image rendered inline
is a script-execution surface on the portal's own origin, and an applicant's
evidence is the last thing that should be able to run there.

## Related

- [Code](code.md) — the layering rule and why guards are repeated in SQL
- [Documentation](documentation.md) — who owns which subject
- [Fixed-role RBAC](../admin-rbac.md) — the roles themselves, and who holds what
