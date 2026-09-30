import { env } from '../support/worker'
import { failure, success } from '../../src/services/envelope'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createLoaders } from '../../src/loaders'
import {
  closeExpiredProgrammeCycles,
  createProgrammeCycle,
  recordDocumentScanResult,
} from '../../src/services/admin'
import {
  adminAudit,
  changedExactlyOne,
  constraintSafe,
  normalizeOptionalText,
  normalizeRequiredText,
} from '../../src/services/admin/support'
import { NO_SCANNER_REFERENCE } from '../../src/services/document-scanner'
import { scanDocumentVersion } from '../../src/services/document-scanner/consume'
import { findSubmissionPolicy } from '../../src/services/application/queries/application'
import { adminResolvers } from '../../src/graphql/resolvers/admin/admin'

import { defaultTemplate } from '../support/form'
import { TEST_PIPELINE_ID } from '../support/pipeline'
import { emptyFormTemplate, everyPermission, graphql, openCycle, seedPolicyDocument, signIn, submittedApplication, testPolicy } from '../support/api'
import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { submittedProfile } from './support/intake-fixtures'

/*
 * One schema per file, emptied between tests. `isolatedStorage` gave the
 * Workers pool the same guarantee; applying the schema per test instead costs
 * four and a half seconds a time.
 */
beforeAll(async () => {
  await freshDatabase()
})

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closeDatabase()
})


const adminContext = (cookie: string) => ({
  db: activeDatabase(), loaders: createLoaders(activeDatabase()), env,
  requestHeaders: new Headers({ cookie, origin: 'https://app.example.test' }),
  requestUrl: 'https://api.example.test/graphql', responseHeaders: new Headers(),
})

describe('Mission SEP administration', () => {
  it('requires a live administrative role for every admin query and mutation', async () => {
    const calls = [
      'query { admin { programmeCycle { list { success } } } }',
      'query { admin { programmeCycle { byId(id: "x") { success } } } }',
      'query { admin { programmeCycle { counts(id: "x") { success } } } }',
      'query { admin { programmeCycle { events(id: "x") { success } } } }',
      'query { admin { intake { queue { success } } } }',
      'query { admin { intake { byReference(referenceNumber: "x") { success } } } }',
      'query { admin { intake { workspace(applicationId: "x") { success } } } }',
      'query { admin { intake { documentDownloadUrl(applicationId: "x", submissionDocumentId: "x") { success } } } }',
      `mutation { admin { programmeCycle { create(input: {
        cycleCode: "SEP-X", displayName: "X", cycleYear: 2026,
        policy: { pipelineId: "x", applicationKinds: [], formTemplate: ${emptyFormTemplate} }
      }) { success } } } }`,
      `mutation { admin { programmeCycle { updateDraft(input: {
        id: "x", expectedVersion: 1, reason: "x", cycle: {
          cycleCode: "SEP-X", displayName: "X", cycleYear: 2026,
          policy: { pipelineId: "x", applicationKinds: [], formTemplate: ${emptyFormTemplate} }
        }
      }) { success } } } }`,
      'mutation { admin { programmeCycle { softDeleteDraft(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { restoreDraft(id: "x", expectedVersion: 1) { success } } } }',
      'mutation { admin { programmeCycle { open(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { close(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { archive(input: { id: "x", expectedVersion: 1, reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { updateOpenGuidance(input: { id: "x", expectedVersion: 1, applicantGuidance: "x", reason: "x" }) { success } } } }',
      'mutation { admin { programmeCycle { changeClosingTime(input: { id: "x", expectedVersion: 1, closesAt: "2030-01-01T00:00:00Z", reason: "x" }) { success } } } }',
      'mutation { admin { intake { addInternalNote(input: { applicationId: "x", note: "x" }) { success } } } }',
    ]
    for (const query of calls) {
      const result = await graphql<any>(query, {})
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
  })

  it('loads live administrative roles and rejects applicants safely', async () => {
    const applicant = await signIn({ roles: ['APPLICANT'] })
    const denied = await graphql<{
      admin: { programmeCycle: { list: { success: boolean; message: string } } }
    }>('query { admin { programmeCycle { list { success message } } } }', {}, applicant.cookie)
    expect(denied.data?.admin.programmeCycle.list).toEqual({
      success: false,
      message: 'You do not have permission to do that.',
    })

    const administrator = await signIn({ permissions: everyPermission() })
    const allowed = await graphql<{
      admin: { programmeCycle: { list: { success: boolean } } }
    }>('query { admin { programmeCycle { list { success } } } }', {}, administrator.cookie)
    expect(allowed.data?.admin.programmeCycle.list.success).toBe(true)

    // Revoking their one composed role: authority is read live, so the very
    // next request is refused.
    await env.DB.prepare(
      `UPDATE core_user_role_grant SET revoked_at = ?, revocation_reason = 'TEST'
       WHERE user_id = ? AND role_id IS NOT NULL AND revoked_at IS NULL`,
    ).bind(Date.now(), administrator.userId).run()
    const revoked = await graphql<{
      admin: { programmeCycle: { list: { success: boolean; message: string } } }
    }>('query { admin { programmeCycle { list { success message } } } }', {}, administrator.cookie)
    expect(revoked.data?.admin.programmeCycle.list.message).toBe('You do not have permission to do that.')
  })

  /*
   * The role boundaries, tested by what each role is *refused*.
   *
   * The refusal is the interesting half: a reviewer who can read is only
   * useful if they genuinely cannot write, and a capability that silently
   * widened would still pass every test that only checks the happy path.
   *
   * These assert against the permission refusal specifically rather than
   * `success: false`, because almost anything returns `success: false` when
   * handed an id that does not exist — including an operation the caller was
   * in fact allowed to attempt.
   */


  it('lets staff open a document only once something has scanned it', async () => {
    /*
     * The whole reason the scanner seam exists.
     *
     * Administrative download fails closed until an ACCEPTED scan result is
     * appended, and until this was built nothing appended one — so no
     * administrator could open any document at all, and the review workflow
     * could not be demonstrated. This walks the gate from shut to open.
     */
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    // Exactly what finalization leaves behind: a request to scan, no verdict.
    const { applicationId, pins } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id, { scan: 'PENDING' },
    )
    const { submissionDocumentId, versionId } = pins.DPR!

    const download = () => graphql<{
      admin: { intake: { documentDownloadUrl: { success: boolean; message: string | null } } }
    }>(`query { admin { intake { documentDownloadUrl(
      applicationId: "${applicationId}", submissionDocumentId: "${submissionDocumentId}"
    ) { success message } } } }`, {}, administrator.cookie)

    // Shut, and it says why rather than pretending the document is missing.
    expect((await download()).data?.admin.intake.documentDownloadUrl).toMatchObject({
      success: false,
      message: 'The submitted document has not passed malware scanning.',
    })

    // What the queue consumer does when it reads a scan request.
    expect(await scanDocumentVersion(activeDatabase(), env, versionId)).toBe('RECORDED')

    // Open. And the history is honest about what actually happened.
    expect((await download()).data?.admin.intake.documentDownloadUrl.success).toBe(true)
    expect(await env.DB.prepare(
      `SELECT status, scanner_reference AS reference FROM seb_application_document_scan
       WHERE document_version_id = ? ORDER BY sequence_number DESC LIMIT 1`,
    ).bind(versionId).first()).toEqual({
      status: 'ACCEPTED',
      reference: NO_SCANNER_REFERENCE,
    })
  })

  it('records nothing for a document that no longer exists', async () => {
    /*
     * Deleted between the request being queued and read: nothing to scan and
     * nothing to write down, rather than an invented result.
     *
     * `GONE` rather than a plain failure because the distinction is what the
     * consumer settles on. No later attempt can find a row that was deleted, so
     * retrying spends a budget shared with failures a retry really can fix, and
     * ends by dropping the message anyway.
     */
    expect(await scanDocumentVersion(activeDatabase(), env, crypto.randomUUID()))
      .toBe('GONE')
  })

  it('defers when the verdict could not be appended', async () => {
    /*
     * A version that exists with no scan history at all — which finalization
     * never produces, since it writes the PENDING row itself. `append` refuses
     * rather than inventing sequence 1, because a scan history that did not
     * begin at finalization is not one this can reason about.
     *
     * Distinct from `GONE` on purpose: the row is there, so this is deferred
     * rather than settled, and the consumer retries it.
     */
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const { documents } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id, { scan: 'NONE' },
    )
    const { versionId } = documents.find((each) => each.fieldKey === 'DPR')!

    expect(await scanDocumentVersion(activeDatabase(), env, versionId))
      .toBe('NOT_RECORDED')
  })



  it('creates and opens a complete versioned cycle through GraphQL', async () => {
    const administrator = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = {
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Mission SEP 2026 Test',
      cycleYear: 2026,
      applicantGuidance: 'Read the policy and submit complete evidence.',
      opensAt: new Date(Date.now() - 1_000).toISOString(),
      closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      policy: testPolicy(),
    }
    const created = await graphql<{
      admin: { programmeCycle: { create: { success: boolean; message: string | null; response: { head: { id: string; currentVersion: number; status: string } } } } }
    }>(`mutation Create($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) {
        success message response { head { id currentVersion status } }
      } } }
    }`, { input: cycle }, administrator.cookie)
    expect(created.errors).toBeUndefined()
    expect(created.data?.admin.programmeCycle.create.success).toBe(true)
    const head = created.data?.admin.programmeCycle.create.response.head
    if (!head) throw new Error('Cycle creation failed.')
    await seedPolicyDocument(head.id)

    const opened = await graphql<{
      admin: { programmeCycle: { open: { success: boolean; response: { head: { status: string; currentVersion: number } } } } }
    }>(`mutation Open($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) {
        success response { head { status currentVersion } }
      } } }
    }`, { input: { id: head.id, expectedVersion: head.currentVersion, reason: 'Publish test policy' } }, administrator.cookie)
    expect(opened.errors).toBeUndefined()
    expect(opened.data?.admin.programmeCycle.open.response.head).toEqual({
      status: 'OPEN',
      currentVersion: 2,
    })

    const policyRows = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*)::int FROM seb_programme_cycle_form_field WHERE programme_cycle_id = ?) AS questions,
        (SELECT COUNT(*)::int FROM seb_programme_cycle_form_rule WHERE programme_cycle_id = ?) AS rules,
        (SELECT COUNT(*)::int FROM seb_programme_cycle_application_kind WHERE programme_cycle_id = ?) AS kinds,
        (SELECT pipeline_version FROM seb_programme_cycle_version
          WHERE programme_cycle_id = ? AND version = 2) AS "pinnedPipelineVersion"`,
    ).bind(head.id, head.id, head.id, head.id).first<{
      questions: number; rules: number; kinds: number; pinnedPipelineVersion: number | null
    }>()
    /*
     * Opening copies the normalized rules to immutable version 2, and the form
     * is now one of them. The question count is asserted against the fixture
     * rather than written as a literal: a copy-forward that misses the field
     * table empties the entire form for every draft in the cycle, and the
     * number that proves it did not must move when the fixture does.
     */
    expect(policyRows).toEqual({
      questions: defaultTemplate().fields.length * 2,
      rules: (defaultTemplate().rules ?? []).length * 2,
      kinds: 2,
      // Opening pins the pipeline's published version onto the new version.
      pinnedPipelineVersion: 1,
    })
  })

  it('versions, publishes, revises, closes, and archives a programme cycle without rewriting policy', async () => {
    const administrator = await signIn({ roles: ['SUPER_ADMIN'] })
    const code = `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
    const draft = {
      cycleCode: code,
      displayName: 'Mission SEP Draft',
      cycleYear: 2027,
      applicantGuidance: null,
      opensAt: null,
      closesAt: null,
      policy: {
        minimumApplicantAge: null, maximumApplicantAge: null,
        categoryAMaximumMonths: null,
        majorityOwnershipRequired: null, jurisdiction: null,
        fundingCeilingState: null, fundingCeilingAmountPaise: null,
        fundingCeilingScope: null, pipelineId: TEST_PIPELINE_ID, applicationKinds: [],
        /*
         * Everything else on this draft is null or empty, deliberately — the
         * point is that a draft need not be complete. The form is the one
         * exception: a template with no questions is refused at authoring
         * time, before the draft exists, so there is no such thing as a cycle
         * carrying an empty one.
         */
        formTemplate: defaultTemplate(),
      },
    }
    const created = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success response { head { id currentVersion status } } } } }
    }`, { input: draft }, administrator.cookie)
    const head = created.data.admin.programmeCycle.create.response.head
    expect(head).toMatchObject({ currentVersion: 1, status: 'DRAFT' })

    const incomplete = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) { success message } } }
    }`, { input: { id: head.id, expectedVersion: 1, reason: 'Publish' } }, administrator.cookie)
    expect(incomplete.data.admin.programmeCycle.open).toMatchObject({
      success: false,
      message: 'Before this cycle can open, fill in the policy document (the order or circular this cycle implements), the guidance for applicants, the opening date, the minimum applicant age, the maximum applicant age, the category threshold, the ownership rule, the jurisdiction and the funding ceiling.',
    })

    const deleted = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { softDeleteDraft(input: $input) { response { head { deletedAt currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 1, reason: 'Draft entered in error' } }, administrator.cookie)
    expect(deleted.data.admin.programmeCycle.softDeleteDraft.response.head).toMatchObject({ currentVersion: 1 })
    const restored = await graphql<any>(`mutation($id: ID!, $version: Int!) {
      admin { programmeCycle { restoreDraft(id: $id, expectedVersion: $version) { response { head { deletedAt currentVersion } } } } }
    }`, { id: head.id, version: 1 }, administrator.cookie)
    expect(restored.errors).toBeUndefined()
    expect(restored.data.admin.programmeCycle.restoreDraft.response.head).toEqual(
      expect.objectContaining({ deletedAt: null, currentVersion: 1 }),
    )

    const complete = {
      ...draft,
      displayName: 'Mission SEP 2027',
      applicantGuidance: 'Read the 2027 policy before applying.',
      opensAt: new Date(Date.now() - 1_000).toISOString(),
      closesAt: new Date(Date.now() + 172_800_000).toISOString(),
      policy: testPolicy(),
    }
    const updated = await graphql<any>(`mutation($input: UpdateProgrammeCycleInput!) {
      admin { programmeCycle { updateDraft(input: $input) { response { head { currentVersion displayName } } } } }
    }`, { input: {
      id: head.id, expectedVersion: 1, reason: 'Complete approved policy', cycle: complete,
    } }, administrator.cookie)
    expect(updated.errors).toBeUndefined()
    expect(updated.data.admin.programmeCycle.updateDraft.response).toMatchObject({
      head: { currentVersion: 2, displayName: 'Mission SEP 2027' },
    })

    await seedPolicyDocument(head.id)
    const opened = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) { response { head { status currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 2, reason: 'Publish approved cycle' } }, administrator.cookie)
    expect(opened.data.admin.programmeCycle.open.response.head).toMatchObject({ status: 'OPEN', currentVersion: 3 })
    expect(await findSubmissionPolicy(activeDatabase(), head.id, 3)).toMatchObject({
      minimumApplicantAge: 18, maximumApplicantAge: 60,
      fundingCeilingState: 'UNRESOLVED',
    })
    expect(await findSubmissionPolicy(activeDatabase(), head.id, 999)).toBeNull()

    const guidance = await graphql<any>(`mutation($input: CycleGuidanceInput!) {
      admin { programmeCycle { updateOpenGuidance(input: $input) { response { head { currentVersion applicantGuidance } } } } }
    }`, { input: {
      id: head.id, expectedVersion: 3,
      applicantGuidance: 'Updated public guidance without changing policy.',
      reason: 'Clarify public wording',
    } }, administrator.cookie)
    expect(guidance.data.admin.programmeCycle.updateOpenGuidance.response.head.currentVersion).toBe(4)

    const newClosing = new Date(Date.now() + 259_200_000).toISOString()
    const closing = await graphql<any>(`mutation($input: CycleClosingInput!) {
      admin { programmeCycle { changeClosingTime(input: $input) { response { head { currentVersion closesAt } } } } }
    }`, { input: {
      id: head.id, expectedVersion: 4, closesAt: newClosing, reason: 'Extend the public window',
    } }, administrator.cookie)
    expect(closing.data.admin.programmeCycle.changeClosingTime.response.head.currentVersion).toBe(5)

    // A second, still-draft cycle proves list cursors and nullable draft
    // updates. Clearing optional policy text must create history rather than
    // silently retaining the old value.
    const secondDraft = {
      ...draft,
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Future policy draft',
    }
    const secondCreated = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { response { head { id currentVersion } } } } }
    }`, { input: secondDraft }, administrator.cookie)
    const secondHead = secondCreated.data.admin.programmeCycle.create.response.head
    const secondUpdated = await graphql<any>(`mutation($input: UpdateProgrammeCycleInput!) {
      admin { programmeCycle { updateDraft(input: $input) { response { head { currentVersion opensAt closesAt } } } } }
    }`, { input: {
      id: secondHead.id, expectedVersion: 1, reason: 'Clarify draft name',
      cycle: { ...secondDraft, displayName: 'Future policy draft revised' },
    } }, administrator.cookie)
    expect(secondUpdated.data.admin.programmeCycle.updateDraft.response.head).toMatchObject({
      currentVersion: 2, opensAt: null, closesAt: null,
    })

    const listed = await graphql<any>(`query($id: ID!) { admin {
      programmeCycle {
        list(first: 1, includeDeleted: true) { response { nodes { id } pageInfo { hasNextPage endCursor } } }
        byId(id: $id) { response { head { currentVersion } } }
        counts(id: $id) { response { counts { status count } } }
        events(id: $id, first: 20) { response { events { eventType message } } }
      }
    } }`, { id: head.id }, administrator.cookie)
    expect(listed.errors).toBeUndefined()
    expect(listed.data.admin.programmeCycle.byId.response.head.currentVersion).toBe(5)
    expect(listed.data.admin.programmeCycle.events.response.events.map((event: any) => event.eventType))
      .toEqual(expect.arrayContaining(['OPENED', 'GUIDANCE_CHANGED', 'CLOSING_CHANGED']))
    expect(listed.data.admin.programmeCycle.list.response.pageInfo.hasNextPage).toBe(true)
    const nextPage = await graphql<any>(`query($after: String!) { admin { programmeCycle {
      list(first: 10, after: $after, includeDeleted: true) {
        response { nodes { id } pageInfo { hasNextPage } }
      }
    } } }`, { after: listed.data.admin.programmeCycle.list.response.pageInfo.endCursor }, administrator.cookie)
    expect(nextPage.data.admin.programmeCycle.list.response.nodes).not.toHaveLength(0)

    const closed = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { close(input: $input) { response { head { status currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 5, reason: 'Window complete' } }, administrator.cookie)
    expect(closed.data.admin.programmeCycle.close.response.head).toMatchObject({ status: 'CLOSED', currentVersion: 6 })
    const archived = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { archive(input: $input) { response { head { status currentVersion } } } } }
    }`, { input: { id: head.id, expectedVersion: 6, reason: 'No unfinished applications' } }, administrator.cookie)
    expect(archived.data.admin.programmeCycle.archive.response.head).toMatchObject({ status: 'ARCHIVED', currentVersion: 7 })

    const duplicate = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success message } } }
    }`, { input: complete }, administrator.cookie)
    expect(duplicate.data.admin.programmeCycle.create.success).toBe(false)
  })

  it('rejects ambiguous, duplicate, and internally inconsistent programme policy', async () => {
    const administrator = await signIn({ roles: ['SUPER_ADMIN'] })
    const base = {
      cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      displayName: 'Policy validation', cycleYear: 2028,
      applicantGuidance: 'Guidance',
      opensAt: new Date(Date.now() + 86_400_000).toISOString(),
      closesAt: new Date(Date.now() + 172_800_000).toISOString(), policy: testPolicy(),
    }
    const create = (input: any) => graphql<any>(`mutation($input: ProgrammeCycleInput!) {
      admin { programmeCycle { create(input: $input) { success message response { head { id currentVersion } } } } }
    }`, { input }, administrator.cookie)
    /*
     * The direct successor to the old unknown-document-type rule. That rule
     * could only ever name one of eight enum members, so "unknown" meant a
     * typo. A condition can name any question at all, so the same class of
     * mistake now reaches much further — a rule reading a question the cycle
     * does not ask is a question nothing can ever make required.
     */
    const unknownDocument = await createProgrammeCycle({
      ...base,
      policy: {
        ...testPolicy(),
        formTemplate: defaultTemplate((template) => ({
          ...template,
          conditions: [...template.conditions, {
            fieldKey: 'NOC', effect: 'REQUIRED_WHEN', groupNumber: 2,
            sequenceNumber: 1, sourceFieldKey: 'NO_SUCH_QUESTION',
            sourceFieldType: 'BOOLEAN' as const,
            operator: 'EQUALS' as const, comparisonValue: 'true',
          }],
        })),
      },
    } as never, adminContext(administrator.cookie))
    expect(unknownDocument).toMatchObject({
      success: false,
      // Both keys named: the rule's own question, and the one it reads.
      message: 'NOC has a rule that reads NO_SUCH_QUESTION, '
        + 'which this cycle does not ask.',
    })
    /*
     * Called directly rather than through GraphQL, because the schema's enum
     * refuses an unknown kind before a resolver ever runs. The guard is still
     * worth having: the controller is also reachable from the cron and from
     * any future caller that is not a GraphQL request, and a vocabulary check
     * that only exists in the transport is one refactor from being gone.
     */
    const unknownRule = await createProgrammeCycle({
      ...base,
      policy: {
        ...testPolicy(),
        applicationKinds: [{
          kindKey: 'INITIAL', label: 'First', rules: [{ ruleType: 'NOT_A_RULE', params: {} }],
        }],
      },
    } as never, adminContext(administrator.cookie))
    expect(unknownRule).toMatchObject({
      success: false, message: 'INITIAL uses a rule type this build does not know.',
    })
    const cases: Array<[any, string]> = [
      [{ ...base, cycleCode: 'bad' }, 'Cycle code must contain 3–32 uppercase letters, numbers, or hyphens.'],
      [{ ...base, displayName: ' ' }, 'Enter a cycle display name.'],
      [{ ...base, cycleYear: 1999 }, 'Enter a valid policy year.'],
      [{ ...base, closesAt: base.opensAt }, 'The closing time must be later than the opening time.'],

      [{ ...base, policy: { ...testPolicy(), applicationKinds: [...testPolicy().applicationKinds as any[], (testPolicy().applicationKinds as any[])[0]] } }, 'Cycle policy entries must be unique.'],
      [{ ...base, policy: { ...testPolicy(), applicationKinds: [{ kindKey: 'x', label: 'Kind', rules: [] }] } }, 'One or more application kinds are invalid.'],
      [{ ...base, policy: { ...testPolicy(), applicationKinds: [{ kindKey: 'LATER', label: 'Later', rules: [{ ruleType: 'MAX_APPLICATIONS_OF_KIND', paramsJson: '{"kind":"LATER"}' }] }] } }, 'LATER: the MAX_APPLICATIONS_OF_KIND rule\u2019s settings are incomplete or invalid.'],
      [{ ...base, policy: { ...testPolicy(), applicationKinds: [{ kindKey: 'LATER', label: 'Later', rules: [{ ruleType: 'NO_OPEN_APPLICATION_OF_KIND', paramsJson: '{"kind":"ELSEWHERE"}' }] }] } }, 'LATER: the NO_OPEN_APPLICATION_OF_KIND rule names ELSEWHERE, which this cycle does not accept.'],
      [{ ...base, policy: { ...testPolicy(), minimumApplicantAge: -1 } }, 'Minimum age must be a non-negative whole number.'],
      [{ ...base, policy: { ...testPolicy(), maximumApplicantAge: -1 } }, 'Maximum age must be a non-negative whole number.'],
      [{ ...base, policy: { ...testPolicy(), minimumApplicantAge: 60, maximumApplicantAge: 18 } }, 'Maximum age cannot be lower than minimum age.'],
      [{ ...base, policy: { ...testPolicy(), categoryAMaximumMonths: -1 } }, 'Category A month limit must be a non-negative whole number.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingAmountPaise: '1' } }, 'An unresolved funding ceiling cannot contain an amount or scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingScope: 'APPLICATION' } }, 'An unresolved funding ceiling cannot contain an amount or scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingState: 'RESOLVED' } }, 'A resolved funding ceiling requires a positive amount and scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '0', fundingCeilingScope: 'APPLICATION' } }, 'A resolved funding ceiling requires a positive amount and scope.'],
      [{ ...base, policy: { ...testPolicy(), fundingCeilingState: 'RESOLVED', fundingCeilingAmountPaise: '1', fundingCeilingScope: null } }, 'A resolved funding ceiling requires a positive amount and scope.'],
    ]
    for (const [input, message] of cases) {
      const result = await create(input)
      expect(result.errors, message).toBeUndefined()
      expect(result.data.admin.programmeCycle.create, message).toMatchObject({ success: false, message })
    }

    /*
     * A form with no role bound at all is a valid form. Roles are how code
     * finds a question across cycles, and every reader treats one as possibly
     * absent — a loan-only cycle has no grant amount to find.
     */
    const unbound = await create({
      ...base,
      cycleCode: `SEP-ROLE-${crypto.randomUUID().slice(0, 5).toUpperCase()}`,
      policy: {
        ...testPolicy(),
        formTemplate: defaultTemplate((template) => ({
          ...template,
          fields: template.fields.map((each) => ({ ...each, role: null })),
        })),
      },
    })
    // Roles are optional now: a cycle may ask no grant amount at all.
    expect(unbound.data.admin.programmeCycle.create).toMatchObject({ success: true })

    const missingCollections = [
      {
        policy: { ...testPolicy(), applicationKinds: [] },
        message: 'Define at least one kind of application before opening the cycle.',
      },
    ]
    for (const [index, candidate] of missingCollections.entries()) {
      const result = await create({
        ...base, cycleCode: `SEP-OPEN-${index}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`,
        policy: candidate.policy,
      })
      const head = result.data.admin.programmeCycle.create.response.head
      // Seeded so the refusal under test is the one about its own collection,
      // not the earlier missing-policy-document one.
      await seedPolicyDocument(head.id)
      const opened = await graphql<any>(`mutation($input: CycleTransitionInput!) {
        admin { programmeCycle { open(input: $input) { success message } } }
      }`, { input: { id: head.id, expectedVersion: 1, reason: 'Publish' } }, administrator.cookie)
      expect(opened.data.admin.programmeCycle.open).toMatchObject({ success: false, message: candidate.message })
    }

    const mutable = await create({
      ...base, cycleCode: `SEP-STATE-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
    })
    const mutableHead = mutable.data.admin.programmeCycle.create.response.head
    const stateCalls = [
      [`mutation($input: UpdateProgrammeCycleInput!) { admin { programmeCycle { updateDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Change', cycle: { ...base, cycleCode: 'bad' } } }],
      [`mutation($input: UpdateProgrammeCycleInput!) { admin { programmeCycle { updateDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: ' ', cycle: base } }],
      [`mutation($input: UpdateProgrammeCycleInput!) { admin { programmeCycle { updateDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, reason: 'Stale', cycle: base } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: ' ' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: 'missing', expectedVersion: 1, reason: 'Publish' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, reason: 'Stale publish' } }],
      [`mutation($input: CycleGuidanceInput!) { admin { programmeCycle { updateOpenGuidance(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, applicantGuidance: 'Guide', reason: 'Change' } }],
      [`mutation($input: CycleClosingInput!) { admin { programmeCycle { changeClosingTime(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, closesAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'Change' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Close' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { archive(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Archive' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { softDeleteDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: ' ' } }],
    ] as const
    for (const [query, variables] of stateCalls) {
      const result = await graphql<any>(query, variables, administrator.cookie)
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
    await seedPolicyDocument(mutableHead.id)
    const openedMutable = await graphql<any>(`mutation($input: CycleTransitionInput!) {
      admin { programmeCycle { open(input: $input) { response { head { currentVersion } } } } }
    }`, { input: { id: mutableHead.id, expectedVersion: 1, reason: 'Publish' } }, administrator.cookie)
    expect(openedMutable.data.admin.programmeCycle.open.response.head.currentVersion).toBe(2)
    const openStateCalls = [
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { open(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: 'Again' } }],
      [`mutation($input: CycleGuidanceInput!) { admin { programmeCycle { updateOpenGuidance(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, applicantGuidance: ' ', reason: 'Change' } }],
      [`mutation($input: CycleGuidanceInput!) { admin { programmeCycle { updateOpenGuidance(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, applicantGuidance: 'Guide', reason: 'Change' } }],
      [`mutation($input: CycleClosingInput!) { admin { programmeCycle { changeClosingTime(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, closesAt: new Date(Date.now() - 1_000).toISOString(), reason: 'Past' } }],
      [`mutation($input: CycleClosingInput!) { admin { programmeCycle { changeClosingTime(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, closesAt: new Date(Date.now() + 259_200_000).toISOString(), reason: 'Stale' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: ' ' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: 'missing', expectedVersion: 1, reason: 'Close' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { archive(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: 'Archive' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { close(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 99, reason: 'Stale' } }],
      [`mutation($input: CycleTransitionInput!) { admin { programmeCycle { softDeleteDraft(input: $input) { success } } } }`, { input: { id: mutableHead.id, expectedVersion: 2, reason: 'Cannot delete published cycle' } }],
    ] as const
    for (const [query, variables] of openStateCalls) {
      const result = await graphql<any>(query, variables, administrator.cookie)
      expect(result.errors, query).toBeUndefined()
      expect(JSON.stringify(result.data), query).toContain('"success":false')
    }
    const badPages = await graphql<any>(`query { admin { programmeCycle {
      list(first: 0) { success }
      events(id: "missing", first: 0) { success }
      byId(id: "missing") { success }
    } } }`, {}, administrator.cookie)
    expect(badPages.errors).toBeUndefined()
    expect(badPages.data.admin.programmeCycle).toMatchObject({
      list: { success: false }, events: { success: false }, byId: { success: false },
    })
  })

  it('rejects multiple administrative actions before either executes', async () => {
    const administrator = await signIn({ permissions: everyPermission() })
    const result = await graphql<unknown>(`mutation {
      admin {
        programmeCycle {
          softDeleteDraft(input: { id: "missing", expectedVersion: 1, reason: "x" }) { success }
          restoreDraft(id: "missing", expectedVersion: 1) { success }
        }
      }
    }`, {}, administrator.cookie)
    expect(result.errors?.[0]?.message).toContain('Only one action')
  })

  it('closes only the bounded expired open cycles without inventing an actor', async () => {
    const administrator = await signIn({ permissions: everyPermission() })
    const now = Date.now()
    const cycleId = crypto.randomUUID()
    const code = `EXP-${cycleId}`
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_programme_cycle (
          id, cycle_code, display_name, cycle_year, status, opens_at, closes_at,
          current_version, created_at, updated_at
        ) VALUES (?, ?, 'Expired cycle', 2026, 'OPEN', ?, ?, 1, ?, ?)`,
      ).bind(cycleId, code, now - 10_000, now - 1_000, now, now),
      env.DB.prepare(
        `INSERT INTO seb_programme_cycle_version (
          id, programme_cycle_id, version, cycle_code, display_name, cycle_year,
          status, opens_at, closes_at, change_type, changed_by_user_id, created_at,
          pipeline_id, pipeline_version
        ) VALUES (?, ?, 1, ?, 'Expired cycle', 2026, 'OPEN', ?, ?, 'OPENED', ?, ?, ?, 1)`,
      ).bind(
        crypto.randomUUID(), cycleId, code, now - 10_000, now - 1_000, administrator.userId, now,
        TEST_PIPELINE_ID,
      ),
    ])
    await closeExpiredProgrammeCycles({
      db: activeDatabase(), loaders: createLoaders(activeDatabase()), env,
      requestHeaders: new Headers(), requestUrl: 'https://scheduled.internal/',
      responseHeaders: new Headers(),
    })
    expect(await env.DB.prepare(
      `SELECT status, current_version AS version FROM seb_programme_cycle WHERE id = ?`,
    ).bind(cycleId).first()).toEqual({ status: 'CLOSED', version: 2 })
    expect(await env.DB.prepare(
      `SELECT changed_by_user_id AS actor FROM seb_programme_cycle_version
       WHERE programme_cycle_id = ? AND version = 2`,
    ).bind(cycleId).first()).toEqual({ actor: null })
  })

  it('keeps administrative response, normalization, constraint, and audit helpers safe', async () => {
    expect(success({ id: 'public' })).toEqual({ success: true, message: null, response: { id: 'public' } })
    expect(success(true, 'Completed.')).toEqual({ success: true, message: 'Completed.', response: true })
    expect(failure('Safe failure.')).toEqual({ success: false, message: 'Safe failure.', response: null })
    expect(normalizeRequiredText(' value ', 5)).toBe('value')
    expect(normalizeRequiredText(' ', 5)).toBeNull()
    expect(normalizeRequiredText('toolong', 2)).toBeNull()
    expect(normalizeOptionalText(undefined, 5)).toBeNull()
    expect(normalizeOptionalText(null, 5)).toBeNull()
    expect(normalizeOptionalText('  ', 5)).toBeNull()
    expect(normalizeOptionalText(' ok ', 5)).toBe('ok')
    expect(normalizeOptionalText('toolong', 2)).toBe('INVALID')
    /*
     * Both shapes the driver returns. A statement with `.returning()` gives
     * rows; one without gives a command result carrying `rowCount`, and the
     * second used to be asserted as D1's `{ meta: { changes } }` — a shape
     * nothing produces, so the case that mattered was never really covered.
     */
    expect(changedExactlyOne([{ id: 'one' }])).toBe(true)
    expect(changedExactlyOne([])).toBe(false)
    expect(changedExactlyOne([{ id: 'one' }, { id: 'two' }])).toBe(false)
    expect(changedExactlyOne({ rowCount: 1 })).toBe(true)
    expect(changedExactlyOne({ rowCount: 0 })).toBe(false)
    expect(changedExactlyOne({ rowCount: 2 })).toBe(false)
    // A statement that reports no count at all is not evidence of a change.
    expect(changedExactlyOne({ rowCount: null })).toBe(false)
    /*
     * The shape the driver really throws: Drizzle's wrapper, whose own message
     * is the SQL it tried, with the database's error underneath. The previous
     * version of this threw `new Error('UNIQUE constraint failed')` — SQLite's
     * words, which no layer produces any more — so it passed while the thing
     * it named had stopped working.
     */
    const wrapped = (code: string) =>
      Object.assign(new Error('Failed query: insert into "seb_programme_cycle"'), {
        cause: Object.assign(new Error('duplicate key value'), { code }),
      })
    await expect(constraintSafe(async () => { throw wrapped('23505') }))
      .resolves.toBeNull()
    await expect(constraintSafe(async () => { throw wrapped('23503') }))
      .resolves.toBeNull()
    // Class 08 is connection failure. Swallowing it would report a lost
    // database as an ordinary refusal, and the caller would retry forever.
    await expect(constraintSafe(async () => { throw wrapped('08006') }))
      .rejects.toThrow('Failed query')
    await expect(constraintSafe(async () => {
      throw new Error('network unavailable')
    })).rejects.toThrow('network unavailable')
    // The word alone is not evidence: a table named for uniqueness fails here
    // for some other reason and must still be reported as that reason.
    await expect(constraintSafe(async () => {
      throw new Error('relation "unique_reference_seed" does not exist')
    })).rejects.toThrow('does not exist')
    await expect(constraintSafe(async () => 'ok')).resolves.toBe('ok')
    const requestHeaders = new Headers({
      'CF-Ray': 'ray-1', 'CF-Connecting-IP': '192.0.2.1', 'User-Agent': 'vitest',
    })
    const context = {
      db: activeDatabase(), loaders: createLoaders(activeDatabase()), env, requestHeaders,
      requestUrl: 'https://api.example.test/graphql', responseHeaders: new Headers(),
    }
    const closedPayload = { version: 2, reason: 'SCHEDULED_CLOSING_TIME_REACHED', scheduled: true }
    expect(adminAudit(context, {
      actorUserId: null, action: 'SEB.CYCLE_CLOSED', entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: 'cycle', now: new Date(0), payload: closedPayload,
    })).toMatchObject({
      requestId: 'ray-1', ipAddress: '192.0.2.1', userAgent: 'vitest',
      subjectUserId: null, applicationId: null, payload: JSON.stringify(closedPayload),
    })
    requestHeaders.delete('CF-Ray')
    requestHeaders.set('X-Request-ID', 'request-1')
    expect(adminAudit(context, {
      actorUserId: null, action: 'SEB.CYCLE_CLOSED', entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: 'cycle', now: new Date(0), payload: closedPayload,
    })).toMatchObject({ requestId: 'request-1' })
    /*
     * Fail closed, and quietly: a payload the schema refuses stops the row
     * being built, and the error names the key — never the value, which can be
     * an operator's reason or an address.
     */
    const refused = () => adminAudit(context, {
      actorUserId: null, action: 'SEB.CYCLE_CLOSED', entityType: 'SEB_PROGRAMME_CYCLE',
      entityId: 'cycle', now: new Date(0),
      payload: { ...closedPayload, version: 0, reason: 'secret-looking reason' },
    })
    expect(refused).toThrow(/SEB\.CYCLE_CLOSED.*version/u)
    expect(refused).not.toThrow(/secret-looking/u)
    expect(adminResolvers.AdminWorkspace.notes({})).toEqual([])
    expect(adminResolvers.AdminWorkspace.notes({ internalNotes: [{ id: 'note' }] })).toEqual([
      { id: 'note' },
    ])
  })

  it('appends trusted scanner results and rejects malformed or unknown callbacks', async () => {
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const { applicationId, pins } = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id, { scan: 'PENDING' },
    )
    const { submissionDocumentId, versionId } = pins.DPR!
    const db = activeDatabase()
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'ACCEPTED', scannerReference: 'SCAN-1',
      safeMessage: 'File accepted.', scannedAt: new Date(),
    })).toBe(true)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'ERROR', scannerReference: 'SCAN-RETRY',
      scannedAt: new Date(),
    })).toBe(true)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: 'missing', status: 'ERROR', scannerReference: 'SCAN-2',
      scannedAt: new Date(),
    })).toBe(false)
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'REJECTED', scannerReference: ' ',
      scannedAt: new Date(Number.NaN),
    })).toBe(false)
    expect(await env.DB.prepare(`SELECT status, sequence_number AS sequence
      FROM seb_application_document_scan WHERE document_version_id = ?
      ORDER BY sequence_number DESC LIMIT 1`).bind(versionId).first()).toEqual({
      status: 'ERROR', sequence: 3,
    })
    expect(await recordDocumentScanResult(db, {
      documentVersionId: versionId, status: 'ACCEPTED', scannerReference: 'SCAN-FINAL',
      safeMessage: 'Accepted after retry.', scannedAt: new Date(),
    })).toBe(true)
    const download = await graphql<any>(`query($applicationId: ID!, $documentId: ID!) {
      admin { intake { documentDownloadUrl(
        applicationId: $applicationId, submissionDocumentId: $documentId
      ) { success response { downloadUrl expiresAt } } } }
    }`, { applicationId, documentId: submissionDocumentId }, administrator.cookie)
    expect(download.data.admin.intake.documentDownloadUrl).toMatchObject({
      // Local environment: served by the Worker. Signing is covered where the
      // context says it is deployed.
      success: true,
      response: { downloadUrl: expect.stringContaining('/internal/storage/objects?key=') },
    })
  })

})

describe('searching the intake queue and the cycle list', () => {
  it('never lets a search reach past the filters beside it', async () => {
    /*
     * The search matches two columns, and two columns mean an `OR`. An `OR`
     * without parentheses binds looser than every `AND` around it, so the
     * predicate collapses to "(everything else AND the first column) OR the
     * second column" — and a row matching the second is returned whatever its
     * status, whatever its cycle, deleted or not.
     *
     * The office would see unsubmitted drafts, which the download path goes out
     * of its way to keep invisible, and soft-deleted applications, in a list
     * whose count claims to describe the filters.
     */
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    /*
     * Searched by the **enterprise name**, which is the second of the two
     * columns the search spans. The first sits inside the AND group and is
     * therefore safe; it is the second that escapes it, so a test using the
     * reference number would pass while the leak was wide open.
     */
    const [row] = await env.DB.prepare(
      `SELECT e.current_name AS name FROM seb_application a
       JOIN seb_enterprise e ON e.id = a.enterprise_id WHERE a.id = ?`,
    ).bind(submitted.applicationId).raw<[string]>()
    const enterpriseName = row?.[0] ?? ''
    expect(enterpriseName).not.toBe('')

    // Soft-delete it. Nothing may bring it back into the queue.
    await env.DB.prepare('UPDATE seb_application SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), submitted.applicationId).run()

    const found = await graphql<any>(`query($input: AdminIntakeQueueInput) {
      admin { intake { queue(input: $input) { response {
        nodes { id } pageInfo { totalCount }
      } } } }
    }`, { input: { first: 50, search: enterpriseName } }, administrator.cookie)
    const page = found.data.admin.intake.queue.response
    expect(page.nodes.map((node: { id: string }) => node.id))
      .not.toContain(submitted.applicationId)
    expect(page.pageInfo.totalCount, 'the count must describe the same rows')
      .toBe(page.nodes.length)
  })


  it('finds an application by the start of its reference or enterprise name', async () => {
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const submitted = await submittedApplication(
      administrator.cookie, administrator.userId, cycle.id,
    )
    const [row] = await env.DB.prepare(
      'SELECT reference_number AS reference FROM seb_application WHERE id = ?',
    ).bind(submitted.applicationId).raw<[string]>()
    const reference = row?.[0] ?? ''
    expect(reference).not.toBe('')

    const search = async (term: string) => {
      const response = await graphql<{
        admin: {
          intake: {
            queue: {
              success: boolean
              response: {
                nodes: { id: string }[]
                pageInfo: { totalCount: number }
              } | null
            }
          }
        }
      }>(
        `query Q($input: AdminIntakeQueueInput) {
          admin { intake { queue(input: $input) {
            success response { nodes { id } pageInfo { totalCount } }
          } } }
        }`,
        { input: { search: term } },
        administrator.cookie,
      )
      return response.data?.admin.intake.queue.response
    }

    // The reference, in the case somebody would type it.
    const byReference = await search(reference.toLowerCase().slice(0, 8))
    expect(byReference?.nodes.map((node) => node.id)).toContain(submitted.applicationId)
    expect(byReference?.pageInfo.totalCount).toBeGreaterThan(0)

    /*
     * Or the enterprise name, because that is the other thing on the paper.
     * Read back rather than written as a literal: the fixture makes the name
     * unique per application so the enterprise cap and the per-owner name
     * uniqueness do not refuse the second one, and a literal here would be a
     * test that passes only while it happens to agree with the fixture.
     */
    const enterpriseName = (await env.DB.prepare(
      `SELECT current_name AS "currentName" FROM seb_enterprise WHERE id = ?`,
    ).bind(submitted.enterpriseId).first<{ currentName: string }>())!.currentName
    const byName = await search(enterpriseName.slice(0, 12).toLowerCase())
    expect(byName?.nodes.map((node) => node.id)).toContain(submitted.applicationId)

    // Prefix only, and a miss is empty rather than everything.
    expect((await search('zzzz'))?.nodes).toEqual([])
    expect((await search('zzzz'))?.pageInfo.totalCount).toBe(0)
  })

  it('narrows the cycle list by status, year and code, and refuses a nonsense year', async () => {
    const administrator = await signIn({ roles: ['SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const [row] = await env.DB.prepare(
      'SELECT cycle_code AS code, cycle_year AS year FROM seb_programme_cycle WHERE id = ?',
    ).bind(cycle.id).raw<[string, number]>()
    const code = row?.[0] ?? ''
    const year = row?.[1] ?? 0

    const list = async (variables: Record<string, unknown>) => {
      const response = await graphql<{
        admin: {
          programmeCycle: {
            list: {
              success: boolean
              message: string | null
              response: { nodes: { id: string }[]; pageInfo: { totalCount: number } } | null
            }
          }
        }
      }>(
        `query L($status: ProgrammeCycleStatus, $cycleYear: Int, $search: String) {
          admin { programmeCycle { list(status: $status, cycleYear: $cycleYear, search: $search) {
            success message response { nodes { id } pageInfo { totalCount } }
          } } }
        }`,
        variables,
        administrator.cookie,
      )
      return response.data?.admin.programmeCycle.list
    }

    expect((await list({ status: 'OPEN' }))?.response?.nodes.map((node) => node.id))
      .toContain(cycle.id)
    expect((await list({ status: 'ARCHIVED' }))?.response?.pageInfo.totalCount).toBe(0)
    expect((await list({ cycleYear: year }))?.response?.nodes.map((node) => node.id))
      .toContain(cycle.id)
    expect((await list({ search: code.slice(0, 3).toLowerCase() }))?.response?.nodes
      .map((node) => node.id)).toContain(cycle.id)

    // A year that is not a year is named rather than silently matching nothing.
    const refused = await list({ cycleYear: 12 })
    expect(refused?.success).toBe(false)
    expect(refused?.message).toBe('Select a valid programme year.')
  })
})

describe('the analytic queue filters', () => {
  const QUEUE = `query($input: AdminIntakeQueueInput) {
    admin { intake { queue(input: $input) {
      success message
      response { nodes { id } pageInfo { totalCount } }
    } } }
  }`

  const idsFor = async (cookie: string, input: Record<string, unknown>) => {
    const body = await graphql<any>(QUEUE, { input: { first: 50, ...input } }, cookie)
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    const page = body.data.admin.intake.queue
    expect(page.success, page.message ?? '').toBe(true)
    return new Set<string>(page.response.nodes.map((node: { id: string }) => node.id))
  }

  it('narrows by every multi-value dimension, superseding the single filters', async () => {
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycleOne = await openCycle(administrator.cookie)
    const cycleTwo = await openCycle(administrator.cookie)
    const established = await submittedProfile({
      cycleId: cycleOne.id,
      enterprise: {
        establishmentDate: '2020-01-01',
        businessSector: 'INFORMATION_TECHNOLOGY',
        businessDistrict: 'DHALAI',
        registrationType: 'LLP',
        registrationNumber: `LLP-${crypto.randomUUID().slice(0, 8)}`,
      },
      requestedPaise: 5_000_000,
    })
    const young = await submittedProfile({
      cycleId: cycleOne.id,
      enterprise: { businessSector: 'FOOD_PROCESSING', businessDistrict: 'WEST_TRIPURA' },
      requestedPaise: 10_000_000,
    })
    const otherCycle = await submittedProfile({
      cycleId: cycleTwo.id,
      enterprise: { businessSector: 'FOOD_PROCESSING', businessDistrict: 'GOMATI' },
      requestedPaise: 20_000_000,
    })

    expect(await idsFor(administrator.cookie, { categories: ['CATEGORY_A'] }))
      .toEqual(new Set([established.applicationId]))
    // The plural supersedes the single, so a client migrating filter by filter
    // cannot have the two intersected behind its back.
    expect(await idsFor(administrator.cookie, {
      category: 'CATEGORY_B', categories: ['CATEGORY_A'],
    })).toEqual(new Set([established.applicationId]))
    expect(await idsFor(administrator.cookie, {
      sector: 'INFORMATION_TECHNOLOGY', sectors: ['FOOD_PROCESSING'],
    })).toEqual(new Set([young.applicationId, otherCycle.applicationId]))
    expect(await idsFor(administrator.cookie, { districts: ['DHALAI', 'GOMATI'] }))
      .toEqual(new Set([established.applicationId, otherCycle.applicationId]))
    expect(await idsFor(administrator.cookie, { registrationTypes: ['LLP'] }))
      .toEqual(new Set([established.applicationId]))
    expect(await idsFor(administrator.cookie, {
      cycleId: cycleOne.id, cycleIds: [cycleTwo.id],
    })).toEqual(new Set([otherCycle.applicationId]))
    expect(await idsFor(administrator.cookie, { statuses: ['DRAFT', 'IN_PIPELINE'] }))
      .toEqual(new Set([
        established.applicationId, young.applicationId, otherCycle.applicationId,
      ]))
    // The queue never lists a draft, whatever the filter asks for.
    expect(await idsFor(administrator.cookie, { statuses: ['DRAFT'] }))
      .toEqual(new Set())
    // An empty list is no filter at all, not a filter matching nothing.
    expect((await idsFor(administrator.cookie, { categories: [] })).size).toBe(3)
  })

  it('narrows by each single filter on its own', async () => {
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycleOne = await openCycle(administrator.cookie)
    const cycleTwo = await openCycle(administrator.cookie)
    const established = await submittedProfile({
      cycleId: cycleOne.id,
      enterprise: { establishmentDate: '2020-01-01', businessSector: 'INFORMATION_TECHNOLOGY' },
    })
    const young = await submittedProfile({ cycleId: cycleTwo.id, enterprise: { businessSector: 'FOOD_PROCESSING' } })
    const all = new Set([established.applicationId, young.applicationId])

    expect(await idsFor(administrator.cookie, { cycleId: cycleTwo.id })).toEqual(new Set([young.applicationId]))
    expect(await idsFor(administrator.cookie, { category: 'CATEGORY_A' })).toEqual(new Set([established.applicationId]))
    expect(await idsFor(administrator.cookie, { sector: 'FOOD_PROCESSING' })).toEqual(new Set([young.applicationId]))
    expect(await idsFor(administrator.cookie, { status: 'IN_PIPELINE' })).toEqual(all)
    expect(await idsFor(administrator.cookie, { phaseNumber: 1 })).toEqual(all)
    expect(await idsFor(administrator.cookie, { phaseNumber: 2 })).toEqual(new Set())
    expect(await idsFor(administrator.cookie, { applicationKind: 'INITIAL' })).toEqual(all)
    expect(await idsFor(administrator.cookie, { applicationKind: 'EXPANSION' })).toEqual(new Set())
    expect(await idsFor(administrator.cookie, { submittedFrom: '2000-01-01T00:00:00Z', submittedTo: '2999-01-01T00:00:00Z' })).toEqual(all)
    expect(await idsFor(administrator.cookie, { submittedFrom: '2999-01-01T00:00:00Z' })).toEqual(new Set())
  })

  it('pages each ordering from where the last page ended, never repeating a file', async () => {
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const submitted: string[] = []
    for (let index = 0; index < 3; index += 1) {
      submitted.push((await submittedProfile({ cycleId: cycle.id })).applicationId)
    }
    const PAGE = `query($input: AdminIntakeQueueInput) {
      admin { intake { queue(input: $input) { success response { nodes { id } pageInfo { endCursor hasNextPage } } } } }
    }`
    for (const [order, expected] of [
      ['OLDEST_WAITING', submitted],
      ['NEWEST_SUBMISSION', [...submitted].reverse()],
      ['LAST_ACTIVITY', [...submitted].reverse()],
    ] as const) {
      const seen: string[] = []
      let after: string | null = null
      do {
        const body: any = await graphql<any>(PAGE, { input: { first: 2, order, ...(after ? { after } : {}) } }, administrator.cookie)
        const page = body.data.admin.intake.queue.response
        seen.push(...page.nodes.map((node: { id: string }) => node.id))
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      } while (after)
      expect(seen, order).toEqual(expected)
    }
  })

  it('bounds the requested amount inclusively, and refuses an inverted range', async () => {
    const administrator = await signIn({ roles: ['APPLICANT', 'SUPER_ADMIN'] })
    const cycle = await openCycle(administrator.cookie)
    const smaller = await submittedProfile({
      cycleId: cycle.id, requestedPaise: 5_000_000,
    })
    const larger = await submittedProfile({
      cycleId: cycle.id, requestedPaise: 10_000_000,
    })

    // Inclusive at both ends: a bound equal to the answer still matches it.
    expect(await idsFor(administrator.cookie, { requestedMinPaise: 10_000_000 }))
      .toEqual(new Set([larger.applicationId]))
    expect(await idsFor(administrator.cookie, { requestedMaxPaise: 5_000_000 }))
      .toEqual(new Set([smaller.applicationId]))
    expect(await idsFor(administrator.cookie, {
      requestedMinPaise: 5_000_000, requestedMaxPaise: 10_000_000,
    })).toEqual(new Set([smaller.applicationId, larger.applicationId]))
    expect(await idsFor(administrator.cookie, {
      requestedMinPaise: 5_000_001, requestedMaxPaise: 9_999_999,
    })).toEqual(new Set())

    /*
     * A corrupt answer must narrow to nothing rather than fail the whole
     * queue: the regex guard keeps the cast off non-numeric rows.
     */
    await env.DB.prepare(`UPDATE seb_application_version_answer
      SET value_text = 'not-a-number' WHERE field_key = 'SEED_FUND_REQUESTED_PAISE'
      AND application_version_id IN (
        SELECT id FROM seb_application_version WHERE application_id = ?
      )`).bind(smaller.applicationId).run()
    expect(await idsFor(administrator.cookie, { requestedMinPaise: 1 }))
      .toEqual(new Set([larger.applicationId]))

    // The refusals, so an impossible range is named rather than answered empty.
    for (const [input, message] of [
      [{ requestedMinPaise: 200, requestedMaxPaise: 100 },
        'The requested amount range is invalid.'],
      [{ submittedFrom: '2026-02-01T00:00:00Z', submittedTo: '2026-01-01T00:00:00Z' },
        'The submission date range is invalid.'],
    ] as const) {
      const refused = await graphql<any>(QUEUE, { input }, administrator.cookie)
      expect(refused.data.admin.intake.queue, JSON.stringify(input))
        .toMatchObject({ success: false, message })
    }
  })
})
