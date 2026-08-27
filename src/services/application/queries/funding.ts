/**
 * Applicant-facing reads of the funding records an administrator created.
 *
 * Awards, releases, reversals, and assessments are written entirely by the
 * administrative service; nothing here mutates them. What this module owns is
 * the boundary: which of those retained fields an applicant may see, and how
 * the append-only ledger is presented to somebody who wants to know what they
 * were paid rather than to audit an accounting journal.
 */
import { and, asc, eq, isNull } from 'drizzle-orm'
import { batch, type Database } from '../../../db'
import { sebAwardAssessment, sebDisbursement, sebFundingAward } from '../../../db/schema'
import { foldDisbursementLedger } from '../ledger'
import type { ApplicantFunding } from '../types'

/**
 * Loads one application's funding outcome, or null when it has no award yet.
 *
 * Three bounded reads and an in-memory fold, mirroring the administrative
 * workspace: the number of releases or assessments never multiplies queries.
 */
export const findApplicantFunding = async (
  db: Database,
  applicationId: string,
): Promise<ApplicantFunding | null> => {
  const [award] = await db
    .select()
    .from(sebFundingAward)
    .where(
      and(
        eq(sebFundingAward.applicationId, applicationId),
        isNull(sebFundingAward.deletedAt),
      ),
    )
    .limit(1)
  if (!award) return null

  /*
   * One statement, not 2. Every read here is single-table, so `db.batch` maps
   * the results back correctly — a joined read could not go in here, because a
   * batch is read back by column name and two columns called `id` collide.
   */
  const [entries, assessments] = await batch(db, (tx) => [
    db
      .select()
      .from(sebDisbursement)
      .where(eq(sebDisbursement.fundingAwardId, award.id))
      .orderBy(asc(sebDisbursement.sequenceNumber)),
    db
      .select()
      .from(sebAwardAssessment)
      .where(eq(sebAwardAssessment.fundingAwardId, award.id))
      // Chronological, because an applicant reads this as a history. The id
      // breaks ties so two results recorded in the same millisecond still have
      // a stable order.
      .orderBy(asc(sebAwardAssessment.assessedAt), asc(sebAwardAssessment.id)),
  ])

  const ledger = foldDisbursementLedger(entries)

  /**
   * Groups assessments the way they are actually numbered.
   *
   * Utilization is assessed once per release obligation and numbered within
   * that obligation, so two releases both carry a utilization assessment
   * number 1. Performance and financial audit apply to the award as a whole and
   * carry no obligation. Grouping by type alone would therefore mark one
   * release's utilization result as superseding another's.
   */
  const assessmentSeries = (assessment: { assessmentType: string; utilizationObligationId: string | null }) =>
    `${assessment.assessmentType}:${assessment.utilizationObligationId ?? ''}`

  // The latest result of each series is identified rather than filtered, so the
  // complete history stays readable behind the current one.
  const latestNumberBySeries = new Map<string, number>()
  for (const assessment of assessments) {
    const series = assessmentSeries(assessment)
    // Taking the maximum rather than trusting the read order: the rows arrive
    // by assessment time, which is administrator-supplied and so need not run
    // in the same direction as the numbering.
    latestNumberBySeries.set(
      series,
      Math.max(latestNumberBySeries.get(series) ?? 0, assessment.assessmentNumber),
    )
  }

  return {
    award: {
      sanctionOrderNumber: award.sanctionOrderNumber,
      sanctionDate: award.sanctionDate,
      sanctionedAmountPaise: award.sanctionedAmountPaise,
      applicantConditions: award.applicantConditions,
      status: award.status,
      closureDisposition: award.closureDisposition,
      grossReleasedPaise: ledger.grossReleasedPaise,
      reversedPaise: ledger.reversedPaise,
      netReleasedPaise: ledger.netReleasedPaise,
      // A corrected award can be amended downwards below what was already
      // released, so the remainder is clamped rather than reported negative.
      remainingPlannedPaise: Math.max(
        0,
        award.sanctionedAmountPaise - ledger.netReleasedPaise,
      ),
    },
    // Reversals are folded into the release they correct instead of being
    // listed as their own entries. The applicant asked what they were paid, not
    // for the ledger: "₹X on this date, of which ₹Y was reversed" answers that.
    //
    // Every other release column stays internal: the approval reference,
    // bank-account verification, performance agreement, and physical
    // verification are programme-office prerequisites, not payment facts.
    releases: ledger.releases.map(({ release, reversedAmountPaise }) => ({
      sequenceNumber: release.sequenceNumber,
      occurredAt: release.occurredAt,
      amountPaise: release.amountPaise,
      paymentReference: release.externalReference,
      reversedAmountPaise,
    })),
    // `evidenceReference` and `internalNote` are deliberately absent: the first
    // points at programme-office filing, the second is reviewer-only.
    assessments: assessments.map((assessment) => ({
      assessmentType: assessment.assessmentType,
      assessmentNumber: assessment.assessmentNumber,
      outcome: assessment.outcome,
      assessedAt: assessment.assessedAt,
      summary: assessment.applicantSummary,
      latest:
        latestNumberBySeries.get(assessmentSeries(assessment)) === assessment.assessmentNumber,
    })),
  }
}
