/**
 * The audit vocabulary, checked as a whole.
 *
 * The compiler already proves that every declared action has a spec, that every
 * payload key has a label, and that a call site passes its action's payload.
 * What it cannot prove is what the specs *say*: that each example is a payload
 * the schema accepts, that a schema refuses what it does not declare, that a
 * summary can be written, and that the credential paths — which record no
 * request labels because their caller is nobody yet — carry no caller text in
 * the payload either. Those are checked here, once per action, so an action
 * added tomorrow is covered without anybody writing a test for it.
 */
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { auditEventRow } from '../../src/services/audit-event'
import { auditActionsIn, auditCategoryOf, auditSpecOf, auditVocabulary } from '../../src/services/audit-vocabulary'
import { auditEmail, auditReason } from '../../src/services/audit-vocabulary/fields'
import { auditCategories, auditDetailKinds, type AuditSpec } from '../../src/services/audit-vocabulary/types'
import { auditCsv, csvCell } from '../../src/services/audit/csv'
import { humanize, presentAuditEvent, referencesWanted } from '../../src/services/audit/present'
import type { AuditRow, ReferenceNames } from '../../src/services/audit/queries/audit'

const specs = Object.entries(auditVocabulary) as [string, AuditSpec][]
const noNames = (): ReferenceNames => ({
  USER: new Map(), ROLE: new Map(), APPLICATION: new Map(), ENTERPRISE: new Map(), CYCLE: new Map(),
})

describe('every declared action', () => {
  it('is here once per catalogue action', () => {
    // The catalogue has 71 actions; a spec per action is what makes the
    // history readable for all of them.
    expect(specs).toHaveLength(71)
  })

  it.each(specs)('%s has an example its own schema accepts', (_action, spec) => {
    expect(spec.payload.safeParse(spec.example).success).toBe(true)
  })

  it.each(specs)('%s refuses a key it does not declare', (_action, spec) => {
    // Strict, so a call site cannot smuggle an extra field into the history.
    expect(spec.payload.safeParse({ ...spec.example, undeclared: 'x' }).success).toBe(false)
  })

  it.each(specs)('%s writes a summary and labels every key it carries', (_action, spec) => {
    const summary = spec.summary(spec.example as never, (kind, id) => `${kind}:${id}`)
    expect(summary.trim().length).toBeGreaterThan(0)
    for (const key of Object.keys(spec.example as object)) {
      expect(spec.fields[key as keyof typeof spec.fields], key).toBeDefined()
    }
  })

  it.each(specs.filter(([, spec]) => spec.callerTextFree))(
    '%s, written without request labels, carries no free caller text either',
    (_action, spec) => {
      const kinds = Object.values(spec.fields).map((field) => (field as { kind: string }).kind)
      expect(kinds).not.toContain('TEXT')
      expect(kinds).not.toContain('FILTERS')
    },
  )

  it('shares one schema between actions a call site chooses between', () => {
    // A ternary picking between two actions is typed against their union; it is
    // only checked against the one it writes if both are the same schema.
    for (const [first, second] of [
      ['RBAC.ROLE_GRANTED', 'RBAC.ROLE_REVOKED'],
      ['SEB.APPLICATION_SUBMITTED', 'SEB.APPLICATION_RESUBMITTED'],
      ['SEB.APPLICATION_DELETED', 'SEB.APPLICATION_RESTORED'],
      ['SEB.DOCUMENT_DELETED', 'SEB.DOCUMENT_RESTORED'],
      ['SEB.ENTERPRISE_DELETED', 'SEB.ENTERPRISE_RESTORED'],
      ['SEB.CYCLE_OPENED', 'SEB.CYCLE_CLOSED'],
      ['SEB.CYCLE_CLOSED', 'SEB.CYCLE_ARCHIVED'],
      ['AUTH.PASSWORD_RESET_REQUESTED', 'USER.EMAIL_CHANGE_REQUESTED'],
    ] as const) {
      expect(auditVocabulary[first].payload, `${first} / ${second}`).toBe(auditVocabulary[second].payload)
    }
  })

  it('agrees with the schema about its categories and detail kinds', () => {
    const sdl = readFileSync('src/graphql/queries/audit/audit.graphql', 'utf8')
    const enumValues = (name: string) => {
      const body = sdl.slice(sdl.indexOf(`enum ${name} {`), sdl.indexOf('}', sdl.indexOf(`enum ${name} {`)))
      return [...body.matchAll(/^\s+([A-Z_]+)$/gmu)].map((match) => match[1])
    }
    expect(enumValues('AuditCategory')).toEqual([...auditCategories])
    expect(enumValues('AuditDetailKind')).toEqual([...auditDetailKinds])
  })
})

describe('reading an action name', () => {
  it('finds a declared action, and calls anything else OTHER', () => {
    expect(auditSpecOf('RBAC.ROLE_CREATED')?.label).toBe('Composed a role')
    expect(auditSpecOf('LEGACY.GONE')).toBeUndefined()
    expect(auditCategoryOf('LEGACY.GONE')).toBe('OTHER')
    expect(auditActionsIn(['AUDIT'])).toEqual(['AUDIT.EXPORTED'])
  })

  it('makes a readable label from a code', () => {
    expect(humanize('SEB.DECISION_RECORDED')).toBe('Decision recorded')
    expect(humanize('subjectUserId')).toBe('Subject user id')
  })
})

describe('bounding what a row may carry', () => {
  it('bounds a reason, and says so when it cut one', () => {
    expect(auditReason('  two   spaces\n')).toBe('two spaces')
    const long = auditReason('x'.repeat(600))
    expect(long).toHaveLength(500)
    expect(long.endsWith('…')).toBe(true)
  })

  it('stores an address only once it parses as one', () => {
    expect(auditEmail('  Person@Example.IN ')).toBe('person@example.in')
    expect(auditEmail('=cmd|/c calc')).toBeUndefined()
  })
})

describe('building a row', () => {
  const context = (headers: Record<string, string> = {}) => ({ requestHeaders: new Headers(headers) })
  const dialect = new PgDialect()

  it('refuses to drop request labels for an action that could carry caller text', () => {
    expect(() => auditEventRow(context(), {
      action: 'RBAC.ROLE_CREATED',
      entityType: 'CORE_ROLE',
      payload: { roleKey: 'X', roleName: 'X' },
      includeRequestMetadata: false,
    })).toThrow('RBAC.ROLE_CREATED may carry caller text')
  })

  it('names the keys a bad payload got wrong, and never the values', () => {
    const attempt = () => auditEventRow(context(), {
      action: 'RBAC.ROLE_RETIRED',
      entityType: 'CORE_ROLE',
      payload: { roleKey: 'X', reason: 'secret-looking text'.repeat(40) },
    })
    expect(attempt).toThrow(/at: reason\./u)
    expect(attempt).not.toThrow(/secret-looking/u)
    // Not an object at all: the whole payload is what is wrong.
    expect(() => auditEventRow(context(), {
      action: 'RBAC.ROLE_RETIRED', entityType: 'CORE_ROLE', payload: null as never,
    })).toThrow('at: (payload).')
  })

  it('takes the request id from Cloudflare first, and the caller second', () => {
    const payload = { roleKey: 'X', roleName: 'X' }
    const input = { action: 'RBAC.ROLE_CREATED', entityType: 'CORE_ROLE', payload } as const
    expect(auditEventRow(context({ 'CF-Ray': 'ray', 'X-Request-ID': 'mine' }), input).requestId).toBe('ray')
    expect(auditEventRow(context({ 'X-Request-ID': 'mine' }), input).requestId).toBe('mine')
    // Opted out: nothing the caller sent is kept.
    const quiet = auditEventRow(context({ 'X-Request-ID': 'mine', 'User-Agent': 'ua' }), {
      action: 'USER.PASSWORD_CHANGED', entityType: 'CORE_USER', entityId: 'u', payload: {}, includeRequestMetadata: false,
    })
    expect([quiet.requestId, quiet.userAgent, quiet.ipAddress]).toEqual([null, null, null])
  })

  it('finds the subject by each rule its action declares', () => {
    // ACTOR: the applicant saving their own draft.
    expect(auditEventRow(context(), {
      action: 'SEB.APPLICATION_SAVED', entityType: 'SEB_APPLICATION', entityId: 'a', actorUserId: 'me',
      applicationId: 'a', payload: { version: 2 },
    }).subjectUserId).toBe('me')
    // A system act has no actor, so nobody is its subject by that rule.
    expect(auditEventRow(context(), {
      action: 'SEB.APPLICATION_SAVED', entityType: 'SEB_APPLICATION', entityId: 'a',
      applicationId: 'a', payload: { version: 2 },
    }).subjectUserId).toBeNull()
    // ENTITY: the account itself.
    expect(auditEventRow(context(), {
      action: 'USER.PASSWORD_CHANGED', entityType: 'CORE_USER', entityId: 'them', actorUserId: 'them', payload: {},
    }).subjectUserId).toBe('them')
    // NONE: a role belongs to nobody.
    expect(auditEventRow(context(), {
      action: 'RBAC.ROLE_CREATED', entityType: 'CORE_ROLE', payload: { roleKey: 'X', roleName: 'X' },
    }).subjectUserId).toBeNull()
    // A person named in the payload: the holder of a grant, not the granter.
    expect(auditEventRow(context(), {
      action: 'RBAC.ROLE_GRANTED', entityType: 'CORE_USER_ROLE_GRANT', actorUserId: 'officer',
      payload: { subjectUserId: 'holder', role: 'X', via: 'DIRECT' },
    }).subjectUserId).toBe('holder')
    // APPLICANT: resolved inside the insert, from the application it names.
    const onFile = auditEventRow(context(), {
      action: 'SEB.REVISION_CANCELLED', entityType: 'SEB_APPLICATION', entityId: 'a', actorUserId: 'officer',
      applicationId: 'a', payload: { revisionRequestId: 'r', reason: 'Asked for the wrong stage.' },
    })
    expect(dialect.sqlToQuery(sql`${onFile.subjectUserId}`).sql).toContain('applicant_user_id')
    // No application, no applicant — never a subselect that finds nobody.
    expect(auditEventRow(context(), {
      action: 'SEB.REVISION_CANCELLED', entityType: 'SEB_APPLICATION',
      payload: { revisionRequestId: 'r', reason: 'Asked for the wrong stage.' },
    } as never).subjectUserId).toBeNull()
  })
})

describe('writing a file', () => {
  it('neutralizes every character a spreadsheet would start a formula with', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${start}1+1`).replace(/^"/u, '').startsWith(`'${start}`), JSON.stringify(start)).toBe(true)
    }
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell(null)).toBe('')
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
  })
})

describe('showing what a row recorded', () => {
  const row = (overrides: Partial<AuditRow>): AuditRow => ({
    id: 'e', action: 'RBAC.ROLE_CREATED', entityType: 'CORE_ROLE', entityId: 'r', outcome: 'SUCCESS',
    requestId: null, ipAddress: null, userAgent: null, metadataJson: null, payload: null, payloadVersion: 0,
    applicationId: null, createdAt: new Date(0), actor: null, subject: null, ...overrides,
  })

  it('shows a typed payload that no longer fits its schema as recorded, not as the new shape', () => {
    const event = presentAuditEvent(row({ payloadVersion: 1, payload: { roleKey: 'X' } }), noNames())
    expect(event.detailed).toBe(false)
    expect(event.details).toEqual([{ key: 'roleKey', label: 'Role key', kind: 'TEXT', value: 'X', reference: null }])
  })

  it('shows legacy text that is not an object, or not JSON, as one recorded value', () => {
    expect(presentAuditEvent(row({ metadataJson: 'not json' }), noNames()).details)
      .toEqual([{ key: 'recorded', label: 'Recorded', kind: 'TEXT', value: 'not json', reference: null }])
    expect(presentAuditEvent(row({ metadataJson: '[1,2]' }), noNames()).details)
      .toEqual([{ key: 'recorded', label: 'Recorded', kind: 'TEXT', value: '[1,2]', reference: null }])
    expect(presentAuditEvent(row({}), noNames()).details).toEqual([])
  })

  it('names a built-in role without reading, and an unknown action by its code', () => {
    const granted = row({
      action: 'RBAC.ROLE_GRANTED', payloadVersion: 1,
      payload: { subjectUserId: 'gone', role: 'SUPER_ADMIN', via: 'BOOTSTRAP' },
    })
    expect(referencesWanted([granted]).ROLE.size).toBe(0)
    const event = presentAuditEvent(granted, noNames())
    expect(event.summary).toBe('Gave an unknown person the role Super administrator by the first-administrator bootstrap')
    expect(presentAuditEvent(row({ action: 'LEGACY.THING' }), noNames())).toMatchObject({
      category: 'OTHER', actionLabel: 'Thing', summary: 'Thing',
    })
  })

  it('writes the same rows into a file, one line each', () => {
    const csv = auditCsv([presentAuditEvent(row({ metadataJson: '{"a":1}' }), noNames())])
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2)
  })
})
