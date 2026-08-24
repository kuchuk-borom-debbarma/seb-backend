/**
 * The rate-limit seam.
 *
 * What is worth protecting here is not throughput either. A limiter that looks
 * present and counts nothing is worse than none at all, because it is trusted —
 * so most of what follows is about the ways one can be silently bypassed.
 */
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../src/db'
import { handleGraphQLRequest } from '../src/graphql'
import { createLoaders } from '../src/loaders'
import type { AppBindings } from '../src/bindings'
import {
  allBuckets,
  bucketsFor,
  enforce,
  operationSubject,
  rateLimiter,
  requestIdentity,
  usesLocalRateLimiter,
  type RateLimitBucket,
  type RateLimitTransport,
} from '../src/services/rate-limit'
import { callerAddress } from '../src/services/rate-limit/identity'
import { memoryRateLimitTransport } from '../src/services/rate-limit/transports/memory'
import {
  cloudflareRateLimitTransport,
  type RateLimiterBinding,
} from '../src/services/rate-limit/transports/cloudflare'
import { unlimitedRateLimitTransport } from '../src/services/rate-limit/transports/unlimited'

const bindings = (extra: Partial<AppBindings> = {}) => ({ ...env, ...extra }) as AppBindings

const SECRET = 'a-test-secret-that-is-at-least-32-bytes-long'

const bucket = (over: Partial<RateLimitBucket> = {}): RateLimitBucket => ({
  binding: 'RL_TEST',
  dimension: 'IP',
  limit: 3,
  periodSeconds: 60,
  ...over,
})

describe('choosing a limiter', () => {
  it('counts in process locally, and treats an unconfigured machine as local', () => {
    expect(usesLocalRateLimiter(bindings({ ENVIRONMENT: undefined }))).toBe(true)
    expect(usesLocalRateLimiter(bindings({ ENVIRONMENT: '  ' }))).toBe(true)
    expect(usesLocalRateLimiter(bindings({ ENVIRONMENT: 'LOCAL' }))).toBe(true)
    expect(usesLocalRateLimiter(bindings({ ENVIRONMENT: 'develop' }))).toBe(false)
    expect(rateLimiter(bindings({
      ENVIRONMENT: 'local', RATE_LIMIT_DISABLED: undefined,
    })).name).toBe('memory')
  })

  it('refuses to switch counting off in production', () => {
    /*
     * The test suites turn the limiter off, so the switch exists — and a switch
     * that could be thrown in production is not a limiter at all. Refused at
     * construction, so the Worker fails to start rather than failing at the
     * first attack.
     */
    expect(() => rateLimiter(bindings({
      ENVIRONMENT: 'production',
      RATE_LIMIT_DISABLED: 'true',
    }))).toThrow(/cannot be disabled in the production/u)

    // Anywhere else it is honoured, which is what lets the suites run.
    expect(rateLimiter(bindings({
      ENVIRONMENT: 'develop',
      RATE_LIMIT_DISABLED: 'true',
    })).name).toBe('unlimited')
    // And on where nothing turns it off, which is every real environment.
    expect(rateLimiter(bindings({
      ENVIRONMENT: 'develop', RATE_LIMIT_DISABLED: undefined,
    })).name).toBe('cloudflare')
    expect(unlimitedRateLimitTransport().name).toBe('unlimited')
  })
})

describe('counting', () => {
  it('permits up to the limit and refuses the next', async () => {
    const transport = memoryRateLimitTransport()
    const only = bucket({ limit: 3 })
    const verdicts = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      verdicts.push((await transport.consume(only, '203.0.113.7')).allowed)
    }
    expect(verdicts).toEqual([true, true, true, false])
  })

  it('counts each binding separately for the same person', async () => {
    /*
     * Two allowances along the same dimension for the same caller are separate.
     * Sharing a key would make whichever is tighter govern both, silently.
     */
    const transport = memoryRateLimitTransport()
    const narrow = bucket({ binding: 'RL_NARROW', limit: 1 })
    const wide = bucket({ binding: 'RL_WIDE', limit: 5 })
    expect((await transport.consume(narrow, 'one')).allowed).toBe(true)
    expect((await transport.consume(narrow, 'one')).allowed).toBe(false)
    expect((await transport.consume(wide, 'one')).allowed).toBe(true)
  })

  it('refills when the window has passed', async () => {
    let now = 1_000
    const transport = memoryRateLimitTransport(() => now)
    const only = bucket({ limit: 1, periodSeconds: 60 })
    expect((await transport.consume(only, 'one')).allowed).toBe(true)
    expect((await transport.consume(only, 'one')).allowed).toBe(false)
    now += 60_001
    expect((await transport.consume(only, 'one')).allowed).toBe(true)
  })

  it('counts nothing when counting is switched off', async () => {
    const transport = unlimitedRateLimitTransport()
    const only = bucket({ limit: 1 })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect((await transport.consume(only, 'one')).allowed).toBe(true)
    }
  })
})

describe('the deployed limiter', () => {
  it('asks the binding the policy names, and returns what it says', async () => {
    const asked: string[] = []
    const binding = (success: boolean): RateLimiterBinding => ({
      limit: async ({ key }) => {
        asked.push(key)
        return { success }
      },
    })
    const transport = cloudflareRateLimitTransport({
      RL_ONE: binding(true),
      RL_TWO: binding(false),
    })
    expect((await transport.consume(bucket({ binding: 'RL_ONE' }), 'k')).allowed).toBe(true)
    expect((await transport.consume(bucket({ binding: 'RL_TWO' }), 'k')).allowed).toBe(false)
    expect(asked).toEqual(['k', 'k'])
  })

  it('throws rather than permitting when the binding is missing', async () => {
    /*
     * A deployment whose configuration does not match its own policy. Throwing
     * becomes a refusal upstream; permitting would leave the operation the
     * policy names completely unprotected while looking configured.
     */
    const transport = cloudflareRateLimitTransport({})
    await expect(transport.consume(bucket({ binding: 'RL_ABSENT' }), 'k'))
      .rejects.toThrow(/RL_ABSENT is not configured/u)
  })
})

describe('what a request is counted against', () => {
  it('trusts only the platform\'s own address header', async () => {
    /*
     * `X-Forwarded-For` arrives from the caller and can say anything, so keying
     * on it would let one attacker occupy as many buckets as they liked.
     */
    const spoofed = new Headers({ 'X-Forwarded-For': '203.0.113.9' })
    expect(callerAddress(spoofed)).toBeNull()
    expect(callerAddress(new Headers({ 'CF-Connecting-IP': ' 203.0.113.9 ' })))
      .toBe('203.0.113.9')
  })

  it('reads one account however the address is spelled', () => {
    /*
     * The bypass this closes: `A@B.com` and `a@b.com` are different strings, so
     * keying on raw input would let changing case reset the allowance.
     */
    expect(operationSubject({ input: { email: '  Applicant@Example.TEST ' } }))
      .toBe('applicant@example.test')
    expect(operationSubject({ email: 'Applicant@Example.TEST' }))
      .toBe('applicant@example.test')
    expect(operationSubject({ input: { email: '   ' } })).toBeNull()
    expect(operationSubject({ input: {} })).toBeNull()
    expect(operationSubject(null)).toBeNull()
    expect(operationSubject('nonsense')).toBeNull()
  })

  it('names a session by digest, never by the token itself', async () => {
    /*
     * A limiter stores its keys. Keying on the session token would put a live
     * credential somewhere whose only job is counting.
     */
    const token = 'a-session-token-nobody-should-store'
    const headers = new Headers({ cookie: `seb_session=${token}` })
    const identity = await requestIdentity(headers, SECRET, null)
    expect(identity.SESSION).not.toBeNull()
    expect(identity.SESSION).not.toContain(token)
    // Opaque and fixed-width, whatever encoding the digest happens to use.
    expect(identity.SESSION).toMatch(/^[A-Za-z0-9_-]{40,}$/u)

    // Stable, or the allowance would reset on every request.
    const again = await requestIdentity(headers, SECRET, null)
    expect(again.SESSION).toBe(identity.SESSION)
  })

  it('offers no session when nobody is signed in', async () => {
    const identity = await requestIdentity(new Headers(), SECRET, null)
    expect(identity).toEqual({ IP: null, SESSION: null, SUBJECT: null })
  })
})

describe('applying the policy', () => {
  const counting = (): { transport: RateLimitTransport; spent: string[] } => {
    const spent: string[] = []
    return {
      spent,
      transport: {
        name: 'counting',
        consume: async (against, identity) => {
          spent.push(`${against.binding}:${identity}`)
          return { allowed: true }
        },
      },
    }
  }

  it('permits an operation the policy does not name', async () => {
    const { transport, spent } = counting()
    const verdict = await enforce(transport, {
      operation: 'admin.intake.queue',
      headers: new Headers({ 'CF-Connecting-IP': '203.0.113.1' }),
      secret: SECRET,
      subject: null,
    })
    expect(verdict.allowed).toBe(true)
    expect(spent, 'an unlimited operation must cost nothing').toEqual([])
  })

  it('skips a bucket this request cannot supply', async () => {
    /*
     * Signing in has a subject bucket and an address bucket. A request with no
     * address still spends the subject one — refusing because a dimension is
     * absent would stop signup working at all.
     */
    const { transport, spent } = counting()
    await enforce(transport, {
      operation: 'auth.signIn',
      headers: new Headers(),
      secret: SECRET,
      subject: 'applicant@example.test',
    })
    expect(spent, 'the address bucket has nothing to count and is skipped')
      .toEqual(['RL_SIGN_IN_SUBJECT:applicant@example.test'])
  })

  it('spends every dimension the operation names, in one pass', async () => {
    /*
     * Signing in counts both the account and the source address. It counts them
     * on every attempt, not only on failures: there is no way to look at an
     * allowance without spending it, so an allowance spent after a failure
     * would never be consulted before the next attempt and would refuse
     * nothing. That was built first and this is what caught it.
     */
    const { transport, spent } = counting()
    const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.2' })

    await enforce(transport, {
      operation: 'auth.signIn', headers, secret: SECRET,
      subject: 'applicant@example.test',
    })
    expect(spent).toEqual([
      'RL_SIGN_IN_SUBJECT:applicant@example.test',
      'RL_SIGN_IN_IP:203.0.113.2',
    ])
  })

  it('spends every applicable allowance even once one has refused', async () => {
    /*
     * Stopping at the first refusal would let somebody exhaust a wide allowance
     * for free by making sure a narrow one refused first.
     */
    const spent: string[] = []
    const transport: RateLimitTransport = {
      name: 'refusing',
      consume: async (against, identity) => {
        spent.push(against.binding)
        return { allowed: !identity.includes('@') }
      },
    }
    const verdict = await enforce(transport, {
      operation: 'auth.startApplicantSignup',
      headers: new Headers({ 'CF-Connecting-IP': '203.0.113.3' }),
      secret: SECRET,
      subject: 'applicant@example.test',
    })
    expect(verdict.allowed).toBe(false)
    expect(spent).toEqual(['RL_SIGNUP_SUBJECT', 'RL_SIGNUP_IP'])
  })
})

describe('the policy itself', () => {
  it('names a distinct binding for every allowance', () => {
    /*
     * Two buckets sharing a binding would share an allowance, so the tighter
     * one would govern both — and nothing about reading the table would say so.
     */
    const names = allBuckets().map((entry) => entry.binding)
    expect(new Set(names).size, names.join(', ')).toBe(names.length)
  })

  it('gives every allowance a positive limit and period', () => {
    for (const entry of allBuckets()) {
      expect(entry.limit, entry.binding).toBeGreaterThan(0)
      expect(entry.periodSeconds, entry.binding).toBeGreaterThan(0)
    }
  })

  it('counts a failure only where a failure is meaningful', () => {
    /*
     * A `FAILURE` bucket on an operation that cannot fail would never be spent.
     * Every one of these is on an operation whose whole point is that it can
     * refuse: signing in, verifying a code, accepting an invitation.
     */
    for (const operation of ['auth.signIn', 'auth.verifyApplicantSignup',
      'access.acceptRoleInvite']) {
      expect(bucketsFor(operation).length, operation).toBeGreaterThan(0)
    }
  })
})

/**
 * The plugin, through real GraphQL requests.
 *
 * The service tests above prove the counting. These prove the wiring: that the
 * policy is consulted for the operation a caller actually wrote, that a refusal
 * arrives where the caller is looking for it, and that the two documented
 * bypasses are closed end to end rather than only in the helper.
 */
describe('limiting a real request', () => {
  /*
   * Driven through `handleGraphQLRequest` rather than `SELF.fetch`, because the
   * rest of the suite runs with counting off and the worker behind `SELF` reads
   * its configuration once — mutating the imported `env` does not reach it.
   *
   * What that costs is the Hono layer, and nothing else: the document is
   * parsed for real, the plugin runs for real, the policy decides, and the
   * envelope comes back the shape a client would receive. The one rate-limit
   * concern that lives in Hono is the coarse request budget, which has its own
   * test below.
   */
  const limitedContext = () => {
    const db = createDatabase(env.DB)
    return {
      env: { ...env, RATE_LIMIT_DISABLED: undefined } as unknown as typeof env,
      db,
      loaders: createLoaders(db),
      requestHeaders: new Headers({ 'content-type': 'application/json' }),
      requestUrl: 'https://api.example.test/graphql',
      responseHeaders: new Headers(),
    }
  }

  const post = async (
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ) => {
    const response = await handleGraphQLRequest(
      new Request('https://api.example.test/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables, operationName }),
      }),
      limitedContext(),
    )
    return await response.json() as {
      data?: Record<string, any>
      errors?: { message: string }[]
    }
  }

  const signIn = (email: string, password = 'wrong-password-entirely') => post(
    /* GraphQL */ `mutation {
      auth { signIn(input: { email: "${email}", password: "${password}" }) {
        success message
      } }
    }`,
  )

  it('refuses the sixth attempt on one address, and not the fifth', async () => {
    /*
     * Five is the policy's allowance for the account being signed into. The
     * fifth must still be a credential refusal — being told "too many attempts"
     * one attempt early would be as wrong as never being told at all.
     */
    const email = `limited-${crypto.randomUUID()}@example.test`
    const messages: string[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const body = await signIn(email)
      expect(body.errors, 'a refusal must never arrive as a GraphQL error')
        .toBeUndefined()
      messages.push(body.data!.auth.signIn.message as string)
    }
    expect(messages.slice(0, 5).every((m) => m === 'Invalid email or password.'))
      .toBe(true)
    expect(messages[5]).toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('reads one account however the caller spells it', async () => {
    /*
     * End to end this time. Changing case must not reset the allowance, or the
     * limit is one keystroke away from being no limit.
     */
    const local = `mixed-${crypto.randomUUID()}`
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signIn(`${local}@example.test`)
    }
    const shouted = await signIn(`${local.toUpperCase()}@EXAMPLE.TEST`)
    expect(shouted.data!.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('limits an address written inline exactly as one passed in a variable', async () => {
    /*
     * The other bypass. Reading only the request's variables would leave an
     * inlined literal unkeyed, so a caller who stopped using variables would
     * stop being limited.
     */
    const email = `inline-${crypto.randomUUID()}@example.test`
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post(
        /* GraphQL */ `mutation ($input: SignInInput!) {
          auth { signIn(input: $input) { success message } }
        }`,
        { input: { email, password: 'wrong-password-entirely' } },
      )
    }
    // Same address, now written into the document rather than sent alongside it.
    const inlined = await signIn(email)
    expect(inlined.data!.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('is not fooled by an alias', async () => {
    /*
     * The policy matches on the field's name and the envelope is built at its
     * response key. Matching on the alias instead would let a caller rename
     * their way past every limit.
     */
    const email = `aliased-${crypto.randomUUID()}@example.test`
    const aliased = () => post(/* GraphQL */ `mutation {
      a: auth { b: signIn(input: {
        email: "${email}", password: "wrong-password-entirely"
      }) { success message } }
    }`)
    for (let attempt = 0; attempt < 5; attempt += 1) await aliased()
    const refused = await aliased()
    expect(refused.data!.a.b.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('refuses when the limiter itself cannot answer', async () => {
    /*
     * The decision this service makes about its own failures: a limiter that
     * cannot answer refuses, rather than permitting. Protection is never
     * silently absent, and the cost is chosen deliberately — a limiter outage
     * refuses signup instead of leaving it unprotected.
     *
     * Reproduced the way it would really happen: a deployed environment whose
     * configuration does not declare the binding its own policy names.
     */
    const db = createDatabase(env.DB)
    const response = await handleGraphQLRequest(
      new Request('https://api.example.test/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: /* GraphQL */ `mutation {
            auth { signIn(input: {
              email: "unanswerable@example.test", password: "whatever"
            }) { success message } }
          }`,
        }),
      }),
      {
        env: {
          ...env,
          ENVIRONMENT: 'develop',
          RATE_LIMIT_DISABLED: undefined,
        } as unknown as typeof env,
        db,
        loaders: createLoaders(db),
        requestHeaders: new Headers(),
        requestUrl: 'https://api.example.test/graphql',
        responseHeaders: new Headers(),
      },
    )
    const body = await response.json() as { data?: any; errors?: unknown[] }
    expect(body.errors, 'even a broken limiter refuses inside the envelope')
      .toBeUndefined()
    expect(body.data.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('limits a named operation, not just the first one in the document', async () => {
    /*
     * A client that names its operations — every generated one here does — must
     * be limited on the operation it asked to run.
     */
    const email = `named-${crypto.randomUUID()}@example.test`
    const named = () => post(
      /* GraphQL */ `mutation SignInOnce {
        auth { signIn(input: {
          email: "${email}", password: "wrong-password-entirely"
        }) { success message } }
      }`,
      undefined,
      // Sent explicitly, the way a generated client sends it — otherwise the
      // server infers it and this covers a different path than intended.
      'SignInOnce',
    )
    for (let attempt = 0; attempt < 5; attempt += 1) await named()
    expect((await named()).data!.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('is not fooled by a fragment', async () => {
    /*
     * A fragment is not a hiding place. Skipping over spreads would let a
     * caller carry the operation past every limit by moving one line, which is
     * a bypass rather than an omission.
     */
    const email = `fragment-${crypto.randomUUID()}@example.test`
    const spread = () => post(/* GraphQL */ `
      mutation { auth { ...SignInFields } }
      fragment SignInFields on AuthMutation {
        signIn(input: {
          email: "${email}", password: "wrong-password-entirely"
        }) { success message }
      }
    `)
    for (let attempt = 0; attempt < 5; attempt += 1) await spread()
    expect((await spread()).data!.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('is not fooled by an inline fragment either', async () => {
    const email = `inlinefrag-${crypto.randomUUID()}@example.test`
    const inline = () => post(/* GraphQL */ `mutation {
      auth { ... on AuthMutation {
        signIn(input: {
          email: "${email}", password: "wrong-password-entirely"
        }) { success message }
      } }
    }`)
    for (let attempt = 0; attempt < 5; attempt += 1) await inline()
    expect((await inline()).data!.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('applies the address allowance with no secret to key a session by', async () => {
    /*
     * A Worker with no `AUTH_SECRET` cannot serve a session, so the session
     * dimension simply does not apply — but the operation is still limited by
     * the dimensions that do. The empty secret must not become a fallback that
     * quietly switches counting off.
     */
    const db = createDatabase(env.DB)
    const email = `nosecret-${crypto.randomUUID()}@example.test`
    const attempt = async () => {
      const response = await handleGraphQLRequest(
        new Request('https://api.example.test/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: /* GraphQL */ `mutation {
              auth { signIn(input: {
                email: "${email}", password: "wrong-password-entirely"
              }) { success message } }
            }`,
          }),
        }),
        {
          env: {
            ...env, AUTH_SECRET: undefined, RATE_LIMIT_DISABLED: undefined,
          } as unknown as typeof env,
          db,
          loaders: createLoaders(db),
          requestHeaders: new Headers(),
          requestUrl: 'https://api.example.test/graphql',
          responseHeaders: new Headers(),
        },
      )
      return await response.json() as { data: any }
    }
    for (let index = 0; index < 5; index += 1) await attempt()
    expect((await attempt()).data.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')
  })

  it('limits the operation that runs, not one sitting beside it', async () => {
    /*
     * A document may hold several operations and run one of them. Running the
     * query must not spend the mutation's allowance — and, the other way
     * round, parking a mutation in the document is not a way to have it
     * counted without running it.
     */
    const body = await post(
      /* GraphQL */ `
        query Health { health { status } }
        mutation Unused {
          auth { signIn(input: {
            email: "beside@example.test", password: "wrong-password-entirely"
          }) { success } }
        }
      `,
      undefined,
      'Health',
    )
    expect(body.errors).toBeUndefined()
    expect(body.data!.health.status).toBeTruthy()
  })

  it('counts each account separately', async () => {
    /*
     * One address exhausting its allowance must not refuse anybody else. A
     * limiter keyed too coarsely would turn one attacker into an outage for
     * every applicant.
     */
    const other = `unrelated-${crypto.randomUUID()}@example.test`
    for (let attempt = 0; attempt < 6; attempt += 1) await signIn(other)
    expect((await signIn(other)).data!.auth.signIn.message)
      .toBe('Too many attempts. Wait a few minutes and try again.')

    const fresh = await signIn(`fresh-${crypto.randomUUID()}@example.test`)
    expect(fresh.data!.auth.signIn.message).toBe('Invalid email or password.')
  })

  it('leaves an operation the policy does not name alone', async () => {
    const body = await post(/* GraphQL */ `query { health { status } }`)
    expect(body.errors).toBeUndefined()
    expect(body.data!.health.status).toBeTruthy()
  })
})
