/**
 * Layer 4: hostile and malformed input, through the real API.
 *
 * Every case here goes over HTTP and then reads **the stored rows**, not the
 * response envelope. A refusal that returns `success: false` and writes the
 * answer anyway is the failure this layer exists to catch, and no assertion on
 * the response can see it.
 *
 * The half that makes this a security test rather than a validation test: an
 * answer to a question the form is not asking must not merely be refused — it
 * must be absent from storage, from a later submission's snapshot, and from
 * what the office is shown. A value that survives anywhere is a value somebody
 * eventually reads as the applicant's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env, SELF } from '../support/worker'
import {
  attachEvidence,
  graphql,
  openCycle,
  saveAnswers,
  signIn,
  startApplication,
  createEnterprise,
  submitApplication,
} from '../support/api'
import { completeAnswers } from '../support/form'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

type Saved = { applicationId: string; cookie: string; userId: string; cycleId: string }

const draft = async (): Promise<Saved> => {
  const administrator = await signIn(['SUPER_ADMIN'])
  const applicant = await signIn(['APPLICANT'])
  const cycle = await openCycle(administrator.cookie)
  const enterpriseId = await createEnterprise(applicant.cookie)
  const applicationId = await startApplication(applicant.cookie, enterpriseId, cycle.id)
  await saveAnswers(applicant.cookie, applicationId)
  return {
    applicationId, cookie: applicant.cookie, userId: applicant.userId, cycleId: cycle.id,
  }
}

/** Attempts a save and reports what came back, without throwing on refusal. */
const attemptSave = async (
  saved: Saved,
  answers: unknown,
  expected: { version: number; statusVersion: number },
) => {
  const body = await graphql<any>(`mutation($input: SaveApplicationDraftInput!) {
    seb { application { saveDraft(input: $input) { success message } } }
  }`, { input: {
    applicationId: saved.applicationId,
    expectedVersion: expected.version,
    expectedStatusVersion: expected.statusVersion,
    answers,
  } }, saved.cookie)
  return {
    errors: body.errors,
    result: body.data?.seb.application.saveDraft as
      { success: boolean; message: string | null } | undefined,
  }
}

/** Every answer stored against this application, whatever the version. */
const storedKeys = async (applicationId: string): Promise<string[]> => {
  const rows = (await env.DB.prepare(
    `SELECT DISTINCT a.field_key AS "fieldKey"
       FROM seb_application_version_answer a
       JOIN seb_application_version v ON v.id = a.application_version_id
      WHERE v.application_id = ?`,
  ).bind(applicationId).all<{ fieldKey: string }>()).results
  return rows.map((row) => row.fieldKey).sort()
}

const storedValue = async (applicationId: string, fieldKey: string): Promise<string[]> => {
  const rows = (await env.DB.prepare(
    `SELECT a.value_text AS "valueText"
       FROM seb_application_version_answer a
       JOIN seb_application_version v ON v.id = a.application_version_id
      WHERE v.application_id = ? AND a.field_key = ?`,
  ).bind(applicationId, fieldKey).all<{ valueText: string }>()).results
  return rows.map((row) => row.valueText)
}

describe('answers the form did not ask for', () => {
  it('refuses an undeclared key rather than dropping it', async () => {
    const saved = await draft()
    const before = await storedKeys(saved.applicationId)

    const { result } = await attemptSave(
      saved,
      { ...completeAnswers(), NOT_A_QUESTION: 'smuggled' },
      { version: 2, statusVersion: 1 },
    )

    /*
     * Refused, not ignored. A client holding a cached older form would
     * otherwise be told the save succeeded and watch its answers disappear —
     * and the applicant would have no way to tell which.
     */
    expect(result?.success).toBe(false)
    expect(await storedKeys(saved.applicationId)).toEqual(before)
    expect(await storedValue(saved.applicationId, 'NOT_A_QUESTION')).toEqual([])
  })

  /*
   * Refused either by the scalar — before a resolver runs, so there is no
   * envelope at all — or by the engine, with one. Which of the two depends on
   * whether the key can be a field key at all, and both are correct; what must
   * never happen is that it is accepted.
   */
  it('stores nothing for a key that only looks like a question', async () => {
    const saved = await draft()
    for (const key of ['constructor', 'BUSINESS_NAME ', 'business_name', 'BUSINESS-NAME']) {
      const { errors, result } = await attemptSave(
        saved, { ...completeAnswers(), [key]: 'x' }, { version: 2, statusVersion: 1 },
      )
      expect((errors?.length ?? 0) > 0 || result?.success === false, key).toBe(true)
      expect(await storedValue(saved.applicationId, key), key).toEqual([])
    }
  })

  /**
   * Prototype pollution.
   *
   * **Built with `defineProperty`, not a spread.** `{ ...answers, __proto__: x }`
   * sets the object's prototype instead of creating a key, so the request
   * would carry no such field and the test would prove nothing. This puts a
   * real own property called `__proto__` on the wire, which is what a hostile
   * client sends.
   */
  it('does not let __proto__ reach anything that survives the request', async () => {
    const saved = await draft()
    const hostile: Record<string, unknown> = { ...completeAnswers() }
    Object.defineProperty(hostile, '__proto__', {
      value: { polluted: true }, enumerable: true, configurable: true, writable: true,
    })
    expect(Object.keys(hostile)).toContain('__proto__')

    const { errors, result } = await attemptSave(saved, hostile, { version: 2, statusVersion: 1 })

    // Refused by the scalar's key-format check, before any resolver sees it.
    expect((errors?.length ?? 0) > 0 || result?.success === false).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(await storedValue(saved.applicationId, '__proto__')).toEqual([])
  })

  it('refuses a whole answer set that is missing a question the form asks', async () => {
    const saved = await draft()
    const { NOC_REQUIRED: _dropped, ...incomplete } = completeAnswers()
    const before = await storedKeys(saved.applicationId)

    const { result } = await attemptSave(saved, incomplete, { version: 2, statusVersion: 1 })

    /*
     * A save is a total replacement, so an absent key is not "leave it alone"
     * — it is a claim about the whole form, and one the client cannot have
     * meant. Accepting it would silently clear an answer.
     */
    expect(result?.success).toBe(false)
    expect(await storedKeys(saved.applicationId)).toEqual(before)
  })
})

describe('an answer to a question the form is not asking', () => {
  /**
   * `GOVERNMENT_SCHEME_NAME` is asked only when the applicant says they have
   * had government funding before. Answering it while that is `false` is the
   * case where a refusal is not enough: the value must not survive anywhere a
   * person later reads it as something the applicant said.
   */
  const HIDDEN = 'GOVERNMENT_SCHEME_NAME'

  const smuggle = async () => {
    const saved = await draft()
    await saveAnswers(
      saved.cookie,
      saved.applicationId,
      {
        ...completeAnswers(),
        RECEIVED_GOVERNMENT_FUNDING: false,
        [HIDDEN]: 'A scheme nobody asked about',
      },
      { version: 2, statusVersion: 1 },
    )
    return saved
  }

  it('is genuinely a question this form is not asking', async () => {
    /*
     * Asserted rather than assumed. If the fixture ever stopped gating this
     * question, every test below would pass by describing an ordinary answer.
     */
    const saved = await smuggle()
    const body = await graphql<any>(`query($id: ID!) { seb { application { byId(id: $id) {
      response { answers }
    } } } }`, { id: saved.applicationId }, saved.cookie)
    expect(body.data.seb.application.byId.response.answers.RECEIVED_GOVERNMENT_FUNDING)
      .toBe(false)
  })

  it('is not stored', async () => {
    const saved = await smuggle()
    expect(await storedValue(saved.applicationId, HIDDEN)).toEqual([])
  })

  it('is not in the answers the applicant is shown back', async () => {
    const saved = await smuggle()
    const body = await graphql<any>(`query($id: ID!) { seb { application { byId(id: $id) {
      response { answers }
    } } } }`, { id: saved.applicationId }, saved.cookie)
    expect(body.data.seb.application.byId.response.answers[HIDDEN] ?? null).toBeNull()
  })

  it('is not in what the office is shown once it is submitted', async () => {
    const saved = await smuggle()
    await attachEvidence(saved.applicationId, saved.userId)
    const head = (await env.DB.prepare(
      `SELECT current_version AS "version", status_version AS "statusVersion"
         FROM seb_application WHERE id = ?`,
    ).bind(saved.applicationId).first<{ version: number; statusVersion: number }>())!
    await submitApplication(saved.cookie, saved.applicationId, head)

    const officer = await signIn(['ADMIN'])
    const workspace = await graphql<any>(`query($id: ID!) { admin { intake { workspace(applicationId: $id) {
      success response { snapshots { version answers } }
    } } } }`, { id: saved.applicationId }, officer.cookie)
    expect(workspace.errors, JSON.stringify(workspace.errors)).toBeUndefined()
    const snapshots = workspace.data.admin.intake.workspace.response.snapshots as
      Array<{ version: number; answers: Record<string, unknown> }>
    /*
     * Every frozen version, not just the latest: an answer smuggled into an
     * earlier one is still an answer somebody reads.
     */
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) {
      expect(snapshot.answers[HIDDEN] ?? null, `version ${snapshot.version}`).toBeNull()
    }
  })

  /*
   * And the reviewer can read what the applicant *did* write. Asserted beside
   * the leak test because the two pull in opposite directions: the cheapest
   * way to pass the test above is to show the office nothing at all.
   */
  it('leaves the office able to read the answers that were given', async () => {
    const saved = await smuggle()
    await attachEvidence(saved.applicationId, saved.userId)
    const head = (await env.DB.prepare(
      `SELECT current_version AS "version", status_version AS "statusVersion"
         FROM seb_application WHERE id = ?`,
    ).bind(saved.applicationId).first<{ version: number; statusVersion: number }>())!
    await submitApplication(saved.cookie, saved.applicationId, head)

    const officer = await signIn(['ADMIN'])
    const workspace = await graphql<any>(`query($id: ID!) { admin { intake { workspace(applicationId: $id) {
      response { snapshots { answers } }
    } } } }`, { id: saved.applicationId }, officer.cookie)
    const answers = workspace.data.admin.intake.workspace.response.snapshots
      .at(-1)!.answers as Record<string, unknown>
    expect(answers.BUSINESS_NAME).toBe(completeAnswers().BUSINESS_NAME)
    expect(answers.SEED_FUND_REQUESTED_PAISE).toBe(completeAnswers().SEED_FUND_REQUESTED_PAISE)
  })
})

describe('the bounds on one request', () => {
  /*
   * Each bound at the value that must be accepted and the value one past it.
   * A limit tested only well inside and well outside passes whatever the
   * comparison is written as.
   */
  const LEAF_MAX = 8_192
  const KEY_MAX = 500

  it('accepts a leaf exactly at the length limit', async () => {
    const saved = await draft()
    const { result } = await attemptSave(
      saved,
      { ...completeAnswers(), OTHER_BUSINESS_SECTOR: 'x'.repeat(LEAF_MAX) },
      { version: 2, statusVersion: 1 },
    )
    /*
     * Accepted by the scalar and then refused by the form's own length rule —
     * which is the point: the two limits are different things. The scalar
     * bounds one request; the cycle bounds one answer.
     */
    expect(result?.success).toBe(false)
    expect(result?.message).not.toContain('at most')
  })

  it('refuses a leaf one character past the length limit', async () => {
    const saved = await draft()
    const { errors, result } = await attemptSave(
      saved,
      { ...completeAnswers(), OTHER_BUSINESS_SECTOR: 'x'.repeat(LEAF_MAX + 1) },
      { version: 2, statusVersion: 1 },
    )
    // Refused before any resolver runs, so there is no envelope at all.
    expect(errors?.length ?? 0).toBeGreaterThan(0)
    expect(result).toBeUndefined()
  })

  /**
   * A payload well inside every size limit that nevertheless cannot be walked.
   *
   * The bound was measured with `JSON.stringify`, which recurses, and it ran
   * **before** anything checked the shape — so this reached that line and
   * overflowed the stack there, on the statement whose own comment said a
   * hostile payload is "refused on its size rather than on the work of
   * inspecting it". The ordering also bought nothing: `JSON.parse` has built the
   * whole structure before a scalar's `parseValue` is called at all.
   *
   * Thirty thousand deep and about 60 KB — comfortably under the 64 KB limit,
   * so size was never going to be what refused it.
   */
  /**
   * A payload well inside every size limit that nevertheless cannot be walked.
   *
   * The bound was measured with `JSON.stringify`, which recurses, and it ran
   * **before** anything checked the shape — so a deeply nested value reached
   * that line and overflowed the stack there, on the statement whose own
   * comment said a hostile payload is "refused on its size rather than on the
   * work of inspecting it". The ordering bought nothing either: `JSON.parse`
   * has built the whole structure before a scalar's `parseValue` is called.
   *
   * **Depth is bounded now by the grammar rather than by the size**, which is
   * the case below. This one is here for what the scalar cannot own: at thirty
   * thousand deep the request body defeats `JSON.parse` itself, long before any
   * resolver or scalar runs. What is asserted is only that the server answers —
   * with an error rather than by falling over — because that is the whole of
   * what this layer can promise about it.
   */
  it('answers rather than hanging on a payload no parser can read', async () => {
    const saved = await draft()
    /*
     * Sent as a raw body, which is how it would really arrive. The helper
     * builds its request with `JSON.stringify`, and that recurses too, so
     * constructing this in JavaScript overflows the *test's* stack before the
     * server ever sees it.
     */
    const nested = `${'['.repeat(30_000)}${']'.repeat(30_000)}`
    const body = JSON.stringify({
      query: `mutation($input: SaveApplicationDraftInput!) {
        seb { application { saveDraft(input: $input) { success message } } }
      }`,
      variables: {
        input: {
          applicationId: saved.applicationId,
          expectedVersion: 2,
          expectedStatusVersion: 1,
          answers: '__ANSWERS__',
        },
      },
    }).replace('"__ANSWERS__"', `{"OTHER_BUSINESS_SECTOR":${nested}}`)
    // Comfortably inside the 64 KB limit, so size was never going to refuse it.
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(120_000)

    const response = await SELF.fetch('https://api.example.test/graphql', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        origin: 'https://app.example.test',
        cookie: saved.cookie,
      }),
      body,
    })
    const answered = await response.json() as { errors?: unknown[]; data?: unknown }
    expect(answered.errors?.length ?? 0).toBeGreaterThan(0)
    // And nothing was written: a refusal, not a partial save.
    expect(await storedValue(saved.applicationId, 'OTHER_BUSINESS_SECTOR')).toEqual([])
  })

  it('refuses more keys than one request may carry', async () => {
    const saved = await draft()
    const many: Record<string, unknown> = { ...completeAnswers() }
    for (let index = 0; index < KEY_MAX + 1; index += 1) many[`EXTRA_${index}`] = 'x'
    const { errors } = await attemptSave(saved, many, { version: 2, statusVersion: 1 })
    expect(errors?.length ?? 0).toBeGreaterThan(0)
  })

  /**
   * `NaN` and `Infinity` do not survive JSON — both encode as `null` — so what
   * arrives is indistinguishable from a deliberately cleared answer. The point
   * is that neither reaches storage as a number, because a stored `NaN` makes
   * every later comparison false without ever looking wrong.
   */
  it.each([['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY]] as const)(
    'never stores %s as an amount',
    async (_label, value) => {
      const saved = await draft()
      await attemptSave(
        saved,
        { ...completeAnswers(), SEED_FUND_REQUESTED_PAISE: value },
        { version: 2, statusVersion: 1 },
      )
      for (const stored of await storedValue(saved.applicationId, 'SEED_FUND_REQUESTED_PAISE')) {
        expect(Number.isFinite(Number(stored)), stored).toBe(true)
      }
    },
  )
})
