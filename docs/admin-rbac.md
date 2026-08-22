# Administrator identity and fixed-role RBAC

This guide describes the authorization foundation shared by applicant and
future administrative services. It covers identity and role persistence only;
administrator GraphQL operations and account provisioning do not exist yet.

## One identity, several roles

`core_user` is the login identity. A user may hold any combination of these
three fixed roles:

| Role | Meaning |
| --- | --- |
| `APPLICANT` | May use applicant-owned enterprise and application operations. |
| `ADMIN` | May use future operational review, award, and finance operations. |
| `SUPER_ADMIN` | Has all `ADMIN` authority and may manage users and role grants. |

There is no permission registry or role table. The role vocabulary is defined
by TypeScript and enforced by a D1 `CHECK`, making every possible authority
visible in code review. `SUPER_ADMIN` implies `ADMIN` in future authorization
helpers; a super administrator does not need a duplicate `ADMIN` grant.

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

`granted_by_user_id` is null only for trusted system transitions, currently
verified applicant signup and later the first-super-admin bootstrap. Future
administrative grant services must provide their authenticated actor. Automated
revocation may have no user actor, but every revocation retains a reason and
time.

## Signup and sessions

Verified public signup always creates only `APPLICANT`. User creation, the role
grant, challenge consumption, sibling cancellation, and safe audit events share
one guarded D1 batch. If any statement fails, none of the applicant identity is
committed.

Sessions contain only the user ID and token digest; they do not snapshot roles.
Every authenticated request joins the session to current active grants. This
means revocation takes effect on the next request without deleting or waiting
for the session to expire.

The same session mechanism will support administrative operations. Applicant
operations additionally require an active `APPLICANT` grant. Therefore:

- an `ADMIN`-only user cannot sign in through applicant authentication;
- an `APPLICANT` plus `ADMIN` user can continue using applicant operations; and
- revoking `APPLICANT` immediately stops applicant access while leaving the
  underlying session available for future administrative authorization.

## Future authorization rules

Future admin services should expose the internal authenticated-user session
resolution through their own guard, load roles on every request, and apply
these checks:

```text
applicant action: APPLICANT
operational admin action: ADMIN or SUPER_ADMIN
role/account administration: SUPER_ADMIN
```

Role strings must never come from a client-controlled signup field. Grant and
revocation transitions must use guarded D1 batches, record allow-listed audit
events, and protect against removing the last usable `SUPER_ADMIN`. The last
super-administrator rule belongs in the future provisioning service because it
is a cross-row transition, not a row-level schema constraint.

## Audit and sensitive data

Role changes use the fixed actions `RBAC.ROLE_GRANTED` and
`RBAC.ROLE_REVOKED`. Safe audit metadata is limited to public user/grant IDs and
one of the three role values. It must not contain passwords, hashes, OTPs,
tokens, cookie values, or document/form contents.

## Deliberate exclusions

The current foundation does not provide:

- an administrator signup or sign-in GraphQL API;
- first-super-admin bootstrapping;
- role grant/revoke GraphQL operations;
- custom roles or permission sets;
- staff profiles, departments, organizations, or partner-bank accounts;
- MFA or separate privileged sessions; or
- conflict-of-interest restrictions for an administrator's own applications.

The future bootstrap must create a verified user and `SUPER_ADMIN` grant through
a privileged, audited mechanism. The base schema never contains an account,
email, password, or other administrator credential.
