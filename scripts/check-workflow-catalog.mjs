#!/usr/bin/env node
/**
 * Proves the workflow catalogue and the code agree, in both directions.
 *
 * `src/services/catalogue/workflow.json` says what a pipeline, a stage action,
 * a cycle's application kinds and a form's cross-field rules may be configured
 * with. Every entry there is a promise that code exists to carry it out, and
 * every piece of that code is only reachable through configuration if the
 * catalogue declares it. Either side drifting alone is silent:
 *
 *   - an effect declared with no handler reads as a capability an author can
 *     choose, and fails only when an officer presses the button;
 *   - a handler nobody declared is code no configuration can reach, which is
 *     dead code that looks alive;
 *   - an effect naming a permission the auth catalogue does not have guards
 *     nothing, and a role can never be composed to use it.
 *
 * So each mapping below is checked from the JSON to the code and from the code
 * to the JSON. Code is found by its registration marker — `defineEffect('KEY'`
 * and its siblings — with comments stripped first, so a marker in a comment is
 * not an implementation. What a regex cannot prove (that a handler's parameter
 * schema matches the declared parameters) is proved by
 * `test/service/workflow-catalogue.test.ts`, which imports the real registries.
 *
 * `--write` regenerates `workflow.generated.ts` — `npm run workflow-catalog:generate`.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalogueFile = join(root, 'src', 'services', 'catalogue', 'workflow.json')
const generatedFile = join(root, 'src', 'services', 'catalogue', 'workflow.generated.ts')
const authCatalogueFile = join(root, 'src', 'services', 'auth', 'catalog.json')
const formTemplateSchema = join(root, 'src', 'db', 'schema', 'seb', 'form-template.ts')
const programmeSchema = join(root, 'src', 'db', 'schema', 'seb', 'programme.ts')
const clientRenderer = join(root, 'dev-web', 'src', 'features', 'application', 'FormRenderer.tsx')

const catalogue = JSON.parse(readFileSync(catalogueFile, 'utf8'))
const problems = []
const problem = (line) => problems.push(line)

/* ---------------------------------------------------------------- structure */

const KEY = /^[A-Z][A-Z0-9_]{1,63}$/u
const sections = ['inputFieldTypes', 'conditionSources', 'paramKinds', 'formRules', 'eligibilityRules', 'effects']
for (const section of sections) {
  const entries = catalogue[section]
  if (!Array.isArray(entries) || entries.length === 0) {
    problem(`${section} is missing or empty`)
    continue
  }
  const seen = new Set()
  for (const entry of entries) {
    if (!KEY.test(entry.key ?? '')) problem(`${section} has a key that is not SCREAMING_SNAKE: ${entry.key}`)
    if (seen.has(entry.key)) problem(`${section} declares ${entry.key} twice`)
    seen.add(entry.key)
    if (!entry.description?.trim()) problem(`${section}.${entry.key} has no description`)
  }
}
const keysOf = (section) => new Set((catalogue[section] ?? []).map((entry) => entry.key))
const paramKinds = keysOf('paramKinds')

/** A `export const name = [...] as const` list of codes, read from a schema source file. */
const schemaList = (path, name) => new Set(
  [...readFileSync(path, 'utf8')
    .match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`, 'u'))?.[1]
    .matchAll(/'([A-Z_]+)'/gu) ?? []].map((match) => match[1]),
)
const formFieldTypes = schemaList(formTemplateSchema, 'formFieldTypes')
if (formFieldTypes.size === 0) problem('Could not read formFieldTypes from form-template.ts — has its shape changed?')

/*
 * The database's twins of two catalogue lists. A CHECK cannot read a JSON
 * file, so the rule-type columns carry their own list; this is what holds
 * each to the catalogue, in both directions, so a rule type added to the JSON
 * without its database value fails here rather than at the first INSERT.
 */
const sameSet = (a, b) => a.size === b.size && [...a].every((key) => b.has(key))
for (const [path, name, section] of [
  [formTemplateSchema, 'formRuleTypes', 'formRules'],
  [programmeSchema, 'eligibilityRuleTypes', 'eligibilityRules'],
]) {
  const twin = schemaList(path, name)
  if (!sameSet(twin, keysOf(section))) {
    problem(`${name} in ${path.replace(`${root}/`, '')} is [${[...twin].join(', ')}]; workflow.json ${section} is [${[...keysOf(section)].join(', ')}]`)
  }
}

for (const rule of catalogue.formRules ?? []) {
  for (const type of rule.operandTypes ?? []) {
    if (!formFieldTypes.has(type)) problem(`formRules.${rule.key} names operand type ${type}, which is not a form field type`)
  }
  if (!(rule.minOperands >= 1 && rule.maxOperands >= rule.minOperands)) problem(`formRules.${rule.key} has incoherent operand bounds`)
  if (!['NONE', 'REQUIRED'].includes(rule.limit)) problem(`formRules.${rule.key} has limit ${rule.limit}; expected NONE or REQUIRED`)
}
for (const section of ['effects', 'eligibilityRules']) {
  for (const entry of catalogue[section] ?? []) {
    for (const param of entry.params ?? []) {
      if (!paramKinds.has(param.kind)) problem(`${section}.${entry.key}.${param.name} has kind ${param.kind}, which paramKinds does not declare`)
      if (typeof param.required !== 'boolean') problem(`${section}.${entry.key}.${param.name} must say whether it is required`)
    }
  }
}

/* ------------------------------------------- input field types ↔ form engine */

for (const type of keysOf('inputFieldTypes')) {
  if (!formFieldTypes.has(type)) problem(`inputFieldTypes.${type} is not a form field type, so the form engine cannot validate it`)
}
try {
  const renderer = readFileSync(clientRenderer, 'utf8')
  for (const type of keysOf('inputFieldTypes')) {
    if (!renderer.includes(`'${type}'`)) problem(`inputFieldTypes.${type} is never rendered by dev-web FormRenderer.tsx`)
  }
} catch {
  problem('dev-web/src/features/application/FormRenderer.tsx is missing, so no input field type can be proven renderable')
}

/* ---------------------------------------------- effect permissions ↔ auth */

const auth = JSON.parse(readFileSync(authCatalogueFile, 'utf8'))
const pairs = new Set(Object.entries(auth.grants).flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`)))
/*
 * `BY_FLAG_KIND` is resolved in code — an OUTCOME flag needs `stage:decide`, a
 * PROGRESS flag `stage:advance` — so both pairs must exist for it to mean
 * anything.
 */
const BY_FLAG_KIND = ['stage:decide', 'stage:advance']
for (const effect of catalogue.effects ?? []) {
  if (!['APPLICATION', 'STAGE'].includes(effect.group)) problem(`effects.${effect.key} has group ${effect.group}`)
  const needed = effect.permission === 'BY_FLAG_KIND' ? BY_FLAG_KIND : effect.permission === null ? [] : [effect.permission]
  for (const pair of needed) {
    if (!pairs.has(pair)) problem(`effects.${effect.key} needs ${pair}, which src/services/auth/catalog.json does not grant`)
  }
  if (effect.terminal && effect.exclusive !== 'STAGE') problem(`effects.${effect.key} is terminal, so it must be exclusive to STAGE`)
}

/* -------------------------------------------------- registries ↔ catalogue */

const withoutComments = (text) =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^[ \t]*\/\/.*$/gmu, '')

/** Every .ts/.tsx file under a directory, or nothing if it does not exist yet. */
const sourcesUnder = (dir) => {
  const found = []
  const walk = (path) => {
    let entries
    try {
      entries = readdirSync(path)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'generated') continue
      const full = join(path, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/u.test(name)) found.push(full)
    }
  }
  walk(join(root, dir))
  return found
}

/** Keys registered with `marker('KEY'` anywhere under the given directories. */
const registered = (marker, dirs) => {
  const keys = new Map()
  const pattern = new RegExp(`\\b${marker}\\(\\s*'([A-Z][A-Z0-9_]*)'`, 'gu')
  for (const file of dirs.flatMap(sourcesUnder)) {
    for (const match of withoutComments(readFileSync(file, 'utf8')).matchAll(pattern)) {
      if (keys.has(match[1])) problem(`${match[1]} is registered twice with ${marker} (${relative(root, keys.get(match[1]))} and ${relative(root, file)})`)
      else keys.set(match[1], file)
    }
  }
  return keys
}

/**
 * One mapping, both directions: every declared key has its code, and every
 * registered key is declared.
 */
const mapped = (what, declared, marker, dirs) => {
  const implemented = registered(marker, dirs)
  for (const key of declared) {
    if (!implemented.has(key)) problem(`${what} ${key} is declared in workflow.json but has no ${marker}('${key}', …) in ${dirs.join(' or ')}`)
  }
  for (const [key, file] of implemented) {
    if (!declared.has(key)) problem(`${relative(root, file)} registers ${what} ${key} with ${marker}, but workflow.json does not declare it`)
  }
}

mapped('effect', keysOf('effects'), 'defineEffect', ['src/services/pipeline'])
mapped('parameter kind', paramKinds, 'defineParamKind', ['src/services/pipeline'])
mapped('parameter kind', paramKinds, 'defineParamControl', ['dev-web/src'])
mapped('condition source', keysOf('conditionSources'), 'defineConditionSource', ['src/services/pipeline'])
mapped('cross-field rule', keysOf('formRules'), 'defineFormRule', ['src/services/application/form'])
mapped('cross-field rule', keysOf('formRules'), 'defineClientFormRule', ['dev-web/src'])
mapped('eligibility rule', keysOf('eligibilityRules'), 'defineEligibility', ['src/services'])

/* ------------------------------------------------------ the generated file */

/*
 * `exported` is false for a list whose only consumer is its own type: the
 * database keeps its own twin of those (checked above), so exporting the
 * runtime array would be an export nothing reads.
 */
const literalUnion = (name, keys, exported = true) =>
  `${exported ? 'export ' : ''}const ${name} = [\n${[...keys].map((key) => `  '${key}',`).join('\n')}\n] as const\n`

const generated = `/*
 * Generated by \`node scripts/check-workflow-catalog.mjs --write\` from
 * workflow.json. Do not edit; \`npm run check:workflow-catalog\` fails on drift.
 */

${literalUnion('inputFieldTypes', keysOf('inputFieldTypes'))}export type InputFieldType = (typeof inputFieldTypes)[number]

${literalUnion('conditionSources', keysOf('conditionSources'))}export type ConditionSource = (typeof conditionSources)[number]

${literalUnion('paramKinds', paramKinds)}export type ParamKind = (typeof paramKinds)[number]

${literalUnion('formRuleTypes', keysOf('formRules'), false)}export type FormRuleType = (typeof formRuleTypes)[number]

${literalUnion('eligibilityRuleTypes', keysOf('eligibilityRules'), false)}export type EligibilityRuleType = (typeof eligibilityRuleTypes)[number]

${literalUnion('effectTypes', keysOf('effects'))}export type EffectType = (typeof effectTypes)[number]

export type CatalogueParam = {
  readonly name: string
  readonly kind: ParamKind
  readonly required: boolean
  readonly description: string
}

export type EffectEntry = {
  readonly group: 'APPLICATION' | 'STAGE'
  readonly description: string
  readonly permission: string | null
  readonly exclusive: 'STAGE' | 'LIFECYCLE' | null
  readonly terminal: boolean
  readonly params: readonly CatalogueParam[]
}

export const effectCatalogue: Record<EffectType, EffectEntry> = ${JSON.stringify(
  Object.fromEntries((catalogue.effects ?? []).map((effect) => [effect.key, {
    group: effect.group,
    description: effect.description,
    permission: effect.permission,
    exclusive: effect.exclusive ?? null,
    terminal: effect.terminal === true,
    params: effect.params,
  }])),
  null,
  2,
)}

export type FormRuleEntry = {
  readonly description: string
  readonly operandTypes: readonly string[]
  readonly minOperands: number
  readonly maxOperands: number
  readonly limit: 'NONE' | 'REQUIRED'
}

export const formRuleCatalogue: Record<FormRuleType, FormRuleEntry> = ${JSON.stringify(
  Object.fromEntries((catalogue.formRules ?? []).map(({ key, ...rest }) => [key, rest])),
  null,
  2,
)}

export type EligibilityEntry = {
  readonly description: string
  readonly params: readonly CatalogueParam[]
}

export const eligibilityCatalogue: Record<EligibilityRuleType, EligibilityEntry> = ${JSON.stringify(
  Object.fromEntries((catalogue.eligibilityRules ?? []).map(({ key, ...rest }) => [key, rest])),
  null,
  2,
)}

/** Every entry's description, for the pipeline editor and the API. */
export const workflowDescriptions: Record<string, string> = ${JSON.stringify(
  Object.fromEntries(sections.flatMap((section) =>
    (catalogue[section] ?? []).map((entry) => [`${section}.${entry.key}`, entry.description]))),
  null,
  2,
)}
`

if (process.argv.includes('--write')) {
  writeFileSync(generatedFile, generated)
  console.log(`Wrote ${relative(root, generatedFile)}.`)
} else {
  let current = ''
  try {
    current = readFileSync(generatedFile, 'utf8')
  } catch {
    // Absent is drift like any other.
  }
  if (current !== generated) problem('src/services/catalogue/workflow.generated.ts is stale — run `npm run workflow-catalog:generate`')
}

if (problems.length > 0) {
  throw new Error(
    'The workflow catalogue and the code disagree:\n\n' +
      problems.map((line) => `  ${line}`).join('\n') +
      '\n\nA catalogue entry with no code is a button that fails when pressed; code with no entry is behaviour nothing can reach.\n',
  )
}

console.log(
  `Workflow catalogue agrees with the code: ${keysOf('effects').size} effects, ${paramKinds.size} parameter kinds, ` +
    `${keysOf('formRules').size} form rules, ${keysOf('eligibilityRules').size} eligibility rules, ` +
    `${keysOf('conditionSources').size} condition sources, ${keysOf('inputFieldTypes').size} input field types.`,
)
