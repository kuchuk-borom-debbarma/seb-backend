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

Throughout this document, **administrator** means a signed-in person with an
active `ADMIN` or `SUPER_ADMIN` role. **Super administrator** specifically means
a person with an active `SUPER_ADMIN` role.

## Product model and fixed rules

These rules are already agreed and must remain true throughout the roadmap.

- [x] One person has one portal identity identified by a verified email address.
- [x] One person may own more than one enterprise.
- [x] Each enterprise has one primary portal owner.
- [x] Each enterprise has one long-lived funding case that joins its initial and
  later expansion applications.
- [x] One application represents one funding phase attempted in one programme
  cycle.
- [x] An initial application is always phase 1.
- [x] An expansion application is always phase 2 or higher and must follow the
  immediately preceding funded phase.
- [x] Enterprise Category A/B describes the enterprise's age or maturity. It is
  separate from INITIAL/EXPANSION, which describes the funding phase.
- [x] Application submissions are historical records. Later enterprise or draft
  changes never rewrite what was submitted.
- [x] Business records are retained for history when corrected, replaced, or
  withdrawn.
- [x] The application does not ask for an ST certificate number.
- [x] An ST certificate file remains mandatory when submitting an application.
- [x] The system does not enforce a seed-fund ceiling until the contradictory
  figures in the source documents are resolved by the policy owner.
- [x] Financing components are not required to add up to the total project cost.
- [x] Expansion requires the latest performance and financial-audit results,
  plus every retained release’s latest utilization result, to pass under the
  target cycle’s pinned rules.
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
  provider that actually delivers the code to the applicant's mailbox.
- [ ] Limit repeated registration and code requests by email, device, and network
  so attackers cannot flood applicants or the notification provider.
- [ ] Add a human-verification challenge after suspicious or excessive signup
  activity without blocking normal first-time applicants.

### 1.2 Sign-in and sessions

- [x] A verified applicant signs in with email and password.
- [x] Invalid email/password combinations return the same safe message and do
  not reveal whether an account exists.
- [x] A signed-in applicant can see the current session and all their other
  signed-in sessions.
- [x] An applicant can sign out the current device.
- [x] An applicant can revoke one selected session, every other session, or all
  sessions.
- [x] Removing applicant access stops applicant operations on the next request,
  even if the person was already signed in.
- [ ] Add “forgot password” using a short-lived email verification flow.
- [ ] Allow a password reset to revoke all existing sessions as the default safe
  choice, while clearly informing the applicant before completion.
- [ ] Add a verified-email change flow that confirms both account ownership and
  the new address before the login email changes.
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
  and it has no submitted applications or awards.
- [x] Deleting an enterprise also makes its funding case unavailable.
- [x] Restoring an enterprise restores its funding case in the same action.
- [x] Another applicant cannot delete or restore the enterprise.
- [ ] Add a clear applicant-facing explanation listing the exact applications or
  awards that prevent deletion, instead of returning only a general refusal.

---

## 3. Programme cycles visible to applicants

A programme cycle is a named application window such as Mission SEP 2026. A
cycle controls when new applications may start; it does not erase work already
submitted in an older cycle.

- [x] Applicants can see currently open programme cycles available for new
  applications.
- [x] A new application records the exact cycle rules that applied when its draft
  was started.
- [x] Closing a cycle prevents new applications from starting in it.
- [x] An applicant responding to an official revision request may resubmit after
  the original cycle closes.
- [ ] Show the applicant the cycle name, application opening time, closing time,
  policy reference, and a plain-language status.
- [ ] Show a countdown or explicit closing date in the applicant journey; do not
  rely on colour alone to communicate urgency.
- [ ] Show closed cycles in read-only application history without offering a
  “start application” action.
- [ ] Publish cycle-specific applicant guidance and clearly identify any rule
  that differs from an earlier cycle.

---

## 4. Starting an application

### 4.1 Initial application

- [x] The applicant chooses one owned, active enterprise and one open programme
  cycle.
- [x] Starting an initial application creates phase 1 and copies the enterprise's
  current profile into the first draft.
- [x] The application remains attached to the selected enterprise and its
  funding case for its entire life.
- [x] Only one non-rejected attempt for the same phase may remain active across
  programme cycles.
- [x] Starting the same phase twice in the same cycle is prevented.
- [x] A rejected phase may be attempted again only in a later open cycle.
- [x] The applicant cannot start an application for another person's enterprise.
- [x] The applicant cannot choose a phase number or mark an initial application
  as an expansion.

### 4.2 Expansion application

- [x] The applicant asks the system to check whether the next expansion phase is
  available; the applicant does not type a Phase-II flag.
- [x] The next phase must immediately follow an awarded phase: phase 1 qualifies
  phase 2, phase 2 qualifies phase 3, and so on.
- [x] The qualifying award must be active and belong to the same enterprise and
  funding case.
- [x] At least one release under the qualifying award must retain a positive
  amount after all reversals.
- [x] Total releases minus reversals must remain greater than zero.
- [x] Twelve calendar months must have passed since the first release that still
  retains a positive amount.
- [x] A release on 29 February reaches its one-year anniversary on 28 February
  in a non-leap year.
- [x] A full reversal removes that release from the eligibility calculation; a
  partial reversal retains the original release date.
- [x] A competing active attempt for the next phase blocks a second expansion.
- [x] A rejected expansion can be retried in a later open cycle.
- [x] Deleting an expansion draft releases its claim on the qualifying award.
- [x] Restoring a deleted expansion draft succeeds only if all eligibility rules
  are still true and no replacement application has claimed the award.
- [x] Expansion drafts receive prior sanction, release, net-disbursement, and
  operating-period facts from programme records rather than applicant typing.
- [ ] Explain every failed eligibility check separately to the applicant: missing
  award, inactive award, no positive release, anniversary not reached, or an
  existing competing application.
- [ ] When time is the only unmet rule, show the exact first eligible calendar
  date.

---

## 5. Completing and saving the application form

### 5.1 Draft behaviour

- [x] The applicant can save an incomplete form as a draft.
- [x] Each meaningful save preserves a complete historical snapshot.
- [x] Saving exactly the same information returns the existing draft version
  instead of creating another copy.
- [x] Clearing an optional answer is an explicit action and is retained in the
  new snapshot.
- [x] If the application changed elsewhere after the applicant loaded it, the
  stale save is rejected and the applicant must reload before trying again.
- [x] Submitted versions never change when the applicant later edits an allowed
  revision section.
- [x] The applicant can view only applications belonging to their account.
- [x] The application list is paginated and supports stable continuation through
  large histories.
- [ ] Add user-facing autosave status with the unambiguous states “Saving”,
  “Saved”, and “Could not save”.
- [ ] Add a recovery prompt when the browser has unsaved edits and the applicant
  tries to leave the page.
- [ ] Show “last saved” time and the current draft version without implying that
  a saved draft has been submitted.

### 5.2 Enterprise section

- [x] Record business name, establishment date, CIN/Udyam registration, GSTIN,
  sector, Category A/B, and majority-ownership confirmation.
- [x] Require a description when “Other” is selected as the sector.
- [x] Require registration details and registration evidence when the enterprise
  is declared registered.
- [x] Require GST evidence when a GSTIN is supplied.
- [x] Category A means proposed or established for no more than 24 calendar
  months at submission.
- [x] Category B means established for more than 24 calendar months at
  submission.
- [x] Reject a category that conflicts with the establishment date.
- [x] Require confirmation of the programme's majority-ownership condition at
  submission.

### 5.3 Applicant/promoter section

- [x] Record name, designation, birth date, gender, business address, PIN code,
  phone, and email.
- [x] Require the applicant to be at least 18 and no older than 60 on the date of
  formal submission.
- [x] Accept real calendar dates only, including correct leap-day handling.
- [x] Validate the email, phone, and PIN formats before submission.
- [x] Do not collect an ST certificate number.

### 5.4 Financial section

- [x] Record total project cost, requested seed fund, proposed bank loan, and
  promoter contribution.
- [x] Require total project cost and requested seed fund to be positive.
- [x] Reject negative monetary values.
- [x] Preserve exact rupee-and-paise values without rounding through floating
  point arithmetic.
- [x] Do not require the listed financing components to equal project cost.
- [x] Do not enforce a seed-fund ceiling until TTAADC resolves the source-policy
  contradiction.

### 5.5 Prior support and credit section

- [x] Ask whether the applicant has received prior government funding.
- [x] If yes, require scheme, positive amount, and sanction year.
- [x] If no, allow the dependent scheme, amount, and year fields to remain empty.
- [x] Ask whether the enterprise has existing bank credit.
- [x] If yes, require the bank, positive sanctioned amount, and `STANDARD` or
  `NPA` status.
- [x] If no, allow dependent bank-credit fields to remain empty.

### 5.6 Declaration section

- [x] Record whether the applicant has a declared relationship, the related
  person's details when applicable, and the declaration place.
- [x] Require the applicant to affirm the declaration on every submission and
  resubmission.
- [x] Record a new official acceptance time on every formal submission; the
  applicant cannot choose that time.

---

## 6. Application documents

### 6.1 Required evidence

- [x] Always require identity/age proof, ST certificate, address proof, detailed
  project report, and bank details before submission.
- [x] Require business-registration evidence when the enterprise is registered.
- [x] Require GST evidence when a GSTIN is supplied.
- [x] Require an NOC when the applicant declares that an NOC applies.
- [x] Do not require optional document types when their condition does not apply.

### 6.2 Upload, replacement, and access

- [x] Accept PDF, JPEG, and PNG files up to 10 MB each.
- [x] Reject a file whose actual type does not match its declared type.
- [x] Reject incomplete, altered, oversized, or expired upload attempts.
- [x] Keep application documents private.
- [x] Give the applicant a short-lived download link only after confirming that
  the document belongs to their application.
- [x] Force downloads as attachments rather than displaying untrusted files in
  the portal page.
- [x] Replacing a document creates a new historical version and makes it current.
- [x] Deleting a document is reversible and does not erase earlier uploaded
  versions.
- [x] A concurrent replacement based on an old document version is rejected.
- [x] Temporary uploads that expire or fail validation are marked for cleanup
  without affecting finalized documents.
- [ ] Scan every finalized document for malware before it becomes available to
  programme staff.
- [ ] Show applicants the malware-scan states “Pending”, “Accepted”, and
  “Rejected”, with a safe reason and a replacement action for rejected files.
- [ ] Prevent submission while any required document is awaiting or has failed
  malware scanning.
- [ ] Allow authorized administrators to download accepted evidence only after
  malware scanning is enabled.

---

## 7. Validation, submission, and applicant history

### 7.1 Validation

- [x] The applicant can validate a draft without submitting it.
- [x] Validation groups issues by form section and identifies the exact field and
  correction needed.
- [x] Validation checks required and conditional answers, dates, age, category,
  contact formats, money, declarations, and documents.
- [x] An invalid validation result does not change the draft or application
  status.
- [x] Submission repeats validation so an earlier successful check cannot bypass
  later changes.
- [ ] Add a clickable validation summary that takes the applicant to each invalid
  field or document slot in form order.

### 7.2 First submission

- [x] A valid draft can be submitted once as submission number 1.
- [x] Submission creates a new frozen formal snapshot, even if the last draft was
  already valid.
- [x] The first submission receives one stable Mission SEP reference number.
- [x] The reference number remains unchanged through review, revision, award,
  and later status changes.
- [x] Successful submission changes the application to `SUBMITTED` and records
  an applicant-visible timeline event.
- [x] Two simultaneous submission attempts cannot create duplicate submissions
  or reference numbers.
- [x] A deleted draft cannot be submitted.
- [ ] Show a submission confirmation page containing the reference number,
  submission number, submission time, and a read-only summary.
- [ ] Let the applicant download a human-readable acknowledgement of the exact
  submitted snapshot and document list.

### 7.3 Applicant timeline and status

- [x] The applicant can see the application's current status.
- [x] The applicant can see a chronological, applicant-safe timeline for events
  already recorded on the application.
- [x] The timeline does not expose internal secrets, staff-only notes, or another
  applicant's information.
- [ ] Define and display a plain-language explanation and next action for every
  status: `DRAFT`, `SUBMITTED`, `DESK_REVIEW`, `REVISION_REQUIRED`,
  `PARTNER_BANK_EVALUATION`, `TTM_REVIEW`, `APPROVED`, `REJECTED`,
  `SANCTIONED`, and `DISBURSED`.
- [ ] Show who must act next—applicant or programme office—without showing a
  promised completion date unless staff explicitly set one.

---

## 8. Revision and resubmission

The applicant response and the staff issuance/cancellation workflow both exist.

- [x] A revision request identifies one form section and gives the applicant a
  readable correction note.
- [x] While revision is required, the applicant may edit only sections named by
  unresolved requests.
- [x] Fields outside those sections must remain identical to the last submission.
- [x] Resubmission validates the complete application and all required evidence.
- [x] Resubmission creates a new formal snapshot and the next submission number.
- [x] A successful resubmission resolves all open revision requests through that
  exact submission and returns the application to `SUBMITTED`.
- [x] Resubmission remains available after the original programme cycle closes.
- [x] Let an administrator cancel an incorrect revision request with a reason
  and issue a replacement without editing or hiding the original request.
- [ ] Show revision requests grouped by section with their issue date, note, and
  current state.
- [ ] Clearly mark fields that are locked because no revision was requested for
  their section.
- [ ] Show the applicant a final comparison of changed sections before
  resubmission.

---

## 9. Administrator identity and access

Administrative business operations use existing multi-role sessions. Admin-only
sign-in, MFA, recovery, and later provisioning remain incomplete.

### 9.1 Role rules already established

- [x] `APPLICANT` grants applicant enterprise and application access.
- [x] `ADMIN` is reserved for programme operations, review, awards, and finance.
- [x] `SUPER_ADMIN` includes administrator capabilities and adds user and role
  administration.
- [x] One person may hold more than one role at the same time.
- [x] Role removals take effect on the person's next action rather than waiting
  for sign-out.
- [x] Past grants and revocations remain visible for accountability.
- [x] Public applicant signup cannot create an administrative role.

### 9.2 First administrator and sign-in

- [x] Let a deployment operator promote one predetermined, normally verified
  applicant through a direct command-line operation that is absent from the
  public GraphQL interface.
- [x] Require both that applicant's current password and a temporary random
  bootstrap secret; the request cannot select a different email or role.
- [x] Permanently close bootstrap after the first retained `SUPER_ADMIN` grant,
  including when that grant is later revoked.
- [x] Record the promoted user, time, role grant, and fixed bootstrap reason
  without retaining the password, configured email, or temporary secret.
- [ ] Give administrators a sign-in journey that works for an `ADMIN` or
  `SUPER_ADMIN` who is not also an applicant.
- [ ] Require multi-factor authentication before any administrative operation.
- [ ] Require fresh password confirmation or multi-factor verification before a
  super administrator changes another person's roles.
- [ ] Provide administrative session listing, sign-out, and revoke-all controls.
- [ ] Define account recovery that requires verified organizational approval and
  cannot be completed by email access alone.

### 9.3 User and role management

- [ ] Let a super administrator search users by exact email or public user ID.
- [ ] Show verified email, active roles, account state, and retained role history
  without exposing passwords or private application answers.
- [ ] Let a super administrator grant `ADMIN` or `SUPER_ADMIN` with a mandatory
  reason.
- [ ] Let a super administrator revoke a role with a mandatory reason.
- [ ] Prevent duplicate active grants of the same role.
- [ ] Permit a previously revoked role to be granted again as a new history item.
- [ ] Prevent removal of the last usable `SUPER_ADMIN` account.
- [ ] Prevent a super administrator from accidentally removing their own final
  administrative access without another active super administrator confirming.
- [ ] Show the affected user, role, actor, reason, and time for every grant and
  revocation.
- [ ] Notify the affected person after an administrative role is granted or
  revoked; the notification must not be required for the role change to take
  effect.

---

## 10. Programme-cycle administration

- [x] Let an administrator create a cycle in `DRAFT` with a unique cycle code,
  display name, policy year, policy reference, opening time, and closing time.
- [x] Require the closing time to be later than the opening time.
- [x] Let an administrator revise a draft cycle while retaining who changed it,
  when, and why.
- [x] Let an administrator open a cycle only when its code, display name, policy
  year, policy reference, opening/closing times, applicant guidance, required
  document list, eligibility rules, and every resolved cycle-specific funding
  limit are present.
- [x] Opening a cycle makes it visible and available for new applicant drafts at
  the stated opening time.
- [x] Let an administrator close a cycle immediately with a required reason, or
  allow it to close automatically at its stated closing time.
- [x] Closing a cycle blocks new applications but does not alter existing drafts,
  submissions, reviews, or requested resubmissions.
- [x] Let an administrator archive a closed cycle only after no active intake or
  review action depends on changing that cycle.
- [x] Archived cycles remain readable in histories and reports.
- [x] Show the administrator counts of drafts, submitted applications, and
  applications under review before closing or archiving.
- [x] Record a public timeline notice when a cycle's closing time changes after
  it has opened.

---

## 11. Administrative intake and work queues

### 11.1 Queue visibility

- [ ] Give administrators separate queues for newly submitted, desk review,
  revision responses, partner-bank evaluation, TTM review, approved, rejected,
  sanctioned, and disbursed applications.
- [x] Each queue item shows reference number, enterprise, applicant, phase,
  programme cycle, current status, submission time, and last activity time.
- [x] Support filtering by cycle, status, phase, application type, sector,
  category, and submission-date range.
- [x] Support exact lookup by application reference number.
- [x] Paginate every queue so large programme years remain usable.
- [x] Default ordering is oldest waiting item first; staff may choose newest
  first or last activity without changing other users' defaults.
- [x] Do not expose draft applications to reviewers before formal submission.

### 11.2 Assignment and conflict visibility

- [x] Let an administrator claim an unassigned application for review.
- [x] Show the current assignee and assignment time to all administrators.
- [x] Let the assignee release it back to the queue with a mandatory reason.
- [x] Let another administrator reassign it with a mandatory reason.
- [x] Warn when the reviewer is also the applicant or enterprise owner; allow the
  action under the selected policy and retain the acknowledgement.
- [x] Prevent two administrators from unknowingly completing the same review
  transition from the same old status.

### 11.3 Review workspace

- [x] Show the exact submitted snapshot, not the applicant's later canonical
  enterprise profile.
- [x] Show every submitted document version associated with that submission.
- [x] Show prior submissions and clearly highlight sections changed in a revision.
- [x] Separate applicant-visible timeline entries from staff-only notes.
- [x] Let staff add a dated internal note that cannot alter an applicant answer.
- [x] Internal notes identify their author and cannot be edited or deleted; a
  correction is a new note referring to the earlier one.

---

## 12. Desk review and revision requests

- [x] Starting desk review changes `SUBMITTED` to `DESK_REVIEW` and records the
  reviewer and time.
- [x] A reviewer checks completeness, eligibility declarations, required
  evidence, and consistency between answers and documents.
- [x] The reviewer records one outcome: request revision, advance to partner-bank
  evaluation, or reject.
- [x] A revision request names exactly one editable section and contains a clear,
  applicant-safe correction instruction.
- [x] Multiple sections require separate revision requests so each issue can be
  tracked and resolved.
- [x] Issuing one or more requests changes the application to
  `REVISION_REQUIRED` and exposes the requests in the applicant workflow.
- [ ] Send a notification when one or more revision requests are issued.
- [x] A reviewer cannot request edits to server-derived award or expansion facts.
- [x] A mistaken open request can be cancelled with a reason and replaced; its
  original text remains in history.
- [x] A revision response returns to the submitted queue and may be reviewed by
  the same or a different administrator.
- [x] Advancing the application requires all review checks and revision requests
  to be resolved.
- [x] Rejection requires a standard reason category plus a plain-language reason
  visible to the applicant.
- [x] Rejection is final for that cycle attempt but does not erase the
  application or prevent an eligible later-cycle retry.

---

## 13. Partner-bank evaluation

Partner-bank verification remains an offline programme activity for now. There
is no separate bank user or bank portal in this roadmap.

- [x] An administrator sends an eligible application to partner-bank evaluation
  and records the bank name, referral reference, and referral date.
- [x] The applicant sees that evaluation is in progress but does not see
  staff-only bank correspondence.
- [x] An administrator records the offline bank outcome as recommended, not
  recommended, or more information required.
- [x] A recorded outcome includes the decision date, decision reference, and a
  safe summary.
- [x] “More information required” creates section-specific revision requests and
  returns the applicant to the normal revision flow.
- [x] “Recommended” advances the application to TTM review.
- [x] “Not recommended” also advances to TTM review; bank feedback is advisory
  evidence and TTM records the programme decision and applicant-safe reason.
- [x] Replacement bank outcomes remain additional history entries; an earlier
  outcome is never overwritten.

---

## 14. TTM review and programme decision

- [x] Administrators can place applications with either positive or negative
  bank feedback into a TTM meeting
  agenda identified by meeting reference and date.
- [x] The agenda shows the exact submission and bank outcome being considered.
- [x] Each application receives one recorded meeting outcome: approved, rejected,
  deferred, or revision required.
- [x] Approval records the approved amount, decision reference, decision date,
  conditions, and authorized actor.
- [x] Rejection records a standard category and applicant-safe reason.
- [x] Deferral records the next required programme action and does not pretend the
  application is approved or rejected.
- [x] Revision required uses the existing section-specific applicant revision
  flow.
- [x] A decision correction creates a superseding decision with a mandatory
  reason and identifies the administrator who made the correction; the original
  decision remains visible.
- [x] The applicant sees the final outcome and safe conditions, but not internal
  deliberations or staff-only notes.

---

## 15. Sanction and funding awards

- [x] An approved application may receive at most one active funding award.
- [x] Creating an award requires the sanctioned application, funding case,
  unique sanction order, sanction date, sanctioned amount, and administrator.
- [x] The award is tied to the exact application and phase that earned it.
- [x] The sanction amount must be positive and cannot be silently changed after
  publication.
- [x] Corrections create a new award version with a reason while preserving the
  prior values.
- [x] Award states are active, suspended, cancelled, and closed.
- [x] Suspending or cancelling an award requires a reason and immediately blocks
  new releases.
- [x] Closing an award requires the programme to state whether all planned
  releases are complete or the remaining amount will not be released.
- [ ] The applicant can see sanction order, sanction date, sanctioned amount,
  award status, and applicant-safe conditions.
- [ ] The applicant can download an official sanction letter generated or
  uploaded by an administrator.
- [x] Award creation changes the application to `SANCTIONED` and records an
  applicant-visible timeline event.

---

## 16. Disbursements and corrections

- [x] Administrators can record a positive release against an active
  award with occurrence date, external payment reference, amount, and recorder.
- [x] External payment references are unique so the same payment is not recorded
  twice.
- [x] Releases appear in chronological programme history with an unambiguous
  sequence number.
- [x] A mistaken release is corrected by a positive reversal linked to that
  release; the original release is never edited or deleted.
- [x] A reversal cannot exceed the unreversed amount of its related release.
- [x] A reversal must belong to the same award as its related release.
- [ ] The award view shows sanctioned amount, gross releases, reversals, net
  released amount, and remaining planned amount.
- [x] Recording the first successful release changes the application to
  `DISBURSED` and records an applicant-visible event.
- [x] Later releases keep the status `DISBURSED` and add separate timeline items.
- [x] Every release records its TTM approval reference/date, verified payment
  prerequisites, and actual payment in one transition.
- [x] Every release creates its own utilization obligation due 180 UTC calendar
  days after that release.
- [ ] The applicant sees payment date, amount, safe reference, and whether an
  amount was reversed; internal banking credentials are never shown.
- [x] Releasing more than the currently sanctioned amount requires an explicit
  corrected award amount before the release can be recorded.

---

## 17. Assessments and post-award monitoring

- [x] Administrators can record utilization, performance, and financial-audit
  assessments against an award.
- [x] Each assessment has a type, assessment number, date, passed/failed outcome,
  assessor, evidence reference, and applicant-safe summary.
- [x] A reassessment creates the next assessment number for that type and does
  not overwrite the earlier result.
- [ ] The latest assessment of each type is clearly identified while the complete
  history remains readable.
- [x] Failed assessments can trigger award suspension only through a separate,
  reasoned administrative action; recording “failed” alone does not silently
  change the award.
- [ ] The applicant can see the applicant-safe outcome and required follow-up but
  not internal reviewer notes.
- [x] Expansion requires every positively retained release’s latest utilization
  result and the latest performance and financial-audit results to pass.

### 17.1 Support cancellation and recovery

- [x] A cancelled award with net released funds may open one active recovery
  case using an official decision reference.
- [x] Staff record principal and penal-interest demands, receipts, waivers, and
  compensating reversals without editing earlier entries.
- [x] Penal interest is entered from an external official calculation; the
  portal does not invent a rate.
- [x] A reversal references a same-case, same-component original entry and
  cannot exceed its unreversed amount.
- [x] Recovery closes only when the guarded write observes a zero derived
  balance.
- [x] An erroneously opened recovery can be cancelled with a retained reason
  only while its ledger is empty; cases with entries use compensating
  corrections and zero-balance closure.
- [ ] Add court proceedings, statutory notices, hearings, and payment-collection
  integrations if TTAADC later requires them.

---

## 18. Notifications and applicant communication

Notifications communicate completed business events. Failure to send a message
must not reverse an otherwise successful submission, decision, or payment
record.

- [ ] Send production email for signup verification codes.
- [ ] Send a submission acknowledgement containing the application reference and
  submission number.
- [ ] Notify the applicant when a revision is requested, including the affected
  sections and a portal link.
- [ ] Notify the applicant when a revision resubmission is accepted by the
  portal.
- [ ] Notify the applicant of approval, rejection, sanction, suspension,
  cancellation, and closure using only applicant-safe text.
- [ ] Notify the applicant when a release or reversal is recorded.
- [ ] Keep a communication history showing event type, destination, send time,
  and delivered/failed state without storing OTPs or document contents.
- [ ] Let authorized staff retry a failed non-OTP notification without repeating
  the underlying business action.
- [ ] Respect future communication preferences for optional updates; security,
  decision, sanction, and payment notices remain mandatory.

---

## 19. Search, reports, and programme oversight

- [ ] Provide cycle-level counts for started drafts, submitted, under review,
  revision required, approved, rejected, sanctioned, and disbursed applications.
- [ ] Report unique applicants and enterprises separately so one person with two
  enterprises is not counted as two people.
- [ ] Break down applications by category, sector, phase, gender, and application
  outcome using only authorized programme views.
- [ ] Report sanctioned amount, gross releases, reversals, and net disbursement
  without treating reversals as new payments.
- [ ] Provide ageing reports showing time spent in each review stage.
- [ ] Provide a revision report by section and reason category to identify common
  applicant difficulties.
- [ ] Allow exports only to authorized administrators and record who exported,
  when, which filters were used, and the purpose.
- [ ] Exports exclude passwords, authentication secrets, private document links,
  and staff-only security data.
- [ ] Provide a complete application history showing submissions, status changes,
  revision requests, decisions, awards, releases, reversals, and assessments in
  event order.
- [ ] Provide a role-change history for super administrators.

---

## 20. Public-launch readiness

The portal must not be publicly launched until every item in this section is
complete.

- [ ] Replace console-only email delivery with the approved production provider.
- [ ] Add signup, sign-in, OTP, upload, and sensitive-action abuse limits.
- [ ] Enable malware scanning before staff can open applicant documents.
- [ ] Require administrator multi-factor authentication.
- [ ] Complete administrator provisioning and recovery procedures.
- [ ] Approve applicant privacy notice, consent text, retention schedule, and
  grievance/contact process.
- [ ] Define who may see application answers, documents, decisions, and reports
  for every staff role.
- [ ] Complete accessibility testing for keyboard use, screen readers, colour
  contrast, error summaries, and mobile layouts.
- [ ] Complete applicant journey testing with realistic low-bandwidth and
  interrupted-upload conditions.
- [ ] Complete administrative review, decision, award, reversal, and role-loss
  scenario testing with programme staff.
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
- [ ] **Administrative approval limits:** TTAADC must define which role may
  approve, reject, sanction, suspend, cancel, reverse, or correct each monetary
  range. Until defined, these actions must not be publicly enabled.
- [ ] **Mission SEP 2026 jurisdiction:** TTAADC must resolve whether eligibility
  is Tripura-wide with TTAADC preference or requires the enterprise to be within
  TTAADC. Until selected explicitly in a cycle, that cycle cannot open.
- [ ] **Award over-release handling:** TTAADC must confirm whether exceptional
  releases above the original sanction are ever legal. The planned rule blocks
  them until an authorized award correction raises the sanctioned amount.
- [ ] **Applicant data retention:** TTAADC must state the retention period after
  rejection, case closure, account closure, and programme archival, including
  document retention. No irreversible business-record deletion should be added
  before this is approved.
- [ ] **Conflict-of-interest oversight:** The current rule allows an administrator
  to act on their own application with a visible warning and history. TTAADC
  must either approve this or define a recusal/second-approval rule before admin
  review launches.
- [ ] **Applicant-visible reasons:** Programme owners must approve reason
  categories and safe message templates for revision, rejection, suspension,
  cancellation, and payment reversal before those actions are exposed.

## Completion order

The intended delivery order is explicit so later features do not launch without
their prerequisites.

1. Complete and harden programme-cycle administration and the current
   applicant-plus-administrator operational workflow.
2. Complete intake, review, partner-bank, TTM, award, release, assessment, and
   recovery scenario testing with programme staff.
3. Complete administrator-only sign-in, multi-factor authentication, role
   management, and recovery before enabling the already implemented business
   workflow publicly.
4. Complete production applicant-account protections, email delivery, malware
   scanning, and abuse limits.
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
mandatory. Bank roster publication uses governed cycle free text, and both
positive and negative bank feedback proceed to TTM.
