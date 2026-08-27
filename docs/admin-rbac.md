# Administrator identity and fixed-role RBAC

This guide describes the authorization foundation shared by the applicant and
administrative services. The first super administrator is promoted through a
one-time curl operation; everybody after them is either granted a role directly
by a super administrator or invited and accepts it themselves. Cycle, intake,
decision, funding and recovery operations all read live roles.

## One identity, several roles

`core_user` is the login identity. A user may hold any combination of these
five fixed roles:

| Role | Meaning |
| --- | --- |
| `APPLICANT` | May use applicant-owned enterprise and application operations. |
| `REVIEWER` | May read every casework screen and change nothing. |
| `APPROVER` | May read casework, and record and correct the programme decision. |
| `ADMIN` | May use the whole operational review, award, and finance workflow. |
| `SUPER_ADMIN` | Has all `ADMIN` authority, and may manage roles and read the audit history. |

There is no permission registry or role table. The role vocabulary is defined
by TypeScript and enforced by a database `CHECK`, making every possible authority
visible in code review.

### Roles are not ranked

An `APPROVER` may record a decision a `REVIEWER` may not, but neither may open a
programme cycle. An ordering that put approver "above" reviewer would imply it
can do everything a reviewer can and more — which is true today and would
quietly stop being checked the moment it was not.

So each operation names the **capability** it needs, and one file decides which
roles hold it:

| Capability | Held by |
| --- | --- |
| `STAFF_READ` — every administrative query | `REVIEWER`, `APPROVER`, `ADMIN`, `SUPER_ADMIN` |
| `STAFF_WRITE` — intake, review, referral, awards, recovery | `ADMIN`, `SUPER_ADMIN` |
| `CYCLE_ADMIN` — creating a cycle and editing its rules and form | `SUPER_ADMIN` |
| `DECIDE` — recording and correcting the programme decision | `APPROVER`, `ADMIN`, `SUPER_ADMIN` |
| `ROLE_INVITE` — inviting somebody to a role they accept themselves | `ADMIN`, `SUPER_ADMIN` |
| `ROLE_ADMIN` — granting and revoking a role directly | `SUPER_ADMIN` |
| `AUDIT_READ` — reading the audit history | `SUPER_ADMIN` |

Somebody holding several roles gets the union. The policy lives in
[`auth/capabilities.ts`](../src/services/auth/capabilities.ts) and is published
on the signed-in user, so the interface can decide what to offer without holding
a second copy of it — but every operation is still re-checked by the API, which
is what actually refuses.

`ADMIN` deliberately lacks `ROLE_ADMIN`: granting and revoking authority is the
one capability a plain administrator must not inherit, because an administrator
who can create administrators is a super administrator by another name.

A user may be both applicant and administrator. The selected policy permits an
administrator to act on their own application; the append-only audit trail must
therefore record the actor for every future administrative transition.

## Retained role grants

`core_user_role_grant` is the assignment history. An active grant has
`revoked_at = NULL`. Revoking it fills the revocation time and reason instead of
deleting the row. Re-granting the same role creates another row.

```text
user@example.in
  APPLICANT    granted 2026-08-22              active
  ADMIN        granted 2026-09-01              revoked 2027-01-15
  ADMIN        granted 2027-03-10              active
```

A partial unique index permits only one active copy of a user/role pair while
retaining both historical `ADMIN` grants. A revocation cannot predate its grant.
`RESTRICT` foreign keys preserve the subject and any recorded granting or
revoking actor.

`granted_by_user_id` is null only for trusted system transitions: verified
applicant signup and the first-super-admin bootstrap. Every grant made through
`access.grantRole` records the super administrator who made it. Automated
revocation may have no user actor, but every revocation retains a reason and
time.

## Signup and sessions

Verified public signup always creates only `APPLICANT`. User creation, the role
grant, challenge consumption, sibling cancellation, and safe audit events share
one guarded transaction. If any statement fails, none of the applicant identity is
committed.

Sessions contain only the user ID and token digest; they do not snapshot roles.
Every authenticated request joins the session to current active grants. This
means revocation takes effect on the next request without deleting or waiting
for the session to expire.

Sign-in requires only that the person holds at least one active role of any
kind. Applicant operations additionally require an active `APPLICANT` grant.
Therefore:

- an `ADMIN`/`SUPER_ADMIN` user who holds no `APPLICANT` grant signs in
  normally and reaches administrative operations;
- an `APPLICANT` plus `ADMIN`/`SUPER_ADMIN` user can use both namespaces;
- revoking `APPLICANT` immediately stops applicant access while leaving the
  underlying session available for administrative authorization; and
- a person whose every grant has been revoked cannot sign in, and the sessions
  they already hold are destroyed rather than merely refused, so granting a
  role back cannot revive an old token.

## Current authorization rules

The shared guards load roles on every request and apply these checks:

```text
applicant action: APPLICANT
operational admin action: ADMIN or SUPER_ADMIN
role/account administration: SUPER_ADMIN
```

## First super administrator

The first super administrator begins as a normally verified applicant. A
deployment operator temporarily configures that exact email and a random secret,
then uses the direct curl endpoint with the applicant's current password. The
same guarded transition revokes that person's `APPLICANT` grant, so the
resulting identity intentionally holds `SUPER_ADMIN` alone. Both role events
stay in retained history, and a request that loses the bootstrap race writes
neither, so the account is never left with no active role.

No `ADMIN` row is added because `SUPER_ADMIN` implies its capabilities. The
grant records null as its granting user because authority comes from trusted
deployment configuration; audit records identify the promoted credential-
authenticated user and the fixed bootstrap reason.

Bootstrap is absent from GraphQL and permanently closes after any historical
`SUPER_ADMIN` grant exists. A revoked grant still closes it. Every later role
change goes through the `access` namespace described below; account recovery
remains out of scope.

Once closed, bootstrap refuses the request before password hashing while the
atomic grant statement retains its own permanent-lock check for concurrent
first attempts. Bootstrap audit rows omit caller-controlled request labels so
credentials cannot be copied into retained history through headers.

Follow the [operator guide](first-super-admin-bootstrap.md) for exact commands,
failure behaviour, and secret removal.

Role strings never come from a client-controlled signup field. Grant and
revocation transitions use guarded transactions, record allow-listed audit events,
and protect against removing the last usable `SUPER_ADMIN`. That last rule is a
cross-row transition rather than a row-level schema constraint, so it is
enforced by the write predicate rather than by the schema alone.

## Role administration

A super administrator manages roles under the `access` GraphQL namespace, which
is implemented inside the authentication service. That placement is deliberate:
`core_user`, `core_user_role_grant`, and `core_session` are written from exactly
one service, so the last-super-administrator guard, the bootstrap swap, and
session deactivation cannot drift apart.

```graphql
query    { access { userByEmail(email: "...") userById(id: "...") } }
mutation { access { grantRole(...) revokeRole(...) inviteRole(...) } }
mutation { access { acceptRoleInvite(token: "...") } }
```

Lookup is exact-match only. There is no listing or prefix search, so the
namespace cannot be used to enumerate accounts.

The mutations hold to the same rule: both establish the caller's authority
before reading anything about their subject. A refusal such as "no user was
found" or "that role is already active" would otherwise tell an unauthorized
caller which user IDs are real and which of them are administrators.

### What may be granted

Grant, revoke and invite accept `REVIEWER`, `APPROVER`, `ADMIN` and
`SUPER_ADMIN`. `APPLICANT` is created solely by verified signup and no operation
can grant it back, so allowing its revocation here would strip an applicant
permanently with no recovery path. The GraphQL enum stops a grant at the schema
boundary; a revocation names a grant ID, so the role of the row it resolves to
is checked in the service.

### Inviting, and the ceiling on it

There are two ways to become staff. A `SUPER_ADMIN` may grant a role directly,
with a step-up password. Anybody holding `ROLE_INVITE` may instead send an
invitation, which lands only when the person accepts it themselves — so the
record always shows they agreed.

An invitation cannot exceed its issuer's own authority:

| Issuer | May invite to |
| --- | --- |
| `ADMIN` | `REVIEWER`, `APPROVER` |
| `SUPER_ADMIN` | `REVIEWER`, `APPROVER`, `ADMIN` |

Nobody is ever invited to `SUPER_ADMIN`; that stays bootstrap or a direct grant.
Without the ceiling, "an administrator may invite" would be a privilege
escalation — a plain administrator could invite a second account to `ADMIN` and
obtain through it exactly what they are directly forbidden.

**Nothing about an invitation is stored.** It travels sealed inside the link,
and accepting it exchanges the applicant grant for the staff role in one batch.
What makes a token that is never recorded single-use is its *precondition*: it
applies only while the person still holds `APPLICANT` and not yet the target
role, so once accepted neither is true. The mechanics and the reasons are in
[`auth/invite.ts`](../src/services/auth/invite.ts) and
[`docs/rules/security.md`](rules/security.md).

### Rules

- **Step-up.** Every grant and revoke requires the caller's current password,
  verified against their own account. There is no MFA.
- **Mandatory reason.** Retained on the grant row and shown to future operators.
  It is never copied into audit metadata.
- **No duplicate active grants.** Enforced by the partial unique index and by a
  `NOT EXISTS` term in the insert, so a concurrent second grant writes nothing
  rather than raising.
- **Re-granting.** A revoked role is granted again as a new row, never by
  reopening the old one, so history stays complete.
- **Last super administrator.** A `SUPER_ADMIN` grant can be closed only while
  another *usable* one exists — an active grant on an identity that is neither
  soft-deleted nor unverified, the same conditions sign-in requires. This is a
  SQL `EXISTS` inside the update, not a controller read, so two concurrent
  revocations cannot both succeed.
- **Self-demotion.** A super administrator can never revoke their own
  `SUPER_ADMIN` grant; another super administrator must do it. When they are
  also the last holder, the remaining-holder rule is reported first because it
  says what to do about it.

### Sessions

Revocation deliberately writes no session code. Roles are joined live, so a
demoted administrator's next administrative call is refused immediately, while a
person who merely lost one of several roles keeps their session. If the
revocation removed their last role, the existing deactivation paths destroy
their sessions.

## Audit and sensitive data

Role changes use the fixed actions `RBAC.ROLE_GRANTED` and `RBAC.ROLE_REVOKED`;
invitations add `RBAC.ROLE_INVITE_ISSUED`, `RBAC.ROLE_INVITE_ACCEPTED` and
`RBAC.ROLE_INVITE_REFUSED`. Safe audit metadata is limited to public user and
grant IDs and one of the five role values. It must not contain passwords,
hashes, OTPs, invitation tokens, cookie values, or document and form contents.

**The invitation token is never recorded.** An audit row carrying it would be a
second copy of a live credential, readable by anybody who may read audits.

That history is now readable in the portal rather than only through a SQL
client, by anybody holding `AUDIT_READ` — which is `SUPER_ADMIN` alone, because
it carries more about people than any other read. See the
[audit service](../src/services/audit/README.md).

## Deliberate exclusions

The current workflow still does not provide:

- a way for somebody to make themselves staff — every route in is either the
  one-time bootstrap, a direct grant, or an invitation accepted by the person
  named in it;
- granting or revoking `APPLICANT` through any operation;
- custom roles or permission sets. The five roles and seven capabilities are
  fixed in TypeScript and in a database `CHECK`;
- staff profiles, departments, organizations, or partner-bank accounts;
- separate privileged sessions; or
- a mandatory recusal/second-approval rule. Self-review is allowed only after
  explicit acknowledgement and remains visible in assignment history.

The base schema never contains an account, email, password, bootstrap secret,
or other administrator credential.
