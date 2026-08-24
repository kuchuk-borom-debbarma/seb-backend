import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const insertUser = async (id = crypto.randomUUID()) => {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_user (
        id, email, password_hash, email_verified_at, row_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, `${id}@example.test`, 'unused-test-password-hash', now, now, now),
    env.DB.prepare(
      `INSERT INTO core_user_role_grant (
        id, user_id, role, grant_reason, granted_at
      ) VALUES (?, ?, 'APPLICANT', 'TEST_FIXTURE', ?)`,
    ).bind(crypto.randomUUID(), id, now),
  ])
  return id
}

const insertEnterprise = async (
  userId: string,
  enterpriseId = crypto.randomUUID(),
  name = `Enterprise ${enterpriseId}`,
) => {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seb_enterprise (
        id, portal_owner_user_id, current_name, registration_type, status,
        current_version, created_at, updated_at
      ) VALUES (?, ?, ?, 'NONE', 'ACTIVE', 1, ?, ?)`,
    ).bind(enterpriseId, userId, name, now, now),
    env.DB.prepare(
      `INSERT INTO seb_enterprise_version (
        id, enterprise_id, version, change_type, changed_by_user_id, created_at,
        name, registration_type, status
      ) VALUES (?, ?, 1, 'CREATED', ?, ?, ?, 'NONE', 'ACTIVE')`,
    ).bind(crypto.randomUUID(), enterpriseId, userId, now, name),
  ])
  return enterpriseId
}

const insertCycle = async (userId: string, cycleId = crypto.randomUUID()) => {
  const now = Date.now()
  const code = `TEST-${cycleId}`
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle (
        id, cycle_code, display_name, cycle_year, status, current_version, created_at, updated_at
      ) VALUES (?, ?, 'Mission SEP Test Cycle', 2026, 'OPEN', 1, ?, ?)`,
    ).bind(cycleId, code, now, now),
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle_version (
        id, programme_cycle_id, version, cycle_code, display_name, cycle_year, status,
        change_type, changed_by_user_id, created_at
      ) VALUES (?, ?, 1, ?, 'Mission SEP Test Cycle', 2026, 'OPEN', 'CREATED', ?, ?)`,
    ).bind(crypto.randomUUID(), cycleId, code, userId, now),
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle_reason (
        id, programme_cycle_id, programme_cycle_version, context, code, label, created_at
      ) VALUES (?, ?, 1, 'RELEASE_REVERSAL', 'TEST_REVERSAL', 'Test reversal', ?)`,
    ).bind(`reversal-${cycleId}`, cycleId, now),
    env.DB.prepare(
      `INSERT INTO seb_programme_cycle_reason (
        id, programme_cycle_id, programme_cycle_version, context, code, label, created_at
      ) VALUES (?, ?, 1, 'AWARD_CLOSURE', 'TEST_CLOSURE', 'Test closure', ?)`,
    ).bind(`closure-${cycleId}`, cycleId, now),
  ])
  return cycleId
}

const insertCase = async (
  userId: string,
  enterpriseId: string,
  caseId = crypto.randomUUID(),
) => {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seb_funding_case (
        id, enterprise_id, status, current_version, created_at, updated_at
      ) VALUES (?, ?, 'OPEN', 1, ?, ?)`,
    ).bind(caseId, enterpriseId, now, now),
    env.DB.prepare(
      `INSERT INTO seb_funding_case_version (
        id, funding_case_id, version, status, change_type, changed_by_user_id, created_at
      ) VALUES (?, ?, 1, 'OPEN', 'CREATED', ?, ?)`,
    ).bind(crypto.randomUUID(), caseId, userId, now),
  ])
  return caseId
}

interface ApplicationInput {
  userId: string
  enterpriseId: string
  caseId: string
  cycleId: string
  applicationId?: string
  type?: 'INITIAL' | 'EXPANSION'
  phase?: number
  status?: string
}

const insertApplication = async ({
  userId,
  enterpriseId,
  caseId,
  cycleId,
  applicationId = crypto.randomUUID(),
  type = 'INITIAL',
  phase = 1,
  status = 'DRAFT',
}: ApplicationInput) => {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO seb_application (
      id, applicant_user_id, enterprise_id, funding_case_id, programme_cycle_id,
      application_type, phase_number, current_version, status, status_version,
      status_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`,
  )
    .bind(
      applicationId,
      userId,
      enterpriseId,
      caseId,
      cycleId,
      type,
      phase,
      status,
      now,
      now,
      now,
    )
    .run()
  return applicationId
}

const createGraph = async () => {
  const userId = await insertUser()
  const enterpriseId = await insertEnterprise(userId)
  const caseId = await insertCase(userId, enterpriseId)
  const cycleId = await insertCycle(userId)
  const applicationId = await insertApplication({ userId, enterpriseId, caseId, cycleId })
  return { userId, enterpriseId, caseId, cycleId, applicationId }
}

const insertAward = async (
  userId: string,
  caseId: string,
  applicationId: string,
  awardId = crypto.randomUUID(),
) => {
  const now = Date.now()
  const order = `ORDER-${awardId}`
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO seb_funding_award (
        id, funding_case_id, application_id, sanction_order_number, sanction_date,
        sanctioned_amount_paise, status, current_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '2026-08-01', 10000000, 'ACTIVE', 1, ?, ?)`,
    ).bind(awardId, caseId, applicationId, order, now, now),
    env.DB.prepare(
      `INSERT INTO seb_funding_award_version (
        id, funding_award_id, version, sanction_order_number, sanction_date,
        sanctioned_amount_paise, status, change_type, changed_by_user_id, created_at
      ) VALUES (?, ?, 1, ?, '2026-08-01', 10000000, 'ACTIVE', 'CREATED', ?, ?)`,
    ).bind(crypto.randomUUID(), awardId, order, userId, now),
  ])
  return awardId
}

describe('core and Mission SEP schema', () => {
  it('creates all domain tables with restricted foreign keys and lookup indexes', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND (name LIKE 'core_%' OR name LIKE 'seb_%')
       ORDER BY name`,
    ).all<{ name: string }>()

    expect(tables.results.map(({ name }) => name)).toEqual([
      'core_audit_event',
      'core_schema_migration',
      'core_session',
      'core_signup_challenge',
      'core_user',
      'core_user_role_grant',
      'seb_application',
      'seb_application_assignment_event',
      'seb_application_document',
      'seb_application_document_scan',
      'seb_application_document_version',
      'seb_application_event',
      'seb_application_internal_note',
      'seb_application_qualifying_award',
      'seb_application_qualifying_award_version',
      'seb_application_submission',
      'seb_application_submission_document',
      'seb_application_version',
      'seb_award_assessment',
      'seb_desk_review',
      'seb_desk_review_check',
      'seb_desk_review_identifier',
      'seb_disbursement',
      'seb_document_upload_intent',
      'seb_enterprise',
      'seb_enterprise_version',
      'seb_funding_award',
      'seb_funding_award_version',
      'seb_funding_case',
      'seb_funding_case_version',
      'seb_partner_bank_outcome',
      'seb_partner_bank_referral',
      'seb_partner_bank_referral_version',
      'seb_programme_cycle',
      'seb_programme_cycle_assessment_rule',
      'seb_programme_cycle_document_rule',
      'seb_programme_cycle_event',
      'seb_programme_cycle_identifier_rule',
      'seb_programme_cycle_reason',
      'seb_programme_cycle_version',
      'seb_recovery_case',
      'seb_recovery_case_version',
      'seb_recovery_entry',
      'seb_revision_request',
      'seb_ttm_agenda_item',
      'seb_ttm_agenda_item_version',
      'seb_ttm_decision',
      'seb_ttm_meeting',
      'seb_ttm_meeting_version',
      'seb_utilization_obligation',
    ])

    for (const table of tables.results.map(({ name }) => name)) {
      const keys = await env.DB.prepare(`PRAGMA foreign_key_list('${table}')`).all<{
        on_delete: string
      }>()
      expect(keys.results.every(({ on_delete }) => on_delete === 'RESTRICT')).toBe(true)
    }

    const indexes = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index'`,
    ).all<{ name: string }>()
    expect(indexes.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'core_session_expiry_idx',
        'core_user_role_grant_active_uq',
        'core_user_role_grant_user_idx',
        'core_user_role_grant_role_idx',
        'seb_enterprise_owner_idx',
        'seb_application_case_phase_idx',
        'seb_funding_award_case_idx',
        'seb_disbursement_award_occurred_idx',
        'seb_application_qualifying_award_version_number_uq',
      ]),
    )
  })

  it('retains fixed multi-role grants and permits only one active copy', async () => {
    const userId = await insertUser()
    const now = Date.now()
    const adminGrantId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (
          id, user_id, role, granted_by_user_id, grant_reason, granted_at
        ) VALUES (?, ?, 'ADMIN', ?, 'TEST_ADMIN_GRANT', ?)`,
      ).bind(adminGrantId, userId, userId, now),
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (
          id, user_id, role, granted_by_user_id, grant_reason, granted_at
        ) VALUES (?, ?, 'SUPER_ADMIN', ?, 'TEST_SUPER_ADMIN_GRANT', ?)`,
      ).bind(crypto.randomUUID(), userId, userId, now),
    ])

    const active = await env.DB.prepare(
      `SELECT role FROM core_user_role_grant
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY role`,
    )
      .bind(userId)
      .all<{ role: string }>()
    expect(active.results.map(({ role }) => role)).toEqual([
      'ADMIN',
      'APPLICANT',
      'SUPER_ADMIN',
    ])

    await expect(
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (
          id, user_id, role, grant_reason, granted_at
        ) VALUES (?, ?, 'NOT_A_ROLE', 'INVALID', ?)`,
      )
        .bind(crypto.randomUUID(), userId, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (
          id, user_id, role, grant_reason, granted_at
        ) VALUES (?, ?, 'ADMIN', 'DUPLICATE', ?)`,
      )
        .bind(crypto.randomUUID(), userId, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `UPDATE core_user_role_grant
         SET revoked_by_user_id = ? WHERE id = ?`,
      )
        .bind(userId, adminGrantId)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `UPDATE core_user_role_grant
         SET revoked_at = ?, revocation_reason = 'IMPOSSIBLE_HISTORY'
         WHERE id = ?`,
      )
        .bind(now - 1, adminGrantId)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (
          id, user_id, role, grant_reason, granted_at
        ) VALUES (?, 'missing-user', 'ADMIN', 'INVALID_OWNER', ?)`,
      )
        .bind(crypto.randomUUID(), now)
        .run(),
    ).rejects.toThrow()

    await env.DB.prepare(
      `UPDATE core_user_role_grant
       SET revoked_by_user_id = ?, revoked_at = ?, revocation_reason = 'ROLE_CHANGED'
       WHERE id = ?`,
    )
      .bind(userId, now + 1, adminGrantId)
      .run()
    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (
        id, user_id, role, granted_by_user_id, grant_reason, granted_at
      ) VALUES (?, ?, 'ADMIN', ?, 'ROLE_REGRANTED', ?)`,
    )
      .bind(crypto.randomUUID(), userId, userId, now + 2)
      .run()

    expect(
      await env.DB.prepare(
        `SELECT count(*) AS total,
          sum(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM core_user_role_grant WHERE user_id = ? AND role = 'ADMIN'`,
      )
        .bind(userId)
        .first(),
    ).toEqual({ total: 2, active: 1 })
  })

  it('allows many enterprises per user while enforcing owner and case scope', async () => {
    const ownerId = await insertUser()
    const otherUserId = await insertUser()
    const firstEnterpriseId = await insertEnterprise(ownerId)
    const secondEnterpriseId = await insertEnterprise(ownerId)
    const firstCaseId = await insertCase(ownerId, firstEnterpriseId)
    const secondCaseId = await insertCase(ownerId, secondEnterpriseId)
    const cycleId = await insertCycle(ownerId)

    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM seb_enterprise WHERE portal_owner_user_id = ?`,
      )
        .bind(ownerId)
        .first(),
    ).toEqual({ count: 2 })
    await expect(insertCase(ownerId, firstEnterpriseId)).rejects.toThrow()
    await expect(
      insertApplication({
        userId: otherUserId,
        enterpriseId: firstEnterpriseId,
        caseId: firstCaseId,
        cycleId,
      }),
    ).rejects.toThrow()
    await expect(
      insertApplication({
        userId: ownerId,
        enterpriseId: firstEnterpriseId,
        caseId: secondCaseId,
        cycleId,
      }),
    ).rejects.toThrow()
  })

  it('keeps enterprise, policy, and phase snapshots unchanged when heads change', async () => {
    const graph = await createGraph()
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO seb_application_version (
        id, application_id, version, programme_cycle_id, programme_cycle_version,
        application_type, phase_number, change_type, changed_by_user_id, created_at,
        business_name, contact_email
      ) VALUES (?, ?, 1, ?, 1, 'INITIAL', 1, 'INITIAL', ?, ?,
        'Original Enterprise', 'old@example.test')`,
    )
      .bind(
        crypto.randomUUID(),
        graph.applicationId,
        graph.cycleId,
        graph.userId,
        now,
      )
      .run()

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE seb_enterprise SET current_name = 'Renamed Enterprise',
         current_version = 2, updated_at = ? WHERE id = ?`,
      ).bind(now + 1, graph.enterpriseId),
      env.DB.prepare(
        `INSERT INTO seb_enterprise_version (
          id, enterprise_id, version, change_type, change_reason,
          changed_by_user_id, created_at, name, registration_type, status
        ) VALUES (?, ?, 2, 'UPDATED', 'Legal name changed', ?, ?,
          'Renamed Enterprise', 'NONE', 'ACTIVE')`,
      ).bind(crypto.randomUUID(), graph.enterpriseId, graph.userId, now + 1),
      env.DB.prepare(
        `UPDATE seb_programme_cycle SET policy_reference = 'POLICY-V2',
         current_version = 2, updated_at = ? WHERE id = ?`,
      ).bind(now + 1, graph.cycleId),
      env.DB.prepare(
        `INSERT INTO seb_programme_cycle_version (
          id, programme_cycle_id, version, cycle_code, display_name, cycle_year, policy_reference,
          status, change_type, changed_by_user_id, created_at
        ) SELECT ?, id, 2, cycle_code, display_name, cycle_year, 'POLICY-V2', status,
          'UPDATED', ?, ? FROM seb_programme_cycle WHERE id = ?`,
      ).bind(crypto.randomUUID(), graph.userId, now + 1, graph.cycleId),
      env.DB.prepare(
        `UPDATE seb_application SET application_type = 'EXPANSION', phase_number = 2,
         current_version = 2, updated_at = ? WHERE id = ?`,
      ).bind(now + 1, graph.applicationId),
      env.DB.prepare(
        `INSERT INTO seb_application_version (
          id, application_id, version, programme_cycle_id, programme_cycle_version,
          application_type, phase_number, change_type, change_reason,
          changed_by_user_id, created_at
        ) VALUES (?, ?, 2, ?, 2, 'EXPANSION', 2, 'SAVE',
          'Moved to the revised policy cycle', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        graph.applicationId,
        graph.cycleId,
        graph.userId,
        now + 1,
      ),
    ])

    expect(
      await env.DB.prepare(
        `SELECT business_name AS businessName, contact_email AS contactEmail,
          programme_cycle_version AS cycleVersion, application_type AS applicationType,
          phase_number AS phaseNumber
         FROM seb_application_version WHERE application_id = ? AND version = 1`,
      )
        .bind(graph.applicationId)
        .first(),
    ).toEqual({
      businessName: 'Original Enterprise',
      contactEmail: 'old@example.test',
      cycleVersion: 1,
      applicationType: 'INITIAL',
      phaseNumber: 1,
    })
  })

  it('enforces initial and generic expansion phase rules', async () => {
    const graph = await createGraph()
    const now = Date.now()
    await expect(
      insertApplication({
        ...graph,
        applicationId: crypto.randomUUID(),
        type: 'INITIAL',
        phase: 2,
      }),
    ).rejects.toThrow()

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_application_version (
          id, application_id, version, programme_cycle_id, programme_cycle_version,
          application_type, phase_number, change_type, changed_by_user_id, created_at
        ) VALUES (?, ?, 2, ?, 99, 'INITIAL', 1, 'SAVE', ?, ?)`,
      )
        .bind(crypto.randomUUID(), graph.applicationId, graph.cycleId, graph.userId, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      insertApplication({
        ...graph,
        applicationId: crypto.randomUUID(),
        type: 'EXPANSION',
        phase: 1,
      }),
    ).rejects.toThrow()
    await insertApplication({
      ...graph,
      applicationId: crypto.randomUUID(),
      type: 'EXPANSION',
      phase: 2,
    })
    await insertApplication({
      ...graph,
      applicationId: crypto.randomUUID(),
      type: 'EXPANSION',
      phase: 3,
    })

    expect(
      await env.DB.prepare(
        `SELECT phase_number AS phase FROM seb_application
         WHERE funding_case_id = ? AND application_type = 'EXPANSION'
         ORDER BY phase_number`,
      )
        .bind(graph.caseId)
        .all(),
    ).toMatchObject({ results: [{ phase: 2 }, { phase: 3 }] })
  })

  it('accepts nullable drafts and binds submissions to exact versions', async () => {
    const graph = await createGraph()
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO seb_application_version (
        id, application_id, version, programme_cycle_id, programme_cycle_version,
        application_type, phase_number, change_type, changed_by_user_id, created_at
      ) VALUES (?, ?, 1, ?, 1, 'INITIAL', 1, 'INITIAL', ?, ?)`,
    )
      .bind(crypto.randomUUID(), graph.applicationId, graph.cycleId, graph.userId, now)
      .run()
    await env.DB.prepare(
      `INSERT INTO seb_application_submission (
        id, application_id, submission_number, application_version,
        submitted_by_user_id, submitted_at
      ) VALUES (?, ?, 1, 1, ?, ?)`,
    )
      .bind(crypto.randomUUID(), graph.applicationId, graph.userId, now)
      .run()

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_application_submission (
          id, application_id, submission_number, application_version,
          submitted_by_user_id, submitted_at
        ) VALUES (?, ?, 2, 2, ?, ?)`,
      )
        .bind(crypto.randomUUID(), graph.applicationId, graph.userId, now)
        .run(),
    ).rejects.toThrow()

    for (const [field, value] of [
      ['majority_ownership_confirmed', 2],
      ['continuous_operation_months', -1],
      ['seed_fund_requested_paise', -1],
      ['business_sector', 'NOT_A_SECTOR'],
    ] as const) {
      await expect(
        env.DB.prepare(
          `INSERT INTO seb_application_version (
            id, application_id, version, programme_cycle_id, programme_cycle_version,
            application_type, phase_number, change_type, changed_by_user_id,
            created_at, ${field}
          ) VALUES (?, ?, 2, ?, 1, 'INITIAL', 1, 'SAVE', ?, ?, ?)`,
        )
          .bind(
            crypto.randomUUID(),
            graph.applicationId,
            graph.cycleId,
            graph.userId,
            now,
            value,
          )
          .run(),
      ).rejects.toThrow()
    }
  })

  it('scopes and versions qualifying-award links without deleting corrections', async () => {
    const first = await createGraph()
    const firstAwardId = await insertAward(
      first.userId,
      first.caseId,
      first.applicationId,
    )
    const expansionId = await insertApplication({
      ...first,
      applicationId: crypto.randomUUID(),
      type: 'EXPANSION',
      phase: 2,
    })
    await expect(
      insertAward(first.userId, first.caseId, first.applicationId),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_funding_award (
          id, funding_case_id, application_id, sanction_order_number, sanction_date,
          sanctioned_amount_paise, status, current_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '2026-08-02', 1, 'ACTIVE', 1, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          first.caseId,
          expansionId,
          `ORDER-${firstAwardId}`,
          Date.now(),
          Date.now(),
        )
        .run(),
    ).rejects.toThrow()

    const linkId = crypto.randomUUID()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_application_qualifying_award (
          id, application_id, funding_case_id, current_funding_award_id, status,
          current_version, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`,
      ).bind(linkId, expansionId, first.caseId, firstAwardId, first.userId, now, now),
      env.DB.prepare(
        `INSERT INTO seb_application_qualifying_award_version (
          id, qualifying_award_link_id, funding_case_id, version, funding_award_id,
          status, change_type, changed_by_user_id, created_at
        ) VALUES (?, ?, ?, 1, ?, 'ACTIVE', 'LINKED', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        linkId,
        first.caseId,
        firstAwardId,
        first.userId,
        now,
      ),
    ])

    // One award can back only one current attempt. Rejected/deleted attempts
    // first clear their pointer, after which the immutable version keeps the
    // historic association and a later application can reuse the award.
    const competingExpansionId = await insertApplication({
      ...first,
      applicationId: crypto.randomUUID(),
      type: 'EXPANSION',
      phase: 3,
    })
    await expect(env.DB.prepare(
        `INSERT INTO seb_application_qualifying_award (
          id, application_id, funding_case_id, current_funding_award_id, status,
          current_version, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          competingExpansionId,
          first.caseId,
          firstAwardId,
          first.userId,
          now,
          now,
        )
        .run()).rejects.toThrow()

    // A link cannot smuggle in an award from another funding case.
    const second = await createGraph()
    const otherCaseAwardId = await insertAward(
      second.userId,
      second.caseId,
      second.applicationId,
    )
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_application_qualifying_award (
          id, application_id, funding_case_id, current_funding_award_id, status,
          current_version, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          competingExpansionId,
          first.caseId,
          otherCaseAwardId,
          first.userId,
          now,
          now,
        )
        .run(),
    ).rejects.toThrow()

    // Correcting the association keeps the original award in version 1.
    const replacementSourceApplicationId = await insertApplication({
      ...first,
      applicationId: crypto.randomUUID(),
      type: 'EXPANSION',
      phase: 4,
    })
    const replacementAwardId = await insertAward(
      first.userId,
      first.caseId,
      replacementSourceApplicationId,
    )
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE seb_application_qualifying_award
         SET current_funding_award_id = ?, current_version = 2, updated_at = ?
         WHERE id = ? AND current_version = 1`,
      ).bind(replacementAwardId, now + 1, linkId),
      env.DB.prepare(
        `INSERT INTO seb_application_qualifying_award_version (
          id, qualifying_award_link_id, funding_case_id, version, funding_award_id,
          status, change_type, change_reason, changed_by_user_id, created_at
        ) VALUES (?, ?, ?, 2, ?, 'ACTIVE', 'CORRECTED',
          'Corrected qualifying award', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        linkId,
        first.caseId,
        replacementAwardId,
        first.userId,
        now + 1,
      ),
    ])

    // Cancellation clears only the current pointer; immutable versions remain.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE seb_application_qualifying_award
         SET current_funding_award_id = NULL, status = 'CANCELLED', current_version = 3,
           updated_at = ?, cancelled_at = ?, cancelled_by_user_id = ?,
           cancellation_reason = 'Application withdrawn'
         WHERE id = ? AND current_version = 2`,
      ).bind(now + 2, now + 2, first.userId, linkId),
      env.DB.prepare(
        `INSERT INTO seb_application_qualifying_award_version (
          id, qualifying_award_link_id, funding_case_id, version, funding_award_id,
          status, change_type, change_reason, changed_by_user_id, created_at
        ) VALUES (?, ?, ?, 3, ?, 'CANCELLED', 'CANCELLED',
          'Application withdrawn', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        linkId,
        first.caseId,
        replacementAwardId,
        first.userId,
        now + 2,
      ),
    ])

    expect(
      await env.DB.prepare(
        `SELECT version, funding_award_id AS awardId, status
         FROM seb_application_qualifying_award_version
         WHERE qualifying_award_link_id = ? ORDER BY version`,
      )
        .bind(linkId)
        .all(),
    ).toMatchObject({
      results: [
        { version: 1, awardId: firstAwardId, status: 'ACTIVE' },
        { version: 2, awardId: replacementAwardId, status: 'ACTIVE' },
        { version: 3, awardId: replacementAwardId, status: 'CANCELLED' },
      ],
    })

    // The old award is reusable by a different expansion after the current
    // association moves away from it. A link root remains one-to-one with its
    // application; retries receive their own application and link roots.
    const retryExpansionId = await insertApplication({
      ...first,
      applicationId: crypto.randomUUID(),
      type: 'EXPANSION',
      phase: 5,
    })
    await env.DB.prepare(
      `INSERT INTO seb_application_qualifying_award (
        id, application_id, funding_case_id, current_funding_award_id, status,
        current_version, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        retryExpansionId,
        first.caseId,
        firstAwardId,
        first.userId,
        now + 3,
        now + 3,
      )
      .run()
  })

  it('keeps disbursements as a positive, ordered, same-award ledger', async () => {
    const first = await createGraph()
    const awardId = await insertAward(first.userId, first.caseId, first.applicationId)
    const releaseId = crypto.randomUUID()
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, amount_paise,
        occurred_at, external_reference, ttm_approval_reference, ttm_approval_date,
        bank_account_verified_at, performance_agreement_reference,
        performance_agreement_executed_at, physical_verification_required,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 1, 'RELEASE', 5000000, ?, 'BANK-RELEASE-1',
        'TTM-TEST', '2025-01-01', ?, 'AGREEMENT-TEST', ?, 0,
        'Test release.', ?, ?)`,
    )
      .bind(releaseId, awardId, now, now, now, first.userId, now)
      .run()
    await env.DB.prepare(
      `INSERT INTO seb_disbursement (
        id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
        amount_paise, occurred_at, external_reference, reason_category_id,
        applicant_message, recorded_by_user_id, created_at
      ) VALUES (?, ?, 2, 'REVERSAL', ?, 1000000, ?, 'BANK-REVERSAL-1',
        (SELECT id FROM seb_programme_cycle_reason WHERE context = 'RELEASE_REVERSAL' LIMIT 1),
        'Test reversal.', ?, ?)`,
    )
      .bind(crypto.randomUUID(), awardId, releaseId, now + 1, first.userId, now + 1)
      .run()

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, recorded_by_user_id, created_at
        ) VALUES (?, ?, 3, 'REVERSAL', 1, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, now, first.userId, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, external_reference, recorded_by_user_id, created_at
        ) VALUES (?, ?, 2, 'RELEASE', 1, ?, 'ANOTHER-REFERENCE', ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, now, first.userId, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, external_reference, recorded_by_user_id, created_at
        ) VALUES (?, ?, 3, 'RELEASE', 1, ?, 'BANK-RELEASE-1', ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, now, first.userId, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, amount_paise,
          occurred_at, recorded_by_user_id, created_at
        ) VALUES (?, ?, 3, 'RELEASE', 0, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, now, first.userId, now)
        .run(),
    ).rejects.toThrow()
    const second = await createGraph()
    const secondAwardId = await insertAward(second.userId, second.caseId, second.applicationId)
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_disbursement (
          id, funding_award_id, sequence_number, entry_type, related_disbursement_id,
          amount_paise, occurred_at, recorded_by_user_id, created_at
        ) VALUES (?, ?, 1, 'REVERSAL', ?, 1, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), secondAwardId, releaseId, now, second.userId, now)
        .run(),
    ).rejects.toThrow()
  })

  it('requires an explicit disposition whenever an award or award version is closed', async () => {
    const graph = await createGraph()
    const awardId = await insertAward(graph.userId, graph.caseId, graph.applicationId)
    const now = Date.now()

    await expect(
      env.DB.prepare(
        `UPDATE seb_funding_award SET status = 'CLOSED', updated_at = ? WHERE id = ?`,
      ).bind(now, awardId).run(),
    ).rejects.toThrow()

    await env.DB.prepare(
      `UPDATE seb_funding_award
       SET status = 'CLOSED', closure_disposition = 'RELEASES_COMPLETE',
           current_version = 2, updated_at = ?
       WHERE id = ?`,
    ).bind(now, awardId).run()

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_funding_award_version (
          id, funding_award_id, version, sanction_order_number, sanction_date,
          sanctioned_amount_paise, status, change_type, reason_category_id,
          changed_by_user_id, created_at
        ) VALUES (?, ?, 2, ?, '2026-08-01', 10000000, 'CLOSED',
          'STATUS_CHANGED', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), awardId, `ORDER-${awardId}`,
        `closure-${graph.cycleId}`, graph.userId, now,
      ).run(),
    ).rejects.toThrow()

    await env.DB.prepare(
      `INSERT INTO seb_funding_award_version (
        id, funding_award_id, version, sanction_order_number, sanction_date,
        sanctioned_amount_paise, status, closure_disposition, change_type,
        reason_category_id, changed_by_user_id, created_at
      ) VALUES (?, ?, 2, ?, '2026-08-01', 10000000, 'CLOSED',
        'RELEASES_COMPLETE', 'STATUS_CHANGED', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), awardId, `ORDER-${awardId}`,
      `closure-${graph.cycleId}`, graph.userId, now,
    ).run()

    expect(await env.DB.prepare(
      `SELECT status, closure_disposition AS disposition
       FROM seb_funding_award WHERE id = ?`,
    ).bind(awardId).first()).toEqual({
      status: 'CLOSED',
      disposition: 'RELEASES_COMPLETE',
    })
  })

  it('retains reassessment history and validates its type, outcome, and ordering key', async () => {
    const graph = await createGraph()
    const awardId = await insertAward(graph.userId, graph.caseId, graph.applicationId)
    const now = Date.now()
    for (const [number, outcome] of [
      [1, 'FAILED'],
      [2, 'PASSED'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO seb_award_assessment (
          id, funding_award_id, assessment_type, assessment_number, outcome,
          evidence_reference, applicant_summary, assessed_by_user_id, assessed_at, created_at
        ) VALUES (?, ?, 'PERFORMANCE', ?, ?, 'EVIDENCE-TEST', 'Test result.', ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, number, outcome, graph.userId, now + number, now)
        .run()
    }

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_award_assessment (
          id, funding_award_id, assessment_type, assessment_number, outcome,
          evidence_reference, applicant_summary, assessed_by_user_id, assessed_at, created_at
        ) VALUES (?, ?, 'PERFORMANCE', 2, 'PASSED', 'EVIDENCE-TEST', 'Test result.', ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, graph.userId, now, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_award_assessment (
          id, funding_award_id, assessment_type, assessment_number, outcome,
          evidence_reference, applicant_summary, assessed_by_user_id, assessed_at, created_at
        ) VALUES (?, ?, 'UNKNOWN', 3, 'PASSED', 'EVIDENCE-TEST', 'Test result.', ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, graph.userId, now, now)
        .run(),
    ).rejects.toThrow()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_award_assessment (
          id, funding_award_id, assessment_type, assessment_number, outcome,
          evidence_reference, applicant_summary, assessed_by_user_id, assessed_at, created_at
        ) VALUES (?, ?, 'PERFORMANCE', 1, 'UNKNOWN', 'EVIDENCE-TEST', 'Test result.', ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), awardId, graph.userId, now, now)
        .run(),
    ).rejects.toThrow()

    expect(
      await env.DB.prepare(
        `SELECT assessment_number AS number, outcome FROM seb_award_assessment
         WHERE funding_award_id = ? ORDER BY assessment_number`,
      )
        .bind(awardId)
        .all(),
    ).toMatchObject({
      results: [
        { number: 1, outcome: 'FAILED' },
        { number: 2, outcome: 'PASSED' },
      ],
    })
  })

  it('retains immutable R2 versions when a logical document is soft-deleted', async () => {
    const graph = await createGraph()
    const documentId = crypto.randomUUID()
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO seb_application_document (
        id, application_id, document_type, current_version, created_at, updated_at
      ) VALUES (?, ?, 'ST_CERTIFICATE', 1, ?, ?)`,
    )
      .bind(documentId, graph.applicationId, now, now)
      .run()
    await env.DB.prepare(
      `INSERT INTO seb_application_document_version (
        id, document_id, version, operation, r2_object_key, original_filename,
        content_type, size_bytes, checksum, uploaded_by_user_id, created_at
      ) VALUES (?, ?, 1, 'UPLOAD', ?, 'certificate.pdf', 'application/pdf',
        128, 'sha256:test', ?, ?)`,
    )
      .bind(crypto.randomUUID(), documentId, `objects/${crypto.randomUUID()}`, graph.userId, now)
      .run()
    await env.DB.prepare(
      `UPDATE seb_application_document SET deleted_at = ?, deleted_by_user_id = ?,
       delete_reason = 'APPLICANT_REMOVED' WHERE id = ?`,
    )
      .bind(now + 1, graph.userId, documentId)
      .run()

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_application_document (
          id, application_id, document_type, current_version, created_at, updated_at
        ) VALUES (?, ?, 'ST_CERTIFICATE', 1, ?, ?)`,
      )
        .bind(crypto.randomUUID(), graph.applicationId, now, now)
        .run(),
    ).rejects.toThrow()

    expect(
      await env.DB.prepare(
        `SELECT
          (SELECT count(*) FROM seb_application_document WHERE id = ?) AS documents,
          (SELECT count(*) FROM seb_application_document_version WHERE document_id = ?) AS versions`,
      )
        .bind(documentId, documentId)
        .first(),
    ).toEqual({ documents: 1, versions: 1 })
  })

  it('keeps submissions, revisions, and events scoped to one application', async () => {
    const first = await createGraph()
    const second = await createGraph()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_application_version (
          id, application_id, version, programme_cycle_id, programme_cycle_version,
          application_type, phase_number, change_type, changed_by_user_id, created_at
        ) VALUES (?, ?, 1, ?, 1, 'INITIAL', 1, 'INITIAL', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        first.applicationId,
        first.cycleId,
        first.userId,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO seb_application_version (
          id, application_id, version, programme_cycle_id, programme_cycle_version,
          application_type, phase_number, change_type, changed_by_user_id, created_at
        ) VALUES (?, ?, 1, ?, 1, 'INITIAL', 1, 'INITIAL', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        second.applicationId,
        second.cycleId,
        second.userId,
        now,
      ),
    ])
    const firstSubmissionId = crypto.randomUUID()
    const secondSubmissionId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_application_submission (
          id, application_id, submission_number, application_version,
          submitted_by_user_id, submitted_at
        ) VALUES (?, ?, 1, 1, ?, ?)`,
      ).bind(firstSubmissionId, first.applicationId, first.userId, now),
      env.DB.prepare(
        `INSERT INTO seb_application_submission (
          id, application_id, submission_number, application_version,
          submitted_by_user_id, submitted_at
        ) VALUES (?, ?, 1, 1, ?, ?)`,
      ).bind(secondSubmissionId, second.applicationId, second.userId, now),
    ])

    await expect(
      env.DB.prepare(
        `INSERT INTO seb_revision_request (
          id, application_id, submission_id, section, note,
          requested_by_user_id, requested_at
        ) VALUES (?, ?, ?, 'ENTERPRISE', 'Review', ?, ?)`,
      )
        .bind(crypto.randomUUID(), first.applicationId, secondSubmissionId, first.userId, now)
        .run(),
    ).rejects.toThrow()

    const revisionId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO seb_revision_request (
        id, application_id, submission_id, section, note,
        requested_by_user_id, requested_at
      ) VALUES (?, ?, ?, 'ENTERPRISE', 'Review', ?, ?)`,
    )
      .bind(revisionId, first.applicationId, firstSubmissionId, first.userId, now)
      .run()
    await expect(
      env.DB.prepare(
        `INSERT INTO seb_application_event (
          id, application_id, event_type, revision_request_id, created_at
        ) VALUES (?, ?, 'REVISION_REQUESTED', ?, ?)`,
      )
        .bind(crypto.randomUUID(), second.applicationId, revisionId, now)
        .run(),
    ).rejects.toThrow()
  })
})
