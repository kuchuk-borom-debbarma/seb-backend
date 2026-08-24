/**
 * Fails when any part of the GraphQL schema is undocumented.
 *
 * ## Why this exists rather than a convention
 *
 * The schema is the API's documentation for everybody who calls it. Before this
 * check the SDL carried 138 `#` comments and **zero** descriptions — and a `#`
 * comment is a lexer comment. It is discarded by the parser, so it never
 * reaches introspection, never appears in GraphiQL, and never reaches the
 * generated TypeScript a frontend developer actually reads. Every explanation
 * written in the schema was invisible at exactly the place it was written for.
 *
 * Descriptions are `"""triple quoted"""` and survive all three.
 *
 * A partial rule cannot be checked and therefore decays, which is why coverage
 * is total: every named type, field, argument, input field and enum value.
 *
 * ## The second check is the one that matters
 *
 * Coverage alone is trivially satisfied by restating the field's own name —
 * `"""The application id."""` on `applicationId` — which passes a counter and
 * helps nobody. So a description whose words are just the name spelled out is
 * refused as well. It is a crude test and it only catches the laziest form, but
 * that is the form a coverage gate actually produces.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
} from 'graphql'

/*
 * The same files, in the same order, that `src/graphql/index.ts` hands to
 * `createSchema`. Kept as an explicit list rather than a glob so that a new SDL
 * file has to be added in both places — a file the Worker loads but this does
 * not check would be silently exempt.
 */
const SDL_FILES = [
  'schema.graphql',
  'queries/auth/auth.graphql',
  'mutations/auth/auth.graphql',
  'queries/access/access.graphql',
  'mutations/access/access.graphql',
  'queries/admin/admin.graphql',
  'mutations/admin/admin.graphql',
  'queries/audit/audit.graphql',
  'queries/seb/seb.graphql',
  'mutations/seb/seb.graphql',
]

/**
 * Scalars defined by the specification, plus the three this API adds.
 *
 * A custom scalar still needs a description — `Money` being paise rather than
 * rupees is exactly the kind of thing that must not be guessed — so only the
 * built-ins are exempt.
 */
const BUILT_IN_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID'])

const sdl = SDL_FILES.map((file) =>
  readFileSync(new URL(`../src/graphql/${file}`, import.meta.url), 'utf8'),
).join('\n')

const schema = buildSchema(sdl)

/** Words that carry no information when they are the whole description. */
const FILLER = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'this', 'its', 'it',
  'is', 'are', 'and', 'or', 'that', 'which', 'as', 'by', 'with',
])

/** `applicationId` and `APPLICATION_ID` both reduce to `application id`. */
const words = (value) =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/gu, ' ')
    .toLowerCase()
    .split(' ')
    .filter((word) => word && !FILLER.has(word))

/**
 * True when a description says nothing the name did not already say.
 *
 * Compared as sets of significant words, so "The application id" against
 * `applicationId` is caught while "The application this belongs to, or null
 * while it is still a draft" is not — the second adds words, which is the
 * whole point.
 */
const merelyRestatesTheName = (name, description) => {
  const fromName = new Set(words(name))
  const fromDescription = words(description)
  if (fromDescription.length === 0) return true
  return fromDescription.every((word) => fromName.has(word))
}

const problems = []

const check = (path, name, description) => {
  if (!description || !description.trim()) {
    problems.push(`${path} has no description`)
    return
  }
  if (merelyRestatesTheName(name, description)) {
    problems.push(
      `${path} only restates its own name: "${description.trim().split('\n')[0]}"`,
    )
  }
}

for (const type of Object.values(schema.getTypeMap())) {
  // Introspection's own types are the GraphQL specification's, not ours.
  if (type.name.startsWith('__')) continue
  if (isScalarType(type) && BUILT_IN_SCALARS.has(type.name)) continue

  check(type.name, type.name, type.description)

  if (isObjectType(type) || isInterfaceType(type)) {
    for (const field of Object.values(type.getFields())) {
      check(`${type.name}.${field.name}`, field.name, field.description)
      for (const argument of field.args) {
        check(
          `${type.name}.${field.name}(${argument.name}:)`,
          argument.name,
          argument.description,
        )
      }
    }
  }

  if (isInputObjectType(type)) {
    for (const field of Object.values(type.getFields())) {
      check(`${type.name}.${field.name}`, field.name, field.description)
    }
  }

  if (isEnumType(type)) {
    for (const value of type.getValues()) {
      check(`${type.name}.${value.name}`, value.name, value.description)
    }
  }
}

if (problems.length > 0) {
  const shown = problems.slice(0, 40)
  const rest = problems.length - shown.length
  throw new Error(
    `The schema is the API's documentation. ${problems.length} part(s) of it ` +
      'are undocumented or say nothing:\n\n' +
      shown.map((line) => `  ${line}`).join('\n') +
      (rest > 0 ? `\n  … and ${rest} more` : '') +
      '\n\nDescriptions are """triple quoted""". A # comment is discarded by ' +
      'the parser and reaches nobody.\nSee docs/rules/graphql.md.\n',
  )
}

console.log(
  `Schema documented: every type, field, argument and enum value across ` +
    `${SDL_FILES.length} SDL files.`,
)
