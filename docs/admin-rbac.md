# Administrator identity and composed roles

This guide describes the authorization foundation shared by the applicant and
administrative services. The first super administrator is promoted through a
one-time curl operation; everybody after them is either granted a role directly
by a super administrator or invited and accepts it themselves. Cycle, intake,
pipeline and stage operations all read live authority.

## One identity, several roles

`core_user` is the login identity. What somebody may do is the union of the
roles they hold, and a role is a set of **permissions** — a resource and an act
on it, such as `application`/`read` or `announcement`/`publish`.

Two authorities are decided in code rather than read from a row:

| Authority | What it is |
| --- | --- |
| `APPLICANT` | May use applicant-owned enterprise and application operations. Created only by verified signup, and nothing can grant it back. |
| `SUPER_ADMIN` | Holds every permission there is, and composes the roles everybody else holds. |

Everything else is a role the office composed for itself. A super
administrator names one, chooses what it may do, and grants it; the programme
decides its own job titles rather than living with six the code chose.

### Why those two are not roles

A super administrator's access is the **wildcard**. Anything added to the
permission catalogue is theirs the moment it is added — no migration, nothing to
backfill, and no chance of a new resource arriving that nobody can administer.
Were it a row, an operator could edit it empty or retire it, and bootstrap
closes permanently after the first grant, so the programme would be locked out
of its own administration with no way back.

An applicant's access is not a staff permission at all. It answers a different
question — may this person use the applicant portal — and no operation can grant
it back, so role administration deliberately cannot touch it.

## The permission catalogue

Every pair a role can be given lives in
[`auth/catalog.json`](../src/services/auth/catalog.json): eleven resources,
twenty acts, and the thirty-six pairs that actually exist. A resource offers
only the acts that mean something on it, so `audit`/`publish` is not a
permission nobody holds — it is not a permission at all.

| Resource | Acts |
| --- | --- |
| `application` | `read` `note` |
| `stage` | `read` `advance` `return` `request_revision` `decide` `close` |
| `pipeline` | `read` `create` `update` `publish` `retire` `assign` |
| `programme_cycle` | `read` `create` `update` `open` `close` `archive` `delete` |
| `form_template` | `update` |
| `policy_document` | `read` `upload` |
| `announcement` | `read` `create` `update` `publish` `remove` `reorder` |
| `audit` | `read` `export` |
| `user` | `read` |
| `role` | `read` `invite` |
| `analytics` | `read` |

The file is authored as JSON and consumed as TypeScript: `catalog.generated.ts`
is derived from it so that a guard's two arguments check against each other, and
`npm run check:catalog` fails the build if the two disagree. Adding a pair is a
catalogue edit and a guard that names it — nothing else.

The fixed workflow's permissions are gone with it: `application`/`review` and
`application`/`refer`, and the whole of `decision`, `funding` and `recovery`.
Their grants were deleted when the pipeline arrived, so no role carries a pair
that means nothing. Every other permission a role held was kept.

**Composing a role, and granting or revoking one, are absent from the catalogue
on purpose.** They are the super administrator's alone, guarded in code. A role
able to hand out roles could hand its own holder every authority there is, and
an authority that cannot be written down cannot be handed out by mistake.

### Roles are not ranked

Two roles overlap or they do not, and somebody holding both simply holds the
union. There is no role that contains another, because an ordering would be a
rule nobody re-checks the moment it stopped being true.

Each operation names the **permission** it needs, and the catalogue is the only
statement of which pairs exist. A screen asks what somebody *may do* rather than
matching a role name — a name is a label the office chose and can change, while
a permission is what the server actually refuses on.

Somebody's permissions are published on the signed-in user so the interface can
decide what to offer without holding a second copy of the policy — but every
operation is still re-checked by the API, which is what actually refuses.

## Working a pipeline: permissions and stage ownership

After submission, a file is worked through a configured **pipeline** of stages
(see the [pipeline guide](pipeline-guide.md)). Two resources govern it.

**`stage` is working a file.** Each act is what one kind of configured effect
needs; an action needs every act its effects need.

| Act | Needed to |
| --- | --- |
| `read` | see a stage's files |
| `advance` | move a file on — to another stage, to the one an input chose, or to a successful end — and change a progress flag |
| `return` | send a file back to the stage it actually came from |
| `request_revision` | ask the applicant to correct named sections of their form |
| `decide` | record a value such as the amount approved, and change an outcome flag |
| `close` | end a file's journey without success, such as a rejection |

Which act an effect needs is fixed by the code's catalogue of effects, never
chosen by whoever configured the action. An approval cannot be made cheaper by
calling it something else. Keeping a staff note needs `application`/`note`, the
same permission as writing one by hand.

**`pipeline` is shaping one.** `read` to see pipelines, `create` to start one,
`update` to edit a draft, `publish` to make a draft the version cycles opening
next will use, `retire` to stop new cycles choosing it, and `assign` to choose
which roles own each stage. Choosing a cycle's pipeline needs
`programme_cycle`/`update` and `pipeline`/`read`, and only a published pipeline
can be chosen.

### Stage ownership is scope, and why a permission is not enough

A State Bank of India officer and a Tripura Gramin Bank officer need exactly the
same permissions: to see a file, send it back, and record a loan. Yet each must
see and act on only their own bank's files. No global permission can say that.

So each stage lists the **roles that own it**. Acting on a file needs both:

1. every permission the action's effects need; and
2. a role that owns the stage the file is at.

> Arjun holds the role `SBI_BANK`, which owns the State Bank stage. A file
> routed to the Tripura Gramin Bank is not his to act on: his permissions
> would allow the action, but he owns no stage the file is at. He cannot open
> it either, unless his role also carries office-wide `application`/`read`.
> When Industries & Commerce sends a file to the State Bank, it appears in his
> queue.

A super administrator owns every stage, for the same reason they hold every
permission. Ownership is not part of a pipeline's versions: adding a second
officer's role to a stage takes effect at once, without publishing, and every
change is kept with who made it and the reason.

**Who may read a file.** A staff member sees the files at stages their roles
own, and the files they have acted on (read-only, so an officer can still find
a file they sent onward). `application`/`read` still gives office-wide reading,
but acting anywhere still needs ownership. The same scope is repeated inside
every read of a file — the workspace, its documents, its notes — so no single
screen is the only thing enforcing it.

**Ownership is read with authority, live.** The session query that resolves a
person's permissions also returns the stages their live roles own, in the same
statement, so there is no extra round trip and no copy that could go stale.
Removing a role from a stage takes effect on its holders' next request.

### Two ceilings on handing out a stage

Attaching a role to a stage hands that role's holders the stage's files, so
`pipeline`/`assign` has a ceiling, like invitations. You may add a role to, or
remove one from, a stage only if:

1. you could offer that role yourself — you already hold every permission it
   carries; **and**
2. you own that stage yourself.

The invitation ceiling (below) gains the same scope: you may offer a role only
if you own every stage it owns. Without it, somebody working the State Bank
stage could invite a second account into the Tripura Gramin Bank role. A super
administrator passes both ceilings.

## What replaced the six fixed roles

`REVIEWER`, `APPROVER`, `ADMIN` and `ANNOUNCER` no longer exist. Their grants
are retained and closed, not deleted, so an audit row naming what somebody did
as an administrator is still readable — and the grant table refuses a *new* row
in that vocabulary, accepting one only where it is already revoked. Their four
keys are reserved, so no composed role can take a name that would make two
different authorities read as one in retained history.

A user may be both applicant and staff. The selected policy permits somebody to
act on their own application; the append-only audit trail records the actor for
every administrative transition.

## Retained role grants

`core_user_role_grant` is the assignment history. An active grant has
`revoked_at = NULL`. Revoking it fills the revocation time and reason instead of
deleting the row. Re-granting the same role creates another row.

```text
user@example.in
  APPLICANT          granted 2026-08-22        active
  DESK_REVIEWER      granted 2026-09-01        revoked 2027-01-15
  DESK_REVIEWER      granted 2027-03-10        active
```

A row names its authority in exactly one place: `role` for the two decided in
code, `role_id` for a composed one. Two partial unique indexes permit only one
active copy of each — two rather than one, because Postgres treats NULLs in a
unique index as distinct, so a single index over the nullable pair would accept
two identical active grants while looking exactly like the guarantee this table
has always carried.

A revocation cannot predate its grant. `RESTRICT` foreign keys preserve the
subject, the role, and any recorded granting or revoking actor.

**Retiring a role closes its grants rather than deleting them**, and the role
row survives soft-deleted, so a closed grant still renders. A grant that could
not be read once its role was retired would leave an audit trail nobody can
follow back to what somebody held.

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

- somebody holding an office permission but no `APPLICANT` grant signs in
  normally and reaches the operations that permission names;
- somebody holding `APPLICANT` as well can use both namespaces;
- revoking `APPLICANT` immediately stops applicant access while leaving the
  underlying session available for administrative authorization; and
- a person whose every grant has been revoked cannot sign in, and the sessions
  they already hold are destroyed rather than merely refused, so granting a
  role back cannot revive an old token.

## Current authorization rules

The shared guards resolve authority on every request and apply these checks:

```text
applicant action:          APPLICANT
staff action:              the permission that operation names
composing or granting a
  role:                    SUPER_ADMIN
```

A super administrator passes the second of these by holding the wildcard, not by
being named in it. Retiring a role, editing its permissions, or revoking a grant
takes effect on the holder's very next request — nothing is copied into the
session, so nothing has to expire first.

## First super administrator

The first super administrator begins as a normally verified applicant. A
deployment operator temporarily configures that exact email and a random secret,
then uses the direct curl endpoint with the applicant's current password. The
same guarded transition revokes that person's `APPLICANT` grant, so the
resulting identity intentionally holds `SUPER_ADMIN` alone. Both role events
stay in retained history, and a request that loses the bootstrap race writes
neither, so the account is never left with no active role.

No other grant is added: `SUPER_ADMIN` holds the wildcard, so there is nothing
a second row could add. The
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
query    { access { roles role(key: "...") permissionCatalogue invitableRoles } }
mutation { access { createRole(...) updateRole(...) deleteRole(...) } }
mutation { access { grantRole(...) revokeRole(...) inviteRole(...) } }
mutation { access { acceptRoleInvite(token: "...") } }
```

Composing a role is two acts: `createRole` names one, holding nothing, and
`updateRole` decides what it may do. That separation is deliberate — a role is
live from the moment it exists, so one that arrived already carrying
permissions would be authorizing people during the window nobody is looking at
it.

`updateRole` replaces the whole permission set rather than adding to it, and
takes the `version` read with the role. A role is live *while it is edited* too:
a sequence of smaller writes would authorize its holders against each
half-finished state in turn, and two operators editing at once would produce a
set neither of them chose.

Lookup is exact-match only. There is no listing or prefix search, so the
namespace cannot be used to enumerate accounts.

The mutations hold to the same rule: both establish the caller's authority
before reading anything about their subject. A refusal such as "no user was
found" or "that role is already active" would otherwise tell an unauthorized
caller which user IDs are real and which of them are administrators.

### What may be granted

Grant and revoke accept `SUPER_ADMIN` and any composed role, named by its key.
`APPLICANT` is created solely by verified signup and no operation can grant it
back, so allowing its revocation here would strip an applicant permanently with
no recovery path — it is the one thing this namespace refuses to touch.

A grant names a role by key, so an unknown key and `APPLICANT` are refused
identically: telling a caller which keys are real is an enumeration this
namespace does not offer. A revocation names a grant ID, so the authority of
the row it resolves to is checked in the service.

### Inviting, and the ceiling on it

There are two ways to become staff. A super administrator may grant a role
directly, with a step-up password. Anybody holding `role`/`invite` may instead
send an invitation, which lands only when the person accepts it themselves — so
the record always shows they agreed.

**An invitation cannot exceed its issuer's own authority.** You may offer only a
role whose permissions you already hold yourself, and whose stages you already
own. This used to be a written
table of role names, which cannot be maintained at all now that the office
composes its own — so the rule is computed from the actual permission sets, and
`access.invitableRoles` returns the list rather than leaving a screen to work it
out and get it wrong.

A super administrator holds the wildcard, so every role is a subset and they may
offer any of them. Nobody is ever invited to `SUPER_ADMIN`; that stays bootstrap
or a direct grant. Without the ceiling, "may invite" would be a privilege
escalation — somebody could obtain through a second account exactly what they
are directly forbidden.

**An invitation names a role by id and by version.** By id because a rename must
not silently redirect one somebody already approved; by version because the
ceiling is checked when the invitation is issued, and a role edited in the
forty-eight hours before it is accepted is no longer the thing that was offered.
Editing a role therefore voids its outstanding invitations, and the invitee is
told the same thing as for any unusable token: ask for a new one.

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

- **Retiring a role.** Permitted whatever holds it, and its live grants close in
  the same statement. A "nobody holds it" precondition would be a predicate over
  rows the statement does not write, which loses: one operator retires while
  another grants, neither blocks, and both succeed. So retirement takes effect
  through the *read* instead — every authority query excludes a retired role —
  and the holder count is shown beside the control so the cost is known before
  the decision rather than after it.

### Sessions

Revocation deliberately writes no session code. Authority is resolved live, so a
demoted administrator's next call is refused immediately, while a person who
merely lost one of several roles keeps their session. If it removed their last
*effective* grant, the existing deactivation paths destroy their sessions.

"Effective" is doing real work there. A role with no permissions on it is a
legitimate thing for an operator to create — every role starts that way — so
sessions are destroyed on holding no grant that authorizes anything, never on
resolving zero permissions. Keying it on the second would turn an editing slip
into a mass sign-out.

## Audit and sensitive data

Role changes use the fixed actions `RBAC.ROLE_GRANTED` and `RBAC.ROLE_REVOKED`;
composing one adds `RBAC.ROLE_CREATED`, `RBAC.ROLE_UPDATED` and
`RBAC.ROLE_RETIRED`; invitations add `RBAC.ROLE_INVITE_ISSUED`,
`RBAC.ROLE_INVITE_ACCEPTED` and `RBAC.ROLE_INVITE_REFUSED`. Each records a
declared payload (see [`audit-vocabulary/access.ts`](../src/services/audit-vocabulary/access.ts)):
the person whose access changed, the role by key, how it came about — directly,
at signup, by the bootstrap — and **the operator's reason, bounded to 500
characters**. The full reason stays on the grant row. A refused invitation
records which check it failed, while the holder of the link is still told one
sentence whatever the cause. An audit row must not contain passwords, hashes,
OTPs, invitation tokens, cookie values, or document and form contents.

`RBAC.ROLE_UPDATED` records how many permissions the role now holds, not which.
The pairs live on the role; a second, diverging copy of somebody's authority in
retained history would be worse than no record of the size.

**The invitation token is never recorded.** An audit row carrying it would be a
second copy of a live credential, readable by anybody who may read audits.

That history is readable in the portal by anybody holding `audit`/`read` — a
permission the office composes into a role deliberately, because that history
carries more about people than any other read. A role that also holds
`audit`/`export` may take a CSV copy of a filtered view; every export is itself
recorded with its filter, its row count and the reason given for it, because a
copy outlives every permission that allowed it. See the
[audit service](../src/services/audit/README.md).

## Deliberate exclusions

The current workflow still does not provide:

- a way for somebody to make themselves staff — every route in is either the
  one-time bootstrap, a direct grant, or an invitation accepted by the person
  named in it;
- granting or revoking `APPLICANT` through any operation;
- **permissions granted to an account directly.** Authority is held through a
  role and only through one, so what somebody may do is always answerable by
  naming the roles they hold;
- **a resource or an act the office can invent.** The catalogue is fixed in code
  and checked against the guards that enforce it, so a permission nothing checks
  cannot be composed into a role and read as coverage;
- **nesting or ranking roles.** Two roles overlap or they do not, and holding
  both is the union;
- staff profiles, departments or organizations. A bank's officers are ordinary
  staff holding a role that owns the bank's stage;
- separate privileged sessions; or
- a mandatory recusal/second-approval rule. Acting on your own application is
  allowed only after you say so, and the disclosure is kept on the action and
  recorded in the activity history as `SEB.SELF_REVIEW_DISCLOSED`.

The base schema never contains an account, email, password, bootstrap secret,
or other administrator credential.
