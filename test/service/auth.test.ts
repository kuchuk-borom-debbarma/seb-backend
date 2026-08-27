import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from '../support/worker'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'
import { createLoaders } from '../../src/loaders'
import { auditActions } from '../../src/db/schema'
import worker from '../../src/index'
import { userRoles } from '../../src/db/schema'
import { capabilities } from '../../src/services/auth/capabilities'
import { createDigest, hashPassword, sessionTokenDigest } from '../../src/services/auth/crypto'
import { sealInvite } from '../../src/services/auth/invite'
import {
  authenticatedApplicant,
  authenticatedWithCapability,
  bootstrapFirstSuperAdmin,
} from '../../src/services/auth'
import {
  consumeWrongOtpAttempt,
  createUserSession,
  createUserFromSignupChallenge,
  findActiveUserByEmail,
  findSignupChallenge,
  grantFirstSuperAdmin,
  type AuditEventRecord,
  type SessionRecord,
} from '../../src/services/auth/queries/auth'
import { markAccountChallengeDeliveryFailed } from '../../src/services/auth/queries/account'
import type { AuthOperationContext } from '../../src/services/auth/types'

/*
 * A fresh database per test, which `isolatedStorage` gave the Workers pool.
 * Cheaper than undoing writes, and one test can never leave a row that changes
 * what the next one sees.
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

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message: string }>
}

/** Shared shape for `auth.currentSession` assertions. */
type CurrentSessionBody = {
  auth: {
    currentSession: {
      success: boolean
      response: { user: { roles: string[] } } | null
    }
  }
}

const testAuditEvent = (
  action: (typeof auditActions)[keyof typeof auditActions],
  entityType:
    | 'CORE_USER'
    | 'CORE_USER_ROLE_GRANT'
    | 'CORE_SESSION'
    | 'CORE_SIGNUP_CHALLENGE'
    | 'CORE_ACCOUNT_CHALLENGE',
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
  // The development transport prints one marked, single-line JSON payload.
  for (const call of log.mock.calls) {
    const line = typeof call[0] === 'string' ? call[0] : ''
    const marked = line.match(/^DEV_EMAIL (.*)$/u)
    if (!marked?.[1]) continue
    const payload = JSON.parse(marked[1]) as { text?: string }
    const match = payload.text?.match(/\b(\d{6})\b/u)
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

const DEFAULT_PASSWORD = 'correct horse battery staple'

const signInAs = async (email: string, password: string) =>
  graphql<{
    auth: {
      signIn: {
        success: boolean
        response: { session: { id: string } }
      }
    }
  }>(/* GraphQL */ `
    mutation {
      auth {
          signIn(input: {
            email: "${email}"
            password: "${password}"
        }) { success response { session { id } } }
      }
    }
  `)

const signInWithPassword = async (password: string) =>
  signInAs('applicant@example.com', password)

const signInDefault = async () => signInWithPassword(DEFAULT_PASSWORD)

/** Completes the signup pair so a test starts from a real verified applicant. */
const registerApplicant = async (
  email: string,
  notificationLog: ReturnType<typeof vi.spyOn>,
) => {
  const signup = await startSignup(email, notificationLog)
  const verified = await verifySignup(signup.challengeToken, signup.otp)
  if (!verified?.success) throw new Error(`Unable to register ${email} in test.`)
}

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
  db: activeDatabase(), loaders: createLoaders(activeDatabase()),
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

/**
 * Revokes every outstanding grant, deactivating each account in the fixture.
 *
 * Written directly because `access.revokeRole` deliberately refuses APPLICANT:
 * that grant is created only by verified signup and cannot be granted back, so
 * no operation may close it. Deactivation therefore has no API to drive.
 */
const revokeEveryRoleGrant = () => env.DB.prepare(
  `UPDATE core_user_role_grant
   SET revoked_at = ?, revocation_reason = 'TEST_REVOKED'
   WHERE revoked_at IS NULL`,
)
  .bind(Date.now())
  .run()

/** Minimal service-layer context carrying one browser cookie. */
const cookieAuthContext = (cookie: string): AuthOperationContext => ({
  db: activeDatabase(), loaders: createLoaders(activeDatabase()),
  env,
  requestHeaders: new Headers({ cookie }),
  requestUrl: 'https://api.example.test/graphql',
  responseHeaders: new Headers(),
})

type ManagedGrant = {
  id: string
  role: string
  grantReason: string
  grantedByUserId: string | null
  revokedByUserId: string | null
  revokedAt: string | null
  revocationReason: string | null
}

type ManagedUserBody = {
  access: {
    userByEmail?: ManagedUserResultBody
    userById?: ManagedUserResultBody
  }
}

type ManagedUserMutationBody = {
  access: {
    grantRole?: ManagedUserResultBody
    revokeRole?: ManagedUserResultBody
  }
}

type ManagedUserResultBody = {
  success: boolean
  message: string | null
  response: {
    id: string
    email: string
    emailVerified: boolean
    deleted: boolean
    roles: string[]
    grants: ManagedGrant[]
  } | null
}

const MANAGED_USER_SELECTION = /* GraphQL */ `
  success
  message
  response {
    id
    email
    emailVerified
    deleted
    roles
    grants {
      id
      role
      grantReason
      grantedByUserId
      revokedByUserId
      revokedAt
      revocationReason
    }
  }
`

const managedUserByEmail = async (email: string, cookie: string) =>
  graphql<ManagedUserBody>(/* GraphQL */ `
    query {
      access {
        userByEmail(email: "${email}") { ${MANAGED_USER_SELECTION} }
      }
    }
  `, cookie)

const managedUserById = async (id: string, cookie: string) =>
  graphql<ManagedUserBody>(/* GraphQL */ `
    query {
      access { userById(id: "${id}") { ${MANAGED_USER_SELECTION} } }
    }
  `, cookie)

const grantRole = async (
  input: { userId: string; role: string; reason?: string; password?: string },
  cookie: string,
) => graphql<ManagedUserMutationBody>(/* GraphQL */ `
  mutation {
    access {
      grantRole(input: {
        userId: "${input.userId}"
        role: ${input.role}
        reason: "${input.reason ?? 'Joining the programme office'}"
        currentPassword: "${input.password ?? DEFAULT_PASSWORD}"
      }) { ${MANAGED_USER_SELECTION} }
    }
  }
`, cookie)

const revokeRole = async (
  input: { grantId: string; reason?: string; password?: string },
  cookie: string,
) => graphql<ManagedUserMutationBody>(/* GraphQL */ `
  mutation {
    access {
      revokeRole(input: {
        grantId: "${input.grantId}"
        reason: "${input.reason ?? 'Left the programme office'}"
        currentPassword: "${input.password ?? DEFAULT_PASSWORD}"
      }) { ${MANAGED_USER_SELECTION} }
    }
  }
`, cookie)

const activeGrantId = (user: ManagedUserResultBody['response'], role: string): string => {
  const grant = user?.grants.find(
    (candidate) => candidate.role === role && candidate.revokedAt === null,
  )
  if (!grant) throw new Error(`Expected an active ${role} grant in test.`)
  return grant.id
}

/**
 * Produces the portal's first super administrator and signs them in.
 *
 * Driven entirely through the real signup, curl bootstrap, and sign-in paths so
 * role-administration tests start from a state the product can actually reach.
 */
const establishSuperAdmin = async (notificationLog: ReturnType<typeof vi.spyOn>) => {
  await registerApplicant('applicant@example.com', notificationLog)
  const bootstrapped = await bootstrapFirstAdmin()
  const userId = bootstrapped.body.response?.userId
  if (!userId) throw new Error('Unable to bootstrap the first super administrator in test.')
  const signedIn = await signInAs('applicant@example.com', DEFAULT_PASSWORD)
  return { userId, cookie: cookieHeaderFrom(signedIn.response) }
}

/** Registers a second person and returns their managed identity. */
const registerManagedApplicant = async (
  email: string,
  notificationLog: ReturnType<typeof vi.spyOn>,
  cookie: string,
) => {
  await registerApplicant(email, notificationLog)
  const looked = await managedUserByEmail(email, cookie)
  const user = looked.body.data?.access.userByEmail?.response
  if (!user) throw new Error(`Unable to look up ${email} in test.`)
  return user
}

const runScheduledCleanup = async () => {
  const context = createExecutionContext()
  worker.scheduled(createScheduledController(), env, context)
  await waitOnExecutionContext(context)
}


/*
 * The authorization vocabulary exists twice — once in TypeScript, once in the
 * GraphQL schema a client reads. Nothing makes them agree, so a role or
 * capability added to one and forgotten in the other would be invisible until
 * somebody could not be granted a role that plainly exists.
 */

/*
 * Role invitations.
 *
 * The invitation is a bearer credential that lives only in a link and is never
 * written down, so what protects it is entirely in what refuses it. These are
 * mostly refusals for that reason: an invitation that can be edited, replayed,
 * or aimed at a role the issuer does not hold is a way to become staff without
 * anybody granting it.
 */
describe('inviting somebody to a staff role', () => {
  const UNUSABLE = 'This invitation is not usable. Ask for a new one.'

  /** Signs somebody up for real, so they are a verified applicant. */
  const applicantAccount = async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const email = `invitee-${crypto.randomUUID()}@example.test`
    const signup = await startSignup(email, log)
    await verifySignup(signup.challengeToken, signup.otp)
    log.mockRestore()
    const row = await env.DB.prepare('SELECT id FROM core_user WHERE email = ?')
      .bind(email).first<{ id: string }>()
    return { id: row!.id, email }
  }

  /** A session holding exactly the roles given, without going through signup. */
  const sessionHolding = async (roles: string[]) => {
    const userId = crypto.randomUUID()
    const token = crypto.randomUUID()
    const now = Date.now()
    const digest = await sessionTokenDigest(env.AUTH_SECRET!, token)
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO core_user (id, email, password_hash, email_verified_at,
          row_version, created_at, updated_at) VALUES (?, ?, 'unused', ?, 1, ?, ?)`,
      ).bind(userId, `${userId}@example.test`, now, now, now),
      ...roles.map((role) => env.DB.prepare(
        `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
         VALUES (?, ?, ?, 'INVITE_TEST', ?)`,
      ).bind(crypto.randomUUID(), userId, role, now)),
      env.DB.prepare(
        `INSERT INTO core_session (id, user_id, token_digest, expires_at,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), userId, digest, now + 3_600_000, now, now),
    ])
    return { userId, cookie: `seb_session=${token}` }
  }

  const invite = async (cookie: string, userId: string, role: string) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { body } = await graphql<{
      access: { inviteRole: { success: boolean; message: string | null } }
    }>(
      `mutation { access { inviteRole(input: {
        userId: "${userId}", role: ${role}, reason: "Joining the office"
      }) { success message } } }`,
      cookie,
    )
    // The link is only ever in the message that was sent, never in the reply.
    const line = log.mock.calls.map((call) => String(call[0]))
      .find((value) => value.startsWith('DEV_EMAIL '))
    log.mockRestore()
    const token = line
      ? (JSON.parse(line.slice('DEV_EMAIL '.length)) as { text: string })
          .text.match(/\/invite#([A-Za-z0-9_-]+)/u)?.[1] ?? null
      : null
    return { result: body.data!.access.inviteRole, token }
  }

  const accept = async (token: string) => {
    const { body } = await graphql<{
      access: { acceptRoleInvite: { success: boolean; message: string | null } }
    }>(`mutation { access { acceptRoleInvite(token: "${token}") { success message } } }`)
    return body.data!.access.acceptRoleInvite
  }

  const activeRoles = async (userId: string): Promise<string[]> => {
    const { results } = await env.DB.prepare(
      `SELECT role FROM core_user_role_grant
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY role`,
    ).bind(userId).all<{ role: string }>()
    return results.map((row) => row.role)
  }

  it('swaps the applicant grant for the role, and never returns the link', async () => {
    const admin = await sessionHolding(['SUPER_ADMIN'])
    const subject = await applicantAccount()

    const { result, token } = await invite(admin.cookie, subject.id, 'REVIEWER')
    expect(result.success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('invite#')
    expect(token).toBeTruthy()

    expect(await activeRoles(subject.id)).toEqual(['APPLICANT'])
    expect((await accept(token!)).success).toBe(true)
    // A swap, not an addition: they stop being an applicant.
    expect(await activeRoles(subject.id)).toEqual(['REVIEWER'])
  })

  it('refuses a replay, because the precondition is what expires it', async () => {
    const admin = await sessionHolding(['SUPER_ADMIN'])
    const subject = await applicantAccount()
    const { token } = await invite(admin.cookie, subject.id, 'APPROVER')

    expect((await accept(token!)).success).toBe(true)
    // Nothing recorded the token as spent. It fails because they are no longer
    // an applicant, which is the same check that authorized the first one.
    expect(await accept(token!)).toMatchObject({ success: false, message: UNUSABLE })
    expect(await activeRoles(subject.id)).toEqual(['APPROVER'])
  })

  it('refuses a token whose bytes were edited', async () => {
    const admin = await sessionHolding(['SUPER_ADMIN'])
    const subject = await applicantAccount()
    const { token } = await invite(admin.cookie, subject.id, 'REVIEWER')

    // Flip one character of the ciphertext. Without authenticated encryption
    // this is where somebody would go looking for a different role.
    const at = token!.length - 5
    const edited = token!.slice(0, at) +
      (token![at] === 'A' ? 'B' : 'A') + token!.slice(at + 1)
    expect(await accept(edited)).toMatchObject({ success: false, message: UNUSABLE })
    expect(await activeRoles(subject.id)).toEqual(['APPLICANT'])

    /*
     * And it is recorded. One refusal is unremarkable; a run of them is
     * somebody trying tokens, which is exactly what a super administrator
     * reviewing the history would want to see. The actor is null, because a
     * refused token identifies nobody — possession is the whole credential.
     */
    const [refusal] = (await env.DB.prepare(
      `SELECT actor_user_id AS actor, outcome FROM core_audit_event
       WHERE action = 'RBAC.ROLE_INVITE_REFUSED' ORDER BY created_at DESC LIMIT 1`,
    ).all()).results as { actor: string | null; outcome: string }[]
    expect(refusal, 'a refused invitation left no trace').toBeDefined()
    expect(refusal).toMatchObject({ actor: null, outcome: 'FAILURE' })
  })

  it('refuses a token sealed with a different secret', async () => {
    const subject = await applicantAccount()
    const forged = await sealInvite('an-entirely-different-secret-32-bytes-long', {
      version: 1,
      userId: subject.id,
      email: subject.email,
      role: 'ADMIN',
      issuerId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      nonce: crypto.randomUUID(),
    })
    expect(await accept(forged)).toMatchObject({ success: false, message: UNUSABLE })
    expect(await activeRoles(subject.id)).toEqual(['APPLICANT'])
  })

  it('refuses one that has expired', async () => {
    const subject = await applicantAccount()
    const stale = await sealInvite('test-invite-secret-that-is-at-least-32-bytes', {
      version: 1,
      userId: subject.id,
      email: subject.email,
      role: 'REVIEWER',
      issuerId: crypto.randomUUID(),
      issuedAt: Date.now() - 100_000,
      expiresAt: Date.now() - 1_000,
      nonce: crypto.randomUUID(),
    })
    expect(await accept(stale)).toMatchObject({ success: false, message: UNUSABLE })
    expect(await activeRoles(subject.id)).toEqual(['APPLICANT'])
  })

  it('refuses one whose address is no longer the account\'s', async () => {
    const admin = await sessionHolding(['SUPER_ADMIN'])
    const subject = await applicantAccount()
    const { token } = await invite(admin.cookie, subject.id, 'REVIEWER')

    // The mailbox that received the link is no longer this account's, so
    // whoever holds it is no longer necessarily the account holder.
    await env.DB.prepare('UPDATE core_user SET email = ? WHERE id = ?')
      .bind(`moved-${crypto.randomUUID()}@example.test`, subject.id).run()
    expect(await accept(token!)).toMatchObject({ success: false, message: UNUSABLE })
    expect(await activeRoles(subject.id)).toEqual(['APPLICANT'])
  })

  it('stops an administrator inviting their way to more authority', async () => {
    const admin = await sessionHolding(['ADMIN'])
    const subject = await applicantAccount()

    // The escalation this ceiling exists to prevent: an ADMIN cannot create
    // another ADMIN, nor a SUPER_ADMIN, through a second account.
    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      const { result, token } = await invite(admin.cookie, subject.id, role)
      expect(result, role).toMatchObject({
        success: false, message: 'You cannot invite somebody to that role.',
      })
      expect(token, role).toBeNull()
    }
    // The two it may invite still work.
    expect((await invite(admin.cookie, subject.id, 'APPROVER')).result.success).toBe(true)
  })

  it('refuses anyone without the capability to invite at all', async () => {
    const subject = await applicantAccount()
    for (const roles of [['REVIEWER'], ['APPROVER'], ['APPLICANT']]) {
      const caller = await sessionHolding(roles)
      const { result } = await invite(caller.cookie, subject.id, 'REVIEWER')
      expect(result.success, roles.join()).toBe(false)
    }
  })

  it('does not invite somebody who has no applicant grant to swap', async () => {
    const admin = await sessionHolding(['SUPER_ADMIN'])
    const staff = await sessionHolding(['REVIEWER'])
    const { result } = await invite(admin.cookie, staff.userId, 'APPROVER')
    expect(result).toMatchObject({ success: false })
  })

  it('settles two simultaneous acceptances as exactly one grant', async () => {
    const admin = await sessionHolding(['SUPER_ADMIN'])
    const subject = await applicantAccount()
    const { token } = await invite(admin.cookie, subject.id, 'REVIEWER')

    const both = await Promise.all([accept(token!), accept(token!)])
    expect(both.filter((one) => one.success)).toHaveLength(1)
    expect(await activeRoles(subject.id)).toEqual(['REVIEWER'])
  })
})

describe('the vocabulary the schema publishes', () => {
  const enumValues = async (name: string): Promise<string[]> => {
    const result = await graphql<{
      __type: { enumValues: Array<{ name: string }> }
    }>(`query { __type(name: "${name}") { enumValues { name } } }`)
    return result.body.data!.__type.enumValues.map((value) => value.name).sort()
  }

  it('offers exactly the roles the database accepts', async () => {
    expect(await enumValues('UserRole')).toEqual([...userRoles].sort())
  })

  it('offers exactly the capabilities the policy defines', async () => {
    expect(await enumValues('Capability')).toEqual([...capabilities].sort())
  })
})

describe('authentication', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects more than one nested auth mutation before execution', async () => {
    const { body } = await graphql<unknown>(/* GraphQL */ `
      mutation {
        auth {
          signOut { success }
          revokeAllSessions { success }
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
          signOut { success }
          revokeAllSessions { success }
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
          response: { email: string; emailVerified: boolean; roles: string[] }
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
            response { email emailVerified roles }
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
        roles: ['APPLICANT'],
      },
    })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_signup_challenge').first<{
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
        signIn: {
          success: boolean
          message: null
          response: { session: { id: string; current: boolean; expiresAt: string } }
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          signIn(input: {
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
    expect(signedIn.body.data?.auth.signIn.success).toBe(true)
    expect(signedIn.response.headers.get('access-control-allow-credentials')).toBe('true')
    const cookies = signedIn.response.headers.get('set-cookie') ?? ''
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('SameSite=Lax')
    expect(cookies).toContain('Secure')
    expect(cookies).not.toMatch(/Max-Age=/iu)

    const publicSessionId = signedIn.body.data?.auth.signIn.response.session.id
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
      auth: { currentSession: { success: boolean; response: { session: { id: string } } } }
    }>(
      /* GraphQL */ `
        query {
          auth {
            currentSession {
              success
              response { session { id } }
            }
          }
        }
      `,
      cookieHeaderFrom(signedIn.response),
    )
    expect(current.body.data?.auth.currentSession.response.session.id).toBe(publicSessionId)

    notificationLog.mockRestore()
  })

  it('returns a successful null response for a signed-out current session', async () => {
    const { body } = await graphql<{
      auth: { currentSession: { success: boolean; message: null; response: null } }
    }>(/* GraphQL */ `
      query {
        auth {
          currentSession { success message response { session { id } } }
        }
      }
    `)
    expect(body.errors).toBeUndefined()
    expect(body.data?.auth.currentSession).toEqual({
      success: true,
      message: null,
      response: null,
    })
  })

  it('loads roles live and keeps administrator access after applicant revocation', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    const signedIn = await signInDefault()
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
          currentSession {
            success
            response { user { roles } }
          }
        }
      }
    `
    const multiRole = await graphql<CurrentSessionBody>(currentQuery, cookie)
    expect(multiRole.body.data?.auth.currentSession).toMatchObject({
      success: true,
      response: { user: { roles: ['APPLICANT', 'ADMIN'] } },
    })

    await env.DB.prepare(
      `UPDATE core_user_role_grant
       SET revoked_at = ?, revocation_reason = 'TEST_REVOKED'
       WHERE user_id = ? AND role = 'APPLICANT' AND revoked_at IS NULL`,
    )
      .bind(Date.now(), user.id)
      .run()

    // The person is now administrator-only. The session stays usable and the
    // payload reports the change on the very next request.
    const revoked = await graphql<CurrentSessionBody>(currentQuery, cookie)
    expect(revoked.body.data?.auth.currentSession).toMatchObject({
      success: true,
      response: { user: { roles: ['ADMIN'] } },
    })
    expect(revoked.response.headers.get('set-cookie')).toBeNull()

    // Sign-in accepts the surviving ADMIN grant, but the applicant capability
    // is gone from the same session.
    expect((await signInDefault()).body.data?.auth.signIn).toMatchObject({
      success: true,
    })
    const roleContext = cookieAuthContext(cookie)
    expect(await authenticatedApplicant(roleContext)).toBeNull()
    expect(await authenticatedWithCapability(roleContext, 'STAFF_WRITE')).not.toBeNull()
  })

  it('signs in an administrator holding no applicant grant and refuses applicant operations', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const bootstrapped = await bootstrapFirstAdmin()
    expect(bootstrapped.body.response?.roles).toEqual(['SUPER_ADMIN'])

    // The account now holds no APPLICANT grant at all. Before this change that
    // made it impossible to sign in; it must now succeed.
    const signedIn = await signInDefault()
    expect(signedIn.body.data?.auth.signIn).toMatchObject({ success: true })
    const cookie = cookieHeaderFrom(signedIn.response)

    const current = await graphql<CurrentSessionBody>(/* GraphQL */ `
      query {
        auth { currentSession { success response { user { roles } } } }
      }
    `, cookie)
    expect(current.body.data?.auth.currentSession).toMatchObject({
      success: true,
      response: { user: { roles: ['SUPER_ADMIN'] } },
    })

    // Session self-service is identity-scoped, so an administrator manages
    // their own sessions exactly like an applicant does.
    const listed = await graphql<{
      auth: { sessions: { success: boolean; response: { sessions: unknown[] } } }
    }>(/* GraphQL */ `
      query {
        auth { sessions { success response { sessions { id current } } } }
      }
    `, cookie)
    expect(listed.body.data?.auth.sessions.success).toBe(true)
    expect(listed.body.data?.auth.sessions.response.sessions).toHaveLength(1)

    // Applicant business operations remain closed: sign-in proves identity,
    // the APPLICANT grant proves capability, and only the former was widened.
    const enterprise = await graphql<{
      seb: { enterprise: { create: { success: boolean; message: string | null } } }
    }>(/* GraphQL */ `
      mutation {
        seb {
          enterprise {
            create(input: { name: "Blocked Enterprise", registrationType: SOLE_PROPRIETORSHIP }) {
              success
              message
            }
          }
        }
      }
    `, cookie)
    expect(enterprise.body.data?.seb.enterprise.create).toMatchObject({
      success: false,
      message: 'Applicant authentication is required.',
    })
  })

  it('refuses sign-in once every role grant has been revoked', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    expect((await signInDefault()).body.data?.auth.signIn).toMatchObject({ success: true })

    await revokeEveryRoleGrant()

    // Widening sign-in to any active role must not widen it to no role.
    const refused = await signInDefault()
    expect(refused.body.data?.auth.signIn).toMatchObject({ success: false })
    expect(refused.response.headers.get('set-cookie')).toBeNull()
  })

  it('stops authenticating an existing session once every role grant is revoked', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    const signedIn = await signInDefault()
    const cookie = cookieHeaderFrom(signedIn.response)

    await revokeEveryRoleGrant()

    // Holding no active role refuses sign-in, so a cookie issued earlier must
    // not keep the account usable for the rest of the seven-day session.
    const current = await graphql<CurrentSessionBody>(/* GraphQL */ `
      query {
        auth { currentSession { success response { user { roles } } } }
      }
    `, cookie)
    expect(current.body.data?.auth.currentSession.response).toBeNull()
    expect(current.response.headers.get('set-cookie')).toContain('Max-Age=0')

    const listed = await graphql<{
      auth: { sessions: { success: boolean; message: string | null } }
    }>(/* GraphQL */ `
      query {
        auth { sessions { success message response { sessions { id } } } }
      }
    `, cookie)
    expect(listed.body.data?.auth.sessions).toMatchObject({
      success: false,
      message: 'Authentication is required.',
    })

    // Refusal alone would leave the rows to authenticate again the moment any
    // role is granted back, so presenting the cookie destroys them.
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_audit_event
         WHERE action = ? AND actor_user_id IS NULL
           AND metadata_json LIKE '%NO_ACTIVE_ROLE%'`,
      )
        .bind(auditActions.sessionsRevoked)
        .first(),
    ).toEqual({ count: 1 })

    // The browser also loses the superseded cookie name, which it would
    // otherwise keep sending forever.
    const clearedCookies = current.response.headers.getSetCookie()
    expect(clearedCookies.some((value) => value.startsWith('seb_session='))).toBe(true)
    expect(
      clearedCookies.some((value) => value.startsWith('seb_applicant_session=')),
    ).toBe(true)
  })

  it('sweeps sessions of deactivated accounts that never present a cookie', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    await signInDefault()
    await revokeEveryRoleGrant()

    // Nothing presented the cookie, so the request path never saw this account.
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
    ).toEqual({ count: 0 })
  })

  it('refuses to bootstrap an applicant who already owns an enterprise', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    const signedIn = await signInDefault()
    const cookie = cookieHeaderFrom(signedIn.response)

    const created = await graphql<{
      seb: { enterprise: { create: { success: boolean; message: string | null } } }
    }>(/* GraphQL */ `
      mutation {
        seb {
          enterprise {
            create(input: {
              name: "Owned Enterprise"
              establishmentDate: "2026-01-15"
              registrationType: PRIVATE_LIMITED
              registrationNumber: "UDYAM-BOOTSTRAP-1"
              gstin: null
              businessSector: FOOD_PROCESSING
              otherBusinessSector: null
              businessBlockOrVillage: "Khumulwng"
              businessDistrict: "WEST_TRIPURA"
              businessPinCode: "799045"
              contactNumber: "9876543210"
              contactEmail: "owner@example.test"
            }) {
              success
              message
            }
          }
        }
      }
    `, cookie)
    expect(created.body.data?.seb.enterprise.create).toMatchObject({ success: true })

    // Bootstrap revokes APPLICANT and nothing can grant it back yet, so
    // promoting this owner would strand the enterprise permanently.
    const refused = await bootstrapFirstAdmin()
    expect(refused.response.status).toBe(403)
    expect(refused.body).toEqual({
      success: false,
      message:
        'First administrator bootstrap is unavailable or the supplied credentials are invalid.',
      response: null,
    })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 0 })

    // The refusal must not have half-applied the swap: the applicant keeps
    // working, which is the outcome the guard exists to protect.
    const listed = await graphql<{
      seb: {
        enterprise: {
          mine: {
            success: boolean
            response: { nodes: Array<{ name: string }> } | null
          }
        }
      }
    }>(/* GraphQL */ `
      query {
        seb { enterprise { mine { success response { nodes { name } } } } }
      }
    `, cookie)
    expect(listed.body.data?.seb.enterprise.mine).toMatchObject({
      success: true,
      response: { nodes: [{ name: 'Owned Enterprise' }] },
    })
  })

  it('destroys the promoted account\'s existing sessions during bootstrap', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    await signInDefault()
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
    ).toEqual({ count: 1 })

    // That session was issued to an applicant. Surviving the swap would upgrade
    // it to full administrative authority without re-proving the password.
    expect((await bootstrapFirstAdmin()).body.response?.roles).toEqual(['SUPER_ADMIN'])
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
    ).toEqual({ count: 0 })
  })

  it('ignores the superseded session cookie name and digest label', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)
    const signedIn = await signInDefault()
    const cookie = cookieHeaderFrom(signedIn.response)
    const token = cookie.slice(cookie.indexOf('=') + 1)

    const currentQuery = /* GraphQL */ `
      query {
        auth { currentSession { success response { session { id } } } }
      }
    `
    // A live token presented under the pre-rename cookie name is not read at all.
    const oldCookieName = await graphql<CurrentSessionBody>(
      currentQuery,
      `seb_applicant_session=${token}`,
    )
    expect(oldCookieName.body.data?.auth.currentSession.response).toBeNull()

    // A session stored under the pre-rename purpose label no longer matches.
    const legacyToken = crypto.randomUUID()
    const user = await env.DB.prepare(
      `SELECT id FROM core_user WHERE email = 'applicant@example.com'`,
    ).first<{ id: string }>()
    if (!user) throw new Error('Expected applicant user.')
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO core_session (
        id, user_id, token_digest, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        user.id,
        await createDigest(env.AUTH_SECRET, 'applicant-session', legacyToken),
        now + 60_000,
        now,
        now,
      )
      .run()
    const legacyDigest = await graphql<CurrentSessionBody>(
      currentQuery,
      `seb_session=${legacyToken}`,
    )
    expect(legacyDigest.body.data?.auth.currentSession.response).toBeNull()
  })

  it('bootstraps the configured applicant through curl-only HTTP and never exposes GraphQL', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    // Bootstrap authenticates the configured existing applicant directly. It
    // does not need or create a browser session.
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
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
        // Bootstrap swaps the role rather than adding to it.
        roles: ['SUPER_ADMIN'],
      },
    })

    const grants = await env.DB.prepare(
      `SELECT role, granted_by_user_id, grant_reason, revoked_by_user_id,
              revocation_reason, revoked_at
       FROM core_user_role_grant ORDER BY granted_at`,
    ).all<{
      role: string
      granted_by_user_id: string | null
      grant_reason: string
      revoked_by_user_id: string | null
      revocation_reason: string | null
      revoked_at: number | null
    }>()
    // The revoked APPLICANT row is retained, so role history stays complete.
    expect(grants.results).toEqual([
      {
        role: 'APPLICANT',
        granted_by_user_id: null,
        grant_reason: 'VERIFIED_APPLICANT_SIGNUP',
        revoked_by_user_id: null,
        revocation_reason: 'FIRST_SUPER_ADMIN_BOOTSTRAP',
        revoked_at: expect.any(Number),
      },
      {
        role: 'SUPER_ADMIN',
        granted_by_user_id: null,
        grant_reason: 'FIRST_SUPER_ADMIN_BOOTSTRAP',
        revoked_by_user_id: null,
        revocation_reason: null,
        revoked_at: null,
      },
    ])
    expect(grants.results.some(({ role }) => role === 'ADMIN')).toBe(false)

    const audits = await env.DB.prepare(
      `SELECT action, outcome, entity_type, entity_id, request_id, ip_address,
              user_agent, changes_json, metadata_json
       FROM core_audit_event ORDER BY created_at`,
    ).all<{
      action: string
      outcome: string
      entity_type: string
      entity_id: string | null
      request_id: string | null
      ip_address: string | null
      user_agent: string | null
      changes_json: string | null
      metadata_json: string | null
    }>()
    // The swap writes both role events; neither may carry caller-controlled
    // request labels, because this endpoint receives two credentials.
    expect(audits.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: auditActions.firstSuperAdminBootstrap,
          outcome: 'SUCCESS',
        }),
        expect.objectContaining({
          action: auditActions.roleRevoked,
          outcome: 'SUCCESS',
          // Named so the revocation stays reachable through the audit entity
          // index rather than only through a full-table action scan.
          entity_type: 'CORE_USER',
          entity_id: bootstrapped.body.response?.userId,
          request_id: null,
          ip_address: null,
          user_agent: null,
        }),
      ]),
    )
    expect(
      audits.results.filter(({ action }) => action === auditActions.roleGranted),
    ).toHaveLength(2)
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
        `SELECT count(*)::int AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_audit_event
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
        `SELECT count(*)::int AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
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
        `SELECT count(*)::int AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
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

    const db = activeDatabase()
    const candidate = await findActiveUserByEmail(db, 'applicant@example.com')
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
      roleGrantAuditEvent: testAuditEvent(
        auditActions.roleGranted,
        'CORE_USER_ROLE_GRANT',
        grantId,
        'SUCCESS',
      ),
      roleRevocationAuditEvent: testAuditEvent(
        auditActions.roleRevoked,
        'CORE_USER_ROLE_GRANT',
        candidate.id,
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
        `SELECT count(*)::int AS count FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'`,
      ).first(),
    ).toEqual({ count: 0 })
    // The swap is all-or-nothing: a losing write must not strip APPLICANT and
    // leave the account with no active role at all.
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_user_role_grant
         WHERE role = 'APPLICANT' AND revoked_at IS NULL`,
      ).first(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_audit_event
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

    const db = activeDatabase()
    // This is the credential lookup that happens before the intentionally slow
    // password hash. Revoking after it models the exact sign-in race.
    const staleUser = await findActiveUserByEmail(db, 'applicant@example.com')
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
    const created = await createUserSession(
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
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_audit_event WHERE action = ?`,
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
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_user').first<{ count: number }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_user_role_grant
         WHERE role = 'APPLICANT' AND revoked_at IS NULL`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_audit_event WHERE action = ?`,
      )
        .bind(auditActions.roleGranted)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 })
  })

  it('does not let a stale valid read bypass concurrently exhausted OTP attempts', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    const db = activeDatabase()
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
        displayName: null,
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
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_user').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_user_role_grant').first<{
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
    /*
     * A forced failure in the middle of the transition, to prove the rollback.
     *
     * A CHECK rather than a trigger: the rule is "this update must fail", and a
     * constraint says that without needing a procedural language PGlite does
     * not carry. Cancelling a sibling challenge is refused, and the identity
     * created beside it in the same transition must not survive.
     */
    await env.DB.prepare(
      `ALTER TABLE core_signup_challenge
       ADD CONSTRAINT reject_signup_cleanup CHECK (status <> 'CANCELLED')`,
    ).run()

    expect(await verifySignup(signup.challengeToken, signup.otp)).toBeUndefined()
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_user').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_user_role_grant').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 2 })

    /*
     * Dropped rather than left to the reset: the constraint outlives a
     * `TRUNCATE`, and every later test in this file would then be unable to
     * cancel a sibling challenge — failing for a reason nothing in their own
     * bodies mentions.
     */
    await env.DB.prepare(
      'ALTER TABLE core_signup_challenge DROP CONSTRAINT reject_signup_cleanup',
    ).run()
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

    await env.DB.prepare(
      'UPDATE core_signup_challenge SET expires_at = to_timestamp(0)',
    ).run()
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(false)
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare(
        // Grouped, not a bare column beside an aggregate: SQLite picked an
        // arbitrary row's status and the assertion was ambiguous about which.
        'SELECT count(*)::int AS count, status FROM core_signup_challenge GROUP BY status',
      ).first<{
        count: number
        status: string
      }>(),
    ).toEqual({ count: 1, status: 'EXPIRED' })
  })

  it('rejects passwords outside the signup policy before sign-in hashing', async () => {
    const { body } = await signInWithPassword('x'.repeat(129))
    expect(body.errors).toBeUndefined()
    expect(body.data?.auth.signIn).toMatchObject({ success: false, response: null })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
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

    expect((await signInDefault()).body.data?.auth.signIn).toMatchObject({
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
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_signup_challenge').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })
  })

  it('hard-deletes sign-out sessions and audits outcomes without retaining credentials', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const failed = await signInWithPassword('incorrect password')
    expect(failed.body.data?.auth.signIn.success).toBe(false)
    const failedAudit = await env.DB.prepare(
      `SELECT actor_user_id, entity_id FROM core_audit_event WHERE action = ?`,
    )
      .bind(auditActions.signInFailed)
      .first<{ actor_user_id: string | null; entity_id: string | null }>()
    expect(failedAudit?.actor_user_id).toBeNull()
    expect(failedAudit?.entity_id).toEqual(expect.any(String))

    const signedIn = await signInDefault()
    const cookie = cookieHeaderFrom(signedIn.response)
    const rawToken = cookie.split('=', 2)[1]
    const signedOut = await graphql<{ auth: { signOut: { success: boolean } } }>(
      /* GraphQL */ `
        mutation {
          auth { signOut { success } }
        }
      `,
      cookie,
    )
    expect(signedOut.body.data?.auth.signOut.success).toBe(true)
    expect(signedOut.response.headers.get('set-cookie')).toMatch(/Max-Age=0/iu)
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
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
        // Grouped, not a bare column beside an aggregate: SQLite picked an
        // arbitrary row's status and the assertion was ambiguous about which.
        'SELECT count(*)::int AS count, status FROM core_signup_challenge GROUP BY status',
      ).first<{
        count: number
        status: string
      }>(),
    ).toEqual({ count: 1, status: 'DELIVERY_FAILED' })
    expect(
      await env.DB.prepare(
        `SELECT count(*)::int AS count FROM core_audit_event
         WHERE action = 'AUTH.SIGNUP_NOTIFICATION_FAILED'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 })
  })

  it('lists and hard-revokes owned sessions while preserving or clearing cookies correctly', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const first = await signInDefault()
    const second = await signInDefault()
    const firstId = first.body.data?.auth.signIn.response.session.id
    const secondId = second.body.data?.auth.signIn.response.session.id
    const secondCookie = cookieHeaderFrom(second.response)

    const listed = await graphql<{
      auth: {
        sessions: {
          success: boolean
          response: { sessions: Array<{ id: string; current: boolean }> }
        }
      }
    }>(
      /* GraphQL */ `
        query {
          auth {
            sessions {
              success
              response { sessions { id current } }
            }
          }
        }
      `,
      secondCookie,
    )
    expect(listed.body.data?.auth.sessions.response.sessions).toEqual(
      expect.arrayContaining([
        { id: firstId, current: false },
        { id: secondId, current: true },
      ]),
    )

    const revokedOther = await graphql<{
      auth: { revokeOtherSessions: { success: boolean } }
    }>(
      /* GraphQL */ `
        mutation {
          auth { revokeOtherSessions { success } }
        }
      `,
      secondCookie,
    )
    expect(revokedOther.body.data?.auth.revokeOtherSessions.success).toBe(true)
    expect(revokedOther.response.headers.get('set-cookie')).toBeNull()
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    const third = await signInDefault()
    const thirdId = third.body.data?.auth.signIn.response.session.id
    const revokedCurrent = await graphql<{
      auth: { revokeSession: { success: boolean } }
    }>(
      /* GraphQL */ `
        mutation {
          auth { revokeSession(sessionId: "${thirdId}") { success } }
        }
      `,
      cookieHeaderFrom(third.response),
    )
    expect(revokedCurrent.body.data?.auth.revokeSession.success).toBe(true)
    expect(revokedCurrent.response.headers.get('set-cookie')).toMatch(/Max-Age=0/iu)
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    const revokedAll = await graphql<{
      auth: { revokeAllSessions: { success: boolean } }
    }>(
      /* GraphQL */ `
        mutation {
          auth { revokeAllSessions { success } }
        }
      `,
      secondCookie,
    )
    expect(revokedAll.body.data?.auth.revokeAllSessions.success).toBe(true)
    expect(revokedAll.response.headers.get('set-cookie')).toMatch(/Max-Age=0/iu)
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
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

  it('lets every staff role be revoked, not only the two it started with', async () => {
    /*
     * Revocation names a grant id, so the role of the row it resolves to is
     * checked inside the write. That predicate was written when `ADMIN` and
     * `SUPER_ADMIN` were the only manageable roles and did not grow with them,
     * so revoking a reviewer matched no rows and reported that the record had
     * changed — for ever, on every attempt.
     *
     * Staff access would have been one-way: invitations are how reviewers and
     * approvers are created, and nothing could take one back.
     */
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    for (const role of ['REVIEWER', 'APPROVER', 'ADMIN'] as const) {
      const subject = await registerManagedApplicant(
        `revoked-${role.toLowerCase()}@example.com`, notificationLog, superAdmin.cookie,
      )
      const granted = await grantRole(
        { userId: subject.id, role, reason: 'Joining the programme office' },
        superAdmin.cookie,
      )
      const managed = granted.body.data?.access.grantRole
      expect(managed?.success, `granting ${role}`).toBe(true)

      const revoked = await revokeRole(
        { grantId: activeGrantId(managed?.response ?? null, role), reason: 'No longer needed' },
        superAdmin.cookie,
      )
      expect(revoked.body.data?.access.revokeRole, `revoking ${role}`)
        .toMatchObject({ success: true })
      const after = await env.DB.prepare(
        `SELECT role FROM core_user_role_grant
         WHERE user_id = ? AND revoked_at IS NULL ORDER BY role`,
      ).bind(subject.id).all<{ role: string }>()
      expect(after.results.map(({ role }) => role)).toEqual(['APPLICANT'])
    }
    notificationLog.mockRestore()
  })

  it('keeps expired-session cleanup out of public requests and runs it by cron', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const signup = await startSignup('applicant@example.com', notificationLog)
    expect((await verifySignup(signup.challengeToken, signup.otp))?.success).toBe(true)

    const signedIn = await signInDefault()
    const cookie = cookieHeaderFrom(signedIn.response)
    await env.DB.prepare('UPDATE core_session SET expires_at = to_timestamp(0)').run()

    const current = await graphql<{
      auth: { currentSession: { success: boolean; response: null } }
    }>(
      /* GraphQL */ `
        query {
          auth { currentSession { success response { session { id } } } }
        }
      `,
      cookie,
    )
    expect(current.body.data?.auth.currentSession).toEqual({
      success: true,
      response: null,
    })
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 1 })

    await runScheduledCleanup()
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first<{
        count: number
      }>(),
    ).toEqual({ count: 0 })
  })
})

describe('administrative role management', () => {
  afterEach(() => vi.restoreAllMocks())

  it('grants ADMIN and lets the new administrator sign in and work', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const subject = await registerManagedApplicant(
      'reviewer@example.com',
      notificationLog,
      superAdmin.cookie,
    )
    expect(subject).toMatchObject({
      email: 'reviewer@example.com',
      emailVerified: true,
      deleted: false,
      roles: ['APPLICANT'],
    })

    const granted = await grantRole(
      { userId: subject.id, role: 'ADMIN', reason: 'Joining desk review' },
      superAdmin.cookie,
    )
    const managed = granted.body.data?.access.grantRole
    expect(managed?.success).toBe(true)
    // Dual roles remain permitted: only the bootstrap path produces an
    // administrator who holds no applicant grant.
    expect(managed?.response?.roles).toEqual(['APPLICANT', 'ADMIN'])
    const adminGrant = managed?.response?.grants.find((grant) => grant.role === 'ADMIN')
    expect(adminGrant).toMatchObject({
      grantReason: 'Joining desk review',
      grantedByUserId: superAdmin.userId,
      revokedAt: null,
      revocationReason: null,
    })

    const signedIn = await signInAs('reviewer@example.com', DEFAULT_PASSWORD)
    expect(signedIn.body.data?.auth.signIn.success).toBe(true)
    const reviewerCookie = cookieHeaderFrom(signedIn.response)
    const queue = await graphql<{
      admin: { intake: { queue: { success: boolean } } }
    }>(/* GraphQL */ `
      query { admin { intake { queue(input: { first: 5 }) { success } } } }
    `, reviewerCookie)
    expect(queue.body.data?.admin.intake.queue.success).toBe(true)

    // A plain administrator may not manage anyone else's authority.
    const escalation = await grantRole(
      { userId: subject.id, role: 'SUPER_ADMIN' },
      reviewerCookie,
    )
    expect(escalation.body.data?.access.grantRole).toMatchObject({
      success: false,
      message: 'Authentication is required.',
      response: null,
    })

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, entity_type, entity_id, metadata_json
       FROM core_audit_event WHERE action = ? AND entity_id = ?`,
    )
      .bind(auditActions.roleGranted, adminGrant?.id)
      .first<{
        actor_user_id: string
        entity_type: string
        entity_id: string
        metadata_json: string
      }>()
    expect(audit).toMatchObject({
      actor_user_id: superAdmin.userId,
      entity_type: 'CORE_USER_ROLE_GRANT',
    })
    // The reason is retained on the grant row; audit metadata stays limited to
    // public identifiers and the role name.
    expect(JSON.parse(audit?.metadata_json ?? '{}')).toEqual({
      subjectUserId: subject.id,
      role: 'ADMIN',
    })
    expect(audit?.metadata_json).not.toContain('reviewer@example.com')
  })

  it('refuses a duplicate active grant and re-grants a revoked role as new history', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const subject = await registerManagedApplicant(
      'reviewer@example.com',
      notificationLog,
      superAdmin.cookie,
    )

    const first = await grantRole({ userId: subject.id, role: 'ADMIN' }, superAdmin.cookie)
    const firstGrantId = activeGrantId(
      first.body.data?.access.grantRole?.response ?? null,
      'ADMIN',
    )

    const duplicate = await grantRole(
      { userId: subject.id, role: 'ADMIN' },
      superAdmin.cookie,
    )
    expect(duplicate.body.data?.access.grantRole).toMatchObject({
      success: false,
      message: 'That role is already active for this user.',
      response: null,
    })

    const revoked = await revokeRole(
      { grantId: firstGrantId, reason: 'Moved to another department' },
      superAdmin.cookie,
    )
    expect(revoked.body.data?.access.revokeRole?.success).toBe(true)
    expect(revoked.body.data?.access.revokeRole?.response?.roles).toEqual(['APPLICANT'])

    const regranted = await grantRole(
      { userId: subject.id, role: 'ADMIN', reason: 'Returned to desk review' },
      superAdmin.cookie,
    )
    const grants = regranted.body.data?.access.grantRole?.response?.grants ?? []
    const adminGrants = grants.filter((grant) => grant.role === 'ADMIN')
    // Re-granting adds a row rather than reopening the old one, so the history
    // of who held what and when stays complete.
    expect(adminGrants).toHaveLength(2)
    expect(adminGrants[0]).toMatchObject({
      id: firstGrantId,
      revokedByUserId: superAdmin.userId,
      revocationReason: 'Moved to another department',
    })
    expect(adminGrants[0]?.revokedAt).not.toBeNull()
    expect(adminGrants[1]).toMatchObject({
      grantReason: 'Returned to desk review',
      revokedAt: null,
    })
  })

  it('requires a correct password and a reason, and writes nothing otherwise', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const subject = await registerManagedApplicant(
      'reviewer@example.com',
      notificationLog,
      superAdmin.cookie,
    )

    const wrongPassword = await grantRole(
      { userId: subject.id, role: 'ADMIN', password: 'not the right password' },
      superAdmin.cookie,
    )
    expect(wrongPassword.body.data?.access.grantRole).toMatchObject({
      success: false,
      message: 'Your password is incorrect.',
    })

    const blankReason = await grantRole(
      { userId: subject.id, role: 'ADMIN', reason: '   ' },
      superAdmin.cookie,
    )
    expect(blankReason.body.data?.access.grantRole?.message).toContain('reason')

    const longReason = await grantRole(
      { userId: subject.id, role: 'ADMIN', reason: 'r'.repeat(501) },
      superAdmin.cookie,
    )
    expect(longReason.body.data?.access.grantRole?.success).toBe(false)

    // Every refusal happened before any write, so the subject still holds only
    // the grant verified signup gave them, and no ADMIN audit event exists.
    const after = await managedUserById(subject.id, superAdmin.cookie)
    expect(after.body.data?.access.userById?.response?.roles).toEqual(['APPLICANT'])
    expect(after.body.data?.access.userById?.response?.grants).toHaveLength(1)
    const audits = await env.DB.prepare(
      `SELECT count(*)::int AS count FROM core_audit_event
       WHERE action = ? AND metadata_json = ?`,
    )
      .bind(
        auditActions.roleGranted,
        JSON.stringify({ subjectUserId: subject.id, role: 'ADMIN' }),
      )
      .first<{ count: number }>()
    expect(audits?.count).toBe(0)
  })

  it('keeps at least one usable super administrator', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const successor = await registerManagedApplicant(
      'successor@example.com',
      notificationLog,
      superAdmin.cookie,
    )
    const own = await managedUserById(superAdmin.userId, superAdmin.cookie)
    const ownGrantId = activeGrantId(
      own.body.data?.access.userById?.response ?? null,
      'SUPER_ADMIN',
    )

    // Nobody else holds the role yet, so the only grant cannot be closed. The
    // remaining-holder rule is reported ahead of the self-revocation rule
    // because it is the one that says what to do about it.
    const lastOne = await revokeRole({ grantId: ownGrantId }, superAdmin.cookie)
    expect(lastOne.body.data?.access.revokeRole).toMatchObject({
      success: false,
      message:
        'At least one super administrator must remain. Grant the role to someone else first.',
    })

    const promoted = await grantRole(
      { userId: successor.id, role: 'SUPER_ADMIN', reason: 'Programme office lead' },
      superAdmin.cookie,
    )
    const successorGrantId = activeGrantId(
      promoted.body.data?.access.grantRole?.response ?? null,
      'SUPER_ADMIN',
    )

    // A soft-deleted holder is not usable, so the guard must ignore them.
    await env.DB.prepare('UPDATE core_user SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), successor.id)
      .run()
    const withDeletedHolder = await revokeRole({ grantId: ownGrantId }, superAdmin.cookie)
    expect(withDeletedHolder.body.data?.access.revokeRole?.success).toBe(false)

    await env.DB.prepare('UPDATE core_user SET deleted_at = NULL WHERE id = ?')
      .bind(successor.id)
      .run()
    const successorSignIn = await signInAs('successor@example.com', DEFAULT_PASSWORD)
    const successorCookie = cookieHeaderFrom(successorSignIn.response)

    // With a second usable holder the demotion is allowed — performed by the
    // other super administrator, because self-revocation is always refused.
    const demoted = await revokeRole(
      { grantId: ownGrantId, reason: 'Handing over the programme office' },
      successorCookie,
    )
    expect(demoted.body.data?.access.revokeRole?.success).toBe(true)
    expect(demoted.body.data?.access.revokeRole?.response?.roles).toEqual([])

    // The remaining holder is once again the last one.
    const nowLast = await revokeRole({ grantId: successorGrantId }, successorCookie)
    expect(nowLast.body.data?.access.revokeRole?.success).toBe(false)
  })

  /**
   * The guard under genuinely concurrent writers, which is the only condition
   * it can fail under.
   *
   * Every other guarded write in this repository is safe because two writers
   * contend for *the same row*: the loser blocks, re-reads the committed row
   * and its predicate fails. This one reads rows it does not write, so writers
   * revoking *different* grants never block each other, each `EXISTS` runs
   * against a snapshot taken before the others committed, and all of them
   * succeed. **The portal is left with no super administrator and no way back**,
   * because bootstrap closes permanently after the first grant.
   *
   * **Three, in a cycle, and not two.** With two it cannot happen: each actor is
   * also the other's subject, so whichever commits second is caught by the
   * separate term requiring the actor to still hold the role. Three actors each
   * removing the next leave every actor live at their own snapshot.
   *
   * **This test does not reproduce the race, and would pass without the fix.**
   * Reaching zero needs all three transactions open at once, and this suite
   * drives the product over HTTP, where nothing can hold one there. What it
   * asserts is the invariant — a super administrator is left standing — so a
   * later change that loses it is caught even though the original defect was
   * not. The race itself was demonstrated against three raw sessions held at a
   * barrier; see `lockSuperAdminRoster` in `auth/queries/access.ts`, which
   * records what that showed.
   */
  it('leaves a super administrator standing when three revocations race in a cycle', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const first = await establishSuperAdmin(notificationLog)

    const promote = async (email: string) => {
      const user = await registerManagedApplicant(email, notificationLog, first.cookie)
      const granted = await grantRole(
        { userId: user.id, role: 'SUPER_ADMIN', reason: 'Programme office lead' },
        first.cookie,
      )
      return {
        grantId: activeGrantId(
          granted.body.data?.access.grantRole?.response ?? null,
          'SUPER_ADMIN',
        ),
        cookie: cookieHeaderFrom((await signInAs(email, DEFAULT_PASSWORD)).response),
      }
    }
    const second = await promote('second-super@example.com')
    const third = await promote('third-super@example.com')
    const own = await managedUserById(first.userId, first.cookie)
    const firstGrantId = activeGrantId(
      own.body.data?.access.userById?.response ?? null,
      'SUPER_ADMIN',
    )

    // Each removes the next, at the same moment. Self-revocation is refused, so
    // a cycle is the only shape in which every actor is still live at its own
    // snapshot and every grant is nevertheless named.
    const reason = 'Reorganising the office'
    const raced = await Promise.all([
      revokeRole({ grantId: second.grantId, reason }, first.cookie),
      revokeRole({ grantId: third.grantId, reason }, second.cookie),
      revokeRole({ grantId: firstGrantId, reason }, third.cookie),
    ])
    expect(raced.filter((each) => each.body.data?.access.revokeRole?.success).length)
      .toBeLessThan(3)

    const remaining = await env.DB.prepare(
      `SELECT count(*)::int AS count FROM core_user_role_grant
        WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL`,
    ).first<{ count: number }>()
    expect(remaining?.count).toBeGreaterThan(0)
  })

  /**
   * Two operators granting the same role at the same moment.
   *
   * The write repeats "they do not already hold it" as a predicate, and that
   * used to be justified by D1 serializing writers — so the partial unique
   * index `core_user_role_grant_active_uq` "never had to raise". Postgres does
   * not serialize them: both evaluate the predicate against their own snapshot,
   * both find nothing, and the second raises `23505`. Which reached the
   * operator as an unhandled error rather than as a refusal.
   *
   * Exactly one grant, and the loser is told so — not shown a stack trace.
   *
   * **This asserts the invariant, not the race.** Two HTTP requests do not
   * reliably have both writes open at once, so the predicate usually decides it
   * and the constraint never fires — the test passes without `constraintSafe`
   * too. It is here because the invariant is what must hold under every
   * interleaving, and because the version of this that *does* reproduce needs
   * both transactions pinned open, which nothing in this suite can do.
   */
  it('lets only one of two simultaneous grants of the same role land', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const subject = await registerManagedApplicant(
      'subject@example.com', notificationLog, superAdmin.cookie,
    )

    const raced = await Promise.all([
      grantRole({ userId: subject.id, role: 'ADMIN', reason: 'Programme office' }, superAdmin.cookie),
      grantRole({ userId: subject.id, role: 'ADMIN', reason: 'Programme office' }, superAdmin.cookie),
    ])
    // Whatever the interleaving, nobody sees an error and one of them refused.
    for (const each of raced) {
      expect(each.body.errors, JSON.stringify(each.body.errors)).toBeUndefined()
    }
    expect(raced.filter((each) => each.body.data?.access.grantRole?.success)).toHaveLength(1)

    const held = await env.DB.prepare(
      `SELECT count(*)::int AS count FROM core_user_role_grant
        WHERE user_id = ? AND role = 'ADMIN' AND revoked_at IS NULL`,
    ).bind(subject.id).first<{ count: number }>()
    expect(held?.count).toBe(1)
  })

  it('refuses self-revocation of super administrator but allows it for admin', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    // A second holder exists, so the remaining-holder rule is satisfied and the
    // self-revocation rule is the one under test.
    const successor = await registerManagedApplicant(
      'successor@example.com',
      notificationLog,
      superAdmin.cookie,
    )
    await grantRole(
      { userId: successor.id, role: 'SUPER_ADMIN', reason: 'Programme office lead' },
      superAdmin.cookie,
    )
    const own = await managedUserById(superAdmin.userId, superAdmin.cookie)
    const ownSuperGrantId = activeGrantId(
      own.body.data?.access.userById?.response ?? null,
      'SUPER_ADMIN',
    )

    const selfDemotion = await revokeRole({ grantId: ownSuperGrantId }, superAdmin.cookie)
    expect(selfDemotion.body.data?.access.revokeRole).toMatchObject({
      success: false,
      message:
        'You cannot revoke your own super administrator access. '
        + 'Another super administrator must do it.',
    })

    // A redundant ADMIN grant on the same person may be closed by them: it
    // cannot remove administrative access while SUPER_ADMIN is still held.
    const withAdmin = await grantRole(
      { userId: superAdmin.userId, role: 'ADMIN', reason: 'Redundant operational role' },
      superAdmin.cookie,
    )
    const ownAdminGrantId = activeGrantId(
      withAdmin.body.data?.access.grantRole?.response ?? null,
      'ADMIN',
    )
    const selfAdminRevoke = await revokeRole(
      { grantId: ownAdminGrantId, reason: 'No longer needed' },
      superAdmin.cookie,
    )
    expect(selfAdminRevoke.body.data?.access.revokeRole?.success).toBe(true)
    expect(selfAdminRevoke.body.data?.access.revokeRole?.response?.roles)
      .toEqual(['SUPER_ADMIN'])
  })

  it('keeps APPLICANT outside role administration entirely', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const subject = await registerManagedApplicant(
      'reviewer@example.com',
      notificationLog,
      superAdmin.cookie,
    )

    // The enum stops a grant at the schema boundary, before any resolver runs.
    const grantAttempt = await grantRole(
      { userId: subject.id, role: 'APPLICANT' },
      superAdmin.cookie,
    )
    expect(grantAttempt.body.data).toBeUndefined()
    expect(grantAttempt.body.errors?.[0]?.message).toContain('APPLICANT')

    // A revocation names a grant ID, so the role of the row it resolves to is
    // checked in the service instead.
    const applicantGrantId = activeGrantId(subject, 'APPLICANT')
    const revokeAttempt = await revokeRole({ grantId: applicantGrantId }, superAdmin.cookie)
    expect(revokeAttempt.body.data?.access.revokeRole).toMatchObject({
      success: false,
      message: 'Only administrative roles can be revoked here.',
    })

    const after = await managedUserById(subject.id, superAdmin.cookie)
    expect(after.body.data?.access.userById?.response?.roles).toEqual(['APPLICANT'])
  })

  it('refuses unknown users, stale grants, and unverified subjects', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)

    expect(
      (await managedUserByEmail('nobody@example.com', superAdmin.cookie))
        .body.data?.access.userByEmail,
    ).toMatchObject({ success: false, message: 'No user was found.', response: null })
    expect(
      (await managedUserByEmail('not-an-email', superAdmin.cookie))
        .body.data?.access.userByEmail?.message,
    ).toBe('Enter a valid email address.')
    expect(
      (await managedUserById('not-a-uuid', superAdmin.cookie))
        .body.data?.access.userById?.message,
    ).toBe('No user was found.')
    expect(
      (await managedUserById(crypto.randomUUID(), superAdmin.cookie))
        .body.data?.access.userById?.success,
    ).toBe(false)

    expect(
      (await grantRole({ userId: 'not-a-uuid', role: 'ADMIN' }, superAdmin.cookie))
        .body.data?.access.grantRole?.message,
    ).toBe('No user was found.')
    expect(
      (await grantRole({ userId: crypto.randomUUID(), role: 'ADMIN' }, superAdmin.cookie))
        .body.data?.access.grantRole?.success,
    ).toBe(false)
    expect(
      (await revokeRole({ grantId: 'not-a-uuid' }, superAdmin.cookie))
        .body.data?.access.revokeRole?.message,
    ).toBe('That role grant is not active.')
    expect(
      (await revokeRole({ grantId: crypto.randomUUID() }, superAdmin.cookie))
        .body.data?.access.revokeRole?.message,
    ).toBe('That role grant is not active.')

    // A soft-deleted or unverified identity cannot receive administrative
    // authority, because neither can sign in to use it.
    const subject = await registerManagedApplicant(
      'reviewer@example.com',
      notificationLog,
      superAdmin.cookie,
    )
    await env.DB.prepare('UPDATE core_user SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), subject.id)
      .run()
    expect(
      (await grantRole({ userId: subject.id, role: 'ADMIN' }, superAdmin.cookie))
        .body.data?.access.grantRole?.message,
    ).toBe('No user was found.')

    await env.DB.prepare(
      'UPDATE core_user SET deleted_at = NULL, email_verified_at = NULL WHERE id = ?',
    )
      .bind(subject.id)
      .run()
    expect(
      (await grantRole({ userId: subject.id, role: 'ADMIN' }, superAdmin.cookie))
        .body.data?.access.grantRole?.message,
    ).toBe('That user has not verified their email address yet.')

    // Soft-deleted identities stay readable so their history can be audited.
    await env.DB.prepare('UPDATE core_user SET deleted_at = ? WHERE id = ?')
      .bind(Date.now(), subject.id)
      .run()
    expect(
      (await managedUserById(subject.id, superAdmin.cookie))
        .body.data?.access.userById?.response,
    ).toMatchObject({ deleted: true, emailVerified: false })
  })

  it('leaves sessions to the existing deactivation paths after a revocation', async () => {
    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const superAdmin = await establishSuperAdmin(notificationLog)
    const subject = await registerManagedApplicant(
      'reviewer@example.com',
      notificationLog,
      superAdmin.cookie,
    )
    const granted = await grantRole(
      { userId: subject.id, role: 'ADMIN' },
      superAdmin.cookie,
    )
    const adminGrantId = activeGrantId(
      granted.body.data?.access.grantRole?.response ?? null,
      'ADMIN',
    )
    const signedIn = await signInAs('reviewer@example.com', DEFAULT_PASSWORD)
    const reviewerCookie = cookieHeaderFrom(signedIn.response)

    await revokeRole({ grantId: adminGrantId }, superAdmin.cookie)

    // Roles are joined live, so administrative access is refused immediately,
    // while the session itself survives because APPLICANT remains.
    const refused = await graphql<{
      admin: { intake: { queue: { success: boolean; message: string | null } } }
    }>(/* GraphQL */ `
      query { admin { intake { queue(input: { first: 5 }) { success message } } } }
    `, reviewerCookie)
    expect(refused.body.data?.admin.intake.queue).toMatchObject({
      success: false,
      message: 'You do not have permission to do that.',
    })
    const stillSignedIn = await graphql<CurrentSessionBody>(/* GraphQL */ `
      query { auth { currentSession { success response { user { roles } } } } }
    `, reviewerCookie)
    expect(stillSignedIn.body.data?.auth.currentSession.response)
      .toMatchObject({ user: { roles: ['APPLICANT'] } })

    // Losing the last remaining role is what destroys sessions, and that is
    // handled by the deactivation paths rather than by role administration.
    await revokeEveryRoleGrant()
    const deactivated = await graphql<CurrentSessionBody>(/* GraphQL */ `
      query { auth { currentSession { success response { user { roles } } } } }
    `, reviewerCookie)
    expect(deactivated.body.data?.auth.currentSession.response).toBeNull()
    // Presenting the cookie destroys every session that account holds. The
    // super administrator's own row survives until they make a request or the
    // scheduled sweep runs, which is what makes deactivation durable.
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session WHERE user_id = ?')
        .bind(subject.id)
        .first(),
    ).toEqual({ count: 0 })
    await runScheduledCleanup()
    expect(
      await env.DB.prepare('SELECT count(*)::int AS count FROM core_session').first(),
    ).toEqual({ count: 0 })
  })

  it('rejects more than one nested access mutation before execution', async () => {
    const { body } = await graphql<unknown>(/* GraphQL */ `
      mutation {
        access {
          grantRole(input: {
            userId: "00000000-0000-4000-8000-000000000000"
            role: ADMIN
            reason: "first"
            currentPassword: "x"
          }) { success }
          revokeRole(input: {
            grantId: "00000000-0000-4000-8000-000000000001"
            reason: "second"
            currentPassword: "x"
          }) { success }
        }
      }
    `)
    expect(body.data).toBeUndefined()
    expect(body.errors?.[0]?.message).toBe(
      'Only one field may be selected beneath mutation.access.',
    )
  })

  it('closes the whole namespace to anyone who is not a super administrator', async () => {
    const anonymous = await graphql<ManagedUserBody>(/* GraphQL */ `
      query { access { userByEmail(email: "applicant@example.com") { success message } } }
    `)
    expect(anonymous.body.data?.access.userByEmail).toMatchObject({
      success: false,
      message: 'Authentication is required.',
    })

    const notificationLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await registerApplicant('applicant@example.com', notificationLog)
    const applicantCookie = cookieHeaderFrom((await signInDefault()).response)
    const asApplicant = await managedUserById(crypto.randomUUID(), applicantCookie)
    expect(asApplicant.body.data?.access.userById?.message).toBe(
      'Authentication is required.',
    )

    /**
     * The mutations must refuse before they describe their subject.
     *
     * A caller who learns "no user was found" for one ID and "that role is
     * already active" for another has been handed an oracle for which user IDs
     * are real and which of them are administrators — which is exactly what
     * exact-match-only lookup exists to prevent. Every probe below must return
     * the same refusal.
     */
    const subject = await env.DB.prepare(
      `SELECT id FROM core_user WHERE email = 'applicant@example.com'`,
    ).first<{ id: string }>()
    if (!subject) throw new Error('Expected the registered applicant.')
    const probes = [
      { userId: subject.id, cookie: undefined },
      { userId: crypto.randomUUID(), cookie: undefined },
      { userId: subject.id, cookie: applicantCookie },
      { userId: 'not-a-uuid', cookie: applicantCookie },
    ]
    for (const probe of probes) {
      const attempt = await graphql<ManagedUserMutationBody>(/* GraphQL */ `
        mutation {
          access {
            grantRole(input: {
              userId: "${probe.userId}"
              role: ADMIN
              reason: "Probing for existing accounts"
              currentPassword: "${DEFAULT_PASSWORD}"
            }) { success message response { id } }
          }
        }
      `, probe.cookie)
      expect(attempt.body.data?.access.grantRole).toEqual({
        success: false,
        message: 'Authentication is required.',
        response: null,
      })
    }

    const revokeProbe = await revokeRole({ grantId: crypto.randomUUID() }, applicantCookie)
    expect(revokeProbe.body.data?.access.revokeRole).toMatchObject({
      success: false, message: 'Authentication is required.',
    })
  })
})

describe('limits on request size and shape', () => {
  it('refuses an oversized body before parsing it', async () => {
    // Far larger than the biggest legitimate request, which is a few kilobytes.
    const padding = 'x'.repeat(100_000)
    const response = await SELF.fetch('https://api.example.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.test' },
      body: JSON.stringify({ query: `query { __typename # ${padding}\n }` }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      success: false,
      message: 'The request is too large.',
      response: null,
    })
  })

  it('refuses a document that asks for the same work hundreds of times', async () => {
    /*
     * Every connection clamps `first` to 100, so no one list can be asked for a
     * million rows. Aliases are the way around that clamp — one modest field,
     * repeated — and it is refused at validation, before a resolver runs.
     */
    const aliases = Array.from(
      { length: 400 },
      (_, index) => `a${index}: health { name status }`,
    ).join(' ')
    const { body } = await graphql<unknown>(`query { ${aliases} }`)
    expect(body.errors?.[0]?.message).toMatch(/the limit is 500/u)
    expect(body.data).toBeFalsy()
  })

  it('lets an ordinary request through untouched', async () => {
    const { body } = await graphql<{ health: { status: string } }>(
      'query { health { name status } }',
    )
    expect(body.errors).toBeUndefined()
    expect(body.data?.health.status).toBeTruthy()
  })
})

describe('recovering and changing an account', () => {
  /** Signs somebody up for real and signs them in, returning both handles. */
  const account = async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const email = `account-${crypto.randomUUID()}@example.test`
    const signup = await startSignup(email, log)
    await verifySignup(signup.challengeToken, signup.otp)
    log.mockRestore()
    const signedIn = await signInAs(email, DEFAULT_PASSWORD)
    return { email, cookie: cookieHeaderFrom(signedIn.response) }
  }

  const startReset = async (email: string) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { body } = await graphql<{
      auth: {
        startPasswordReset: {
          success: boolean
          message: string | null
          response: { challengeToken: string; expiresAt: string } | null
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startPasswordReset(input: { email: "${email}" }) {
            success message response { challengeToken expiresAt }
          }
        }
      }
    `)
    const otp = log.mock.calls.some((call) => String(call[0]).startsWith('DEV_EMAIL '))
      ? extractOtp(log)
      : null
    log.mockRestore()
    return { result: body.data?.auth.startPasswordReset, otp }
  }

  const completeReset = async (challengeToken: string, otp: string, newPassword: string) => {
    const { body } = await graphql<{
      auth: { completePasswordReset: { success: boolean; message: string | null } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          completePasswordReset(input: {
            challengeToken: "${challengeToken}"
            otp: "${otp}"
            newPassword: "${newPassword}"
          }) { success message }
        }
      }
    `)
    return body.data?.auth.completePasswordReset
  }

  it('answers an unknown address exactly as it answers a real one', async () => {
    const person = await account()
    const real = await startReset(person.email)
    const nobody = await startReset(`ghost-${crypto.randomUUID()}@example.test`)

    /*
     * The whole enumeration defence. Same success, same message, and a token of
     * the same shape — the only difference is that one was stored and a code
     * sent. A response that differed here would turn a grants portal into a
     * membership oracle for its own applicant list.
     */
    expect(nobody.result?.success).toBe(real.result?.success)
    expect(nobody.result?.message).toBe(real.result?.message)
    expect(nobody.result?.response?.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    // The decoy is a real refusal underneath: no code was sent, and it works
    // against nothing.
    expect(nobody.otp).toBeNull()
    expect(real.otp).toMatch(/^\d{6}$/u)
  })

  /**
   * The same answer when the code could not be sent — which is the case that
   * broke the defence above.
   *
   * An unknown address returned the ordinary success; a known one whose
   * delivery failed returned *"The code could not be sent. Please try again."*
   * So anyone able to make delivery fail could ask this endpoint, one address
   * at a time, which of them hold accounts — the exact enumeration the neutral
   * response exists to prevent.
   *
   * The cost is accepted rather than hidden: somebody whose code genuinely
   * failed to send is told to check their email and nothing arrives. The
   * failure is still marked on the challenge and audited, so the office can
   * see what the caller cannot.
   */
  it('answers a failed delivery exactly as it answers an unknown address', async () => {
    const person = await account()
    const nobody = await startReset(`ghost-${crypto.randomUUID()}@example.test`)

    // The console transport is what a test environment delivers through, so
    // making it throw is a real delivery failure rather than a mocked one.
    const failing = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('the transport is down')
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { body } = await graphql<{
      auth: {
        startPasswordReset: {
          success: boolean
          message: string | null
          response: { challengeToken: string } | null
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startPasswordReset(input: { email: "${person.email}" }) {
            success message response { challengeToken }
          }
        }
      }
    `)
    failing.mockRestore()
    errorLog.mockRestore()

    const undelivered = body.data?.auth.startPasswordReset
    expect(undelivered?.success).toBe(nobody.result?.success)
    expect(undelivered?.message).toBe(nobody.result?.message)
    expect(undelivered?.response?.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    // The office can still see it, under its own action and as an outcome.
    const recorded = await env.DB.prepare(
      `SELECT count(*)::int AS count FROM core_audit_event
        WHERE action = ? AND outcome = 'FAILURE'`,
    ).bind(auditActions.passwordResetNotificationFailed).first<{ count: number }>()
    expect(recorded?.count).toBe(1)
  })

  it('resets a forgotten password and signs every device out', async () => {
    const person = await account()
    // A second device, so "every session" can be shown to mean every one.
    const second = await signInAs(person.email, DEFAULT_PASSWORD)
    const secondCookie = cookieHeaderFrom(second.response)

    const started = await startReset(person.email)
    const NEW_PASSWORD = 'a different correct horse'
    expect(await completeReset(started.result!.response!.challengeToken, started.otp!, NEW_PASSWORD))
      .toMatchObject({ success: true })

    // The old password is gone and the new one works.
    expect((await signInAs(person.email, DEFAULT_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(false)
    expect((await signInAs(person.email, NEW_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(true)

    /*
     * Both prior sessions are dead. A password that was forgotten cannot be
     * told apart from one that was taken, so leaving any session alive would
     * leave whoever took it signed in.
     */
    for (const cookie of [person.cookie, secondCookie]) {
      const { body } = await graphql<CurrentSessionBody>(
        /* GraphQL */ `query { auth { currentSession { success response { user { roles } } } } }`,
        cookie,
      )
      expect(body.data?.auth.currentSession.response).toBeNull()
    }
  })

  it('spends attempts on a wrong code and then refuses the right one', async () => {
    const person = await account()
    const started = await startReset(person.email)
    const token = started.result!.response!.challengeToken

    // Five attempts is the configured allowance; the sixth has nothing left.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await completeReset(token, '000000', 'a different correct horse'))
        .toMatchObject({ success: false })
    }
    // Exhausted, so even the genuine code no longer works — the challenge is
    // spent rather than the code being wrong.
    expect(await completeReset(token, started.otp!, 'a different correct horse'))
      .toMatchObject({ success: false })
    expect((await signInAs(person.email, DEFAULT_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(true)
  })

  it('refuses a reset password that is too short, without spending the code', async () => {
    const person = await account()
    const started = await startReset(person.email)
    const token = started.result!.response!.challengeToken

    expect(await completeReset(token, started.otp!, 'short')).toMatchObject({ success: false })
    // Validation runs before the challenge is read, so the code a person is
    // holding still works once they choose a longer password.
    expect(await completeReset(token, started.otp!, 'a different correct horse'))
      .toMatchObject({ success: true })
  })

  const changePassword = async (cookie: string, current: string, next: string) => {
    const { body } = await graphql<{
      auth: { changePassword: { success: boolean; message: string | null } }
    }>(/* GraphQL */ `
      mutation {
        auth {
          changePassword(input: {
            currentPassword: "${current}"
            newPassword: "${next}"
          }) { success message }
        }
      }
    `, cookie)
    return body.data?.auth.changePassword
  }

  it('changes a known password, keeping this session and ending the others', async () => {
    const person = await account()
    const second = await signInAs(person.email, DEFAULT_PASSWORD)
    const secondCookie = cookieHeaderFrom(second.response)

    const NEW_PASSWORD = 'another correct horse entirely'
    expect(await changePassword(person.cookie, DEFAULT_PASSWORD, NEW_PASSWORD))
      .toMatchObject({ success: true })

    // The person is holding this one, so it survives.
    const here = await graphql<CurrentSessionBody>(
      /* GraphQL */ `query { auth { currentSession { success response { user { roles } } } } }`,
      person.cookie,
    )
    expect(here.body.data?.auth.currentSession.response).not.toBeNull()

    // The other device does not.
    const elsewhere = await graphql<CurrentSessionBody>(
      /* GraphQL */ `query { auth { currentSession { success response { user { roles } } } } }`,
      secondCookie,
    )
    expect(elsewhere.body.data?.auth.currentSession.response).toBeNull()

    expect((await signInAs(person.email, NEW_PASSWORD)).body.data?.auth.signIn.success).toBe(true)
  })

  it('refuses a password change without the current password', async () => {
    const person = await account()
    expect(await changePassword(person.cookie, 'not the password', 'a long enough one'))
      .toMatchObject({ success: false, message: 'Your password is incorrect.' })
    // Nothing changed.
    expect((await signInAs(person.email, DEFAULT_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(true)
  })

  it('refuses every account change to a caller with no session', async () => {
    const person = await account()
    expect(await changePassword(undefined as unknown as string, DEFAULT_PASSWORD, 'a long one'))
      .toMatchObject({ success: false })

    const { body } = await graphql<{
      auth: { changeDisplayName: { success: boolean; message: string | null } }
    }>(/* GraphQL */ `
      mutation { auth { changeDisplayName(input: { displayName: "Nobody" }) { success message } } }
    `)
    expect(body.data?.auth.changeDisplayName.success).toBe(false)
    expect(person.email).toBeTruthy()
  })

  const startEmailChange = async (cookie: string, newEmail: string, password: string) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { body } = await graphql<{
      auth: {
        startEmailChange: {
          success: boolean
          message: string | null
          response: { challengeToken: string } | null
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          startEmailChange(input: {
            newEmail: "${newEmail}"
            currentPassword: "${password}"
          }) { success message response { challengeToken } }
        }
      }
    `, cookie)
    const sent = log.mock.calls.some((call) => String(call[0]).startsWith('DEV_EMAIL '))
    const otp = sent ? extractOtp(log) : null
    log.mockRestore()
    return { result: body.data?.auth.startEmailChange, otp }
  }

  const completeEmailChange = async (cookie: string, challengeToken: string, otp: string) => {
    const { body } = await graphql<{
      auth: {
        completeEmailChange: {
          success: boolean
          message: string | null
          response: { email: string } | null
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          completeEmailChange(input: {
            challengeToken: "${challengeToken}"
            otp: "${otp}"
          }) { success message response { email } }
        }
      }
    `, cookie)
    if (body.errors) throw new Error(JSON.stringify(body.errors))
    return body.data?.auth.completeEmailChange
  }

  it('moves an account to an address whose code was proved', async () => {
    const person = await account()
    const moved = `moved-${crypto.randomUUID()}@example.test`

    const started = await startEmailChange(person.cookie, moved, DEFAULT_PASSWORD)
    expect(started.result?.success).toBe(true)
    const done = await completeEmailChange(
      person.cookie, started.result!.response!.challengeToken, started.otp!,
    )
    expect(done?.response?.email).toBe(moved)

    // The new address signs in; the old one no longer names anybody.
    expect((await signInAs(moved, DEFAULT_PASSWORD)).body.data?.auth.signIn.success).toBe(true)
    expect((await signInAs(person.email, DEFAULT_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(false)
  })

  it('refuses an address already in use, and does not say that is why', async () => {
    const person = await account()
    const other = await account()

    const started = await startEmailChange(person.cookie, other.email, DEFAULT_PASSWORD)
    /*
     * Succeeds and says what a free address would say. Anything else lets a
     * signed-in person test addresses one at a time to learn who has an
     * account — the same oracle the reset flow refuses to be.
     */
    expect(started.result?.success).toBe(true)
    // No code was sent, so the token it handed back works against nothing.
    expect(started.otp).toBeNull()
    expect(await completeEmailChange(person.cookie, started.result!.response!.challengeToken, '123456'))
      .toMatchObject({ success: false })
    expect((await signInAs(person.email, DEFAULT_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(true)
  })

  /**
   * The address was free when the code went out and taken by the time it came
   * back.
   *
   * The controller has always had a sentence for this — *"That address is no
   * longer available"* — and it was unreachable. `core_user.email` is unique
   * and the write held no term about it, so the `UPDATE` raised `23505` and
   * the applicant got an unhandled error instead. The refusal was written and
   * the mechanism was not, which is the same species as the `EMAIL` and
   * `PHONE` rules that constrained nothing.
   */
  it('refuses an address claimed while the code was in flight', async () => {
    const person = await account()
    const wanted = `contested-${crypto.randomUUID()}@example.test`
    const started = await startEmailChange(person.cookie, wanted, DEFAULT_PASSWORD)
    expect(started.result?.success).toBe(true)
    expect(started.otp).not.toBeNull()

    // Somebody else takes it in the meantime.
    const rival = await account()
    await env.DB.prepare('UPDATE core_user SET email = ? WHERE email = ?')
      .bind(wanted, rival.email)
      .run()

    expect(await completeEmailChange(
      person.cookie, started.result!.response!.challengeToken, started.otp!,
    )).toMatchObject({
      success: false,
      message: 'That address is no longer available.',
    })
    // And they are still on the address they had.
    expect((await signInAs(person.email, DEFAULT_PASSWORD)).body.data?.auth.signIn.success)
      .toBe(true)
  })

  it('refuses a change of address without the current password', async () => {
    const person = await account()
    const started = await startEmailChange(
      person.cookie, `nope-${crypto.randomUUID()}@example.test`, 'wrong password',
    )
    expect(started.result).toMatchObject({
      success: false,
      message: 'Your password is incorrect.',
    })
    expect(started.otp).toBeNull()
  })

  it('refuses moving to the address already held', async () => {
    const person = await account()
    const started = await startEmailChange(person.cookie, person.email, DEFAULT_PASSWORD)
    expect(started.result).toMatchObject({ success: false })
  })

  it('will not let a reset code stand in for an email-change code', async () => {
    const person = await account()
    const reset = await startReset(person.email)
    /*
     * Purpose is part of the lookup, not a property of the row. Without that a
     * code mailed for one purpose would authorise the other, and the reset code
     * goes to the address somebody may have just lost control of.
     */
    expect(await completeEmailChange(
      person.cookie, reset.result!.response!.challengeToken, reset.otp!,
    )).toMatchObject({ success: false })
  })

  const setDisplayName = async (cookie: string, displayName: string) => {
    const { body } = await graphql<{
      auth: {
        changeDisplayName: {
          success: boolean
          response: { displayName: string | null } | null
        }
      }
    }>(/* GraphQL */ `
      mutation {
        auth {
          changeDisplayName(input: { displayName: "${displayName}" }) {
            success response { displayName }
          }
        }
      }
    `, cookie)
    return body.data?.auth.changeDisplayName
  }

  it('records a name, and tells an empty one from never having said', async () => {
    const person = await account()

    // Nobody has said yet.
    const before = await graphql<{
      auth: { currentSession: { response: { user: { displayName: string | null } } | null } }
    }>(/* GraphQL */ `
      query { auth { currentSession { response { user { displayName } } } } }
    `, person.cookie)
    expect(before.body.data?.auth.currentSession.response?.user.displayName).toBeNull()

    expect(await setDisplayName(person.cookie, 'Ada Lovelace'))
      .toMatchObject({ success: true, response: { displayName: 'Ada Lovelace' } })

    // Clearing it is a real choice and lands as null, not as an empty string.
    expect(await setDisplayName(person.cookie, '   '))
      .toMatchObject({ success: true, response: { displayName: null } })
  })

  it('works the same for staff, who never went through applicant signup screens', async () => {
    /*
     * Roles are grants, not a column, and the flows operate on `core_user` — so
     * "for all kinds of users" has to be shown rather than assumed. A super
     * administrator is the furthest thing from the applicant these were built
     * against.
     */
    const person = await account()
    const row = await env.DB.prepare('SELECT id FROM core_user WHERE email = ?')
      .bind(person.email).first<{ id: string }>()
    // A staff grant, alongside the APPLICANT one signup created. Capabilities
    // are the union of both, which is the ordinary shape for this programme.
    await env.DB.prepare(`INSERT INTO core_user_role_grant (
      id, user_id, role, granted_by_user_id, grant_reason, granted_at
    ) VALUES (?, ?, 'SUPER_ADMIN', NULL, 'TEST_STAFF', ?)`)
      .bind(crypto.randomUUID(), row!.id, Date.now()).run()

    const started = await startReset(person.email)
    expect(started.result?.success).toBe(true)
    expect(started.otp).toMatch(/^\d{6}$/u)

    const NEW_PASSWORD = 'staff correct horse battery'
    expect(await completeReset(
      started.result!.response!.challengeToken, started.otp!, NEW_PASSWORD,
    )).toMatchObject({ success: true })

    const signedIn = await signInAs(person.email, NEW_PASSWORD)
    expect(signedIn.body.data?.auth.signIn.success).toBe(true)

    // And an identity edit works for them too.
    expect(await setDisplayName(cookieHeaderFrom(signedIn.response), 'Programme Officer'))
      .toMatchObject({ success: true, response: { displayName: 'Programme Officer' } })
  })

  it('closes a challenge whose code could not be delivered', async () => {
    /*
     * A code that never arrived must not stay usable. The row is closed rather
     * than deleted, so the security history still shows that somebody asked and
     * that the message failed — which is what distinguishes a provider outage
     * from nobody having tried.
     */
    const person = await account()
    const started = await startReset(person.email)
    expect(started.result?.success).toBe(true)

    const row = await env.DB.prepare(
      `SELECT id FROM core_account_challenge WHERE purpose = 'PASSWORD_RESET'
         AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ id: string }>()

    await markAccountChallengeDeliveryFailed(
      activeDatabase(),
      row!.id,
      new Date(),
      testAuditEvent(
        auditActions.passwordResetNotificationFailed,
        'CORE_ACCOUNT_CHALLENGE',
        row!.id,
        'FAILURE',
      ),
    )

    const after = await env.DB.prepare(
      'SELECT status, invalidation_reason AS reason FROM core_account_challenge WHERE id = ?',
    ).bind(row!.id).first<{ status: string; reason: string }>()
    expect(after).toEqual({
      status: 'DELIVERY_FAILED',
      reason: 'NOTIFICATION_DELIVERY_FAILED',
    })

    // And the code it carried is spent, not merely unsent.
    expect(await completeReset(
      started.result!.response!.challengeToken, started.otp!, 'a different correct horse',
    )).toMatchObject({ success: false })
  })
})
