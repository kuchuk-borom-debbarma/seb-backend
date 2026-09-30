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

## What an audit row may carry

The activity history is not a log: it is retained evidence, readable in the
portal by roles holding `audit`/`read`. So it is allowed some things a log is
not, and refused others a log would never see.

| Recorded | Because |
| --- | --- |
| Full email addresses — a sign-up, an address change, a sign-in attempt | The office decided the history must name who, and an address is how a person is found. **This does not relax the log rule above**: a Worker log still never carries one. |
| An operator's reason, at most 500 characters | It is what makes a grant, a correction or a retirement explicable later. The whole reason stays on the record it explains. |
| Amounts, references, dates, outcomes | They are the facts an auditor asks about, copied from the record at the instant it changed. |

| Never recorded | Because |
| --- | --- |
| Passwords, hashes, OTPs, invite tokens, cookies, provider tokens | Credentials, and the history is readable by more people than any credential should be |
| Object keys and file names | A storage identifier is enough to ask for a file |
| Message bodies, internal note text, guidance text, applicant form answers | Business content has one home, its own record; a second copy in the history drifts and is believed anyway |

Three mechanisms enforce this rather than good intentions:

- **Every payload is a strict schema** in `services/audit-vocabulary`, parsed
  before the row is written. An undeclared key fails the write.
- **`check:audit` refuses a payload key shaped like a secret** — `password`,
  `token`, `otp`, `hash`, `secret`, `cookie`, `objectKey`, `body`, `answers`,
  `note` — by name, because the type system cannot tell a secret from a string.
- **The credential paths record no caller text.** They drop the request labels,
  because their caller is not yet anybody; their payloads are
  `callerTextFree`, holding no free text at all, and an address only after it
  has parsed as one. Dropping labels for any other action throws.

An export is CSV opened in a spreadsheet, and several cells hold text somebody
else chose. A cell starting `=`, `+`, `-`, `@`, tab or carriage return is
prefixed with an apostrophe so it is read as text, never run as a formula by
the reader — who, by holding `audit`/`export`, is among the most privileged
people in the office.

## Secrets are separated by purpose

Two secrets exist and none is a synonym for another:

| Secret | Keys | Rotating it |
| --- | --- | --- |
| `AUTH_SECRET` | session and challenge signing | signs everybody out |
| `ROLE_INVITE_SECRET` | sealed role invitations | invalidates outstanding invitations; recoverable by reissuing |

They are separate precisely so that rotating one does not do the other's damage.

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
invitation to a weak role could flip bits and see what came out. AES-GCM
authenticates as it decrypts, so a modified byte fails instead of producing a
different invitation.

Encryption *as well as* signing, where the payload should not be readable: a
signed-but-plain token would put the invitee's address and the issuer's id into
a URL that ends up in mail archives.

## A counting key is never a credential

A rate limiter stores what it counts against, so the key must be safe to hold.
The session token is not: it is the credential itself, and keying on it would
put live credentials somewhere whose only job is arithmetic. The session is
named by the same digest the session table holds — stable per session, useless
to whoever reads it.

The address being signed into is keyed after `normalizeEmail`, the same function
authentication uses. Not for tidiness: `A@B.com` and `a@b.com` are different
strings, so keying the raw input would let changing case reset the allowance,
and the limit would be one keystroke from being no limit.

Only `CF-Connecting-IP` is trusted for the caller's address. `X-Forwarded-For`
arrives from the caller and can say anything, so keying on it would let one
attacker occupy as many buckets as they cared to invent.

## One refusal for every kind of failure

Where distinguishing failures would help an attacker more than a user, they get
the same answer. A missing upload authorization and a spent one are refused
identically, so the path cannot be used to discover which ids exist. Every way
an invitation can fail — wrong key, altered bytes, expired, already accepted —
returns "this invitation is not usable".

The staff refusal names no role, for the same reason: telling somebody which
role would have worked tells them which account to go looking for.

A rate-limited caller is told the same thing whether the allowance is spent or
the limiter itself is broken. Distinguishing them would say whether the
protection is currently working.

## Authority has a ceiling

**You may offer only a role whose permissions you already hold.** Without that,
"may invite" is a privilege escalation — somebody could invite a second account
to more than they hold and obtain through it exactly what they are directly
forbidden. Nobody is ever invited to `SUPER_ADMIN`.

This was a written table of role names — `ADMIN` may invite `REVIEWER` or
`APPROVER`, and no more. That table cannot be maintained at all now the office
composes its own roles, so the rule is computed from the actual permission sets.
The scar is worth keeping because the table was *right* and still could not
survive: a policy written as a list of names outlives the names.

Two further consequences, both of which had to be found rather than deduced:

- **An invitation names its role by id and by version.** The ceiling is checked
  when the invitation is issued, and a role can be edited in the forty-eight
  hours before it is accepted — so without the version somebody could offer a
  weak role they may legitimately offer, then add authority to it. Editing a
  role therefore voids its outstanding invitations, which is the safe direction.
- **Composing a role, and granting or revoking one, are absent from the
  permission catalogue entirely.** Not fenced off inside it — absent. A role
  able to hand out roles could hand its own holder everything, and a role able
  to *edit* roles could write that authority onto itself in two moves. An
  authority that cannot be written down cannot be granted by mistake, and there
  is no `CHECK` to get right and no reviewer to rely on.

The related rule the code already carried: granting and revoking authority
directly is the one thing a member of staff must not inherit, because an
administrator who can create administrators is a super administrator by another
name.

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
- [Roles and permissions](../admin-rbac.md) — the catalogue, how a role is
  composed, and who holds what
