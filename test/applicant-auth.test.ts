import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '../src/db'
import worker from '../src/index'
import { createDigest, hashPassword } from '../src/services/auth/crypto'
import {
  consumeWrongOtpAttempt,
  createApplicantFromSignupPair,
  findSignupPair,
} from '../src/services/auth/queries/auth'

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message: string }>
}

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
      `SELECT email, challenge_digest, otp_digest, attempts_remaining
       FROM applicant_signup_pair`,
    ).first<{
      email: string
      challenge_digest: string
      otp_digest: string
      attempts_remaining: number
    }>()
    expect(stored?.email).toBe('applicant@example.com')
    expect(stored?.challenge_digest).not.toBe(started?.response?.challengeToken)
    expect(stored?.otp_digest).not.toBe(otp)
    expect(stored?.attempts_remaining).toBe(5)

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
      'SELECT attempts_remaining FROM applicant_signup_pair',
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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_signup_pair').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })

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
      'SELECT id, token_digest, expires_at FROM applicant_session WHERE id = ?',
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

  it('exhausts only the supplied challenge and leaves sibling challenges valid', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const first = await startSignup('applicant@example.com', notificationLog)
    const second = await startSignup('applicant@example.com', notificationLog)
    const wrongOtp = first.otp === '000000' ? '999999' : '000000'

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await verifySignup(first.challengeToken, wrongOtp)
      expect(result?.success).toBe(false)
    }

    const pairs = await env.DB.prepare(
      'SELECT count(*) AS count FROM applicant_signup_pair',
    ).first<{ count: number }>()
    expect(pairs).toEqual({ count: 1 })
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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant').first<{ count: number }>(),
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
    const pair = await findSignupPair(db, challengeDigest)
    if (!pair) throw new Error('Expected the signup pair to exist.')

    // Model the exact race: the valid request has read the pair and starts its
    // expensive hash while concurrent wrong writes consume the attempt budget.
    const passwordHash = hashPassword('correct horse battery staple')
    await Promise.all(
      Array.from({ length: 5 }, () => consumeWrongOtpAttempt(db, pair.id, Date.now())),
    )
    const createdAt = new Date()
    const created = await createApplicantFromSignupPair(
      db,
      {
        applicant: {
          id: crypto.randomUUID(),
          email: pair.email,
          passwordHash: await passwordHash,
          emailVerified: true,
          role: 'APPLICANT',
          createdAt,
          updatedAt: createdAt,
        },
        pair,
        submittedOtpDigest: await createDigest(
          env.AUTH_SECRET,
          `applicant-signup-otp:${pair.id}`,
          signup.otp,
        ),
        now: Date.now(),
      },
    )

    expect(created).toBe(false)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_signup_pair').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })

  it('rolls applicant creation back when sibling challenge cleanup fails', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    await env.DB.prepare(`
      CREATE TRIGGER reject_signup_cleanup
      BEFORE DELETE ON applicant_signup_pair
      BEGIN
        SELECT RAISE(ABORT, 'forced cleanup failure');
      END;
    `).run()

    expect(await verifySignup(signup.challengeToken, signup.otp)).toBeUndefined()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_signup_pair').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

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
      await env.DB.prepare('SELECT attempts_remaining FROM applicant_signup_pair').first<{
        attempts_remaining: number
      }>(),
    ).toEqual({ attempts_remaining: 5 })

    await env.DB.prepare('UPDATE applicant_signup_pair SET expires_at = 0').run()
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(false)
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_signup_pair').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_signup_pair').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })

  it('rejects passwords outside the signup policy before sign-in hashing', async () => {
    const { body } = await signInWithPassword('x'.repeat(129))
    expect(body.errors).toBeUndefined()
    expect(body.data?.auth.signInApplicant).toMatchObject({ success: false, response: null })
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })

  it('removes only the new pair when notification delivery fails', async () => {
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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_signup_pair').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })

  it('keeps expired-session cleanup out of public requests and runs it by cron', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const signedIn = await signIn()
    const cookie = cookieHeaderFrom(signedIn.response)
    await env.DB.prepare('UPDATE applicant_session SET expires_at = 0').run()

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
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM applicant_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })
})
