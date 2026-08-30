#!/usr/bin/env node
/**
 * Proves `catalog.generated.ts` is what `catalog.json` says, and that the
 * catalogue itself is coherent.
 *
 * The catalogue is authored as JSON and consumed as TypeScript. That split is
 * not decoration: a JSON import gives widened types — `string[]`, never a
 * literal union — so `currentStaff(context, 'aplication', 'read')` would
 * compile, and every authorization guard in this repository fails at build time
 * instead. Generating the types and failing on drift is the same arrangement
 * `database/schema.sql` has with `src/db/schema/`, and rests on the same
 * argument: a generated description cannot drift from what it describes when
 * regenerating it is the test.
 *
 * `--write` regenerates the file, which is `npm run catalog:generate`.
 *
 * ## What is checked, and what is not yet
 *
 * The structural half is here: the mapping names only declared keys, nothing is
 * declared twice, and no action is declared that no resource offers. That last
 * one is the `check:audit` scar in a different file — three recovery actions
 * were declared and never written, so the catalogue read as coverage while the
 * activity history contained no recovery at all.
 *
 * The half with real teeth — **every pair is asked for by a guard somewhere** —
 * arrives with the guards themselves. Until an operation names a pair there is
 * nothing to scan for, and a check that cannot pass is one people learn to
 * skip. A permission nothing enforces is exactly as empty as an audit action
 * nothing writes, so it is a gap held open deliberately, not forgotten.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalogFile = join(root, 'src', 'services', 'auth', 'catalog.json')
const generatedFile = join(root, 'src', 'services', 'auth', 'catalog.generated.ts')

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))

/* ---------------------------------------------------------------- structure */

const KEY = /^[a-z][a-z0-9_]*$/u

const collect = (entries, what) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`catalog.json declares no ${what}. Has its shape changed?`)
  }
  const byKey = new Map()
  for (const entry of entries) {
    if (!KEY.test(entry.key ?? '')) {
      fail(`catalog.json: ${what} key ${JSON.stringify(entry.key)} is not lower_snake_case.`)
    }
    if (byKey.has(entry.key)) fail(`catalog.json declares the ${what} "${entry.key}" twice.`)
    if (!entry.description?.trim()) {
      fail(`catalog.json: the ${what} "${entry.key}" has no description.`)
    }
    byKey.set(entry.key, entry.description)
  }
  return byKey
}

const resources = collect(catalog.resources, 'resource')
const actions = collect(catalog.actions, 'action')

const grantedActions = new Set()
for (const [resource, offered] of Object.entries(catalog.grants)) {
  if (!resources.has(resource)) {
    fail(`catalog.json: grants name the resource "${resource}", which is not declared.`)
  }
  if (!Array.isArray(offered) || offered.length === 0) {
    fail(`catalog.json: the resource "${resource}" offers no actions. Remove it or give it one.`)
  }
  const seen = new Set()
  for (const action of offered) {
    if (!actions.has(action)) {
      fail(`catalog.json: "${resource}" offers the action "${action}", which is not declared.`)
    }
    if (seen.has(action)) fail(`catalog.json: "${resource}" offers "${action}" twice.`)
    seen.add(action)
    grantedActions.add(action)
  }
}

for (const resource of resources.keys()) {
  if (!(resource in catalog.grants)) {
    fail(`catalog.json declares the resource "${resource}" but grants it no actions.`)
  }
}

/*
 * An action no resource offers is a word in the vocabulary that nothing can
 * ever hold — the same emptiness a declared-but-unwritten audit action has.
 */
const orphans = [...actions.keys()].filter((action) => !grantedActions.has(action))
if (orphans.length) {
  fail(`catalog.json declares actions no resource offers: ${orphans.join(', ')}`)
}

/* ---------------------------------------------------------------- generation */

const quote = (value) => `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`
const list = (values) => values.map(quote).join(', ')
const pairs = Object.entries(catalog.grants).flatMap(([resource, offered]) =>
  offered.map((action) => ({ resource, action })),
)

const generate = () => `/**
 * GENERATED FROM \`catalog.json\`. Do not edit.
 *
 * \`npm run catalog:generate\` writes it; \`npm run check:catalog\` regenerates
 * and fails on any difference, which is what makes the JSON the source of truth
 * rather than a second copy of these types. Same arrangement as
 * \`database/schema.sql\`, and for the same reason.
 *
 * The literal unions are the point. A guard that named a resource or an action
 * as a plain string would let a typo through to run time, where it reads as a
 * permission nobody holds — a refusal with no cause anybody can find.
 */

/** Every kind of record something may be done to. */
export const resources = [${list([...resources.keys()])}] as const

export type Resource = (typeof resources)[number]

/** Every act that may be permitted, as a vocabulary shared across resources. */
export const actions = [${list([...actions.keys()])}] as const

export type Action = (typeof actions)[number]

/**
 * Which actions each resource actually offers.
 *
 * Kept separate from the two lists above because \`read\` means the same thing
 * everywhere while only some resources offer it, and a flat product of the two
 * would contain pairs no operation could ever check.
 */
export const grants = {
${Object.entries(catalog.grants)
  .map(([resource, offered]) => `  ${resource}: [${list(offered)}],`)
  .join('\n')}
} as const satisfies Record<Resource, readonly Action[]>

/**
 * The actions one resource offers, as a type.
 *
 * This is what makes a guard's two arguments check against each other:
 * \`ActionOf<'audit'>\` is \`'read'\`, so asking to award something on the audit
 * history does not compile.
 */
export type ActionOf<R extends Resource> = (typeof grants)[R][number]

/** Every legal pair, in catalogue order. */
export const permissions = [
${pairs.map(({ resource, action }) => `  { resource: ${quote(resource)}, action: ${quote(action)} },`).join('\n')}
] as const

export type Permission = (typeof permissions)[number]

/** What each resource is, for whoever is deciding whether to hand it out. */
export const resourceDescriptions: Record<Resource, string> = {
${[...resources].map(([key, description]) => `  ${key}: ${quote(description)},`).join('\n')}
}

/** What each action permits, in the words somebody reads before allowing it. */
export const actionDescriptions: Record<Action, string> = {
${[...actions].map(([key, description]) => `  ${key}: ${quote(description)},`).join('\n')}
}
`

const generated = generate()

if (process.argv.includes('--write')) {
  writeFileSync(generatedFile, generated)
  console.log(
    `Wrote src/services/auth/catalog.generated.ts ` +
      `(${resources.size} resources, ${actions.size} actions, ${pairs.length} permissions).`,
  )
  process.exit(0)
}

let current
try {
  current = readFileSync(generatedFile, 'utf8')
} catch {
  fail('src/services/auth/catalog.generated.ts is missing. Run `npm run catalog:generate`.')
}

if (current !== generated) {
  /* Name what moved rather than printing the whole file at somebody. */
  const pairsIn = (source) =>
    new Set(
      [...source.matchAll(/\{ resource: '([a-z_]+)', action: '([a-z_]+)' \}/gu)].map(
        (match) => `${match[1]}:${match[2]}`,
      ),
    )
  const before = pairsIn(current)
  const after = pairsIn(generated)
  const added = [...after].filter((pair) => !before.has(pair))
  const removed = [...before].filter((pair) => !after.has(pair))

  console.error('src/services/auth/catalog.generated.ts does not match catalog.json.')
  if (added.length) console.error(`  permissions added:   ${added.join(', ')}`)
  if (removed.length) console.error(`  permissions removed: ${removed.join(', ')}`)
  if (!added.length && !removed.length) {
    console.error('  the same permissions, but their descriptions or order differ')
  }
  fail('Run `npm run catalog:generate` and commit the result.')
}

console.log(
  `Catalogue agrees: ${resources.size} resources, ${actions.size} actions, ` +
    `${pairs.length} permissions.`,
)
