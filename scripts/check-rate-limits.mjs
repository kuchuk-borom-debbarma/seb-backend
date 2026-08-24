/**
 * Fails when the rate-limit policy and the Worker's configuration disagree.
 *
 * The platform's limiter takes its limit and period from configuration rather
 * than from the call, so a bucket names a binding and
 * `src/services/rate-limit/policy.ts` restates the numbers — for the in-process
 * transport, and so a reader can see what is permitted without opening two
 * files. That is a duplication, and this is what stops it drifting.
 *
 * **Unchecked it would be the worst kind of drift.** The limiter fails closed:
 * a policy naming a binding the configuration does not declare would not fall
 * back to permitting, it would refuse — so a typo here takes down signup rather
 * than quietly removing a limit.
 *
 * Also refuses a deployed configuration that switches counting off, which is
 * the second of the two independent things standing between the test suites'
 * bypass and a real environment.
 */
import { readFileSync } from 'node:fs'

const wranglerPath = new URL('../wrangler.jsonc', import.meta.url)

/**
 * Reads JSONC.
 *
 * One pass that keeps string literals and drops comments, so a `//` inside a
 * string — a URL, say — is not mistaken for the start of one. Comments are
 * stripped rather than parsed because the alternative is a dependency for a
 * single file.
 */
const readJsonc = (url) =>
  JSON.parse(
    readFileSync(url, 'utf8').replace(
      /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
      (_match, literal) => literal ?? '',
    ),
  )

const config = readJsonc(wranglerPath)

/** Every rate-limit binding the Worker declares, by name. */
const declared = new Map(
  (config.ratelimits ?? []).map((binding) => [binding.name, binding.simple ?? {}]),
)

/*
 * The policy is TypeScript, so it is read as source rather than imported. A
 * build step to run one check would be a heavier dependency than the parsing
 * below, and the shape it reads is the shape the type enforces.
 */
const policySource = readFileSync(
  new URL('../src/services/rate-limit/policy.ts', import.meta.url),
  'utf8',
)

const wanted = [...policySource.matchAll(
  /binding: '([A-Z0-9_]+)',\s*\n\s*dimension: '[A-Z]+',\s*\n\s*limit: ([\d_]+),\s*\n\s*periodSeconds: ([\d_]+),/gu,
)].map((match) => ({
  binding: match[1],
  limit: Number(match[2].replaceAll('_', '')),
  period: Number(match[3].replaceAll('_', '')),
}))

if (wanted.length === 0) {
  throw new Error(
    'No allowances found in the policy. Has the shape of policy.ts changed?',
  )
}

const problems = []

for (const bucket of wanted) {
  const configured = declared.get(bucket.binding)
  if (!configured) {
    problems.push(
      `${bucket.binding} is named by the policy and not declared in wrangler.jsonc — ` +
        'the limiter fails closed, so this refuses whatever it names',
    )
    continue
  }
  if (configured.limit !== bucket.limit || configured.period !== bucket.period) {
    problems.push(
      `${bucket.binding} permits ${configured.limit} per ${configured.period}s in ` +
        `wrangler.jsonc and ${bucket.limit} per ${bucket.period}s in the policy`,
    )
  }
}

for (const name of declared.keys()) {
  if (!wanted.some((bucket) => bucket.binding === name)) {
    problems.push(`${name} is declared in wrangler.jsonc and named by no allowance`)
  }
}

/*
 * The deployed configuration must never switch counting off. The factory
 * already refuses it in production at construction; this is the second,
 * independent thing standing in the way, so it takes two mistakes rather than
 * one.
 */
const disabled = String(config.vars?.RATE_LIMIT_DISABLED ?? '').toLowerCase()
if (disabled === 'true') {
  problems.push(
    'wrangler.jsonc sets RATE_LIMIT_DISABLED — that is for test runs, never for a deployment',
  )
}

if (problems.length > 0) {
  throw new Error(
    'The rate-limit policy and the Worker configuration disagree:\n\n' +
      problems.map((line) => `  ${line}`).join('\n') +
      '\n\nThe numbers live in both because the platform takes them from ' +
      'configuration.\nSee src/services/rate-limit/README.md.\n',
  )
}

console.log(
  `Rate limits agree: ${wanted.length} allowance(s), each declared and matching.`,
)
