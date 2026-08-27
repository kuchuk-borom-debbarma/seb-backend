import { env } from '../support/worker'
import { buildSchema, parse, validate } from 'graphql'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  documentCostRule,
  singleAuthMutationRule,
  singleSebMutationRule,
} from '../../src/graphql/validation'
import { decodeCursor, encodeCursor, pageSize } from '../../src/services/application/pagination'
import type {
  ApplicationOperationContext,
  ApplicationSnapshot,
  EnterpriseProfileInput,
} from '../../src/services/application/types'
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  createDocumentObjectKey,
  extensionMatchesContentType,
  sanitizeFilename,
  validSha256Base64,
  verifyUploadedObject,
} from '../../src/services/application/uploads'
import { storage } from '../../src/services/storage'
import {
  addUtcCalendarMonths,
  fullUtcCalendarMonths,
  normalizeEnterpriseProfile,
  parseDateOnly,
} from '../../src/services/application/validation'

import {
  activeDatabase,
  closeDatabase,
  freshDatabase,
  resetDatabase,
} from '../support/harness'

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




// Says it is deployed, because signing is what a deployed environment does.
// Locally the bytes come to the Worker and nothing is signed.
const signingBackend = (extra: Partial<typeof env> = {}) =>
  storage(
    { ...env, ENVIRONMENT: 'develop', ...extra } as typeof env,
    'https://api.example.test/graphql',
  )

const digest = async (bytes: Uint8Array) => {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const value = await crypto.subtle.digest('SHA-256', input)
  return {
    buffer: value,
    base64: btoa(String.fromCharCode(...new Uint8Array(value))),
  }
}

describe('application cursors and private upload helpers', () => {
  it('enforces pagination bounds and round-trips opaque cursors', () => {
    expect(pageSize(undefined)).toBe(20)
    expect(pageSize(1)).toBe(1)
    expect(pageSize(100)).toBe(100)
    expect(pageSize(0)).toBeNull()
    expect(pageSize(101)).toBeNull()
    const date = new Date('2026-08-22T10:20:30Z')
    const cursor = encodeCursor('updatedAt', date, 'public-id')
    expect(decodeCursor(cursor, 'updatedAt')).toEqual({ timestamp: date, id: 'public-id' })

    /*
     * A cursor belongs to the ordering that produced it. The administrative
     * queue seeks on any of three columns, and one taken under a different
     * ordering used to be accepted and seeked against the wrong column — a
     * wrong page of results, reported as success.
     */
    expect(decodeCursor(cursor, 'submittedAt')).toBe('INVALID')
    expect(decodeCursor(cursor, 'statusChangedAt')).toBe('INVALID')

    expect(decodeCursor('not-base64', 'updatedAt')).toBe('INVALID')
    expect(decodeCursor(btoa(JSON.stringify(['updatedAt'])), 'updatedAt')).toBe('INVALID')
    expect(
      decodeCursor(btoa(JSON.stringify(['updatedAt', 8_640_000_000_000_001, 'id'])), 'updatedAt'),
    ).toBe('INVALID')
    expect(decodeCursor(btoa(JSON.stringify(['updatedAt', Date.now(), ''])), 'updatedAt')).toBe(
      'INVALID',
    )
  })

  it('counts custom SEB mutations safely even for incomplete fragment documents', () => {
    const schema = buildSchema(`type Query { ok: Boolean } type Mutation { seb: Boolean }`)
    const missingFragment = validate(
      schema,
      parse('mutation { seb ...Missing }'),
      [singleSebMutationRule],
    )
    expect(missingFragment).toEqual([])
    const missingSelectionSet = validate(
      schema,
      parse('mutation { seb }'),
      [singleSebMutationRule],
    )
    expect(missingSelectionSet).toEqual([])
  })

  it('does not count GraphQL __typename meta-fields as business mutations', () => {
    const schema = buildSchema(`
      type Query { ok: Boolean }
      type Mutation { auth: AuthMutation!, seb: SebMutation! }
      type AuthMutation { signOut: Boolean }
      type SebMutation { enterprise: EnterpriseMutation! }
      type EnterpriseMutation { restore: Boolean }
    `)
    expect(validate(
      schema,
      parse('mutation { auth { __typename signOut } }'),
      [singleAuthMutationRule],
    )).toEqual([])
    expect(validate(
      schema,
      parse('mutation { seb { __typename enterprise { __typename restore } } }'),
      [singleSebMutationRule],
    )).toEqual([])
    // The one-action rule also runs on otherwise invalid documents; the normal
    // GraphQL validation rules are responsible for the missing selection set.
    expect(validate(
      schema,
      parse('mutation { seb { enterprise } }'),
      [singleSebMutationRule],
    )).toEqual([])
  })

  it('sanitizes filenames and creates opaque, application-bound object keys', () => {
    expect(sanitizeFilename(' ../a\\b\u0000.pdf ')).toBe('.._a_b.pdf')
    expect(sanitizeFilename(' ')).toBeNull()
    expect(sanitizeFilename('a'.repeat(256))).toBeNull()
    expect(validSha256Base64('A'.repeat(43) + '=')).toBe(true)
    expect(validSha256Base64('bad')).toBe(false)
    const key = createDocumentObjectKey('application-id', 'DPR')
    expect(key).toMatch(/^applications\/application-id\/documents\/DPR\/[0-9a-f-]+$/u)
  })


  it('refuses a name that describes something the file is not', async () => {
    /*
     * The third check on an upload, and the only one that concerns the name.
     * The MIME type is what the browser claims and the magic bytes are what
     * the file is — but the filename is the one of the three that gets stored
     * and later served back.
     *
     * `report.pdf.exe` passes both the others: the browser reports
     * application/pdf and the bytes begin %PDF-.
     */
    expect(extensionMatchesContentType('report.pdf.exe', 'application/pdf')).toBe(false)
    expect(extensionMatchesContentType('scan.png', 'application/pdf')).toBe(false)

    // Only the final extension is judged. Dots earlier in a name are ordinary.
    expect(extensionMatchesContentType('annual.report.2026.pdf', 'application/pdf')).toBe(true)
    expect(extensionMatchesContentType('PROOF.PDF', 'application/pdf')).toBe(true)
    expect(extensionMatchesContentType('photo.JPEG', 'image/jpeg')).toBe(true)
    expect(extensionMatchesContentType('photo.jpg', 'image/jpeg')).toBe(true)
    expect(extensionMatchesContentType('logo.png', 'image/png')).toBe(true)

    // No extension is refused rather than waved through: a stored document
    // with no extension is one nobody can open by clicking it.
    expect(extensionMatchesContentType('report', 'application/pdf')).toBe(false)
    expect(extensionMatchesContentType('report.', 'application/pdf')).toBe(false)
    expect(extensionMatchesContentType('.pdf', 'application/pdf')).toBe(false)
  })
})

describe('limits on how much one request may ask for', () => {
  const schema = buildSchema(`
    type Query { seb: SebQuery! }
    type SebQuery { application: SebApplicationQuery! }
    type SebApplicationQuery { byId(id: ID!): Application! }
    type Application { id: ID!, child: Application }
  `)

  const errorsFor = (source: string) =>
    validate(schema, parse(source), [documentCostRule]).map((error) => error.message)

  it('accepts a document the size the real client sends', () => {
    // The client's largest operation selects 159 fields at depth 8. This builds
    // something comfortably larger and still expects it through.
    const fields = Array.from({ length: 150 }, (_, index) => `f${index}: id`).join(' ')
    expect(errorsFor(`query { seb { application { byId(id: "x") { ${fields} } } } }`))
      .toEqual([])
  })

  it('refuses a document that asks for the same work hundreds of times', () => {
    /*
     * `first` is clamped to 100 on every connection, so no single list can be
     * asked for a million rows. Aliases are how that clamp is evaded: one
     * modest field, repeated. A per-field limit cannot see it.
     */
    const aliases = Array.from(
      { length: 300 },
      (_, index) => `a${index}: byId(id: "x") { id }`,
    ).join(' ')
    const [message] = errorsFor(`query { seb { application { ${aliases} } } }`)
    expect(message).toMatch(/asks for \d+ fields; the limit is 500/u)
  })

  it('refuses a document nested past the limit', () => {
    // Deeper than any real screen: the deepest the client sends is 7.
    const open = 'child { '.repeat(20)
    const close = '}'.repeat(20)
    const [message] = errorsFor(
      `query { seb { application { byId(id: "x") { ${open} id ${close} } } } }`,
    )
    expect(message).toMatch(/nests \d+ levels deep; the limit is 12/u)
  })

  it('counts through fragments, and counts a fragment once per use', () => {
    // Moving the selections into a fragment must not evade the limit.
    const fields = Array.from({ length: 260 }, (_, index) => `f${index}: id`).join(' ')
    const spread = `
      query { seb { application {
        one: byId(id: "x") { ...big }
        two: byId(id: "x") { ...big }
      } } }
      fragment big on Application { ${fields} }
    `
    const [message] = errorsFor(spread)
    expect(message).toMatch(/asks for \d+ fields; the limit is 500/u)
  })

  it('ignores __typename, which clients add on their own', () => {
    const fields = Array.from({ length: 400 }, (_, index) => `f${index}: __typename`).join(' ')
    expect(errorsFor(`query { seb { application { byId(id: "x") { ${fields} } } } }`))
      .toEqual([])
  })

  it('tolerates a spread of a fragment that is not there', () => {
    /*
     * Standard validation reports the unknown fragment — but this rule is
     * registered first, so it walks the document before that report exists and
     * must not fall over on the gap.
     */
    expect(errorsFor('query { seb { application { byId(id: "x") { ...missing } } } }'))
      .toEqual([])
  })

  it('does not recurse forever on a self-referential fragment', () => {
    // Standard validation reports the cycle; this rule must not hang first.
    const source = `
      query { seb { application { byId(id: "x") { ...loop } } } }
      fragment loop on Application { id child { ...loop } }
    `
    expect(() => errorsFor(source)).not.toThrow()
  })
})
