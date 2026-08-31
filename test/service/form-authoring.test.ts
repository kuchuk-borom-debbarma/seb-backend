/**
 * Authoring the questions a cycle asks, through the API an officer uses.
 *
 * The form is a rule of the cycle, so these are draft-only and every change
 * mints a version carrying the reason for it. What each test is really
 * checking is that a refusal *names the question at fault* — an officer told
 * only "the form is invalid" has to find it themselves, across a form they may
 * not have written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { createEnterprise, graphql, openCycle, signIn, startApplication, testPolicy } from '../support/api'
import { defaultTemplate } from '../support/form'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

/** A draft cycle carrying the fixture form, which is where authoring starts. */
const draftCycle = async (cookie: string) => {
  const created = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
    admin { programmeCycle { create(input: $input) {
      success message response { head { id currentVersion status } }
    } } }
  }`, { input: {
    cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    displayName: 'Authoring test', cycleYear: 2026,
    applicantGuidance: 'Guide.',
    partnerBankGuidance: 'Roster.',
    opensAt: new Date(Date.now() + 86_400_000).toISOString(),
    closesAt: new Date(Date.now() + 172_800_000).toISOString(),
    policy: testPolicy(),
  } }, cookie)
  const result = created.data.admin.programmeCycle.create
  expect(result.success, result.message ?? '').toBe(true)
  return result.response.head as { id: string; currentVersion: number }
}

const questionKeys = async (cookie: string, id: string): Promise<string[]> => {
  const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
    response { formTemplate { fields { key label } } }
  } } } }`, { id }, cookie)
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
  return body.data.admin.programmeCycle.byId.response.formTemplate.fields
    .map((field: { key: string }) => field.key)
}

const call = (
  cookie: string,
  mutation: string,
  input: Record<string, unknown>,
) => graphql<any>(
  `mutation($input: ${mutation === 'replace' ? 'ReplaceFormTemplateInput'
    : mutation === 'removeStage' ? 'RemoveFormStageInput'
    : mutation === 'removeQuestion' ? 'RemoveFormQuestionInput'
    : mutation === 'putGroupDefinition' ? 'PutGroupDefinitionInput'
    : mutation === 'removeGroupDefinition' ? 'RemoveGroupDefinitionInput'
    : mutation.endsWith('Stage') ? 'FormStageMutationInput'
    : 'FormQuestionMutationInput'}!) {
    admin { formTemplate { ${mutation}(input: $input) {
      success message response { head { currentVersion } }
    } } }
  }`,
  { input },
  cookie,
).then((body) => {
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
  return body.data.admin.formTemplate[mutation] as
    { success: boolean; message: string | null; response: { head: { currentVersion: number } } | null }
})

describe('an administrator authoring a cycle’s questions', () => {
  /*
   * The whole fragment the client asks for, not a corner of it. Reading two
   * fields proves the resolver runs; it does not prove that everything the
   * cycle editor selects can be serialized — and a field that cannot is a
   * screen that says only "This page could not be loaded".
   */
  it('serializes every part of the form the client asks for', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { formTemplate {
        programmeCycleId
        programmeCycleVersion
        stages { key title description position }
        fields {
          key stageKey type role label helpText requirement source position repeatGroupKey
          options { value label position }
          validation {
            minLength maxLength pattern patternMessage
            minValue maxValue minDate maxDate relativeDateBound
            minRepeat maxRepeat maxFileBytes
          }
          conditions {
            effect groupNumber sequenceNumber sourceFieldKey operator comparisonValue
          }
        }
      } }
    } } } }`, { id: cycle.id }, officer.cookie)
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
    const template = body.data.admin.programmeCycle.byId.response.formTemplate
    expect(template.stages.length).toBeGreaterThan(0)
    expect(template.fields.length).toBeGreaterThan(0)
  })

  it('serializes the same parts on the applicant’s own query', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const open = await openCycle(officer.cookie)
    const applicant = await signIn(['APPLICANT'])
    const enterpriseId = await createEnterprise(applicant.cookie)
    const applicationId = await startApplication(applicant.cookie, enterpriseId, open.id)
    const body = await graphql<any>(`query($id: ID!) { seb { application {
      formTemplate(applicationId: $id) {
        success
        response { fields { key validation { maxLength minRepeat maxFileBytes } } }
      }
    } } }`, { id: applicationId }, applicant.cookie)
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
  })

  it('can read the form back before changing it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    /*
     * The read is the precondition for all of this: until it existed the only
     * way to see a cycle's questions was to start an application against it.
     */
    expect(await questionKeys(officer.cookie, cycle.id))
      .toEqual(defaultTemplate().fields.map((field) => field.fieldKey))
  })

  it('adds a question, and it is there afterwards', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const added = await call(officer.cookie, 'addQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'The programme now asks how many people the enterprise employs.',
      },
      field: {
        stageKey: 'FINANCIAL', fieldKey: 'EMPLOYEE_COUNT', fieldType: 'INTEGER',
        label: 'How many people does the enterprise employ?',
        requirement: 'OPTIONAL', minValue: 0,
      },
    })
    expect(added.success, added.message ?? '').toBe(true)
    expect(await questionKeys(officer.cookie, cycle.id)).toContain('EMPLOYEE_COUNT')
  })

  it('refuses a question key the cycle already asks, and says which', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const again = await call(officer.cookie, 'addQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Duplicate.',
      },
      field: {
        stageKey: 'DOCUMENTS', fieldKey: 'NOC_REQUIRED', fieldType: 'TEXT',
        label: 'The certificate question again', requirement: 'OPTIONAL', maxLength: 200,
      },
    })
    expect(again).toMatchObject({
      success: false,
      message: 'This cycle already asks a question called NOC_REQUIRED.',
    })
  })

  it('removes a question', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const removed = await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'The programme no longer asks about gender.',
      },
      fieldKey: 'GENDER',
    })
    expect(removed.success, removed.message ?? '').toBe(true)
    expect(await questionKeys(officer.cookie, cycle.id)).not.toContain('GENDER')
  })

  /**
   * The refusal that matters most.
   *
   * `NOC_REQUIRED` is read by the rule that decides when the no-objection
   * certificate is wanted. Removing it quietly would leave a conditional
   * question with no rule saying when — a question nothing can ever ask for —
   * so the refusal names the question that would have been stranded.
   */
  it('refuses to remove a question another question’s rule reads, and names it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const removed = await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Dropping the certificate question.',
      },
      fieldKey: 'NOC_REQUIRED',
    })
    expect(removed.success).toBe(false)
    expect(removed.message).toContain('NOC')
    // And nothing moved: a refused edit is not a partial one.
    expect(await questionKeys(officer.cookie, cycle.id)).toContain('NOC_REQUIRED')
  })

  it('adds a stage, and removes one with its questions', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const added = await call(officer.cookie, 'addStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'A step for the market study.',
      },
      stage: { stageKey: 'MARKET', title: 'Your market', sortOrder: 99 },
    })
    expect(added.success, added.message ?? '').toBe(true)

    const removed = await call(officer.cookie, 'removeStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: added.response!.head.currentVersion,
        reason: 'Not needed after all.',
      },
      stageKey: 'MARKET',
    })
    expect(removed.success, removed.message ?? '').toBe(true)
  })

  it('replaces the whole form at once', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const replaced = await call(officer.cookie, 'replace', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Imported last year’s form.',
      },
      template: defaultTemplate((template) => ({
        ...template,
        fields: template.fields.map((field) =>
          field.fieldKey === 'NAME'
            ? { ...field, label: 'Full legal name' }
            : field),
      })),
    })
    expect(replaced.success, replaced.message ?? '').toBe(true)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { formTemplate { fields { key label } } }
    } } } }`, { id: cycle.id }, officer.cookie)
    const renamed = body.data.admin.programmeCycle.byId.response.formTemplate.fields
      .find((field: { key: string }) => field.key === 'NAME')
    expect(renamed.label).toBe('Full legal name')
  })

  it('refuses a form the engine could not resolve, and says why', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const refused = await call(officer.cookie, 'addQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'A question in a stage that does not exist.',
      },
      field: {
        stageKey: 'NOWHERE', fieldKey: 'ORPHAN', fieldType: 'TEXT',
        label: 'An orphan', requirement: 'OPTIONAL', maxLength: 50,
      },
    })
    expect(refused).toMatchObject({
      success: false,
      message: 'ORPHAN names a stage this cycle does not have.',
    })
  })

  it('refuses a stale version rather than overwriting somebody else’s edit', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const scope = {
      programmeCycleId: cycle.id,
      expectedVersion: cycle.currentVersion,
      reason: 'The first of two edits.',
    }
    const first = await call(officer.cookie, 'removeQuestion', { scope, fieldKey: 'GENDER' })
    expect(first.success, first.message ?? '').toBe(true)

    // The same version quoted again: somebody reading a stale screen.
    const second = await call(officer.cookie, 'removeQuestion', {
      scope, fieldKey: 'DESIGNATION',
    })
    expect(second).toMatchObject({
      success: false,
      message: 'The record changed. Reload and try again.',
    })
  })

  it('refuses to change the questions of a cycle that is open', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const open = await openCycle(officer.cookie)
    const refused = await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: open.id,
        expectedVersion: open.currentVersion,
        reason: 'Too late.',
      },
      fieldKey: 'GENDER',
    })
    /*
     * Said plainly rather than as "the record changed", which is what the
     * guarded write alone would have reported — true of a stale version and
     * useless here, because reloading changes nothing.
     */
    expect(refused).toMatchObject({
      success: false,
      message: 'A cycle’s questions can only be changed while it is a draft.',
    })
  })

  it('renames a stage without disturbing the questions in it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const renamed = await call(officer.cookie, 'updateStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'The step is about the people, not the paperwork.',
      },
      stage: { stageKey: 'OWNERS', title: 'The owners', sortOrder: 1 },
    })
    expect(renamed.success, renamed.message ?? '').toBe(true)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { formTemplate { stages { key title } } }
    } } } }`, { id: cycle.id }, officer.cookie)
    const stages = body.data.admin.programmeCycle.byId.response.formTemplate.stages
    expect(stages.find((stage: { key: string }) => stage.key === 'OWNERS').title)
      .toBe('The owners')
    // The questions are the point: a rename must not be a removal.
    expect(await questionKeys(officer.cookie, cycle.id)).toContain('NAME')
  })

  it('refuses to update a stage the cycle does not have, and names it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    expect(await call(officer.cookie, 'updateStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Renaming something that is not there.',
      },
      stage: { stageKey: 'MARKET', title: 'Your market', sortOrder: 9 },
    })).toMatchObject({
      success: false,
      message: 'This cycle has no stage called MARKET.',
    })
  })

  it('refuses to remove a stage the cycle does not have, and names it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    expect(await call(officer.cookie, 'removeStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Removing something that is not there.',
      },
      stageKey: 'MARKET',
    })).toMatchObject({
      success: false,
      message: 'This cycle has no stage called MARKET.',
    })
  })

  it('refuses a stage key the cycle already has, and says which', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    expect(await call(officer.cookie, 'addStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'A second owners step.',
      },
      stage: { stageKey: 'OWNERS', title: 'The owners again', sortOrder: 9 },
    })).toMatchObject({
      success: false,
      message: 'This cycle already asks a stage called OWNERS.',
    })
  })

  /**
   * Removing a stage takes its questions with it.
   *
   * The alternative is a refusal an officer cannot act on: a stage removed on
   * its own leaves every question in it naming a stage that is gone, which the
   * whole-form check refuses — so they would have to delete each question by
   * hand first, in an order they have to work out.
   */
  it('removes a stage that still has questions in it, and takes them along', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const removed = await call(officer.cookie, 'removeStage', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'The programme stops asking about previous support.',
      },
      stageKey: 'PRIOR_FUNDING',
    })
    expect(removed.success, removed.message ?? '').toBe(true)

    const remaining = await questionKeys(officer.cookie, cycle.id)
    for (const key of [
      'RECEIVED_GOVERNMENT_FUNDING', 'GOVERNMENT_SCHEME_NAME',
      'GOVERNMENT_FUNDING_AMOUNT_PAISE', 'GOVERNMENT_FUNDING_SANCTION_YEAR',
    ]) expect(remaining, key).not.toContain(key)
    // And the rules that read them went too, or the form would not resolve.
    expect(remaining).toContain('NAME')
  })

  it('changes a question’s wording and its choices together', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const updated = await call(officer.cookie, 'updateQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'The gender list is worded differently this year.',
      },
      field: {
        stageKey: 'OWNERS', fieldKey: 'GENDER',
        fieldType: 'SINGLE_CHOICE', parentFieldKey: 'OWNERS',
        label: 'How does this owner describe their gender?', requirement: 'REQUIRED',
      },
      options: [
        { optionValue: 'WOMAN', optionLabel: 'A woman', sortOrder: 1 },
        { optionValue: 'MAN', optionLabel: 'A man', sortOrder: 2 },
      ],
    })
    expect(updated.success, updated.message ?? '').toBe(true)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { formTemplate { fields { key label options { value label } } } }
    } } } }`, { id: cycle.id }, officer.cookie)
    const gender = body.data.admin.programmeCycle.byId.response.formTemplate.fields
      .find((field: { key: string }) => field.key === 'GENDER')
    expect(gender.label).toBe('How does this owner describe their gender?')
    expect(gender.options.map((option: { label: string }) => option.label))
      .toEqual(['A woman', 'A man'])
  })

  it('refuses to update a question the cycle does not ask, and names it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    expect(await call(officer.cookie, 'updateQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Editing something that is not there.',
      },
      field: {
        stageKey: 'FINANCIAL', fieldKey: 'EMPLOYEE_COUNT', fieldType: 'INTEGER',
        label: 'How many people?', requirement: 'OPTIONAL', minValue: 0,
      },
    })).toMatchObject({
      success: false,
      message: 'This cycle has no question called EMPLOYEE_COUNT.',
    })
  })

  it('refuses to remove a question the cycle does not ask, and names it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    expect(await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Removing something that is not there.',
      },
      fieldKey: 'EMPLOYEE_COUNT',
    })).toMatchObject({
      success: false,
      message: 'This cycle has no question called EMPLOYEE_COUNT.',
    })
  })

  /**
   * A rule *on* the question being changed is replaced; a rule *reading* it
   * belongs to somebody else's question and is left alone.
   *
   * The second half is what makes this worth a test: dropping a rule that
   * reads this question would quietly make that other question unconditional —
   * a change to the form nobody asked for, and one nothing would report.
   */
  it('replaces the rules on a question and leaves the rules that read it', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const updated = await call(officer.cookie, 'updateQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'The certificate question stands on its own now.',
      },
      field: {
        stageKey: 'DOCUMENTS', fieldKey: 'NOC_REQUIRED', fieldType: 'BOOLEAN',
        label: 'Is a no-objection certificate needed for these premises?',
        requirement: 'REQUIRED',
      },
      conditions: [],
    })
    expect(updated.success, updated.message ?? '').toBe(true)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { formTemplate { fields { key conditions { sourceFieldKey } } } } }
    } } }`, { id: cycle.id }, officer.cookie)
    const fields = body.data.admin.programmeCycle.byId.response.formTemplate.fields
    const question = fields.find((field: { key: string }) => field.key === 'NOC_REQUIRED')
    expect(question.conditions).toEqual([])
    // The certificate still knows when it is wanted.
    const certificate = fields.find((field: { key: string }) => field.key === 'NOC')
    expect(certificate.conditions.map((rule: { sourceFieldKey: string }) => rule.sourceFieldKey))
      .toContain('NOC_REQUIRED')
  })

  it('refuses an edit with no reason', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    /*
     * A cycle's questions are what applicants are judged against, so every
     * change to them is versioned and carries why. Whitespace is not a reason.
     */
    expect(await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: '   ',
      },
      fieldKey: 'GENDER',
    })).toMatchObject({ success: false, message: 'Enter a change reason.' })
  })

  it('refuses a cycle that is not there', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    expect(await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: crypto.randomUUID(),
        expectedVersion: 1,
        reason: 'Against a cycle that does not exist.',
      },
      fieldKey: 'GENDER',
    })).toMatchObject({
      success: false,
      message: 'The programme cycle was not found.',
    })
  })

  /**
   * Changing a question changes nothing else about the cycle.
   *
   * Every edit here rebuilds the cycle's **entire** rule set — it has to, since
   * a version is written whole — and reads the current one back rather than
   * trusting the caller to resend it. So the round trip has to be lossless: a
   * policy value this controller forgets to carry is one that resets to its
   * default the next time anybody rewords a question, silently, on a record
   * that decides who is eligible and for how much.
   *
   * The compiler is the first guard — the two casts that used to turn it off
   * are gone — and this is the second, because a value carried as `null`
   * typechecks perfectly.
   *
   * Read from the stored row rather than through the API, deliberately: the
   * policy scalars are **input-only** on the admin surface, so a read there
   * would be asserting against what a resolver happens to expose rather than
   * against what was written.
   */
  it('leaves every other rule of the cycle exactly as it was', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)

    const storedRules = async () => {
      const version = await env.DB.prepare(
        `SELECT policy_reference, applicant_guidance, partner_bank_guidance,
                minimum_applicant_age, maximum_applicant_age, category_a_maximum_months,
                expansion_wait_months, majority_ownership_required, jurisdiction,
                funding_ceiling_state, funding_ceiling_amount_paise, funding_ceiling_scope,
                cycle_code, display_name, cycle_year, status
           FROM seb_programme_cycle_version
          WHERE programme_cycle_id = ?
          ORDER BY version DESC LIMIT 1`,
      ).bind(cycle.id).first()
      const children = await Promise.all(
        ['assessment_rule', 'identifier_rule', 'reason'].map(async (table) => {
          const rows = await env.DB.prepare(
            `SELECT * FROM seb_programme_cycle_${table}
              WHERE programme_cycle_id = ?
                AND programme_cycle_version = (
                  SELECT max(version) FROM seb_programme_cycle_version
                   WHERE programme_cycle_id = ?)
              ORDER BY id`,
          ).bind(cycle.id, cycle.id).all()
          /*
           * Ids are minted fresh on every copy-forward and the version pin
           * moves with the edit, so neither is part of what "unchanged" means.
           * Everything the officer configured is.
           */
          return (rows.results as Record<string, unknown>[])
            .map(({
              id: _id,
              created_at: _created,
              programme_cycle_version: _version,
              ...rest
            }) => rest)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        }),
      )
      return { version, children }
    }

    const before = await storedRules()
    const renamed = await call(officer.cookie, 'updateQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Rewording one question and nothing else.',
      },
      field: {
        stageKey: 'OWNERS', fieldKey: 'NAME', fieldType: 'TEXT',
        parentFieldKey: 'OWNERS', label: 'Full legal name',
        requirement: 'REQUIRED', maxLength: 120, autocompleteHint: 'name',
      },
    })
    expect(renamed.success, renamed.message ?? '').toBe(true)

    expect(await storedRules()).toEqual(before)
    // And the question really did change, or the assertion above is satisfied
    // by an edit that did nothing at all.
    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { formTemplate { fields { key label } } }
    } } } }`, { id: cycle.id }, officer.cookie)
    expect(body.data.admin.programmeCycle.byId.response.formTemplate.fields
      .find((field: { key: string }) => field.key === 'NAME').label)
      .toBe('Full legal name')
  })

  /**
   * The rules an officer configured, read back as they were set.
   *
   * `ProgrammeCyclePolicyInput` carries all of these and **nothing returned any
   * of them**: they could be written and not read. A cycle editor with nothing
   * to populate its fields from has to resend its own defaults on every save,
   * which is how a settled age limit or a funding ceiling gets reset without
   * anybody choosing to.
   */
  it('reads a cycle’s own rules back, not a client’s defaults', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { policy {
        minimumApplicantAge maximumApplicantAge categoryAMaximumMonths
        expansionWaitMonths majorityOwnershipRequired jurisdiction
        fundingCeilingState fundingCeilingAmountPaise fundingCeilingScope
      } }
    } } } }`, { id: cycle.id }, officer.cookie)
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()

    const { formTemplate: _form, identifierRules: _ids, reasons: _reasons,
      requiredAssessmentTypes: _types, ...configured } = testPolicy() as Record<string, unknown>
    expect(body.data.admin.programmeCycle.byId.response.policy)
      .toMatchObject(configured)
  })

  /**
   * Rewording one question does not reorder the form.
   *
   * Every write re-derives each stage's number from its position in the array
   * it is given, and that array came from a read with **no `ORDER BY`** — so a
   * cycle's steps came back in whatever order the planner chose (alphabetical,
   * given the unique index on the stage key) and the next edit renumbered the
   * form to match. Every applicant on the new version then saw the steps in an
   * order nobody had chosen.
   *
   * **This asserts the invariant, not the fault.** A read with no `ORDER BY`
   * returns rows in whatever order the planner picks, and here it picks
   * insertion order — so the test passes against the unordered read too. It is
   * kept because the property is what must hold, and because the planner's
   * choice is exactly the kind of thing that changes under a different row
   * count, a different engine, or a vacuum.
   */
  it('keeps the stages in the order the cycle set them', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)

    const stageKeys = async () => {
      const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
        response { formTemplate { stages { key position } } }
      } } } }`, { id: cycle.id }, officer.cookie)
      expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()
      return body.data.admin.programmeCycle.byId.response.formTemplate.stages
        .map((stage: { key: string }) => stage.key)
    }

    const before = await stageKeys()
    // The fixture's own order, which is not alphabetical — so a read that lost
    // it would be visible rather than coincidentally right.
    expect(before).toEqual(defaultTemplate().stages.map((stage) => stage.stageKey))
    expect([...before].sort()).not.toEqual(before)

    const renamed = await call(officer.cookie, 'updateQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Rewording one question.',
      },
      field: {
        stageKey: 'OWNERS', fieldKey: 'NAME', fieldType: 'TEXT',
        parentFieldKey: 'OWNERS', label: 'Full legal name', requirement: 'REQUIRED',
        maxLength: 120, autocompleteHint: 'name',
      },
    })
    expect(renamed.success, renamed.message ?? '').toBe(true)
    expect(await stageKeys()).toEqual(before)
  })

  it('is not something an applicant can do', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    const applicant = await signIn(['APPLICANT'])
    const refused = await call(applicant.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'Not mine to change.',
      },
      fieldKey: 'GENDER',
    })
    expect(refused.success).toBe(false)
    expect(await questionKeys(officer.cookie, cycle.id)).toContain('GENDER')
  })
})

describe('reusable structures, through the API', () => {
  const partner = {
    definitionKey: 'PARTNER',
    label: 'Partner',
    members: [
      {
        memberKey: 'NAME', fieldType: 'TEXT', label: 'Partner name',
        requirement: 'REQUIRED', maxLength: 120,
      },
      {
        memberKey: 'KIND', fieldType: 'SINGLE_CHOICE', label: 'Kind',
        requirement: 'OPTIONAL',
        options: [
          { optionValue: 'WORKING', optionLabel: 'Working partner' },
          { optionValue: 'SLEEPING', optionLabel: 'Sleeping partner' },
        ],
      },
    ],
  }

  /** Defines PARTNER and adds a PARTNERS group using it. */
  const withPartners = async (cookie: string) => {
    const cycle = await draftCycle(cookie)
    const defined = await call(cookie, 'putGroupDefinition', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: cycle.currentVersion,
        reason: 'A partner is a reusable thing.',
      },
      definition: partner,
    })
    expect(defined.success, defined.message ?? '').toBe(true)
    const used = await call(cookie, 'addQuestion', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: defined.response!.head.currentVersion,
        reason: 'Asking about partners.',
      },
      field: {
        stageKey: 'FINANCIAL', fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP',
        label: 'Partners', requirement: 'OPTIONAL', repeatMin: 0, repeatMax: 5,
        groupDefinitionKey: 'PARTNER',
      },
    })
    expect(used.success, used.message ?? '').toBe(true)
    return { cycle, version: used.response!.head.currentVersion }
  }

  it('stores the definition, materialises the members, and round-trips both', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const { cycle } = await withPartners(officer.cookie)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response {
        groupDefinitions { definitionKey label members {
          memberKey fieldType requirement options { optionValue optionLabel }
        } }
        formTemplate { fields { key repeatGroupKey options { value } } }
      }
    } } } }`, { id: cycle.id }, officer.cookie)
    const response = body.data.admin.programmeCycle.byId.response

    // The editor sees the structure, as authored.
    expect(response.groupDefinitions).toEqual([{
      definitionKey: 'PARTNER',
      label: 'Partner',
      members: [
        {
          memberKey: 'NAME', fieldType: 'TEXT', requirement: 'REQUIRED', options: [],
        },
        {
          memberKey: 'KIND', fieldType: 'SINGLE_CHOICE', requirement: 'OPTIONAL',
          options: [
            { optionValue: 'WORKING', optionLabel: 'Working partner' },
            { optionValue: 'SLEEPING', optionLabel: 'Sleeping partner' },
          ],
        },
      ],
    }])

    // The applicant-facing template sees the expansion: qualified members
    // under the group, with the member's choices along.
    const fields = response.formTemplate.fields as
      Array<{ key: string; repeatGroupKey: string | null; options: { value: string }[] }>
    const name = fields.find((field) => field.key === 'PARTNERS__NAME')
    const kind = fields.find((field) => field.key === 'PARTNERS__KIND')
    expect(name).toMatchObject({ repeatGroupKey: 'PARTNERS' })
    expect(kind?.options.map((option) => option.value)).toEqual(['WORKING', 'SLEEPING'])
  })

  it('survives a version bump with its definition intact', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const { cycle, version } = await withPartners(officer.cookie)
    // Any ordinary edit bumps the version and copies every rule table forward.
    const renamed = await call(officer.cookie, 'updateStage', {
      scope: {
        programmeCycleId: cycle.id, expectedVersion: version,
        reason: 'Rewording a stage; the structures must ride along.',
      },
      stage: { stageKey: 'OWNERS', title: 'The people', sortOrder: 1 },
    })
    expect(renamed.success, renamed.message ?? '').toBe(true)

    const body = await graphql<any>(`query($id: ID!) { admin { programmeCycle { byId(id: $id) {
      response { groupDefinitions { definitionKey members { memberKey } } }
    } } } }`, { id: cycle.id }, officer.cookie)
    expect(body.data.admin.programmeCycle.byId.response.groupDefinitions)
      .toEqual([{
        definitionKey: 'PARTNER',
        members: [{ memberKey: 'NAME' }, { memberKey: 'KIND' }],
      }])
  })

  it('refuses to remove a structure in use, naming the group', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const { cycle, version } = await withPartners(officer.cookie)
    const refused = await call(officer.cookie, 'removeGroupDefinition', {
      scope: {
        programmeCycleId: cycle.id, expectedVersion: version,
        reason: 'Trying to drop a structure that is in use.',
      },
      definitionKey: 'PARTNER',
    })
    expect(refused).toMatchObject({
      success: false,
      message: 'PARTNER is used by PARTNERS. Remove those groups first.',
    })

    // Drop the group, and the structure can go.
    const dropped = await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id, expectedVersion: version,
        reason: 'No longer asking about partners.',
      },
      fieldKey: 'PARTNERS',
    })
    expect(dropped.success, dropped.message ?? '').toBe(true)
    const removed = await call(officer.cookie, 'removeGroupDefinition', {
      scope: {
        programmeCycleId: cycle.id,
        expectedVersion: dropped.response!.head.currentVersion,
        reason: 'Dropping the unused structure.',
      },
      definitionKey: 'PARTNER',
    })
    expect(removed.success, removed.message ?? '').toBe(true)
  })

  it('refuses to remove a structure the cycle never defined, by name', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const cycle = await draftCycle(officer.cookie)
    expect(await call(officer.cookie, 'removeGroupDefinition', {
      scope: {
        programmeCycleId: cycle.id, expectedVersion: cycle.currentVersion,
        reason: 'Removing something that is not there.',
      },
      definitionKey: 'NOWHERE',
    })).toMatchObject({
      success: false,
      message: 'This cycle defines no structure called NOWHERE.',
    })
  })

  it('refuses an edit addressed to a derived member', async () => {
    const officer = await signIn(['SUPER_ADMIN'])
    const { cycle, version } = await withPartners(officer.cookie)
    // The derived rows are stripped on the authoring read, so a derived key is
    // simply not a question the editor can name.
    expect(await call(officer.cookie, 'removeQuestion', {
      scope: {
        programmeCycleId: cycle.id, expectedVersion: version,
        reason: 'Trying to edit an expansion.',
      },
      fieldKey: 'PARTNERS__NAME',
    })).toMatchObject({
      success: false,
      message: 'This cycle has no question called PARTNERS__NAME.',
    })
  })
})
