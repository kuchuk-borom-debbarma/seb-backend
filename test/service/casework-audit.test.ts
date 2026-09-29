/**
 * What the history says about a file worked from submission to decision.
 *
 * These rows were written by hand-built SQL that recorded an action and an id
 * and nothing else: a decision's history did not say what was decided, a bank
 * outcome did not say what the bank answered, and none of them said whose file
 * it was. Each assertion here is a fact the history must now carry on its own,
 * without a join back to the record it describes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { workedFile, type AuditRow } from './support/worked-file'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const payloadOf = (rows: AuditRow[], action: string) => rows.find((row) => row.action === action)?.payload

describe('the history of a worked file', () => {
  it('says what was decided, for how much, and on whose file', async () => {
    const file = await workedFile()
    expect(await file.decide(await file.live())).toMatchObject({ success: true })
    const rows = await file.rows()

    expect(payloadOf(rows, 'SEB.DECISION_RECORDED')).toMatchObject({
      outcome: 'APPROVED',
      approvedAmountPaise: 900_000,
      requestedAmountPaise: 10_000_000,
      reference: `DEC-${file.applicationId}`,
      date: '2026-06-15',
      revisionCount: 0,
    })
    expect(payloadOf(rows, 'SEB.BANK_OUTCOME_RECORDED')).toMatchObject({
      outcome: 'RECOMMENDED',
      availableLoanAmountPaise: 500_000,
      decisionDate: '2026-05-10',
    })
    expect(payloadOf(rows, 'SEB.BANK_REFERRED')).toMatchObject({
      bankName: 'Tripura Gramin Bank',
      referralReference: `REF-${file.applicationId}`,
    })
    expect(payloadOf(rows, 'SEB.DESK_REVIEW_COMPLETED')).toMatchObject({
      outcome: 'ADVANCE_TO_BANK',
      checkCount: 9,
      failedCheckCount: 0,
      identifierCount: 3,
      revisionCount: 0,
    })
    expect(rows.filter((row) => row.action === 'SEB.SELF_REVIEW_DISCLOSED')
      .map((row) => row.payload?.stage)).toEqual(['DESK_REVIEW', 'DECISION'])
  })

  it('files every row under the application and its applicant, as a typed row', async () => {
    const file = await workedFile()
    expect(await file.decide(await file.live())).toMatchObject({ success: true })
    const rows = await file.rows()

    expect(rows.map((row) => row.action)).toContain('SEB.DECISION_RECORDED')
    for (const row of rows) {
      expect(row, row.action).toMatchObject({
        application_id: file.applicationId,
        subject_user_id: file.applicantId,
        payload_version: 1,
        metadata_json: null,
      })
    }
  })

  it('records nothing for a decision the version guard refused', async () => {
    const file = await workedFile()
    const stale = await file.decide((await file.live()) - 1)
    expect(stale.success).toBe(false)
    const rows = await file.rows()
    expect(rows.map((row) => row.action)).not.toContain('SEB.DECISION_RECORDED')
    expect(rows.filter((row) => row.payload?.stage === 'DECISION')).toEqual([])
  })
})
