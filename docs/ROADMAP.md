# Mission SEP product roadmap

This roadmap describes **what people can do**, **how each feature behaves**, and
**what remains to be delivered**. It intentionally avoids implementation
details. It is the shared product checklist for policy owners, programme staff,
reviewers, designers, and developers.

The TTAADC Mission SEP policy and application form are the primary source for
business rules. The UI/UX guide may improve presentation, but it cannot change
eligibility, evidence, or approval rules.

## How to read and update this roadmap

- `[x]` means the exact behaviour or rule named by that checkbox is implemented
  and independently verifiable. It does not mean that every surrounding feature
  or launch dependency is complete.
- `[ ]` means it is not yet available, even if part of its foundation exists.
- A parent feature is complete only when every required child item is checked.
- A checkbox must describe an observable outcome. Entries such as “finish admin
  work” are not acceptable because they do not say what completion means.
- When a rule changes, update the rule here before marking affected work done.
- Policy decisions that are not settled appear in the final section with the
  exact question, owner, and effect of leaving the decision open.

Throughout this document, **administrator** means a signed-in person holding any
programme-office permission — whatever the role carrying it is called, because
the office composes its own. **Super administrator** specifically means a person
with an active `SUPER_ADMIN` grant, which is the wildcard and is the one role
never stored as a row.

The word is deliberately not a role name. It was `ADMIN` or `SUPER_ADMIN` when
those were four fixed roles; naming a role here again would go stale the first
time somebody composed another.

## Product model and fixed rules

These rules are already agreed and must remain true throughout the roadmap.

- [x] One person has one portal identity identified by a verified email address.
- [x] One person may own more than one enterprise.
- [x] Each enterprise has one primary portal owner.
- [x] Each enterprise has one long-lived funding case that joins every
  application it makes, of every kind.
- [x] One application is one attempt, of one kind, in one programme cycle.
- [x] The kinds of application a cycle accepts, and who may start each, are the
  cycle's configuration. The code knows no kind by name — "expansion" is a kind
  a cycle declares, with rules saying when an enterprise may start one.
- [x] An application's phase number is one more than the enterprise's earlier
  applications of the kinds its cycle declares before this one, so a first
  application is phase 1.
- [x] Enterprise Category A/B describes the enterprise's age or maturity. It is
  separate from the application's kind.
- [x] After submission, an application is worked through the pipeline its
  cycle pinned. The code knows no stage, bank, or post-submission status by
  name.
- [x] Application submissions are historical records. Later enterprise or draft
  changes never rewrite what was submitted.
- [x] Business records are retained for history when corrected, replaced, or
  withdrawn.
- [x] The application does not ask for an ST certificate number.
- [x] An ST certificate file remains mandatory when submitting an application.
- [x] The system does not enforce a seed-fund ceiling until the contradictory
  figures in the source documents are resolved by the policy owner.
- [x] Financing components are not required to add up to the total project cost.
- [x] A person may be both an applicant and an administrator. Administrative
  actions on that person's own application are allowed and must remain visible
  in the activity history.

---

## 1. Applicant account and access

### 1.1 Account creation

- [x] An applicant starts registration by entering an email address.
- [x] Email matching ignores leading/trailing spaces and letter case, so
  `Rina@Example.com` and `rina@example.com` are the same identity.
- [x] The applicant receives a six-digit one-time code through the notification
  provider.
- [x] Each registration attempt has its own code and expires after ten minutes.
- [x] Requesting a new code does not invalidate earlier unexpired codes.
- [x] The first valid code successfully used for the email completes the signup;
  the remaining codes can no longer be used.
- [x] A wrong code reduces the attempts only for that particular registration
  attempt and does not damage sibling attempts.
- [x] The applicant chooses a password while confirming the code.
- [x] A successful confirmation creates a verified applicant account but does
  not sign the person in automatically.
- [x] An email already used by an active or deleted account cannot be registered
  again.
- [x] Registration gives only applicant access. It can never grant administrator
  or super-administrator access.
- [ ] Replace development-only email output with a production notification
  provider that actually delivers the code to the applicant's mailbox. The
  adapter is delivered; only the key is unprovisioned — see §18.
- [ ] Limit repeated registration and code requests by email, device, and
  network so attackers cannot flood applicants or the notification provider.
- [ ] Add a human-verification challenge after suspicious or excessive signup
  activity without blocking normal first-time applicants.

### 1.2 Sign-in and sessions

- [x] A verified applicant signs in with email and password.
- [x] Invalid email/password combinations return the same safe message and do
  not reveal whether an account exists.
- [x] A signed-in applicant can see the current session and all their other
  signed-in sessions.
- [x] An applicant can sign out the current device.
- [x] Signing out returns the person to the public programme site, not to a
  second legacy authentication screen.
- [x] An applicant can revoke one selected session, every other session, or all
  sessions.
- [x] Removing applicant access stops applicant operations on the next request,
  even if the person was already signed in.
- [x] Add “forgot password” using a short-lived email verification flow. Ten
  minutes, five attempts, and a challenge token independent of the emailed code
  — the same pair signup uses. Answers identically for an address that has no
  account, so it cannot be used to discover who has applied.
- [x] Allow a password reset to revoke all existing sessions as the default safe
  choice, while clearly informing the applicant before completion. The reset
  screen says so before the password is set, and a notice is sent afterwards.
- [x] Add a verified-email change flow that confirms both account ownership and
  the new address before the login email changes. The password proves the
  account, a code sent to the new address proves that; the old address is told a
  change was asked for.
- [x] Let somebody change a password they still know, and set what they are
  called. Other devices are signed out; the one in use is not.
- [ ] Add an applicant account closure flow that explains retained application
  history, blocks further sign-in, and revokes all active sessions.

---

## 2. Applicant enterprises

An enterprise is the applicant's reusable business profile. It is not itself an
application. The applicant can update the current enterprise for future work
without altering older submitted applications.

### 2.1 Enterprise ownership and listing

- [x] An applicant can create and own multiple enterprises under one account.
- [x] The applicant can see a paginated list of only their own enterprises.
- [x] The enterprise list shows current identifying information and whether the
  enterprise is active or deleted.
- [x] The applicant can open one enterprise and see its current profile.
- [x] An applicant cannot discover or open another applicant's enterprise by
  guessing its identifier.
- [x] Creating an enterprise also creates its one long-lived Mission SEP funding
  case.
- [x] A second funding case cannot be created for the same enterprise.

### 2.2 Enterprise profile

- [x] The enterprise profile records its current name, establishment date,
  registration details, GSTIN, sector, business address, phone, and email.
- [x] Enterprise registration and editing present one category at a time:
  enterprise details, registration and tax, business location, then contact
  details. Earlier categories remain available while later ones stay blocked.
- [x] Enterprise location asks for `Office address (as per your business
  documents)`, warns against a personal or residential address, and limits
  district selection to Tripura's eight districts.
- [x] Enterprise answers remain local while moving between categories and the
  complete profile is created or updated only from the final category. Leaving
  through Cancel after making a change asks before discarding the answers.
- [x] Registration and GST fields may remain empty when they do not apply; their
  necessity is checked when an application is submitted.
- [x] Every meaningful enterprise edit creates a new historical version.
- [x] Saving an unchanged enterprise does not create a duplicate version.
- [x] If two edits are based on the same old version, only the first succeeds;
  the second person is told to reload before editing again.
- [x] Editing the enterprise affects only future drafts. Existing application
  drafts and submissions keep the enterprise details copied into them.

### 2.3 Deletion and restoration

- [x] Deleting an enterprise is reversible and preserves its history.
- [x] An enterprise can be deleted only when all its drafts are already deleted
  and it has no submitted applications.
- [x] Deleting an enterprise also makes its funding case unavailable.
- [x] Restoring an enterprise restores its funding case in the same action.
- [x] Another applicant cannot delete or restore the enterprise.
- [x] A refused deletion lists the exact applications preventing it,
  with their reference numbers and statuses, instead of a general refusal.

---

## 3. Programme cycles visible to applicants

A programme cycle is a named application window such as Mission SEP 2026. A
cycle controls when new applications may start; it does not erase work already
submitted in an older cycle.

- [x] Applicants can see currently open programme cycles available for new
  applications.
- [x] A new application records the exact cycle rules that applied when its
  draft was started.
- [x] Closing a cycle prevents new applications from starting in it.
- [x] An applicant responding to an official revision request may resubmit after
  the original cycle closes.
- [x] The applicant cycle view carries the cycle name, application opening and
  closing times, policy reference, and lifecycle status.
- [x] Show a countdown or explicit closing date in the applicant journey; do not
  rely on colour alone to communicate urgency. The cycles screen, the draft form
  and the Review screen all state the closing date and the time
  remaining, and the wording changes as well as the tone when it is near.
- [x] Cycles the applicant has work in are listed separately from cycles a new
  application may start in, so closed cycles render read-only and can never
  carry a “start application” action.
- [ ] Clearly identify any cycle rule that differs from an earlier cycle.
  Cycle-specific applicant guidance is already published to the applicant.

---

## 4. Starting an application

### 4.1 Choosing a kind

- [x] The applicant chooses one owned, active enterprise and one open programme
  cycle.
- [x] The cycle's kinds of application are shown as described choices, each
  saying whether this enterprise may start it and, when it may not, every
  reason why. No draft is created until the applicant confirms a kind they may
  start.
- [x] Registering another enterprise from application setup returns with that
  enterprise selected, preserves the chosen cycle, and advances to the choice
  of kind when both choices are present. A registration opened directly
  continues to the new enterprise profile.
- [x] Starting an application copies the enterprise's current profile into the
  first draft and records the kind and phase number.
- [x] The application remains attached to the selected enterprise and its
  funding case for its entire life.
- [x] The applicant cannot start an application for another person's enterprise.
- [x] The applicant cannot choose a phase number or assert an eligibility fact;
  eligibility is read from the enterprise's recorded history.

### 4.2 Eligibility rules

A cycle gives each kind its own rules. The full vocabulary is in the
[form template guide](form-template-guide.md#kinds-of-application-and-who-may-start-one).

- [x] A kind may require an earlier application holding a status flag
  (optionally in one pipeline, optionally for a number of months), an earlier
  recorded value of at least an amount, no unfinished application of a kind,
  fewer than a number of applications of a kind, or an enterprise at least a
  number of months old.
- [x] Every rule of a kind must hold; all are evaluated and every failing
  reason is shown at once, in applicant-safe words.
- [x] A fact a rule needs and cannot find fails the rule rather than passing it.
- [x] The history is read across every cycle, and when a flag was added comes
  from the pipeline's action history, never from anything the applicant types.
- [x] The rules are asked again when a removed draft is restored and at the
  first submission, because the history may have moved. The application being
  checked never counts against itself.
- [ ] Show the first date on which a time-based rule will be met, when time is
  the only thing unmet.
- [ ] Let an eligibility rule read released money and assessment results
  (§17). The fixed expansion rule did; the configured rules cannot until that
  money is recorded.

---

## 5. Completing and saving the application form

### 5.1 Draft behaviour

- [x] The applicant can save an incomplete form as a draft.
- [x] The applicant completes seven ordered stages: Enterprise details, Owners,
  Project cost and funding, Previous support and credit, Evidence requirements,
  Attach evidence, and Review.
- [x] The active answer category is held in a validated `section` address
  parameter. An address without it opens the earliest incomplete category,
  while existing field bookmarks still open and focus the exact question.
- [x] `Save & Next` appears on every editable answer stage and Attach evidence.
  It immediately saves pending answers or uploads and requests fresh server
  validation. It advances only when the current category has no issues, reports
  how many remain, and focuses the first question to fix. Completed categories
  remain available and future categories stay blocked.
- [x] Missing document files are enforced on the attach-evidence category,
  separately from the NOC applicability question, so applicants can answer the
  question before being asked for the resulting files. Required files block
  review while optional files do not.
- [x] Desktop forms use a sticky category rail and action footer. Narrow screens
  use a Step X of Y selector without horizontal scrolling, preserve action
  clearance at 360–390 pixels, and respect keyboard, screen-reader and reduced-
  motion preferences.
- [x] Revision-locked categories remain readable and explicitly marked read
  only. Every category remains browsable after an application becomes fully
  read only.
- [x] Each meaningful save preserves a complete historical snapshot.
- [x] Saving exactly the same information returns the existing draft version
  instead of creating another copy.
- [x] Clearing an optional answer is an explicit action and is retained in the
  new snapshot.
- [x] If the application changed elsewhere after the applicant loaded it, the
  stale save is rejected and the applicant must reload before trying again.
- [x] Submitted versions never change when the applicant later edits an allowed
  revision stage.
- [x] The applicant can view only applications belonging to their account.
- [x] The application list is paginated and supports stable continuation through
  large histories.
- [x] Save by hand — Save, "Save & next" and Cmd/Ctrl+S; nothing is saved on a
  timer — with the unambiguous states “Unsaved changes”, “Saving”, “Saved” and
  “Could not save”.
- [x] Ask before losing unsaved answers: the browser's prompt when the tab is
  closed or reloaded, and a dialog offering to save first when the applicant
  leaves for another page of the portal. Moving between the form's own stages
  keeps the answers on screen and is not leaving.
- [ ] Show “last saved” time and the current draft version without implying that
  a saved draft has been submitted. The saved time is shown, taken from the
  server's own record rather than the moment the request was sent. The draft
  version is not, so this stays open — though it is worth asking whether it
  should be dropped instead: a version number means nothing to an applicant and
  reads as a count of submissions.

### 5.2 What a cycle may ask

**The questions are no longer the software's.** Sections 5.2–5.6 used to list
about thirty-five specific fields as though they were product rules; every one of
them is now the *content* of a form template a cycle declares, and the software's
behaviour is that it enforces whatever the template says. A cycle that drops the
GSTIN question, or adds one, needs no deploy and no change here. The whole
system — types, conditions, structures, storage, authoring — is the
[form template guide](form-template-guide.md).

What the software guarantees:

- [x] A cycle declares its form as stages and fields, frozen with the cycle
  version. An application is judged against the version it pinned, so the
  questions it was asked cannot change under it.
- [x] Each field declares one of fourteen types — text, long text, email,
  phone, date, integer, money in paise, boolean, an attestation with one
  acceptable answer, a statement the applicant only reads, single choice,
  multiple choice, file, or a repeated group — and the answer is coerced and
  checked against it. A statement takes no answer at all, and one addressed to
  it is refused.
- [x] Each field declares its own bounds: length, an anchored pattern with the
  cycle's own message, numeric and date ranges, a `NOT_FUTURE`/`NOT_PAST` bound
  resolved against the write's instant, repeat bounds, and a file-size cap.
- [x] Each field declares when it is shown and when it becomes compulsory, as
  conditions against other answers. Conditions in one group are ANDed; separate
  groups are alternatives.
- [x] A hidden question is never required, and its answer is cleared rather than
  stored — run to a fixed point, so hiding a question hides what depended on it.
- [x] Documents are `FILE` fields, so which evidence a cycle wants and when it is
  required are the same kind of decision as any other question.
- [x] A save replaces the whole answer set: an unknown key is refused rather than
  dropped, and a declared key left out is refused rather than treated as
  unchanged.
- [x] Each field carries how it is drawn as well as what it must satisfy —
  placeholder, inline note with a tone, width, prefix/suffix, autocomplete
  hint, character counter, textarea rows, choice style; options carry a
  description and an icon; stages carry a description, an icon and an
  estimated-minutes hint. Every one is a closed set, so a typo is refused
  rather than silently unstyled.
- [x] A cycle can define a reusable structure once — "an Owner is a name, a
  date of birth, a share" — and use it in any repeated group. Members are
  expanded into ordinary questions under `USE__MEMBER` keys at authoring time,
  with hard ceilings (16 definitions, 24 members each, 20 entries, 200
  questions, 20 stages, one level of nesting, no conditions on members yet)
  and a 32 KB worst-case answer budget refused when the *form* is authored
  rather than when an applicant hits it.
- [x] Three **roles** pin the questions the programme itself must find across
  cycles — the applicant's date of birth (which may live inside the owners
  group), the grant asked for (pinned to the key `SEED_FUND_REQUESTED_PAISE`)
  and the loan asked for (pinned to `LOAN_AMOUNT_REQUESTED_PAISE`), which SQL
  reads literally. The business name, sector, establishment date and category
  are not answers: they are read live from the enterprise, and the category is
  computed at submission.
- [x] A cycle binds only the roles it asks — a loan-only round has no grant
  amount — but a role is never bound twice, off its pinned key, or to a
  question of the wrong type: authoring refuses it by name, and
  `resolveFormTemplate` refuses to resolve such a template at all.
- [x] A cycle may declare rules about several answers at once — at least one of
  some yes/no questions is yes, some answers all differ, some amounts add up to
  no more than a limit, one answer is no more than another — and authoring
  refuses a rule that could never hold or never fail.
- [x] Refuse a submission that breaks one of those rules, on the stage the
  rule names, counting only the questions the applicant was asked — in the
  browser as soon as the second answer is given, and on the server whatever the
  browser did. A save is not refused: such a rule cannot hold part way through
  a form.
- [x] Authoring a form in the cycle editor. The nine `formTemplate` mutations
  and the cycle editor's form screen exist, gated by `form_template`/`update`
  and only while the cycle is a draft.

### 5.3 The three rules that are still the programme's

These read cycle policy rather than template rows, so they cannot become field
bounds — their inputs are cycle scalars, not anything an applicant answers.

- [x] The applicant must be at least the minimum and no older than the maximum
  age the cycle states, on the date of formal submission.
- [x] Category A means trading for at least the cycle's stated number of
  calendar months at submission; Category B means younger. The category is
  computed by the server from the enterprise's establishment date, and a
  sorting cycle refuses submission when that date is missing.
- [x] The grant asked for is refused above the cycle's funding ceiling, where
  the cycle states one. Unresolved means no ceiling is enforced — see §21.
- [x] Real calendar dates only, including correct leap-day handling.
- [x] Exact rupee-and-paise values, without rounding through floating point.

---

## 6. Application documents

### 6.1 Required evidence

**Which documents a cycle wants is the cycle's decision too.** Evidence is a
`FILE` field of the form template, so "always required", "required when the
enterprise is registered" and "required when a GSTIN is present" are ordinary
conditions against whatever questions that cycle happens to ask — strictly more
expressive than the four fixed conditions this used to list.

- [x] A `FILE` field carries evidence rather than an answer, and is required
  exactly when the template says and its conditions hold.
- [x] A document whose question is not on screen is not asked for at all.
- [x] The list the validator computes is the same list the submitting write
  repeats in its own predicate, so a document deleted between the two cannot
  slip past.

### 6.2 Upload, replacement, and access

- [x] Accept PDF, JPEG, and PNG files up to 2 MB each, with the file name's
  extension required to match the file's declared type.
- [x] Reject a file whose actual type does not match its declared type.
- [x] Reject incomplete, altered, oversized, or expired upload attempts.
- [x] Keep application documents private.
- [x] Give the applicant a short-lived download link only after confirming that
  the document belongs to their application.
- [x] Force downloads as attachments rather than displaying untrusted files in
  the portal page.
- [x] Replacing a document creates a new historical version and makes it
  current.
- [x] Deleting a document is reversible and does not erase earlier uploaded
  versions.
- [x] A concurrent replacement based on an old document version is rejected.
- [x] Temporary uploads that expire or fail validation are marked for cleanup
  without affecting finalized documents.
- [x] Route every finalized document through a scanner before it becomes
  available to programme staff. The seam, the producer and the consumer are all
  real; which product does the scanning is the open decision below.
- [x] Choose a real malware scanner. Cloudmersive, selected by
  `SCANNER_TRANSPORT` alongside the permissive `none`. With `none`, `local` and
  `develop` accept documents without examining them and record
  `NO_SCANNER_CONFIGURED` against each one, so an unexamined file can never be
  mistaken for a checked one. `production` refuses `none`, and
  `npm run check:scanner` refuses that configuration before it is deployed.
- [ ] Provision `CLOUDMERSIVE_API_KEY` and turn the transport on in the deployed
  configuration. The code is delivered and tested; what remains is an account.
  Its free tier is ~600-800 scans a month, one at a time, and refuses a file
  over 2.5 MB — which is why documents are capped at 2 MB. An intake round of
  any size needs a paid tier or a different transport.
- [ ] Show applicants the malware-scan states “Pending”, “Accepted”, and
  “Rejected”, with a safe reason and a replacement action for rejected files.
- [ ] Prevent submission while any required document is awaiting or has failed
  malware scanning.
- [x] Allow authorized administrators to download evidence only once a scan
  result has been recorded against it. The download fails closed until then.

---

## 7. Validation, submission, and applicant history

### 7.1 Validation

- [x] The applicant can validate a draft without submitting it.
- [x] Validation groups issues by form stage and identifies the exact field
  and correction needed.
- [x] Validation checks required and conditional answers, dates, age, category,
  contact formats, money, declarations, and documents.
- [x] An invalid validation result does not change the draft or application
  status.
- [x] Submission repeats validation so an earlier successful check cannot bypass
  later changes.
- [x] Add a clickable validation summary that takes the applicant to each
  invalid field or document slot in form order. Each row links to the screen
  that fixes it — the form for an answer, the evidence screen for a document —
  and names the field in the address, so the control is scrolled to and focused
  on arrival.

### 7.2 First submission

- [x] A valid draft can be submitted once as submission number 1.
- [x] Submission creates a new frozen formal snapshot, even if the last draft
  was already valid.
- [x] The first submission receives one stable Mission SEP reference number.
- [x] The reference number remains unchanged through every stage, revision and
  status flag.
- [x] Successful submission enters the application at the first stage of the
  pipeline version its cycle pinned, adds the flags the pipeline adds on
  submission, and records an applicant-visible timeline event.
- [x] Two simultaneous submission attempts cannot create duplicate submissions
  or reference numbers.
- [x] A deleted draft cannot be submitted.
- [x] Show a submission confirmation page containing the reference number,
  submission number, submission time, and a read-only summary. The submission
  number is read from `draftChanges.comparedToSubmissionNumber`, which is the
  submission just made — the applicant surface reports no submission number of
  its own, and inventing one in the browser was not acceptable.
- [ ] Let the applicant download a human-readable acknowledgement of the exact
  submitted snapshot and document list. The server now renders exactly such a
  PDF and attaches it to the submission confirmation email, so the file
  exists; what is still missing is a download control in the portal. The
  confirmation page prints as a document, which gives a paper copy meanwhile.

### 7.3 Applicant timeline and status

- [x] The applicant can see the application's current status: a draft, or
  submitted and being worked.
- [ ] The applicant can see where a submitted file is, by the stage's applicant
  label and explanation, and the status flags and recorded values the pipeline
  lets them see (§14).
- [x] The applicant can see a chronological, applicant-safe timeline for events
  already recorded on the application.
- [x] The timeline does not expose internal secrets, staff-only notes, or
  another applicant's information.
- [x] A status guide defines a label, plain-language explanation, and next
  action for both statuses the code owns, built from the schema's own status
  list so a new status cannot be missing from it. Everything after submission
  is explained by the pipeline's own applicant labels instead.
- [x] Each status names who must act next—applicant, programme office, or
  nobody—and the guide deliberately carries no dates at all.

---

## 8. Revision and resubmission

A revision is asked for by a configured stage action (§15). The applicant's
side of it is complete; the office's side arrives with stage actions.

- [ ] An officer asks for a revision through an action at the file's stage,
  naming the form stages to correct and giving the applicant a readable note.
- [x] While a revision is open, the applicant may edit only stages named by
  unresolved requests.
- [x] Fields outside those stages must remain identical to the last
  submission.
- [x] Resubmission validates the complete application and all required evidence.
- [x] Resubmission creates a new formal snapshot and the next submission number.
- [x] A successful resubmission resolves all open revision requests through that
  exact submission, removes the flag that let the applicant edit, and leaves
  the file at the stage that asked — not back at the start.
- [x] Resubmission remains available after the original programme cycle closes.
- [ ] Let an officer withdraw an incorrect revision request with a reason and
  ask again, without editing or hiding the original request.
- [x] Revision requests carry their stage, issue date, note, and resolved or
  withdrawn state, ready to group by stage.
- [x] The application reports which stages are editable right now, derived
  from the same rule the draft-save path enforces, so a locked stage can never
  be shown as editable.
- [x] The applicant can list the stages their draft changes relative to the
  submission under revision, using the same comparison a reviewer sees.

---

## 9. Administrator identity and access

Sign-in accepts any person holding at least one active role, so an
administrator who is not also an applicant can reach administrative operations.
A super administrator can provision and demote administrators under the `access`
namespace. Account recovery remains incomplete.

### 9.1 Role rules already established

- [x] `APPLICANT` grants applicant enterprise and application access, and is
  created only by verified signup.
- [x] `SUPER_ADMIN` may do everything the portal can do, and is the only
  authority that composes roles and hands them out.
- [x] Every other role is one the office composed for itself: a name, a purpose,
  and a set of permissions it chose.
- [x] A permission is a resource and an act on it. The office may combine them
  freely but cannot invent one — the catalogue is fixed in code, so a permission
  nothing enforces cannot be composed into a role and read as coverage.
- [x] One person may hold more than one role at the same time, and what they may
  do is the union.
- [x] Roles are not ranked and do not contain one another.
- [x] Role removals, permission changes and role retirement all take effect on
  the person's next action rather than waiting for sign-out.
- [x] Past grants and revocations remain visible for accountability, including
  grants of roles that have since been retired.
- [x] Public applicant signup cannot create an administrative role.

### 9.2 First administrator and sign-in

- [x] Let a deployment operator promote one predetermined, normally verified
  applicant through a direct command-line operation that is absent from the
  public GraphQL interface.
- [x] Require both that applicant's current password and a temporary random
  bootstrap secret; the request cannot select a different email or role.
- [x] Permanently close bootstrap after the first retained `SUPER_ADMIN` grant,
  including when that grant is later revoked.
- [x] Revoke the promoted person's `APPLICANT` grant in the same guarded
  transition that grants `SUPER_ADMIN`, so bootstrap produces an
  administrator-only account and a losing request changes neither role.
- [x] Refuse to promote an applicant who owns any enterprise, because losing
  `APPLICANT` would strand that enterprise permanently: role administration
  deliberately excludes `APPLICANT`, so nothing can grant it back.
- [x] Delete the promoted account's existing sessions in the same transition, so
  administrative authority requires a fresh sign-in.
- [x] Record the promoted user, time, role grant, role revocation, and fixed
  bootstrap reason without retaining the password, configured email, or
  temporary secret.
- [x] Give administrators a sign-in journey that works for anybody holding an
  office permission who is not also an applicant.
- [x] Refuse sign-in for a person whose every role grant has been revoked, and
  destroy their existing sessions rather than only refusing them, so restoring a
  role cannot revive a previously issued token.
- [x] Require fresh password confirmation before a super administrator changes
  another person's roles.
- [x] Provide administrative session listing, sign-out, and revoke-all controls.
- [ ] Define account recovery that requires verified organizational approval and
  cannot be completed by email access alone.

### 9.3 User and role management

Role administration lives under the `access` GraphQL namespace. Grant, revoke
and invite name a role by its key: `SUPER_ADMIN`, or any role the office
composed. `APPLICANT` is created only by verified signup and cannot be granted
back by any operation, so allowing its revocation here would strip an applicant
permanently with no recovery path.

- [x] Let a super administrator search users by exact email or public user ID.
- [x] Show verified email, active roles, account state, and retained role
  history without exposing passwords or private application answers.
- [x] Let a super administrator grant any role with a mandatory reason.
- [x] Let a super administrator compose a role: name it, say what it is for, and
  choose what it may do from the permissions the server can enforce.
- [x] Start a new role holding nothing, so a half-configured one is never live.
- [x] Show what a role may do, and how many people hold it, before offering any
  control that changes either.
- [x] Let a super administrator retire a role, closing every grant of it. The
  holder count is shown first, so the cost is known before the decision.
- [x] Keep composing, granting and revoking a role to the super administrator
  alone, and out of the permission catalogue entirely — a role able to hand out
  roles could hand its own holder everything.
- [x] Separate reading casework from deciding it, from shaping the programme:
  the office composes a role that reads and one that decides if it wants them
  separate, rather than living with a split the code chose. Working a file is
  the `stage` resource, shaping a pipeline the `pipeline` resource, and which
  stages a person works is the stage ownership of their roles.
- [x] Decide authorization by resource and act rather than by role name, so an
  operation states what it needs and a name can change without the rule moving.
- [x] Publish what the signed-in person may do, so a screen offers only controls
  that will work — while every operation is still re-checked by the server.
- [x] Let anybody holding the invite permission invite somebody to a role they
  accept themselves, so the record shows consent rather than an assignment they
  may not know about.
- [x] Stop an invitation exceeding its issuer's own authority: you may offer
  only a role whose permissions you already hold, and nobody is ever invited to
  super administrator.
- [x] Void an outstanding invitation when the role it names is edited, so nobody
  accepts something stronger than what was offered.
- [x] Keep nothing about an invitation in the database. It travels sealed in the
  link, and it is single-use because it applies only while the person is still
  an applicant.
- [x] Let a super administrator revoke a role with a mandatory reason.
- [x] Prevent duplicate active grants of the same role.
- [x] Refuse a role key the server reserves for itself, and never reuse one, so
  retained history cannot confuse two different authorities.
- [x] Permit a previously revoked role to be granted again as a new history
  item.
- [x] Prevent removal of the last usable `SUPER_ADMIN` account, decided by the
  guarded write itself so two concurrent revocations cannot both succeed.
- [x] Prevent a super administrator from removing their own super administrator
  access; another super administrator must do it.
- [x] Show the affected user, role, actor, reason, and time for every grant and
  revocation.
- [ ] Notify the affected person after an administrative role is granted or
  revoked; the notification must not be required for the role change to take
  effect.
- [ ] Notify the holders of a role when its permissions change or it is retired.
  They lose access on their next action either way, and today nothing tells them
  why.
- [ ] Show, for one role, which accounts hold it. The count is shown; the list
  is not, so retiring a role names a number rather than the people affected.

---

### 9.4 Two portals

- [x] Keep public programme information at `/`, the applicant portal at
  `/dashboard`, and the programme office at `/admin`, so visitors can learn
  about the programme without a session and the two signed-in audiences do not
  share one navigation list filtered by role.
- [x] Send each account to the portal its roles fit at sign-in, so an officer
  holding no applicant grant never reads a refusal after signing in.
- [x] Refuse a portal in place rather than redirecting: name the roles the
  account does hold, link to the portal it can use, and when it holds neither,
  give the exact sentence to send a super administrator.
- [x] Show the navigation that *works* beside a refusal, never four links that
  would each refuse in turn.
- [x] Keep one design system at two densities — an applicant applies once in a
  lifetime and needs room; an officer works all day and needs density.
- [x] Give applicants a live Dashboard with linked application, enterprise,
  and open-cycle totals; show requested revisions before drafts; name the next
  action from the status guide; surface the nearest closing time; and choose a
  primary action from the account's actual state.
- [x] Give programme staff a live Dashboard with actionable and total intake
  counts, direct filtered-queue links, reference lookup, the five latest
  committee meetings, and quick actions gated by published capabilities.
- [x] Consolidate account details and signed-in devices under General and
  Security settings, while keeping `/settings` and the former sessions address
  as working redirects and offering no unsupported account controls.
- [x] Keep role-aware operational, administrative, guide, and settings
  navigation in a collapsible desktop sidebar and an accessible small-screen
  drawer, with nested routes marking their owning section.
- [x] Keep the gates advisory: every operation is still refused server-side, so
  the client is never the security boundary.
- [ ] Name each role in the account menu by the role's own name, not its key
  re-cased: an officer holding `SBI_BANK` reads "Sbi Bank" where the office
  named the role "SBI Bank". The session carries role keys only, so this needs
  the names read in the same statement as the keys — no extra round trip.

---

## 10. Programme-cycle administration

- [x] Let an administrator create a cycle in `DRAFT` with a unique cycle code,
  display name, policy year, policy reference, opening time, and closing time.
- [x] Require the closing time to be later than the opening time.
- [x] Let an administrator revise a draft cycle while retaining who changed it,
  when, and why.
- [x] Let an administrator open a cycle only when its code, display name, policy
  year, policy reference, opening/closing times, applicant guidance, a
  resolvable form template (required documents are its `FILE` questions), at
  least one kind of application, a published pipeline to pin, and every
  resolved cycle-specific funding limit are present.
- [x] Opening a cycle makes it visible and available for new applicant drafts at
  the stated opening time.
- [x] Let an administrator close a cycle immediately with a required reason, or
  allow it to close automatically at its stated closing time.
- [x] Closing a cycle blocks new applications but does not alter existing
  drafts, submissions, files being worked, or requested resubmissions.
- [x] Let an administrator archive a closed cycle only when none of its
  applications is unfinished — no draft, and no file still at a stage of its
  pipeline.
- [x] Archived cycles remain readable in histories and reports.
- [x] Show the administrator counts of the cycle's applications by status
  before closing or archiving.
- [x] Record a public timeline notice when a cycle's closing time changes after
  it has opened.

---

## 11. Administrative intake and the office-wide view

What happens to a file after submission is configured as a pipeline (§12–§16).
This section is the office's view across every pipeline: finding a file,
reading it, and keeping staff-only notes.

### 11.1 Finding a file

- [x] Support exact lookup by application reference number.
- [x] Paginate every list so large programme years remain usable.
- [x] Do not expose draft applications to staff before formal submission.
- [ ] Filter the office-wide list by pipeline, stage and status flags, and by
  the grant and loan amounts asked for, replacing the nine fixed queues the
  hard-coded workflow had. Each item shows reference number, enterprise,
  applicant, phase, cycle, stage, flags, submission time and last activity.
- [ ] Default ordering is oldest waiting item first; staff may choose newest
  first or last activity without changing other users' defaults.

### 11.2 Reading a file

- [x] Show the exact submitted snapshot, not the applicant's later canonical
  enterprise profile.
- [x] Show every submitted document version associated with that submission.
- [x] Show prior submissions and clearly highlight stages changed in a
  revision.
- [x] Separate applicant-visible timeline entries from staff-only notes.
- [x] Let staff add a dated internal note that cannot alter an applicant answer.
- [x] Internal notes identify their author and cannot be edited or deleted; a
  correction is a new note referring to the earlier one.
- [ ] Scope every read of a file — the workspace, its documents, its notes — to
  the stages the reader's roles own and the files they have acted on, unless
  they hold office-wide `application`/`read`. See
  [RBAC](admin-rbac.md#stage-ownership-is-scope-and-why-a-permission-is-not-enough).
- [ ] Record a transcribed identifier behind a passed check and compare it
  across funding cases. The fixed desk review did this — the ST certificate,
  identity document and bank account, stored as a keyed digest — and it went
  with the desk review. A pipeline action can ask for a number as a text input,
  but nothing compares it across files or keeps it as a digest.

---

## 12. Pipelines: configuring how a file is worked

An application's route after submission is **configured, not coded**. The
office describes it as a pipeline of stages, each worked by the roles that own
it, each offering actions that ask the officer for inputs and then do
configured things to the file. The whole model is the
[pipeline guide](pipeline-guide.md).

- [x] What an action can do is a fixed vocabulary in code — add or remove a
  status flag, record a value, ask the applicant for a revision, notify the
  applicant, keep a staff note, move to a stage, route by a choice, return to
  the previous stage, complete, close. An author combines these but cannot
  invent one, and every one is backed by code the build checks for.
- [x] A pipeline's shape is kept as versions: at most one draft, edited as a
  whole against a revision number, and published versions never change.
- [x] A pipeline is checked as a whole, with every problem listed at once: a
  stage nothing reaches or nothing leaves, no way to finish, an action that
  moves a file twice or moves it and hands it to the applicant at once, a
  choice with an unrouted option, a terminal flag added by anything but an
  ending, an editing flag added by anything but a revision, a return from the
  first stage, an action needing no permission, or a reference to something
  that does not exist.
- [x] A cycle names the pipeline its applications are worked in. Opening pins
  that pipeline's current published version, and every application in the
  cycle is worked in that version, so a later publish never re-routes a file.
- [ ] Let the office create, edit, validate, publish, discard and retire
  pipelines on screen, starting from the worked Mission SEP example, with every
  change recorded in the activity history.
- [x] Refuse to open a cycle whose form cannot carry its pipeline: every answer
  the pipeline reads must be a top-level question of the right type, and a
  pre-filled choice must not offer what its input does not.
- [ ] Move a file already being worked onto a newer published version. Today a
  file finishes in the version it started in.
- [ ] Warn, when a pipeline is checked, about an ending that leaves a progress
  flag on the file: a pipeline whose "Mark the loan fulfilled" completes the
  file without removing `IN_REVIEW` shows a finished file as both "In review"
  and "Completed", to the office and the applicant alike.

---

## 13. Stages and who works them

- [x] Each stage lists the roles that own it, kept as history with who changed
  it and why, rather than overwritten. Ownership is not versioned with the
  pipeline, so adding an officer's role needs no publish.
- [x] The signed-in person's owned stages are resolved live, in the same read
  as their permissions, so removing a role from a stage takes effect on its
  holders' next request.
- [x] Let an office holding `pipeline`/`assign` change a stage's owners with a
  reason, only for roles within their own authority and only at stages they
  own themselves. (The operation; its screen is part of the pipeline editor.)
- [x] Stop an invitation handing out a stage: you may offer a role only if you
  own every stage it owns. Accepting re-checks it against the issuer's stages
  at that moment.
- [ ] Show each officer the stages they own with how many files wait at each,
  and a queue per stage, oldest waiting first.
- [ ] Set a service level per stage and show files waiting beyond it.

---

## 14. Status flags and recorded values

- [x] An application's status is the set of flags it holds, declared by its
  pipeline, each with an office label, an applicant label and explanation, and
  whether the applicant sees it. The code itself owns only two states: a draft,
  and a file in its pipeline.
- [x] A flag is a PROGRESS flag or an OUTCOME flag; changing an OUTCOME flag
  needs `stage`/`decide`.
- [x] A terminal flag ends the journey: the file sits at no stage and no action
  is offered.
- [x] A stage's presence flags are added when a file arrives and removed when
  it leaves, so "at the bank" cannot outlive the file being there.
- [x] Flags the pipeline adds on submission are added the moment a file is
  submitted.
- [x] Only a revision may add a flag that lets the applicant edit, and only the
  applicant's resubmission removes it.
- [x] An action may keep an input as a named recorded value — an approved
  grant, a loan's reference — optionally bounded by an answer the applicant
  gave or by the cycle's ceiling, and the bound is enforced in code whatever is
  configured.
- [ ] Show the applicant where their file is, by the stage's applicant label
  and explanation, and the flags and recorded values the pipeline lets them
  see.

---

## 15. Working a file at a stage

- [x] An action's inputs — an amount, a bank, a note, a reference, a date — use
  the application form's own field types and are validated by the same engine
  as an applicant's answers. An input may be pre-filled from an answer or a
  recorded value, and the officer may change it.
- [x] An action needs every permission its effects need, decided by the code's
  catalogue of effects rather than by the author.
- [x] A return goes only to the stage the file actually came from.
- [x] A choice routes the file to the stage configured for the option chosen,
  and every option must be routed.
- [ ] Offer, on the application page, the actions the officer may take at the
  file's stage, with their inputs, and refuse the same action server-side for
  anybody who does not own the stage.
- [ ] Take an action as one guarded write: two officers acting at once cannot
  both land, and the loser is told the file changed.
- [ ] Ask for and keep a disclosure when an officer acts on their own
  application, recorded in the activity history.
- [ ] Record every action in the activity history with where the file went, the
  flags it gained and lost, what was recorded, and what was entered — never a
  long note's text.
- [ ] Notify the applicant when an action says to, best-effort after the write.
- [ ] Show the applicant's resubmission in a file's stage history, between the
  request for corrections and what the office did next. The history lists
  stage actions only, so "Ask the applicant to correct it" is followed
  directly by the next officer's action with no word that the applicant
  answered, or when.

---

## 16. The Mission SEP route

The route the office described — TTC checks the file, Industries & Commerce
approves the grant and chooses the bank, the chosen bank fulfils the loan — is
a pipeline like any other, shipped as the worked example. Nothing in the code
knows its stage names.

- [x] The example is a complete, valid pipeline: TTC may ask for a revision,
  move the file to Industries & Commerce, or reject it; Industries & Commerce
  may send it back, approve the grant (no more than asked or than the cycle's
  ceiling), send it to the bank pre-filled from the applicant's first choice,
  or complete it when no loan was asked for; each bank may send it back or mark
  the loan fulfilled with an amount, a reference and a sanction date.
- [ ] Author and publish it in the deployed portal, create the TTC, Industries
  & Commerce, State Bank of India and Tripura Gramin Bank roles, and give each
  its stage.
- [ ] Walk one application through every path — the revision loop, a send-back
  from a bank and a re-route to the other, the no-loan completion and a
  rejection — with programme staff.

---

## 17. Money after approval

The hard-coded workflow tracked sanction orders, releases and reversals,
utilization, performance and audit assessments, and recovery of cancelled
support. All of it went with that workflow, and none of it is configured yet.
What a pipeline records today is the approved grant and the loan a bank
fulfilled, as recorded values.

- [ ] Record a sanction order and date, and give the applicant an official
  sanction letter.
- [ ] Record releases against an approved grant as an append-only ledger, with
  reversals rather than edits, and never above what was approved.
- [ ] Record utilization, performance and financial-audit results, per release
  where that is how they are assessed.
- [ ] Open recovery of support cancelled after money was released, with
  demands, receipts, waivers and reversals.
- [ ] Let an eligibility rule read released money and assessment results, so an
  expansion can again require them.

Each is intended as a configurable effect or recorded value rather than a fixed
desk, so a later programme year can ask for less or more without a release.

---

## 18. Notifications and applicant communication

Notifications communicate completed business events. Failure to send a message
must not reverse an otherwise successful submission, decision, or payment
record.

- [x] Put outbound delivery behind an interface that names no provider, so the
  transport is chosen by environment and no caller knows which one it got.
- [ ] Provision a provider key for the deployed environment. The adapter exists
  and refuses rather than printing codes when the key is absent, so a deployed
  environment currently cannot send signup verification codes at all.
- [x] Send a submission acknowledgement containing the application reference,
  the cycle, and a PDF copy of the application as submitted. Best-effort after
  the write, with a failure-only audit action.
- [ ] Notify the applicant when a revision is requested, including the affected
  stages and a portal link.
- [ ] Notify the applicant when a revision resubmission is accepted by the
  portal.
- [ ] Notify the applicant when a stage action says to — an approval, a
  rejection, a move to the bank — using only the text the action configures,
  on their timeline and by email where it is set. The fixed approval and
  sanction notices went with the fixed workflow.
- [ ] Notify the applicant when a release or reversal is recorded (§17).
- [ ] Keep a communication history showing event type, destination, send time,
  and delivered/failed state without storing OTPs or document contents.
- [ ] Let authorized staff retry a failed non-OTP notification without repeating
  the underlying business action.
- [ ] Respect future communication preferences for optional updates; security,
  decision, sanction, and payment notices remain mandatory.
- [ ] Open emailed links through an in-app browser, and send only links whose
  targets have passed malware scanning. Explicitly deferred by the product
  owner on 2026-08-27.

---

## 18a. The public announcement banner

The landing page's notice board is authored content, not hardcoded copy. An
announcer — a role with no casework access, created only by a super
administrator — writes cards the public reads without signing in.

- [x] Let an announcer author a card: a tag chip, a headline, a sentence or
  two, one of a fixed set of pictograms, an optional free-text date label, an
  optional link, an optional end time, and a hidden/draft toggle.
- [x] Validate a card's link by kind before it can ever become an `href`: an
  outside address must be http or https and is stored re-serialized, a site
  path must start with a single `/`, an anchor with `#`.
- [x] Let the announcer arrange the display order, guarded so an order built
  from an outdated board is refused rather than applied.
- [x] Serve the published, unexpired cards to anybody without a session, in
  the arranged order, with an empty banner as an ordinary answer.
- [x] Render the banner on the landing page from the API, hiding the board
  when nothing is published, and give the announcer an authoring screen with
  a live preview of the card as the public will see it.
- [ ] Notify or hand off nothing: a card is content, not a business event —
  revisit only if the office asks for scheduled publication beyond the end
  time it already has.

---

## 19. Search, reports, and programme oversight

- [x] Let staff and applicants find a record by the start of a reference number,
  an enterprise name, or a cycle code, backed by an index rather than a table
  scan.
- [x] State the limit honestly: it is a prefix match, and the interface says
  "starts with" rather than "search". Substring search is not available;
  `pg_trgm` would serve it and is not yet enabled.
- [x] Report a total alongside every paged list, so a page can say where it sits
  in the set and an empty result can distinguish "nothing matches these filters"
  from "nothing here yet".
- [x] Provide counts of submitted applications in every status, filterable by
  cycle — `admin.analytics.summary` groups the queue's own filtered set by
  status, category, sector, district and cycle, with requested-amount totals
  and a monthly series. Drafts are deliberately absent: the summary describes
  the intake, and drafts are not in it.
- [ ] Report unique applicants and enterprises separately so one person with two
  enterprises is not counted as two people.
- [ ] Break down applications by category, sector, phase, gender, and
  application outcome using only authorized programme views. Category, sector
  and district are delivered in the analytics summary; phase, gender and
  outcome views are not.
- [ ] Report sanctioned amount, gross releases, reversals, and net disbursement
  without treating reversals as new payments.
- [ ] Provide ageing reports showing time spent at each pipeline stage.
- [ ] Provide a revision report by form stage to identify common applicant
  difficulties.
- [x] Export the activity history as CSV only for a role holding `audit`/`export`
  as well as `audit`/`read`, and record who exported, when, which filter was
  used, how many rows it carried, and the purpose they gave. No export is
  returned without that record. One file carries at most 10,000 events and
  says when it was cut; exports are limited to five a minute per session.
- [x] The activity-history export carries no passwords, authentication secrets,
  one-time codes, invitation tokens, object keys or document contents, and a
  cell a spreadsheet would run as a formula is neutralized.
- [ ] Exports of the other reports in this section — they do not exist yet, and
  each will need the same authority and the same record of who took it.
- [x] Provide a complete application history in event order: its drafts,
  evidence, submissions, revision requests and notes — every event on the
  application or on any record belonging to it — shown on the office's
  application page and in the activity history by application or by reference
  number. Events the retired fixed workflow recorded stay readable as stored.
- [ ] Include every stage action in that history, with what it did (§15).
- [x] Provide a role-change history for super administrators.
- [x] Let anybody whose role holds `audit`/`read` read the whole recorded
  history, scoped by the people who acted, the people it was about, one
  person's whole history, everybody holding a role, category, action, kind of
  record, one record, application or reference number, outcome, date and
  request, and paged the same way every other list is.
- [x] Read that history from what was actually recorded rather than from a list
  of actions the current code can write, so a filter never offers a dead end.
- [x] Every recorded action says what it did in its own terms — a sign-up the
  address it was for, a decision its outcome and amount, a grant the person,
  the role and the reason — as labelled details and one plain sentence, with
  the people, roles, applications and cycles it names shown by name. Events
  recorded before actions declared their details are shown exactly as stored
  and marked as such.
- [x] Open one entry to see everything it recorded, where the request came
  from, and every other entry the same request produced.
- [x] Reach a person's whole history from their record in Users & access, and a
  role's from its page.
- [ ] Search the text of recorded reasons. It needs `pg_trgm` for an indexed
  substring match, which is not enabled; until then entries are found by the
  filters above.

---

### 19.1 Bounding what one request may ask for

- [x] Clamp `first` on every connection to 1–100 and refuse anything outside,
  rather than silently capping it.
- [x] Limit one document to 500 fields and depth 12, counted at validation
  before any resolver runs. Aliases make a field repeatable, so a per-field
  limit cannot see a document that asks for one expensive operation five hundred
  times; only the whole document can.
- [x] Limit the request body to 64 KB, refused before parsing.
- [x] Cap collections that have no cursor at 500 rows, and signed-in devices at
  100. A collection something adds up is never capped, because a truncated
  ledger would report a wrong figure rather than a short list.

### 19.2 Every operation within its round-trip budget

The [performance rules](rules/performance.md) set a budget per operation shape.
Taking a stage action and every applicant operation meet theirs; the officer's
workspace, the administrative writes and the client do not yet.

- [x] Take a stage action in three round trips whatever its effects, asserted by
  a budget test.
- [x] Read a cycle version's pinned form in one statement, once per request. It
  was six statements, read up to three times in a save or a submit.
- [x] Build an applicant write's response from the write itself rather than
  reloading the application. Each write's response is tested field for field
  against a read made straight after it.
- [x] Fold every applicant write — save, submit, resubmit, start, delete and
  restore, the document writes — into one data-modifying statement with its
  audit row, and pin a submission's documents with one `INSERT … SELECT`.
- [x] Read the kinds an enterprise may start, with the open cycle, in one
  statement rather than two read transactions (nine round trips).
- [x] Send the submission confirmation and stage notifications after the
  response (`src/deferred.ts`, through `waitUntil`).
- [x] Give every applicant operation a budget test
  (`test/service/application-performance.test.ts`).
- [ ] Fold the officer's workspace read (12 round trips) to its budget of three,
  and stop reloading it after an intake write.
- [ ] Give the administrative writes (cycles, forms, roles, enterprises) and
  every screen's read a budget test, and fold what exceeds it.
- [ ] In the client, stop fetching loader-fed queries twice on entry, update the
  cache from mutation responses instead of refetching, and give the
  applications list the progress each row shows so it makes no request per row.

---

## 20. Public-launch readiness

The portal must not be publicly launched until every item in this section is
complete.

- [ ] Provision the approved provider's key. The console transport cannot be
  reached from a delivering environment, but nothing is sent without a key.
- [x] Build a forward path for the schema. `database/schema.sql` is the whole
  schema, and `db:schema:check` proves it is exactly what `src/db/schema` says.
  Deployed databases move forward through the ordered migration chain under
  `database/migrations/`, each file idempotent and rehearsed by
  `check:migration` over seeded data.
- [x] Add signup, sign-in, OTP, upload, and sensitive-action abuse limits. One
  policy names which operations are limited and by how much, counted against
  the caller's address, their session, and the account being acted on; a
  refusal arrives as an ordinary result envelope, and a limiter that cannot
  answer refuses rather than permitting.
- [ ] Count abuse limits over windows longer than a minute. The platform's
  rate-limiting binding accepts a period of ten seconds or sixty and nothing
  else, so "three signups an hour for one address" is expressible only as "two
  a minute" — bulk abuse is stopped, a patient attacker trickling requests is
  not. A Durable Object counts any window; swapping to one changes a single
  transport file and the numbers in the policy.
- [ ] Offer a free self-hosted server option, so the programme can run without
  a paid cloud account. Explicitly deferred by the product owner on
  2026-08-27.
- [ ] Provision the malware scanner's API key and enable it. This is a
  **production** blocker rather than a blanket one: the transport is delivered,
  and `local` and `develop` are usable without it because they record plainly
  that nothing examined the file.
- [x] Complete administrator recovery procedures. Password reset by emailed
  code works for every account, a reset ends every session, and the manual
  route for a lost sole `SUPER_ADMIN` is a documented runbook. The stronger
  organizational-approval recovery in §9.2 remains open.
- [ ] Approve applicant privacy notice, consent text, retention schedule, and
  grievance/contact process.
- [ ] Define who may see application answers, documents, decisions, and reports
  for every staff role.
- [ ] Complete accessibility testing for keyboard use, screen readers, colour
  contrast, error summaries, and mobile layouts.
- [ ] Complete applicant journey testing with realistic low-bandwidth and
  interrupted-upload conditions.
- [ ] Complete pipeline scenario testing with programme staff — every stage
  action, send-backs, revisions, routing between banks, and role loss.
- [ ] Prepare operational procedures for notification failure, document
  rejection, suspected account compromise, incorrect decisions, incorrect
  payments, and service outage.
- [ ] Conduct an independent security and privacy review and close all launch-
  blocking findings.
- [ ] Obtain named policy-owner approval that the implemented validation,
  eligibility, approval, sanction, and expansion rules match the authoritative
  Mission SEP policy.

---

## 21. Explicit policy decisions still required

These are not vague future questions. Each item states the exact decision that
must be supplied before the affected feature can be completed.

- [ ] **Seed-fund ceiling:** TTAADC must provide one authoritative maximum,
  specify whether it is per application, phase, enterprise, or funding case, and
  state whether different cycles/categories have different limits. Until then,
  the portal accepts any positive requested amount and staff decide under the
  prevailing policy.
- [ ] **Administrative approval limits:** TTAADC must define which stage, and
  which role owning it, may approve or reject each monetary range. A pipeline
  can express a range today only as an action offered when an answer is within
  it; until the limits are defined, approving actions must not be publicly
  enabled.
- [ ] **Mission SEP 2026 jurisdiction:** TTAADC must resolve whether eligibility
  is Tripura-wide with TTAADC preference or requires the enterprise to be within
  TTAADC. Until selected explicitly in a cycle, that cycle cannot open.
- [ ] **Over-release handling:** TTAADC must confirm whether exceptional
  releases above the approved grant are ever legal. Nothing records releases
  yet (§17); when it does, the rule blocks them until an authorized correction
  raises the approved amount.
- [ ] **Applicant data retention:** TTAADC must state the retention period after
  rejection, case closure, account closure, and programme archival, including
  document retention. No irreversible business-record deletion should be added
  before this is approved.
- [ ] **Conflict-of-interest oversight:** The current rule allows an
  administrator to act on their own application with a visible warning and
  history. TTAADC must either approve this or define a recusal/second-approval
  rule before admin review launches.
- [ ] **Applicant-visible reasons:** Programme owners must approve reason
  categories and safe message templates for revision, rejection, suspension,
  cancellation, and payment reversal before those actions are exposed.
- [ ] **Who signs off the wording of the questions.** A programme officer now
  owns the words on an applicant's screen: every label, every piece of help text
  and every choice on the form is a cycle's own, not the software's. That is the
  point of the change, and it moves an approval that used to happen implicitly —
  through code review and a deploy — to somewhere nobody has named. Rewording is
  a versioned cycle revision carrying a required reason, and is refused on an
  open cycle, so the trail exists; what does not exist is a decision about whose
  approval it needs.
- [ ] **Who decides an application.** Whoever owns the stage whose action
  approves it, holding `stage`/`decide` — in the worked route, Industries &
  Commerce for the grant and the chosen bank for the loan. The portal has no
  Tripartite Meeting; see [policy alignment](policy-alignment.md), where this
  is the one row that diverges from the TTAADC source rather than interpreting
  it.

## Completion order

The intended delivery order is explicit so later features do not launch without
their prerequisites.

1. Complete and harden programme-cycle administration, pipeline authoring and
   stage casework.
2. Complete pipeline scenario testing with programme staff, then decide which
   of the money after approval (§17) the programme needs configured.
3. Complete administrator recovery before enabling the already implemented
   business workflow publicly. Administrator-only sign-in and role management
   are delivered; account recovery is not.
4. Complete production applicant-account protections, email delivery, and
   malware scanning. Abuse limits are delivered; what remains is counting them
   over windows longer than the minute the platform's binding allows.
5. Complete notifications, reports, privacy/access rules, and operational
   procedures.
6. Resolve every launch-blocking policy decision and finish the public-launch
   checklist.

## TTAADC policy alignment

The detailed [policy alignment crosswalk](policy-alignment.md) identifies what
comes directly from the PDF, what is a user-approved portal decision, and what
is a conservative safeguard. Publication/public launch remains blocked by:

- the contradictory seed-fund ceiling amount and scope;
- the Tripura-versus-TTAADC jurisdiction rule for Mission SEP 2026;
- administrative monetary authority and self-review oversight;
- approved applicant-visible reason catalogues; and
- privacy, retention, staff-access, and malware-scanning approval.

The omission of the ST certificate number is an intentional user-approved
portal decision differing from the paper form; the certificate file remains
mandatory. The partner banks are stages of a pipeline, each owned by its
bank's role, and which banks an applicant may choose are the options of a form
question. The portal has no Tripartite Meeting: an application is decided by
whoever owns the approving stage, which is a divergence from the source rather
than a reading of it.
