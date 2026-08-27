/**
 * The closed set of refusal codes, against the enum the schema publishes.
 *
 * `codes.ts` has said since it was written that the set is "exported as a
 * GraphQL enum, so a client can branch on a code rather than matching a
 * sentence — and a test asserts they do". **There was no enum and no test.**
 * `ValidationIssue.code` was a plain `String!`, so a code the engine emitted
 * that no client knew about travelled quietly, and a code a client branched on
 * that the engine had stopped emitting looked exactly the same as one it had
 * never emitted.
 *
 * Now the two are compared directly rather than through a fixture: a fixture
 * only records what somebody believed when they wrote it, and would go on
 * passing while both sides drifted the same wrong way.
 */
import { describe, expect, it } from 'vitest'
import { buildSchema, isEnumType } from 'graphql'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validationIssueCodes } from '../../src/services/application/form/codes'

/**
 * The schema as the Worker assembles it: every `.graphql` file, concatenated.
 *
 * Read off disk rather than imported from `src/graphql/index.ts`, which builds
 * an executable schema with resolvers and a Yoga instance around it. What is
 * under test is the *published vocabulary*, and that is the text.
 */
const schema = () => {
  const roots = ['src/graphql', 'src/graphql/queries', 'src/graphql/mutations']
  const files: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.graphql')) files.push(path)
    }
  }
  walk('src/graphql')
  expect(roots.length).toBeGreaterThan(0)
  return buildSchema(files.map((path) => readFileSync(path, 'utf8')).join('\n'))
}

describe('the refusal codes a client may branch on', () => {
  it('publishes every code the engine can emit, and no others', () => {
    const published = schema().getType('ValidationIssueCode')
    expect(isEnumType(published)).toBe(true)
    expect(isEnumType(published) ? published.getValues().map((each) => each.name).sort() : [])
      .toEqual([...validationIssueCodes].sort())
  })

  it('has a set that did not silently collapse to nothing', () => {
    // A comparison of two empty lists is a fast green run that proves nothing.
    expect(validationIssueCodes.length).toBe(34)
    expect(new Set(validationIssueCodes).size).toBe(validationIssueCodes.length)
  })

  /*
   * The field is the enum rather than a string, which is what makes an
   * unpublished code a serialization error instead of a value passing through.
   */
  it('types the field as the enum rather than as text', () => {
    const issue = schema().getType('ValidationIssue')
    const code = (issue as { getFields(): Record<string, { type: unknown }> })
      .getFields().code
    expect(String(code.type)).toBe('ValidationIssueCode!')
  })
})
