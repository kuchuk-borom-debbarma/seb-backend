# Mission SEP policy alignment

This crosswalk separates the authoritative six-page TTAADC Mission SEP policy
and application form from product decisions made for the portal. The source is
the TTAADC Mission SEP policy and application form — the six-page document
issued by the council. It is not checked into this repository; obtain it from
the programme office. The UI/UX flow guide may improve presentation, but it is
not a policy source.

The PDF establishes a business sequence: TTAADC desk scrutiny, partner-bank
appraisal, consideration and decision, sanction and release, then Phase-II only
after twelve months and successful utilization, performance, and financial
audit. The portal no longer fixes that sequence in code. What happens after
submission is a configured **pipeline** of stages, each owned by the roles that
work it (see the [pipeline guide](pipeline-guide.md)), and which kinds of
application a cycle accepts, and who may start each, are the cycle's own
eligibility rules. So most rows below say what the portal *can* be configured
to do and what the worked Mission SEP route does, rather than what the code
insists on. “Portal behaviour” is never presented as a quotation from TTAADC
unless the source says it unambiguously.

## Crosswalk

| Subject | TTAADC source | Current portal behaviour | Classification |
| --- | --- | --- | --- |
| Seed-fund ceiling | The document contains both `₹5,000,000` and “5 Lacs”. | A cycle records `UNRESOLVED`; no amount or scope is enforced until TTAADC confirms both. | Awaiting TTAADC decision |
| ST certificate number | The paper form asks for a number. | The portal deliberately omits the number, while the ST certificate file remains mandatory. | Intentional user-approved product decision |
| Jurisdiction | The policy says Tripura, preferably TTAADC; the form says the unit must be within TTAADC. | Every published cycle must select `TRIPURA` or `TTAADC`; the 2026 selection cannot be published as confirmed policy without TTAADC direction. | Awaiting TTAADC decision |
| Category B and Phase-II | Paper wording can appear to combine enterprise expansion concepts. | Category A/B describes enterprise maturity. The application's kind and phase number describe the funding sequence. | Conservative portal safeguard |
| Phase-II eligibility | Phase-II follows successful utilization, performance, and financial audit after twelve months. | A cycle declares an expansion kind with eligibility rules — for example, an earlier application holding `GRANT_APPROVED` for at least twelve months. Utilization, performance and audit results are **not recorded** since the fixed workflow was replaced, so no rule can require them yet. | Gap — money after approval is not yet configured |
| Utilization deadline | Utilization certificate is due within 180 days; multiple tranches are not specified. | Not tracked: releases and their obligations went with the fixed workflow. | Gap — money after approval is not yet configured |
| Bank authority | TTM considers bank appraisal and reaches the programme decision. | In the worked route, Industries & Commerce approves the grant and sends the file to the bank; the bank marks the loan fulfilled or sends the file back. A bank does not reject the application; only a configured `CLOSE_APPLICATION` action does, and in the worked route only TTC has one. | Configured; worked route aligned with source |
| **Who decides** | **The source names a Tripartite Meeting as what reaches the programme decision.** | **The portal has no meeting. An application is decided by whoever owns the stage whose action approves it and holds `stage`/`decide` — in the worked route, Industries & Commerce for the grant. The action records what the officer entered, and the file keeps the submission that was read.** | **Divergence from source — needs TTAADC sight** |
| Bank roster | The policy calls for a dynamic public partner-bank roster. | The banks are data: each is a stage of the pipeline owned by that bank's role, and the banks an applicant may choose are the options of a form question (the State Bank of India and the Tripura Gramin Bank in the default form). Adding a bank is a new stage, owner role and option — a configuration change, not a release. | Intentional user-approved product decision |
| Approval amount | The source does not expressly discuss approving more than requested. | An approving action may bound the approved amount by the amount the applicant asked for and by the cycle's ceiling; the worked route does both, and the bound is enforced in code whatever the author configures. | Conservative portal safeguard |
| Release approval | TTM approves releases. | Not tracked: releases went with the fixed workflow. | Gap — money after approval is not yet configured |
| Later phases | The source explicitly describes Phase-II. | Kinds are the cycle's; a phase number counts the earlier applications of earlier kinds, so later phases are expressible without claiming that TTAADC has approved them. | Intentional user-approved product decision |
| Penal interest | Recovery may include penal interest, but no rate is stated. | Not tracked: recovery went with the fixed workflow. When it returns, staff will enter an externally calculated amount; the portal will not invent a rate. | Gap — money after approval is not yet configured |

## Rules the portal keeps whatever is configured

- Scrutiny is a stage the office configures. What TTC checks — identity and
  KYC, ST evidence, ownership, jurisdiction, completeness, document
  consistency, DPR feasibility — is the officer's judgement at that stage; the
  fixed nine-item checklist went with the fixed desk review.
- A stage may approve, reject, or ask the applicant for a revision of named form
  stages; which it may do is configured, and each needs its own permission.
- A file returned by a stage goes back only to the stage it came from, and a
  revision returns to the stage that asked for it.
- An approval bound by the requested amount or the ceiling is enforced in code.
- Corrections append new evidence. Previous submissions and every stage action
  are kept; nothing a stage recorded is overwritten by a later one.

## Decisions still required from TTAADC

1. Confirm the ceiling amount and whether it applies per application, phase,
   enterprise, or complete funding case.
2. Select the Mission SEP 2026 jurisdiction rule: all Tripura, preference for
   TTAADC, or mandatory TTAADC location.
3. Approve the applicant-safe wording of the configured actions that reach an
   applicant — revision requests, rejections and notices.
4. Define which stage, and which role owning it, may approve each monetary
   range, and whether acting on one's own application requires a second
   approval.
5. Approve privacy, retention, staff-access, and document-scanning policy before
   public launch.
6. Confirm that a decision taken by one authorised officer owning the approving
   stage satisfies the source's Tripartite Meeting, or say what the portal must
   record instead. **This is the
   one row above where the portal does not do what the source describes.** The
   meeting was removed because nothing about it was ever minuted — no quorum,
   attendance, membership or chair was recorded anywhere — so what it added was a
   second permission, held jointly and bounded in time, rather than a record of
   who deliberated. Two things went with it and are not recoverable from the
   data: that applications were considered *as a set, in a stated order*, and the
   audit questions of who put one before the committee and who took it off.

7. Say which money after approval the portal must track — sanction orders,
   releases, utilization, performance and audit results, recovery — before an
   expansion kind can require them.

Until these decisions are recorded in an opened programme cycle, the portal
uses the conservative behaviours above and remains blocked from public launch.
