/**
 * Driving the product the way a caller would, so a fixture cannot outlive it.
 *
 * Both service suites used to keep their own copy of "get an application to
 * submitted", and the copies had already diverged — one wrote the answer
 * columns directly, the other went through `saveDraft`. With the form in the
 * database rather than in columns, a fixture that writes rows by hand is a
 * fixture that can seed an application the product would have refused, and the
 * test built on it then asserts against a state that cannot occur.
 *
 * So everything here goes through the real mutation wherever one exists. Raw
 * SQL is reserved for the two things no mutation reaches: a session (the
 * password path is another suite's subject) and an uploaded document's bytes
 * (they live in R2, which the service suite does not run).
 */
import { env, SELF } from './worker'
import { hashPassword, sessionTokenDigest } from '../../src/services/auth/crypto'
import { catalogue } from '../../src/services/auth/permissions'
import { completeAnswers, defaultTemplate, requiredDocuments } from './form'
import { ensureTestPipeline, TEST_PIPELINE_ID } from './pipeline'

export type GraphQLBody<T> = { data?: T; errors?: Array<{ message: string }> }

export const graphql = async <T>(
  query: string,
  variables: Record<string, unknown> = {},
  cookie?: string,
  /** Extra request headers, for tests about what an audit row retains. */
  extraHeaders: Record<string, string> = {},
): Promise<GraphQLBody<T>> => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: 'https://app.example.test',
    ...extraHeaders,
  })
  if (cookie) headers.set('cookie', cookie)
  const response = await SELF.fetch('https://api.example.test/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })
  return (await response.json()) as GraphQLBody<T>
}

/** Reads one field out of a result, and fails loudly with the whole body. */
const expectSuccess = <T>(body: GraphQLBody<T>, what: string): T => {
  if (body.errors?.length || !body.data) {
    throw new Error(`${what} failed: ${JSON.stringify(body.errors ?? body)}`)
  }
  return body.data
}

/*
 * Catalogue-derived selectors, so a suite can say "a member of staff" without
 * writing down a policy.
 *
 * Derived rather than listed: a pair added to the catalogue joins these
 * automatically, and none of them can drift from what the server enforces. A
 * hand-written `REVIEWER = [...]` table would be the authorization policy
 * living a second time in the tests, and a wrong pair at a call site would then
 * be invisible.
 *
 * Suites that assert *authorization* name their pairs explicitly instead. These
 * are for the many suites that merely need somebody who can reach a screen.
 */
export const everyPermission = (): FixturePermission[] =>
  catalogue.map((pair) => [pair.resource, pair.action] as const)

export const everyReadPermission = (): FixturePermission[] =>
  catalogue.filter((pair) => pair.action === 'read')
    .map((pair) => [pair.resource, pair.action] as const)

export const permissionsOn = (resource: string): FixturePermission[] =>
  catalogue.filter((pair) => pair.resource === resource)
    .map((pair) => [pair.resource, pair.action] as const)

/** One authority decided in code, which a fixture may still grant by name. */
type BuiltinRole = 'APPLICANT' | 'SUPER_ADMIN'

/** A resource and act, as a fixture states the authority it is exercising. */
export type FixturePermission = readonly [resource: string, action: string]

/**
 * A signed-in user holding exactly the authority named, and no more.
 *
 * `permissions` takes explicit pairs rather than a role-name shorthand, and
 * that is the whole point: a fixture with a `REVIEWER = [...]` table would be a
 * second copy of the authorization policy living in the tests, and a wrong pair
 * at a call site would then be invisible — the test would grant exactly the
 * mistake it was meant to catch.
 *
 * The ad-hoc role is real: a `core_role` row with real permission rows, granted
 * through the same table the product writes. Nothing here is a stand-in.
 */
export const signIn = async (
  authority: {
    roles?: readonly BuiltinRole[]
    permissions?: readonly FixturePermission[]
    /**
     * A real password, hashed as the product hashes one.
     *
     * Only needed by suites exercising a step-up confirmation. Left unset
     * elsewhere because scrypt is real CPU and blocks the isolate, so paying
     * for it on every fixture would slow the whole suite for one assertion.
     */
    password?: string
  } = {},
) => {
  const userId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = Date.now()
  const builtins = authority.roles ?? []
  const permissions = authority.permissions ?? []
  const roleId = crypto.randomUUID()
  const passwordHash = authority.password === undefined
    ? 'unused'
    : await hashPassword(authority.password)

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_user (
        id, email, password_hash, email_verified_at, row_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(userId, `${userId}@example.test`, passwordHash, now, now, now),
    ...builtins.map((role) => env.DB.prepare(
      `INSERT INTO core_user_role_grant (
        id, user_id, role, grant_reason, granted_at
      ) VALUES (?, ?, ?, 'TEST_FIXTURE', ?)`,
    ).bind(crypto.randomUUID(), userId, role, now)),
    ...(permissions.length === 0 ? [] : [
      env.DB.prepare(
        `INSERT INTO core_role (
          id, key, name, description, current_version, created_at, updated_at,
          created_by_user_id
        ) VALUES (?, ?, 'Fixture role', 'Composed by a test.', 1, ?, ?, ?)`,
      ).bind(roleId, `FIXTURE_${roleId.replace(/-/gu, '').slice(0, 20).toUpperCase()}`, now, now, userId),
      ...permissions.map(([resource, action]) => env.DB.prepare(
        `INSERT INTO core_role_permission (id, role_id, resource, action, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), roleId, resource, action, now)),
      env.DB.prepare(
        `INSERT INTO core_user_role_grant (
          id, user_id, role_id, grant_reason, granted_at
        ) VALUES (?, ?, ?, 'TEST_FIXTURE', ?)`,
      ).bind(crypto.randomUUID(), userId, roleId, now),
    ]),
    env.DB.prepare(
      `INSERT INTO core_session (
        id, user_id, token_digest, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), userId,
      await sessionTokenDigest(env.AUTH_SECRET, token),
      now + 86_400_000, now, now,
    ),
  ])
  await ensureTestPipeline(userId)
  return { userId, roleId, cookie: `seb_session=${token}` }
}

/**
 * A cycle policy the product accepts, with the fixture form on it.
 *
 * Exported as a function rather than an object: a suite that mutates a shared
 * literal to make one case fail changes every later case in the file, and the
 * failure surfaces somewhere else entirely.
 */
export const testPolicy = (): Record<string, unknown> => ({
  minimumApplicantAge: 18,
  maximumApplicantAge: 60,
  categoryAMaximumMonths: 24,
  majorityOwnershipRequired: true,
  jurisdiction: 'TTAADC',
  fundingCeilingState: 'UNRESOLVED',
  fundingCeilingAmountPaise: null,
  fundingCeilingScope: null,
  formTemplate: defaultTemplate(),
  pipelineId: TEST_PIPELINE_ID,
  applicationKinds: [
    /*
     * One open first application per enterprise at a time — the rule the
     * hard-coded workflow used to enforce, now configured like any other.
     */
    {
      kindKey: 'INITIAL', label: 'First application', description: null,
      // As the wire carries it: parameters are JSON text in the GraphQL input.
      rules: [{
        ruleType: 'NO_OPEN_APPLICATION_OF_KIND',
        paramsJson: JSON.stringify({ kind: 'INITIAL' }),
      }],
    },
  ],
})

/** The minimum a role-gate probe needs: enough to pass GraphQL validation. */
export const emptyFormTemplate = '{ stages: [], fields: [], options: [], conditions: [] }'

export type CycleHead = { id: string; currentVersion: number }

/**
 * A published policy PDF, seeded as rows.
 *
 * Raw SQL under this file's own exception: the real path PUTs bytes to R2 and
 * waits for the malware scanner, and the service suite runs neither. The rows
 * mirror exactly what `finalizePolicyDocumentUpload` plus an ACCEPTED verdict
 * would leave behind, which is what opening a cycle demands.
 */
export const seedPolicyDocument = async (cycleId: string): Promise<void> => {
  const documentId = crypto.randomUUID()
  const versionId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(`INSERT INTO seb_cycle_policy_document (
    id, programme_cycle_id, current_version, created_at, updated_at
  ) VALUES (?, ?, 1, ?, ?)`).bind(documentId, cycleId, now, now).run()
  await env.DB.prepare(`INSERT INTO seb_cycle_policy_document_version (
    id, document_id, version, operation, r2_object_key, original_filename,
    content_type, size_bytes, checksum, uploaded_by_user_id, created_at
  ) VALUES (?, ?, 1, 'UPLOAD', ?, 'policy.pdf', 'application/pdf', 1024, ?,
    (SELECT id FROM core_user LIMIT 1), ?)`)
    .bind(versionId, documentId, `cycles/${cycleId}/policy/${versionId}`,
      'c2hhLTI1Ni10ZXN0LWNoZWNrc3VtLXZhbHVlLTAwMDA=', now)
    .run()
  await env.DB.prepare(`INSERT INTO seb_cycle_policy_document_scan (
    id, document_version_id, sequence_number, status, scanner_reference,
    safe_message, scanned_at, created_at
  ) VALUES (?, ?, 1, 'ACCEPTED', 'seed', NULL, ?, ?)`)
    .bind(crypto.randomUUID(), versionId, now, now)
    .run()
}

/** A cycle created and opened, which is the only state an applicant can use. */
export const openCycle = async (
  cookie: string,
  policyOverride: Record<string, unknown> = {},
  cycleOverride: Record<string, unknown> = {},
): Promise<CycleHead> => {
  const input = {
    cycleCode: `SEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    displayName: 'Mission SEP Test Cycle',
    cycleYear: 2026,
    applicantGuidance: 'Applicant guide.',
    opensAt: new Date(Date.now() - 1_000).toISOString(),
    closesAt: new Date(Date.now() + 86_400_000).toISOString(),
    policy: { ...testPolicy(), ...policyOverride },
    ...cycleOverride,
  }
  const created = await graphql<any>(`mutation($input: ProgrammeCycleInput!) {
    admin { programmeCycle { create(input: $input) {
      success message response { head { id currentVersion } }
    } } }
  }`, { input }, cookie)
  const head = expectSuccess(created, 'cycle create').admin.programmeCycle.create
  if (!head.success) throw new Error(`cycle create refused: ${head.message}`)
  await seedPolicyDocument(head.response.head.id)

  const opened = await graphql<any>(`mutation($input: CycleTransitionInput!) {
    admin { programmeCycle { open(input: $input) {
      success message response { head { id currentVersion } }
    } } }
  }`, { input: {
    id: head.response.head.id,
    expectedVersion: head.response.head.currentVersion,
    reason: 'Publish',
  } }, cookie)
  const result = expectSuccess(opened, 'cycle open').admin.programmeCycle.open
  if (!result.success) throw new Error(`cycle open refused: ${result.message}`)
  return result.response.head as CycleHead
}

/** An enterprise profile the eligibility rules pass. */
export const createEnterprise = async (
  cookie: string,
  override: Record<string, unknown> = {},
): Promise<string> => {
  const body = await graphql<any>(`mutation($input: EnterpriseProfileInput!) {
    seb { enterprise { create(input: $input) { success message response { id } } } }
  }`, { input: {
    name: `Test Enterprise ${crypto.randomUUID().slice(0, 8)}`,
    establishmentDate: '2026-01-01',
    registrationType: 'SOLE_PROPRIETORSHIP', registrationNumber: null, gstin: null,
    businessSector: 'FOOD_PROCESSING', otherBusinessSector: null,
    businessBlockOrVillage: 'Khumulwng', businessDistrict: 'WEST_TRIPURA',
    businessPinCode: '799045', contactNumber: '+919876543210',
    contactEmail: 'rina@example.test',
    ...override,
  } }, cookie)
  const result = expectSuccess(body, 'enterprise create').seb.enterprise.create
  if (!result.success) throw new Error(`enterprise refused: ${result.message}`)
  return result.response.id as string
}

/** A fresh draft against an open cycle, of the fixture policy's one kind by default. */
export const startApplication = async (
  cookie: string, enterpriseId: string, programmeCycleId: string, applicationKind = 'INITIAL',
): Promise<string> => {
  const body = await graphql<any>(`mutation($input: StartApplicationInput!) {
    seb { application { start(input: $input) { success message response { id } } } }
  }`, { input: { enterpriseId, programmeCycleId, applicationKind } }, cookie)
  const result = expectSuccess(body, 'start').seb.application.start
  if (!result.success) throw new Error(`start refused: ${result.message}`)
  return result.response.id as string
}

/** The whole form, answered. Returns the versions the next call must quote. */
export const saveAnswers = async (
  cookie: string,
  applicationId: string,
  answers: Record<string, unknown> = completeAnswers(),
  expected: { version: number; statusVersion: number } = { version: 1, statusVersion: 1 },
): Promise<{ currentVersion: number; statusVersion: number }> => {
  const body = await graphql<any>(`mutation($input: SaveApplicationDraftInput!) {
    seb { application { saveDraft(input: $input) {
      success message response { currentVersion statusVersion }
    } } }
  }`, { input: {
    applicationId,
    expectedVersion: expected.version,
    expectedStatusVersion: expected.statusVersion,
    answers,
  } }, cookie)
  const result = expectSuccess(body, 'saveDraft').seb.application.saveDraft
  if (!result.success) throw new Error(`saveDraft refused: ${result.message}`)
  return result.response
}

/**
 * A scan verdict against one uploaded version.
 *
 * The queue writes these; the office reads them before it will hand out a
 * download link. A test that wants a document readable needs an `ACCEPTED`
 * row, and one that wants the gate shut needs `PENDING` — which is what
 * finalization leaves behind, not an absence.
 */
const recordScan = async (
  versionId: string,
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FAILED',
  reference: string | null = 'TEST',
) => {
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO seb_application_document_scan (
    id, document_version_id, sequence_number, status, scanner_reference,
    scanned_at, created_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), versionId, status, reference,
      status === 'PENDING' ? null : now, now)
    .run()
}

/**
 * The evidence the fixture form asks for, written straight to the tables.
 *
 * The real path issues an upload intent and finalizes it against R2, which the
 * service suite has no bucket for. What matters to every caller here is that
 * the rows exist and name a scannable object, not how the bytes arrived.
 */
export type SeededDocument = { fieldKey: string; documentId: string; versionId: string }

/** No verdict at all, which is not the same as a verdict of "not yet". */
export type ScanState = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FAILED' | 'NONE'

export const attachEvidence = async (
  applicationId: string,
  userId: string,
  fieldKeys: readonly string[] = requiredDocuments,
  /*
   * Accepted by default, because that is what a submitted application looks
   * like once the queue has run, and every test about what the office does
   * next assumes it. A test about the gate itself asks for something else.
   */
  scan: ScanState = 'ACCEPTED',
): Promise<SeededDocument[]> => {
  const now = Date.now()
  const seeded: SeededDocument[] = []
  for (const fieldKey of fieldKeys) {
    const documentId = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    seeded.push({ fieldKey, documentId, versionId })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO seb_application_document (
          id, application_id, field_key, current_version, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(documentId, applicationId, fieldKey, now, now),
      env.DB.prepare(
        `INSERT INTO seb_application_document_version (
          id, document_id, version, operation, r2_object_key, original_filename,
          content_type, size_bytes, checksum, uploaded_by_user_id, created_at
        ) VALUES (?, ?, 1, 'UPLOAD', ?, ?, 'application/pdf', 10, ?, ?, ?)`,
      ).bind(
        versionId, documentId, `test/${versionId}`,
        `${fieldKey}.pdf`, 'A'.repeat(43) + '=', userId, now,
      ),
    ])
    if (scan !== 'NONE') await recordScan(versionId, scan)
  }
  return seeded
}

/** Submits, and refuses to return quietly if the product said no. */
export const submitApplication = async (
  cookie: string,
  applicationId: string,
  expected: { version: number; statusVersion: number },
) => {
  const body = await graphql<any>(`mutation($input: ApplicationVersionInput!) {
    seb { application { submit(input: $input) {
      success message response { currentVersion statusVersion status }
    } } }
  }`, { input: {
    applicationId,
    expectedVersion: expected.version,
    expectedStatusVersion: expected.statusVersion,
  } }, cookie)
  const result = expectSuccess(body, 'submit').seb.application.submit
  if (!result.success) throw new Error(`submit refused: ${result.message}`)
  return result.response as { currentVersion: number; statusVersion: number; status: string }
}

/**
 * An application in front of the office, by the route an applicant takes.
 *
 * Every admin test that reviews, refers, decides or funds starts here, so this
 * is the one place that knows what "submitted" costs. It is deliberately not a
 * shortcut: an admin suite seeding a submission by hand is how the office ends
 * up tested against applications the applicant path could never produce.
 */
export const submittedApplication = async (
  applicantCookie: string,
  applicantUserId: string,
  cycleId: string,
  options: { answers?: Record<string, unknown>; scan?: ScanState } = {},
) => {
  const enterpriseId = await createEnterprise(applicantCookie)
  const applicationId = await startApplication(applicantCookie, enterpriseId, cycleId)
  const saved = await saveAnswers(
    applicantCookie, applicationId, options.answers ?? completeAnswers(),
  )
  const documents = await attachEvidence(
    applicationId, applicantUserId, requiredDocuments, options.scan ?? 'ACCEPTED',
  )
  const submitted = await submitApplication(applicantCookie, applicationId, {
    version: saved.currentVersion, statusVersion: saved.statusVersion,
  })
  const row = await env.DB.prepare(
    `SELECT id FROM seb_application_submission
      WHERE application_id = ? ORDER BY submission_number DESC LIMIT 1`,
  ).bind(applicationId).first<{ id: string }>()
  if (!row) throw new Error('submission row missing after a successful submit')
  /*
   * Submitting pins the evidence, so these rows exist already. A test that
   * inserts its own would be asserting against a pin the product did not
   * make — and would collide with the real one on the same field key.
   */
  const pinned = (await env.DB.prepare(
    `SELECT id AS "submissionDocumentId", field_key AS "fieldKey",
            document_id AS "documentId"
       FROM seb_application_submission_document WHERE submission_id = ?`,
  ).bind(row.id).all<{
    submissionDocumentId: string; fieldKey: string; documentId: string
  }>()).results
  return {
    enterpriseId, applicationId, submissionId: row.id, documents,
    /** The evidence as the submission pinned it, by field key. */
    pins: Object.fromEntries(pinned.map((pin) => [pin.fieldKey, {
      ...pin,
      versionId: documents.find((each) => each.fieldKey === pin.fieldKey)!.versionId,
    }])),
    currentVersion: submitted.currentVersion,
    statusVersion: submitted.statusVersion,
  }
}
