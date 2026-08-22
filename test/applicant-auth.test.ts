import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/db'
import { auditActions } from '../src/db/schema'
import worker from '../src/index'
import { createDigest, hashPassword } from '../src/services/auth/crypto'
import { bootstrapFirstSuperAdmin } from '../src/services/auth'
import {
  consumeWrongOtpAttempt,
  createApplicantSession,
  createUserFromSignupChallenge,
  findActiveApplicantByEmail,
  findSignupChallenge,
  grantFirstSuperAdmin,
  type AuditEventRecord,
  type SessionRecord,
} from '../src/services/auth/queries/auth'
import type { AuthOperationContext } from '../src/services/auth/types'

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message: string }>
}

const testAuditEvent = (
  action: (typeof auditActions)[keyof typeof auditActions],
  entityType:
    | 'CORE_USER'
    | 'CORE_USER_ROLE_GRANT'
    | 'CORE_SESSION'
    | 'CORE_SIGNUP_CHALLENGE',
  entityId: string,
  outcome: 'SUCCESS' | 'FAILURE',
): AuditEventRecord => ({
  id: crypto.randomUUID(),
  actorUserId: null,
  action,
  entityType,
  entityId,
  outcome,
  requestId: null,
  ipAddress: null,
  userAgent: null,
  changesJson: null,
  metadataJson: null,
  createdAt: new Date(),
})

const graphql = async <T>(
  query: string,
  cookie?: string,
): Promise<{ body: GraphQLResponse<T>; response: Response }> => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: 'https://app.example.test',
  })
  if (cookie) headers.set('cookie', cookie)

  const response = await SELF.fetch('https://api.example.test/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  return { body: (await response.json()) as GraphQLResponse<T>, response }
}

const cookieHeaderFrom = (response: Response): string => {
  const setCookie = response.headers.get('set-cookie') ?? ''
  return setCookie.split(';', 1)[0]
}

const extractOtp = (log: ReturnType<typeof vi.spyOn>): string => {
  for (const call of log.mock.calls) {
    const payload = call[1] as { text?: string } | undefined
    const match = payload?.text?.match(/\b(\d{6})\b/u)
    if (match) return match[1]
  }
  throw new Error('Console notification did not contain an OTP.')
}

const startSignup = async (email: string, notificationLog: ReturnType<typeof vi.spyOn>) => {
  notificationLog.mockClear()
  const { body } = await graphql<{
    auth: {
      startApplicantSignup: {
        success: boolean
        response: { challengeToken: string }
      }
    }
  }>(/* GraphQL */ `
    mutation {
      auth {
        startApplicantSignup(input: { email: "${email}" }) {
          success
          response { challengeToken }
        }
      }
    }
  `)
  const result = body.data?.auth.startApplicantSignup
  if (!result?.success) throw new Error('Unable to start applicant signup in test.')
  return { challengeToken: result.response.challengeToken, otp: extractOtp(notificationLog) }
}

const verifySignup = async (challengeToken: string, otp: string) => {
  const { body } = await graphql<{
    auth: { verifyApplicantSignup: { success: boolean; message: string | null } }
  }>(/* GraphQL */ `
    mutation {
      auth {
        verifyApplicantSignup(input: {
          challengeToken: "${challengeToken}"
          otp: "${otp}"
          password: "correct horse battery staple"
        }) { success message }
      }
    }
  `)
  return body.data?.auth.verifyApplicantSignup
}

const signInWithPassword = async (password: string) =>
  graphql<{
    auth: {
      signInApplicant: {
        success: boolean
        response: { session: { id: string } }
      }
    }
  }>(/* GraphQL */ `
    mutation {
      auth {
          signInApplicant(input: {
            email: "applicant@example.com"
            password: "${password}"
        }) { success response { session { id } } }
      }
    }
  `)

const signIn = async () => signInWithPassword('correct horse battery staple')

type BootstrapResponse = {
  success: boolean
  message: string | null
  response: { userId: string; roles: string[] } | null
}

const bootstrapFirstAdmin = async (input?: {
  password?: string
  secret?: string
  origin?: string
  contentType?: string
  rawBody?: string
  authorization?: string | null
  requestHeaders?: Record<string, string>
}) => {
  const headers = new Headers({
    'content-type': input?.contentType ?? 'application/json',
  })
  if (input?.authorization !== null) {
    headers.set(
      'authorization',
      input?.authorization ?? `Bearer ${input?.secret ?? env.FIRST_SUPER_ADMIN_SECRET}`,
    )
  }
  if (input?.origin) headers.set('origin', input.origin)
  for (const [name, value] of Object.entries(input?.requestHeaders ?? {})) {
    headers.set(name, value)
  }
  const response = await SELF.fetch(
    'https://api.example.test/internal/bootstrap/first-super-admin',
    {
      method: 'POST',
      headers,
      body: input?.rawBody ?? JSON.stringify({
        currentPassword: input?.password ?? 'correct horse battery staple',
      }),
    },
  )
  return { response, body: (await response.json()) as BootstrapResponse }
}

const directAuthContext = (
  bindings: Partial<AuthOperationContext['env']> = {},
): AuthOperationContext => ({
  db: createDatabase(env.DB),
  env: {
    AUTH_SECRET: env.AUTH_SECRET,
    FIRST_SUPER_ADMIN_EMAIL: env.FIRST_SUPER_ADMIN_EMAIL,
    FIRST_SUPER_ADMIN_SECRET: env.FIRST_SUPER_ADMIN_SECRET,
    ...bindings,
  } as AuthOperationContext['env'],
  requestHeaders: new Headers({ 'User-Agent': 'vitest-direct-auth' }),
  requestUrl: 'https://api.example.test/internal/bootstrap/first-super-admin',
  responseHeaders: new Headers(),
})

const runScheduledCleanup = async () => {
  const context = createExecutionContext()
  worker.scheduled(createScheduledController(), env, context)
  await waitOnExecutionContext(context)
}

describe('applicant authentication', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects more than one nested auth mutation before execution', async () => {
    const { body } = await graphql<unknown>(/* GraphQL */ `
      mutation {
        auth {
          signOutApplicant { success }
          revokeAllApplicantSessions { success }
        }
      }
    `)

    expect(body.data).toBeUndefined()
    expect(body.errors?.map((error) => error.message)).toContain(
      'Only one field may be selected beneath mutation.auth.',
    )

    const throughFragment = await graphql<unknown>(/* GraphQL */ `
      mutation AuthActions {
        ...RootMutation
      }
      fragment RootMutation on Mutation {
        auth {
          signOutApplicant { success }
          revokeAllApplicantSessions { success }
        }
      }
    `)
    expect(throughFragment.body.errors?.map((error) => error.message)).toContain(
      'Only one field may be selected beneath mutation.auth.',
    )
  })

  it('normalizes email, stores digests, provisions an applicant, and uses browser cookies', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const start = await graphql<{
      auth: {
        startApplicantSignup: {
          success: boolean
          message: string | null
          response: { challengeToken: string; expiresAt: string } | null
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startApplicantSignup(input: { email: "  Applicant@Example.COM " }) {
            success
            message
            response { challengeToken expiresAt }
          }
        }
      }
    `)
    const started = start.body.data?.auth.startApplicantSignup
    expect(started?.success).toBe(true)
    expect(started?.message).toBeTruthy()
    expect(started?.response?.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    const otp = extractOtp(notificationLog)
    const stored = await env.DB.prepare(
      `SELECT email, challenge_digest, otp_digest, attempts_remaining, status
       FROM core_signup_challenge`,
    ).first<{
      email: string
      challenge_digest: string
      otp_digest: string
      attempts_remaining: number
      status: string
    }>()
    expect(stored?.email).toBe('applicant@example.com')
    expect(stored?.challenge_digest).not.toBe(started?.response?.challengeToken)
    expect(stored?.otp_digest).not.toBe(otp)
    expect(stored?.attempts_remaining).toBe(5)
    expect(stored?.status).toBe('PENDING')

    const wrong = await graphql<{
      auth: { verifyApplicantSignup: { success: boolean; message: string; response: null } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          verifyApplicantSignup(input: {
            challengeToken: "${started?.response?.challengeToken}"
            otp: "000000"
            password: "correct horse battery staple"
          }) { success message response { id } }
        }
      }
    `)
    expect(wrong.body.errors).toBeUndefined()
    expect(wrong.body.data?.auth.verifyApplicantSignup).toMatchObject({
      success: false,
      response: null,
    })
    const remaining = await env.DB.prepare(
      'SELECT attempts_remaining FROM core_signup_challenge',
    ).first<{ attempts_remaining: number }>()
    expect(remaining?.attempts_remaining).toBe(4)

    const verified = await graphql<{
      auth: {
        verifyApplicantSignup: {
          success: boolean
          message: null
          response: { email: string; emailVerified: boolean; role: string }
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          verifyApplicantSignup(input: {
            challengeToken: "${started?.response?.challengeToken}"
            otp: "${otp}"
            password: "correct horse battery staple"
          }) {
            success
            message
            response { email emailVerified role }
          }
        }
      }
    `)
    expect(verified.body.errors).toBeUndefined()
    expect(verified.body.data?.auth.verifyApplicantSignup).toEqual({
      success: true,
      message: null,
      response: {
        email: 'applicant@example.com',
        emailVerified: true,
        role: 'APPLICANT',
      },
    })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        'SELECT status, consumed_by_user_id FROM core_signup_challenge',
      ).first<{ status: string; consumed_by_user_id: string | null }>(),
    ).toMatchObject({ status: 'CONSUMED' })
    expect(
      await env.DB.prepare(
        `SELECT role, grant_reason, revoked_at
         FROM core_user_role_grant`,
      ).first(),
    ).toEqual({
      role: 'APPLICANT',
      grant_reason: 'VERIFIED_APPLICANT_SIGNUP',
      revoked_at: null,
    })

    const auditRows = await env.DB.prepare(
      'SELECT action, actor_user_id, entity_id, metadata_json FROM core_audit_event ORDER BY created_at',
    ).all<{
      action: string
      actor_user_id: string | null
      entity_id: string | null
      metadata_json: string | null
    }>()
    expect(auditRows.results.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        auditActions.signupChallengeCreated,
        auditActions.otpFailed,
        auditActions.userCreated,
        auditActions.roleGranted,
      ]),
    )
    expect(JSON.stringify(auditRows.results)).not.toContain(otp)
    expect(JSON.stringify(auditRows.results)).not.toContain('correct horse battery staple')

    notificationLog.mockClear()
    const decoy = await graphql<{
      auth: { startApplicantSignup: { success: boolean; response: { challengeToken: string } } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startApplicantSignup(input: { email: "applicant@example.com" }) {
            success
            response { challengeToken }
          }
        }
      }
    `)
    expect(decoy.body.data?.auth.startApplicantSignup.success).toBe(true)
    expect(decoy.body.data?.auth.startApplicantSignup.response.challengeToken).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    )
    expect(notificationLog).not.toHaveBeenCalled()

    const signedIn = await graphql<{
      auth: {
        signInApplicant: {
          success: boolean
          message: null
          response: { session: { id: string; current: boolean; expiresAt: string } }
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          signInApplicant(input: {
            email: "APPLICANT@example.com"
            password: "correct horse battery staple"
          }) {
            success
            message
            response { session { id current expiresAt } }
          }
        }
      }
    `)
    expect(signedIn.body.errors).toBeUndefined()
    expect(signedIn.body.data?.auth.signInApplicant.success).toBe(true)
    expect(signedIn.response.headers.get('access-control-allow-credentials')).toBe('true')
    const cookies = signedIn.response.headers.get('set-cookie') ?? ''
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('SameSite=Lax')
    expect(cookies).toContain('Secure')
    expect(cookies).not.toMatch(/Max-Age=/iu)

    const publicSessionId = signedIn.body.data?.auth.signInApplicant.response.session.id
    expect(JSON.stringify(signedIn.body)).not.toContain('tokenDigest')
    const storedSession = await env.DB.prepare(
      'SELECT id, token_digest, expires_at FROM core_session WHERE id = ?',
    )
      .bind(publicSessionId)
      .first<{ id: string; token_digest: string; expires_at: number }>()
    expect(storedSession?.id).toBe(publicSessionId)
    expect(storedSession?.token_digest).toBeTruthy()
    expect(storedSession?.token_digest).not.toBe(cookieHeaderFrom(signedIn.response).split('=')[1])
    expect(storedSession?.expires_at).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1_000)

    const current = await graphql<{
      auth: { currentApplicantSession: { success: boolean; response: { session: { id: string } } } }
    }>(
      /* GraphQL */ `
        query {
          auth {
            currentApplicantSession {
              success
              response { session { id } }
            }
          }
        }
      `,
      cookieHeaderFrom(signedIn.response),
    )
    expect(current.body.data?.auth.currentApplicantSession.response.session.id).toBe(publicSessionId)

    notificationLog.mockRestore()
  })

  it('returns a successful null response for a signed-out current session', async () => {
    const { body } = await graphql<{
      auth: { currentApplicantSession: { success: boolean; message: null; response: null } }
    }>(/* GraphQL */ `
      query {
        auth {
          currentApplicantSession { success message response { session { id } } }
        }
      }
    `)
    expect(body.errors).toBeUndefined()
    expect(body.data?.auth.currentApplicantSession).toEqual({
      success: true,
      message: null,
      response: null,
    })
  })

  it('loads multiple roles live and immediately stops applicant authorization after revocation', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    const signedIn = await signIn()
    const cookie = cookieHeaderFrom(signedIn.response)
    const user = await env.DB.prepare(
      `SELECT id FROM core_user WHERE email = 'applicant@example.com'`,
    ).first<{ id: string }>()
    if (!user) throw new Error('Expected applicant user.')

    await env.DB.prepare(
      `INSERT INTO core_user_role_grant (
        id, user_id, role, grant_reason, granted_at
      ) VALUES (?, ?, 'ADMIN', 'TEST_ADMIN_ROLE', ?)`,
    )
      .bind(crypto.randomUUID(), user.id, Date.now())
      .run()

    const currentQuery = /* GraphQL */ `
      query {
        auth {
          currentApplicantSession {
            success
            response { applicant { role } }
          }
        }
      }
    `
    const multiRole = await graphql<{
      auth: {
        currentApplicantSession: {
          success: boolean
          response: { applicant: { role: string } } | null
        }
      }
    }>(currentQuery, cookie)
    expect(multiRole.body.data?.auth.currentApplicantSession).toMatchObject({
      success: true,
      response: { applicant: { role: 'APPLICANT' } },
    })

    await env.DB.prepare(
      `UPDATE core_user_role_grant
       SET revoked_at = ?, revocation_reason = 'TEST_REVOKED'
       WHERE user_id = ? AND role = 'APPLICANT' AND revoked_at IS NULL`,
    )
      .bind(Date.now(), user.id)
      .run()

    const revoked = await graphql<{
      auth: {
        currentApplicantSession: { success: boolean; message: null; response: null }
      }
    }>(currentQuery, cookie)
    expect(revoked.body.data?.auth.currentApplicantSession).toEqual({
      success: true,
      response: null,
    })
    // The identity session remains valid for future ADMIN operations; only the
    // applicant capability disappears, so no browser cookie is cleared here.
    expect(revoked.response.headers.get('set-cookie')).toBeNull()
    expect((await signIn()).body.data?.auth.signInApplicant).toMatchObject({
      success: false,
      response: null,
    })
  })

  it('bootstraps the configured applicant through curl-only HTTP and never exposes GraphQL', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    // Bootstrap authenticates the configured existing applicant directly. It
    // does not need or create a browser session.
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first(),
    ).toEqual({ count: 0 })
    const bootstrapped = await bootstrapFirstAdmin({
      // These caller-controlled values must never be copied into the durable
      // bootstrap audit rows, even when the role transition succeeds.
      requestHeaders: {
        'user-agent': 'correct horse battery staple',
        'x-request-id': env.FIRST_SUPER_ADMIN_SECRET,
        'cf-connecting-ip': env.FIRST_SUPER_ADMIN_EMAIL,
      },
    })
    expect(bootstrapped.response.status).toBe(200)
    expect(bootstrapped.body).toEqual({
      success: true,
      message: null,
      response: {
        userId: expect.any(String),
        roles: ['APPLICANT', 'SUPER_ADMIN'],
      },
    })

    const grants = await env.DB.prepare(
      `SELECT role, granted_by_user_id, grant_reason, revoked_at
       FROM core_user_role_grant ORDER BY granted_at`,
    ).all<{
      role: string
      granted_by_user_id: string | null
      grant_reason: string
      revoked_at: number | null
    }>()
    expect(grants.results).toEqual([
      {
        role: 'APPLICANT',
        granted_by_user_id: null,
        grant_reason: 'VERIFIED_APPLICANT_SIGNUP',
        revoked_at: null,
      },
      {
        role: 'SUPER_ADMIN',
        granted_by_user_id: null,
        grant_reason: 'FIRST_SUPER_ADMIN_BOOTSTRAP',
        revoked_at: null,
      },
    ])
    expect(grants.results.some(({ role }) => role === 'ADMIN')).toBe(false)

    const audits = await env.DB.prepare(
      `SELECT action, outcome, request_id, ip_address, user_agent,
              changes_json, metadata_json
       FROM core_audit_event ORDER BY created_at`,
    ).all<{
      action: string
      outcome: string
      request_id: string | null
      ip_address: string | null
      user_agent: string | null
      changes_json: string | null
      metadata_json: string | null
    }>()
    expect(audits.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: auditActions.firstSuperAdminBootstrap,
          outcome: 'SUCCESS',
        }),
      ]),
    )
    const serializedAudit = JSON.stringify(audits.results)
    expect(serializedAudit).not.toContain(env.FIRST_SUPER_ADMIN_SECRET)
    expect(serializedAudit).not.toContain('correct horse battery staple')
    expect(serializedAudit).not.toContain(env.FIRST_SUPER_ADMIN_EMAIL)

    const graphqlExposure = await graphql<unknown>(/* GraphQL */ `
      mutation {
        auth { bootstrapFirstSuperAdmin { success } }
      }
    `)
    expect(graphqlExposure.body.data).toBeUndefined()
    expect(graphqlExposure.body.errors?.[0]?.message).toContain(
      'Cannot query field "bootstrapFirstSuperAdmin"',
    )
  })

  it('permanently closes bootstrap after one historical SUPER_ADMIN grant', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const concurrent = await Promise.all([
      bootstrapFirstAdmin(),
      bootstrapFirstAdmin(),
    ])
    expect(concurrent.filter(({ body }) => body.success)).toHaveLength(1)
    expect(concurrent.filter(({ response }) => response.status === 403)).toHaveLength(1)
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_audit_event
         WHERE action = ? AND outcome = 'SUCCESS'`,
      )
        .bind(auditActions.firstSuperAdminBootstrap)
        .first(),
    ).toEqual({ count: 1 })

    await env.DB.prepare(
      `UPDATE core_user_role_grant
       SET revoked_at = ?, revocation_reason = 'TEST_REVOKED'
       WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL`,
    )
      .bind(Date.now())
      .run()
    // A malformed password hash would throw if the closed endpoint attempted
    // scrypt. The historical role must short-circuit before hash parsing.
    await env.DB.prepare(
      `UPDATE core_user SET password_hash = 'invalid-closed-bootstrap-hash'
       WHERE email = 'applicant@example.com'`,
    ).run()
    const afterRevocation = await bootstrapFirstAdmin()
    expect(afterRevocation.response.status).toBe(403)
    expect(afterRevocation.body).toEqual({
      success: false,
      message:
        'First administrator bootstrap is unavailable or the supplied credentials are invalid.',
      response: null,
    })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 1 })
  })

  it('fails closed for invalid bootstrap credentials, configuration, and user lifecycle', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    const expectedFailure = {
      success: false,
      message:
        'First administrator bootstrap is unavailable or the supplied credentials are invalid.',
      response: null,
    }

    expect((await bootstrapFirstAdmin({ secret: 'wrong-secret' })).body).toEqual(
      expectedFailure,
    )
    expect(
      (await bootstrapFirstAdmin({
        password: 'incorrect password',
        requestHeaders: {
          'user-agent': 'incorrect password',
          'x-request-id': env.FIRST_SUPER_ADMIN_SECRET,
          'cf-connecting-ip': env.FIRST_SUPER_ADMIN_EMAIL,
        },
      })).body,
    ).toEqual(expectedFailure)
    expect(
      await bootstrapFirstSuperAdmin(
        {
          currentPassword: 'correct horse battery staple',
          bootstrapSecret: env.FIRST_SUPER_ADMIN_SECRET,
        },
        directAuthContext({ FIRST_SUPER_ADMIN_EMAIL: 'another@example.com' }),
      ),
    ).toEqual(expectedFailure)
    const oversizedConfiguredSecret = 'x'.repeat(513)
    expect(
      await bootstrapFirstSuperAdmin(
        {
          currentPassword: 'correct horse battery staple',
          bootstrapSecret: oversizedConfiguredSecret,
        },
        directAuthContext({ FIRST_SUPER_ADMIN_SECRET: oversizedConfiguredSecret }),
      ),
    ).toEqual(expectedFailure)
    const whitespaceConfiguredSecret = `${'x'.repeat(31)} `
    expect(
      await bootstrapFirstSuperAdmin(
        {
          currentPassword: 'correct horse battery staple',
          bootstrapSecret: whitespaceConfiguredSecret,
        },
        directAuthContext({ FIRST_SUPER_ADMIN_SECRET: whitespaceConfiguredSecret }),
      ),
    ).toEqual(expectedFailure)
    expect(
      await bootstrapFirstSuperAdmin(
        {
          currentPassword: 'correct horse battery staple',
          bootstrapSecret: env.FIRST_SUPER_ADMIN_SECRET,
        },
        directAuthContext({
          FIRST_SUPER_ADMIN_EMAIL: undefined,
          FIRST_SUPER_ADMIN_SECRET: undefined,
        }),
      ),
    ).toEqual(expectedFailure)
    expect(
      await bootstrapFirstSuperAdmin(
        {
          currentPassword: 'correct horse battery staple',
          bootstrapSecret: 'short',
        },
        directAuthContext({ FIRST_SUPER_ADMIN_SECRET: 'short' }),
      ),
    ).toEqual(expectedFailure)

    await env.DB.prepare(
      `UPDATE core_user SET email_verified_at = NULL
       WHERE email = 'applicant@example.com'`,
    ).run()
    expect((await bootstrapFirstAdmin()).body).toEqual(expectedFailure)
    await env.DB.prepare(
      `UPDATE core_user SET email_verified_at = ?, deleted_at = ?
       WHERE email = 'applicant@example.com'`,
    )
      .bind(Date.now(), Date.now())
      .run()
    expect((await bootstrapFirstAdmin()).body).toEqual(expectedFailure)
    await env.DB.prepare(
      `UPDATE core_user SET deleted_at = NULL
       WHERE email = 'applicant@example.com'`,
    ).run()
    await env.DB.prepare(
      `UPDATE core_user_role_grant
       SET revoked_at = ?, revocation_reason = 'TEST_REVOKED'
       WHERE role = 'APPLICANT' AND revoked_at IS NULL`,
    )
      .bind(Date.now())
      .run()
    expect((await bootstrapFirstAdmin()).body).toEqual(expectedFailure)
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 0 })
    const audits = await env.DB.prepare(
      `SELECT request_id, ip_address, user_agent, changes_json, metadata_json
       FROM core_audit_event
       WHERE action = ?`,
    )
      .bind(auditActions.firstSuperAdminBootstrap)
      .all<{
        request_id: string | null
        ip_address: string | null
        user_agent: string | null
        changes_json: string | null
        metadata_json: string | null
      }>()
    const serializedAudit = JSON.stringify(audits.results)
    expect(serializedAudit).not.toContain(env.FIRST_SUPER_ADMIN_SECRET)
    expect(serializedAudit).not.toContain('correct horse battery staple')
    expect(serializedAudit).not.toContain('incorrect password')
    expect(serializedAudit).not.toContain(env.FIRST_SUPER_ADMIN_EMAIL)
    expect(serializedAudit).not.toContain('another@example.com')
  })

  it('rejects browser, malformed, and non-JSON requests before bootstrap evaluation', async () => {
    const expectedFailure = {
      success: false,
      message:
        'First administrator bootstrap is unavailable or the supplied credentials are invalid.',
      response: null,
    }
    const browser = await bootstrapFirstAdmin({ origin: 'https://app.example.test' })
    expect(browser.response.status).toBe(403)
    expect(browser.body).toEqual(expectedFailure)

    const missingAuthorization = await bootstrapFirstAdmin({
      authorization: null,
      rawBody: '{',
    })
    expect(missingAuthorization.response.status).toBe(403)
    expect(missingAuthorization.body).toEqual(expectedFailure)

    const wrongType = await bootstrapFirstAdmin({ contentType: 'text/plain' })
    expect(wrongType.response.status).toBe(400)
    expect(wrongType.body).toEqual(expectedFailure)

    const malformed = await bootstrapFirstAdmin({ rawBody: '{' })
    expect(malformed.response.status).toBe(400)
    expect(malformed.body).toEqual(expectedFailure)

    const missingPassword = await bootstrapFirstAdmin({ rawBody: '{}' })
    expect(missingPassword.response.status).toBe(400)
    expect(missingPassword.body).toEqual(expectedFailure)

    const unexpectedField = await bootstrapFirstAdmin({
      rawBody: JSON.stringify({ currentPassword: 'password', email: 'other@example.com' }),
    })
    expect(unexpectedField.response.status).toBe(400)
    expect(unexpectedField.body).toEqual(expectedFailure)

    const oversized = await bootstrapFirstAdmin({
      rawBody: JSON.stringify({ currentPassword: 'x'.repeat(1_025) }),
    })
    expect(oversized.response.status).toBe(413)
    expect(oversized.body).toEqual(expectedFailure)

    const unusableBearer = await bootstrapFirstAdmin({
      authorization: `Bearer ${'x'.repeat(513)}`,
    })
    expect(unusableBearer.response.status).toBe(403)
    expect(unusableBearer.body).toEqual(expectedFailure)
  })

  it('guards bootstrap against a password hash changed after credential verification', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const db = createDatabase(env.DB)
    const candidate = await findActiveApplicantByEmail(db, 'applicant@example.com')
    if (!candidate) throw new Error('Expected bootstrap candidate.')
    await env.DB.prepare(
      `UPDATE core_user SET password_hash = ? WHERE id = ?`,
    )
      .bind(await hashPassword('replacement password'), candidate.id)
      .run()

    const now = new Date()
    const grantId = crypto.randomUUID()
    const granted = await grantFirstSuperAdmin(db, {
      userId: candidate.id,
      email: candidate.email,
      verifiedPasswordHash: candidate.passwordHash,
      roleGrant: {
        id: grantId,
        userId: candidate.id,
        role: 'SUPER_ADMIN',
        grantedByUserId: null,
        grantReason: 'FIRST_SUPER_ADMIN_BOOTSTRAP',
        grantedAt: now,
        revokedByUserId: null,
        revokedAt: null,
        revocationReason: null,
      },
      roleAuditEvent: testAuditEvent(
        auditActions.roleGranted,
        'CORE_USER_ROLE_GRANT',
        grantId,
        'SUCCESS',
      ),
      bootstrapAuditEvent: testAuditEvent(
        auditActions.firstSuperAdminBootstrap,
        'CORE_USER',
        candidate.id,
        'SUCCESS',
      ),
    })
    expect(granted).toBe(false)
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_audit_event
         WHERE action = ? AND outcome = 'SUCCESS'`,
      )
        .bind(auditActions.firstSuperAdminBootstrap)
        .first(),
    ).toEqual({ count: 0 })
  })

  it('does not create a session from a stale credential read after role revocation', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const db = createDatabase(env.DB)
    // This is the credential lookup that happens before the intentionally slow
    // password hash. Revoking after it models the exact sign-in race.
    const staleUser = await findActiveApplicantByEmail(db, 'applicant@example.com')
    if (!staleUser) throw new Error('Expected applicant credential record.')
    await env.DB.prepare(
      `UPDATE core_user_role_grant
       SET revoked_at = ?, revocation_reason = 'REVOKED_DURING_SIGN_IN'
       WHERE user_id = ? AND role = 'APPLICANT' AND revoked_at IS NULL`,
    )
      .bind(Date.now(), staleUser.id)
      .run()

    const now = new Date()
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      userId: staleUser.id,
      tokenDigest: 'stale-sign-in-digest',
      expiresAt: new Date(now.getTime() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: now,
      updatedAt: now,
    }
    const created = await createApplicantSession(
      db,
      session,
      testAuditEvent(
        auditActions.signInSucceeded,
        'CORE_SESSION',
        session.id,
        'SUCCESS',
      ),
    )

    expect(created).toBe(false)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_audit_event WHERE action = ?`,
      )
        .bind(auditActions.signInSucceeded)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 })
  })

  it('exhausts only the supplied challenge and leaves sibling challenges valid', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const first = await startSignup('applicant@example.com', notificationLog)
    const second = await startSignup('applicant@example.com', notificationLog)
    const wrongOtp = first.otp === '000000' ? '999999' : '000000'

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await verifySignup(first.challengeToken, wrongOtp)
      expect(result?.success).toBe(false)
    }

    const challenges = await env.DB.prepare(
      'SELECT status, attempts_remaining FROM core_signup_challenge ORDER BY created_at',
    ).all<{ status: string; attempts_remaining: number }>()
    expect(challenges.results).toEqual(
      expect.arrayContaining([
        { status: 'EXHAUSTED', attempts_remaining: 0 },
        { status: 'PENDING', attempts_remaining: 5 },
      ]),
    )
    expect((await verifySignup(second.challengeToken, second.otp))?.success).toBe(true)
  })

  it('allows only one concurrent sibling challenge to claim an email', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const first = await startSignup('applicant@example.com', notificationLog)
    const second = await startSignup('applicant@example.com', notificationLog)

    const results = await Promise.all([
      verifySignup(first.challengeToken, first.otp),
      verifySignup(second.challengeToken, second.otp),
    ])
    expect(results.filter((result) => result?.success)).toHaveLength(1)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_user').first<{ count: number }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_user_role_grant
         WHERE role = 'APPLICANT' AND revoked_at IS NULL`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_audit_event WHERE action = ?`,
      )
        .bind(auditActions.roleGranted)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 })
  })

  it('does not let a stale valid read bypass concurrently exhausted OTP attempts', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    const db = createDatabase(env.DB)
    const challengeDigest = await createDigest(
      env.AUTH_SECRET,
      'applicant-signup-challenge',
      signup.challengeToken,
    )
    const challenge = await findSignupChallenge(db, challengeDigest)
    if (!challenge) throw new Error('Expected the signup challenge to exist.')

    // Model the exact race: the valid request has read the pair and starts its
    // expensive hash while concurrent wrong writes consume the attempt budget.
    const passwordHash = hashPassword('correct horse battery staple')
    await Promise.all(
      Array.from({ length: 5 }, () =>
        consumeWrongOtpAttempt(
          db,
          challenge.id,
          new Date(),
          testAuditEvent(
            auditActions.otpFailed,
            'CORE_SIGNUP_CHALLENGE',
            challenge.id,
            'FAILURE',
          ),
        ),
      ),
    )
    const createdAt = new Date()
    const userId = crypto.randomUUID()
    const created = await createUserFromSignupChallenge(db, {
      user: {
        id: userId,
        email: challenge.email,
        passwordHash: await passwordHash,
        emailVerifiedAt: createdAt,
        rowVersion: 1,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
      },
      roleGrant: {
        id: crypto.randomUUID(),
        userId,
        role: 'APPLICANT',
        grantedByUserId: null,
        grantReason: 'VERIFIED_APPLICANT_SIGNUP',
        grantedAt: createdAt,
        revokedByUserId: null,
        revokedAt: null,
        revocationReason: null,
      },
      challenge,
      submittedOtpDigest: await createDigest(
        env.AUTH_SECRET,
        `applicant-signup-otp:${challenge.id}`,
        signup.otp,
      ),
      now: new Date(),
      auditEvent: testAuditEvent(auditActions.userCreated, 'CORE_USER', userId, 'SUCCESS'),
      roleAuditEvent: testAuditEvent(
        auditActions.roleGranted,
        'CORE_USER_ROLE_GRANT',
        userId,
        'SUCCESS',
      ),
    })

    expect(created).toBe(false)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_user').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_user_role_grant').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        'SELECT status, attempts_remaining FROM core_signup_challenge',
      ).first<{
        status: string
        attempts_remaining: number
      }>(),
    ).toEqual({ status: 'EXHAUSTED', attempts_remaining: 0 })
  })

  it('rolls applicant creation back when sibling challenge cleanup fails', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    await startSignup('applicant@example.com', notificationLog)
    await env.DB.prepare(`
      CREATE TRIGGER reject_signup_cleanup
      BEFORE UPDATE ON core_signup_challenge
      WHEN NEW.status = 'CANCELLED'
      BEGIN
        SELECT RAISE(ABORT, 'forced cleanup failure');
      END;
    `).run()

    expect(await verifySignup(signup.challengeToken, signup.otp)).toBeUndefined()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_user').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_user_role_grant').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 2 })

    await env.DB.prepare('DROP TRIGGER reject_signup_cleanup').run()
  })

  it('validates passwords before consuming a challenge and schedules expired-pair cleanup', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)

    const shortPassword = await graphql<{
      auth: { verifyApplicantSignup: { success: boolean; message: string } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          verifyApplicantSignup(input: {
            challengeToken: "${signup.challengeToken}"
            otp: "000000"
            password: "short"
          }) { success message }
        }
      }
    `)
    expect(shortPassword.body.data?.auth.verifyApplicantSignup.success).toBe(false)
    expect(
      await env.DB.prepare('SELECT attempts_remaining FROM core_signup_challenge').first<{
        attempts_remaining: number
      }>(),
    ).toEqual({ attempts_remaining: 5 })

    await env.DB.prepare('UPDATE core_signup_challenge SET expires_at = 0').run()
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(false)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count, status FROM core_signup_challenge',
      ).first<{
        count: number
        status: string
      }>(),
    ).toEqual({ count: 1, status: 'EXPIRED' })
  })

  it('rejects passwords outside the signup policy before sign-in hashing', async () => {
    const { body } = await signInWithPassword('x'.repeat(129))
    expect(body.errors).toBeUndefined()
    expect(body.data?.auth.signInApplicant).toMatchObject({ success: false, response: null })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })

    expect(
      await env.DB.prepare(
        `SELECT action, actor_user_id, entity_id
         FROM core_audit_event WHERE action = ?`,
      )
        .bind(auditActions.signInFailed)
        .first<{ action: string; actor_user_id: string | null; entity_id: string | null }>(),
    ).toEqual({
      action: auditActions.signInFailed,
      actor_user_id: null,
      entity_id: null,
    })
  })

  it('reserves soft-deleted user emails and excludes them from authentication', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    await env.DB.prepare(
      `UPDATE core_user SET deleted_at = ?, updated_at = ?, delete_reason = 'TEST'
       WHERE email = 'applicant@example.com'`,
    )
      .bind(Date.now(), Date.now())
      .run()

    expect((await signIn()).body.data?.auth.signInApplicant).toMatchObject({
      success: false,
      response: null,
    })

    notificationLog.mockClear()
    const decoy = await graphql<{
      auth: { startApplicantSignup: { success: boolean; response: { challengeToken: string } } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startApplicantSignup(input: { email: "applicant@example.com" }) {
            success
            response { challengeToken }
          }
        }
      }
    `)
    expect(decoy.body.data?.auth.startApplicantSignup.success).toBe(true)
    expect(notificationLog).not.toHaveBeenCalled()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })
  })

  it('hard-deletes sign-out sessions and audits outcomes without retaining credentials', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const failed = await signInWithPassword('incorrect password')
    expect(failed.body.data?.auth.signInApplicant.success).toBe(false)
    const failedAudit = await env.DB.prepare(
      `SELECT actor_user_id, entity_id FROM core_audit_event WHERE action = ?`,
    )
      .bind(auditActions.signInFailed)
      .first<{ actor_user_id: string | null; entity_id: string | null }>()
    expect(failedAudit?.actor_user_id).toBeNull()
    expect(failedAudit?.entity_id).toEqual(expect.any(String))

    const signedIn = await signIn()
    const cookie = cookieHeaderFrom(signedIn.response)
    const rawToken = cookie.split('=', 2)[1]
    const signedOut = await graphql<{ auth: { signOutApplicant: { success: boolean } } }>(
      /* GraphQL */ `
        mutation {
          auth { signOutApplicant { success } }
        }
      `,
      cookie,
    )
    expect(signedOut.body.data?.auth.signOutApplicant.success).toBe(true)
    expect(signedOut.response.headers.get('set-cookie')).toMatch(/Max-Age=0/iu)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })

    const audit = await env.DB.prepare(
      'SELECT action, changes_json, metadata_json FROM core_audit_event ORDER BY created_at',
    ).all<{ action: string; changes_json: string | null; metadata_json: string | null }>()
    expect(audit.results.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        auditActions.signInFailed,
        auditActions.signInSucceeded,
        auditActions.signedOut,
      ]),
    )
    const serializedAudit = JSON.stringify(audit.results)
    expect(serializedAudit).not.toContain(rawToken)
    expect(serializedAudit).not.toContain('incorrect password')
    expect(serializedAudit).not.toContain('correct horse battery staple')
  })

  it('invalidates only the new challenge when notification delivery fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementationOnce(() => {
      throw new Error('notification unavailable')
    })

    const { body } = await graphql<{
      auth: { startApplicantSignup: { success: boolean; message: string; response: null } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startApplicantSignup(input: { email: "applicant@example.com" }) {
            success
            message
            response { challengeToken }
          }
        }
      }
    `)
    expect(body.errors).toBeUndefined()
    expect(body.data?.auth.startApplicantSignup).toMatchObject({ success: false, response: null })
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count, status FROM core_signup_challenge',
      ).first<{
        count: number
        status: string
      }>(),
    ).toEqual({ count: 1, status: 'DELIVERY_FAILED' })
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM core_audit_event
         WHERE action = 'AUTH.SIGNUP_NOTIFICATION_FAILED'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 })
  })

  it('lists and hard-revokes owned sessions while preserving or clearing cookies correctly', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const first = await signIn()
    const second = await signIn()
    const firstId = first.body.data?.auth.signInApplicant.response.session.id
    const secondId = second.body.data?.auth.signInApplicant.response.session.id
    const secondCookie = cookieHeaderFrom(second.response)

    const listed = await graphql<{
      auth: {
        applicantSessions: {
          success: boolean
          response: { sessions: Array<{ id: string; current: boolean }> }
        }
      }
    }>(
      /* GraphQL */ `
        query {
          auth {
            applicantSessions {
              success
              response { sessions { id current } }
            }
          }
        }
      `,
      secondCookie,
    )
    expect(listed.body.data?.auth.applicantSessions.response.sessions).toEqual(
      expect.arrayContaining([
        { id: firstId, current: false },
        { id: secondId, current: true },
      ]),
    )

    const revokedOther = await graphql<{
      auth: { revokeOtherApplicantSessions: { success: boolean } }
    }>(
      /* GraphQL */ `
        mutation {
          auth { revokeOtherApplicantSessions { success } }
        }
      `,
      secondCookie,
    )
    expect(revokedOther.body.data?.auth.revokeOtherApplicantSessions.success).toBe(true)
    expect(revokedOther.response.headers.get('set-cookie')).toBeNull()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    const third = await signIn()
    const thirdId = third.body.data?.auth.signInApplicant.response.session.id
    const revokedCurrent = await graphql<{
      auth: { revokeApplicantSession: { success: boolean } }
    }>(
      /* GraphQL */ `
        mutation {
          auth { revokeApplicantSession(sessionId: "${thirdId}") { success } }
        }
      `,
      cookieHeaderFrom(third.response),
    )
    expect(revokedCurrent.body.data?.auth.revokeApplicantSession.success).toBe(true)
    expect(revokedCurrent.response.headers.get('set-cookie')).toMatch(/Max-Age=0/iu)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    const revokedAll = await graphql<{
      auth: { revokeAllApplicantSessions: { success: boolean } }
    }>(
      /* GraphQL */ `
        mutation {
          auth { revokeAllApplicantSessions { success } }
        }
      `,
      secondCookie,
    )
    expect(revokedAll.body.data?.auth.revokeAllApplicantSessions.success).toBe(true)
    expect(revokedAll.response.headers.get('set-cookie')).toMatch(/Max-Age=0/iu)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    const revocationAudit = await env.DB.prepare(
      `SELECT action FROM core_audit_event
       WHERE action IN ('AUTH.SESSION_REVOKED', 'AUTH.SESSIONS_REVOKED')`,
    ).all<{ action: string }>()
    expect(revocationAudit.results.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        auditActions.sessionRevoked,
        auditActions.sessionsRevoked,
      ]),
    )
  })

  it('keeps expired-session cleanup out of public requests and runs it by cron', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const signedIn = await signIn()
    const cookie = cookieHeaderFrom(signedIn.response)
    await env.DB.prepare('UPDATE core_session SET expires_at = 0').run()

    const current = await graphql<{
      auth: { currentApplicantSession: { success: boolean; response: null } }
    }>(
      /* GraphQL */ `
        query {
          auth { currentApplicantSession { success response { session { id } } } }
        }
      `,
      cookie,
    )
    expect(current.body.data?.auth.currentApplicantSession).toEqual({
      success: true,
      response: null,
    })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })
})
