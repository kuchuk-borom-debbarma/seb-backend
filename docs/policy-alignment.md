# Mission SEP policy alignment

This crosswalk separates the authoritative six-page TTAADC Mission SEP policy
and application form from product decisions made for the portal. The source is
the TTAADC Mission SEP policy and application form — the six-page document
issued by the council. It is not checked into this repository; obtain it from
the programme office. The UI/UX flow guide may improve presentation, but it is
not a policy source.

The PDF establishes the business sequence used here: TTAADC desk scrutiny,
partner-bank appraisal, consideration and decision, sanction and release,
then Phase-II only after twelve months and successful utilization, performance,
and financial audit. “Portal behaviour” below is never presented as a quotation
from TTAADC unless the source says it unambiguously.

## Crosswalk

| Subject | TTAADC source | Current portal behaviour | Classification |
| --- | --- | --- | --- |
| Seed-fund ceiling | The document contains both `₹5,000,000` and “5 Lacs”. | A cycle records `UNRESOLVED`; no amount or scope is enforced until TTAADC confirms both. | Awaiting TTAADC decision |
| ST certificate number | The paper form asks for a number. | The portal deliberately omits the number, while the ST certificate file remains mandatory. | Intentional user-approved product decision |
| Applicant declaration | The paper form contains a declaration and relationship details. | The portal deliberately removes the declaration, related-person fields, acceptance, place, and acceptance timestamp from the applicant journey and retained application record. Final submission remains an explicit applicant action from Review. | Intentional user-approved portal policy divergence |
| Jurisdiction | The policy says Tripura, preferably TTAADC; the form says the unit must be within TTAADC. | Every published cycle must select `TRIPURA` or `TTAADC`; the 2026 selection cannot be published as confirmed policy without TTAADC direction. | Awaiting TTAADC decision |
| Category B and Phase-II | Paper wording can appear to combine enterprise expansion concepts. | Category A/B describes enterprise maturity. `INITIAL`/`EXPANSION` and phase number describe funding sequence. | Conservative portal safeguard |
| Phase-II assessment | Phase-II follows successful utilization, performance, and financial audit after twelve months. | The target cycle must require all three and the latest applicable result must be `PASSED`; utilization is checked separately for every retained release. | Aligned with source |
| Utilization deadline | Utilization certificate is due within 180 days; multiple tranches are not specified. | Every release creates its own obligation due 180 UTC calendar days later. | Conservative portal safeguard |
| Bank authority | TTM considers bank appraisal and reaches the programme decision. | Both recommended and not-recommended outcomes proceed to the decision stage. A bank outcome alone never rejects the application. | Aligned with source |
| **Who decides** | **The source names a Tripartite Meeting as what reaches the programme decision.** | **The portal has no meeting. An application that clears the bank stage is decided directly by a holder of `DECIDE`, and the decision pins the submission and bank outcome that were read.** | **Divergence from source — needs TTAADC sight** |
| Bank roster | The policy calls for a dynamic public partner-bank roster. | A cycle publishes governed free text; each referral freezes the bank name and optional branch typed by staff. | Intentional user-approved product decision |
| Approval amount | The source does not expressly discuss approving more than requested. | An approval cannot exceed the exact requested amount in the frozen submission. | Conservative portal safeguard |
| Release approval | TTM approves releases. | One atomic staff action records the approval evidence and the actual payment entry. | Intentional user-approved product decision |
| Later phases | The source explicitly describes Phase-II. | Phase 2 is the first expansion; the data model supports later phases without claiming that TTAADC has approved them. | Intentional user-approved product decision |
| Penal interest | Recovery may include penal interest, but no rate is stated. | Staff enter an externally calculated amount and official reference; the portal never invents a rate. | Aligned with source |

## Rules taken directly into the workflow

- Desk review covers identity/KYC, ST evidence, ownership, jurisdiction,
  completeness, document consistency, DPR feasibility, and expansion evidence.
- Partner-bank feedback is recorded as evidence, not treated as the final
  authority.
- The programme records approval, rejection, or a stage-specific revision.
- A sanction is created only from the latest effective approval, and release
  evidence retains the approval reference.
- Expansion uses the preceding phase’s active award, a positively retained
  release, the calendar waiting period, and required passed assessments.
- Corrections append new evidence. Previous submissions, bank outcomes,
  decisions, payments, assessments, and recovery entries are never overwritten.

## Decisions still required from TTAADC

1. Confirm the ceiling amount and whether it applies per application, phase,
   enterprise, or complete funding case.
2. Select the Mission SEP 2026 jurisdiction rule: all Tripura, preference for
   TTAADC, or mandatory TTAADC location.
3. Approve the cycle-specific reason catalogue and applicant-safe templates.
4. Define which administrative authority may approve or correct each monetary
   range and whether self-review requires a second approval.
5. Approve privacy, retention, staff-access, and document-scanning policy before
   public launch.
6. Confirm that a decision taken by one authorised officer satisfies the source's
   Tripartite Meeting, or say what the portal must record instead. **This is the
   one row above where the portal does not do what the source describes.** The
   meeting was removed because nothing about it was ever minuted — no quorum,
   attendance, membership or chair was recorded anywhere — so what it added was a
   second permission, held jointly and bounded in time, rather than a record of
   who deliberated. Two things went with it and are not recoverable from the
   data: that applications were considered *as a set, in a stated order*, and the
   audit questions of who put one before the committee and who took it off.

Until these decisions are recorded in an opened programme cycle, the portal
uses the conservative behaviours above and remains blocked from public launch.
