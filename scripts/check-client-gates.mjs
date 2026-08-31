/**
 * Every client component that can send more than one guarded mutation must ask
 * for each of their permissions separately.
 *
 * ## The bug this exists for
 *
 * The API guards each operation with its own resource/action pair. A screen
 * that draws several of them behind one question inherits the wrong answer for
 * all but one: a role holding `decision`/`record` and not `decision`/`correct`
 * was offered "Correct the recorded decision", and the API refused it. The same
 * shape appeared on the announcement board, the funding workspace, the cycle
 * lifecycle bar and the internal notes — four times, each found by hand, each
 * after the last one had been fixed.
 *
 * `check:catalog` already fails the build when a catalogue pair is enforced
 * nowhere on the server. This is the same question asked of the client: not
 * *whether* a screen checks, but whether it checks for everything it can send.
 *
 * ## Why only components sending two or more pairs
 *
 * A component whose every mutation needs one pair can legitimately be gated
 * where it is rendered — `<BankStage>` is drawn under one `can(…, 'application',
 * 'refer')` and every operation inside it needs exactly that. Following the
 * render tree to prove it would mean resolving JSX across files, and guessing
 * would make this noisy enough to ignore. Two distinct pairs is where whole-
 * component gating stops being able to be right, so that is where this bites.
 *
 * ## The mapping is derived, never written down
 *
 * A hand-written table of operation to permission would be a third copy of what
 * `catalog.json` and the guards already say, and it would go stale in the
 * direction that hides the bug. So the chain is read from the source each run:
 * a resolver delegates a GraphQL field to one controller function, that
 * function names its pair at its guard, and the client's own documents say
 * which fields a screen sends.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const client = join(root, 'dev-web/src')

const walk = (directory, match, found = []) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'generated' && entry !== 'node_modules') walk(path, match, found)
    } else if (match.test(entry)) {
      found.push(path)
    }
  }
  return found
}

/*
 * Which pair each controller function guards itself with.
 *
 * The first guard in the body, because that is the authorization one: a
 * controller reads and validates after deciding whether the caller may be told
 * anything at all. A function guarded by `authenticatedSuperAdministrator`
 * names no pair and simply does not appear here — the authority is reserved in
 * code, which is the point of it not being in the catalogue.
 */
const GUARD = /(?:currentStaff|authenticatedWithPermission|authorizeReasonedTransition)\s*\(\s*\w+\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/u
const pairOf = new Map()
for (const file of walk(join(root, 'src/services'), /\.ts$/u)) {
  const source = readFileSync(file, 'utf8')
  // Split on exported bindings, so a guard is attributed to the function it is
  // written in rather than to whichever one happens to be declared first.
  const parts = source.split(/^export const (\w+)\s*=/mu)
  for (let index = 1; index < parts.length; index += 2) {
    const guard = GUARD.exec(parts[index + 1] ?? '')
    if (guard) pairOf.set(parts[index], `${guard[1]}:${guard[2]}`)
  }
}

/**
 * Which controller function each GraphQL field delegates to, keyed by the type
 * that owns it.
 *
 * By type, not by bare name: `create` is a field of the announcement, cycle and
 * enterprise namespaces alike, and keying on the name alone attributed the
 * announcement board's create to whichever resolver was read last. The check
 * then reported a screen for sending an operation it has never heard of, which
 * is worse than not checking — a guardrail nobody believes gets turned off.
 */
const fieldFn = new Map()
for (const file of walk(join(root, 'src/graphql/resolvers'), /\.ts$/u)) {
  const source = readFileSync(file, 'utf8')
  /*
   * By position, not line by line.
   *
   * A resolver is written on one line where its arguments fit and across five
   * where they do not, and matching only the first shape silently dropped every
   * multi-line one — including `AccessQuery.userByEmail`, which is the guarded
   * read this check exists to notice. A regex that matches less than it should
   * reports agreement, which is the failure mode worth engineering against.
   */
  const owners = [...source.matchAll(/^ {2}(\w+):\s*\{/gmu)]
  const fields = [...source.matchAll(/^ {4}(\w+):/gmu)]
  for (const [index, field] of fields.entries()) {
    const owner = owners.filter((match) => match.index < field.index).at(-1)?.[1]
    if (!owner) continue
    const until = fields[index + 1]?.index ?? source.length
    const body = source.slice(field.index, until)
    const call = /=>\s*(\w+)\(/u.exec(body)
    if (call && pairOf.has(call[1])) fieldFn.set(`${owner}.${field[1]}`, call[1])
  }
}

/**
 * Where a selection path in a client document lands in the schema.
 *
 * `admin { announcement { create } }` is `AdminAnnouncementMutation.create`,
 * and only the schema knows that. Read from the same SDL files the Worker
 * serves, so a namespace that moves takes this with it.
 */
const fieldType = new Map()
for (const file of walk(join(root, 'src/graphql'), /\.graphql$/u)) {
  const source = readFileSync(file, 'utf8').replace(/"""[\s\S]*?"""/gu, '')
  for (const [, name, body] of source.matchAll(
    /(?:extend\s+)?type\s+(\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gu,
  )) {
    for (const [, field, target] of body.matchAll(
      /^\s{2}(\w+)\s*(?:\([^)]*\))?\s*:\s*(\w+)/gmu,
    )) {
      fieldType.set(`${name}.${field}`, target)
    }
  }
}

/** Walks a document's selection path down to the type that owns its leaf. */
const ownerOf = (path, root) => {
  let type = root
  for (const step of path.slice(0, -1)) {
    const next = fieldType.get(`${type}.${step}`)
    if (!next) return null
    type = next
  }
  return type
}

/**
 * Which pairs each client mutation sends.
 *
 * **Mutations only, and that is a real limit rather than an oversight.**
 * Guarded *queries* belong here too — the invitation screen was admitted on
 * `role`/`invite` while its first step looks an account up, which the API
 * guards with `user`/`read` — but a screen almost never names a query document
 * itself. It imports `managedUserQuery` from a `*Queries` module, so proving
 * which guarded reads a screen actually performs means resolving *which export*
 * it imported, not merely which module. Attributing every document in that
 * module to every importer was tried and reported four screens for reads they
 * do not make.
 *
 * A check that over-reports gets switched off, and one that under-reports at
 * least never lies about what it looked at. So this covers the controls, and
 * the reads are stated here as uncovered.
 */
const documentPairs = new Map()
for (const file of walk(client, /\.graphql$/u)) {
  const source = readFileSync(file, 'utf8')
  for (const [, name, body] of source.matchAll(
    /^\s*mutation\s+(\w+)([\s\S]*?)(?=^\s*(?:query|mutation)\s+\w+|$(?![\s\S]))/gmu,
  )) {
    const pairs = new Set()
    const path = []
    for (const line of body.split('\n')) {
      const selection = /^\s*(\w+)\s*(\()?/u.exec(line)
      /*
       * Read the operation before descending into it. Pushing first put the
       * field on the path twice, so the walk went one level past the type that
       * owns it and matched nothing at all — which the emptiness check below
       * caught, and would otherwise have read as "no screen sends anything".
       */
      if (selection?.[2]) {
        for (const root of ['Mutation', 'Query']) {
          const owner = ownerOf([...path, selection[1]], root)
          const fn = owner && fieldFn.get(`${owner}.${selection[1]}`)
          if (fn) pairs.add(pairOf.get(fn))
        }
      }
      if (selection && line.includes('{')) path.push(selection[1])
      if (line.includes('}') && !line.includes('{')) path.pop()
    }
    if (pairs.size > 0) documentPairs.set(name, pairs)
  }
}

/** What each component sends, and what it asks. */
const problems = []
for (const file of walk(client, /\.tsx?$/u)) {
  const source = readFileSync(file, 'utf8')
  const needed = new Set()
  for (const [name, pairs] of documentPairs) {
    if (source.includes(`${name}Document`)) for (const pair of pairs) needed.add(pair)
  }
  if (needed.size < 2) continue
  /*
   * Asked across the same reach the sending was counted over. A screen that
   * draws `<AwardActions>` has not failed to gate the release form — that
   * component asks for itself, and blaming the parent for a child that gates
   * correctly is how a check earns its way into being ignored.
   */
  const asked = new Set(
    [...source.matchAll(/\bcan\(\s*[^,]+,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/gu)]
      .map(([, resource, action]) => `${resource}:${action}`),
  )
  const missing = [...needed].filter((pair) => !asked.has(pair)).sort()
  if (missing.length > 0) {
    problems.push({ file: relative(root, file), missing, needed: [...needed].sort() })
  }
}

if (documentPairs.size === 0 || fieldFn.size === 0) {
  console.error(
    'check:client-gates read nothing. The resolver or guard shape has changed, '
    + 'and a check that matches nothing passes everything.',
  )
  process.exit(1)
}

if (problems.length > 0) {
  console.error('Screens that send a guarded mutation they never ask about:\n')
  for (const { file, missing, needed } of problems) {
    console.error(`  ${file}`)
    console.error(`    sends ${needed.join(', ')}`)
    console.error(`    never asks ${missing.join(', ')}\n`)
  }
  console.error(
    'Each control has to ask for the pair its own mutation needs. Gating them '
    + 'together draws one that the API then refuses.',
  )
  process.exit(1)
}

console.log(
  `Client gates agree: ${documentPairs.size} guarded operations across `
  + `${fieldFn.size} fields, every multi-permission screen asks for each.`,
)
