/**
 * Fails when the deployed configuration would accept documents nothing scans.
 *
 * ## Why this exists rather than a runtime guard
 *
 * `documentScanner()` throws when it is asked for a scanner that `production`
 * may not have. That refusal is real, but it happens where the scanner is
 * *built*, and the only place that builds one is the queue consumer — so a
 * misconfigured Worker deploys green, serves every request, accepts uploads,
 * and fails on the first queued scan, where the error is swallowed into a
 * retry. The document stays PENDING and unopenable.
 *
 * The docs used to claim the Worker "refuses at startup". It never did. This
 * closes the half of the gap that can be closed from outside the Worker: the
 * declared configuration, checked before anything is deployed.
 *
 * ## What it cannot check
 *
 * Whether `CLOUDMERSIVE_API_KEY` is actually set. Secrets are write-only —
 * `wrangler secret list` names them but this check runs offline and must not
 * depend on credentials. A transport named here without its key still fails at
 * the first scan; the dead-letter queue is what keeps that from being silent.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Transports that actually examine a file. `none` is not one of them. */
const REAL_TRANSPORTS = new Set(['cloudmersive'])

/** Environments where an unexamined document must never become openable. */
const SCANNING_REQUIRED = new Set(['production'])

/**
 * Reads JSONC.
 *
 * One pass that keeps string literals and drops comments, so a `//` inside a
 * string — or the `/*` inside a `"**\/*.graphql"` glob — is not mistaken for a
 * comment. Same expression as `check-rate-limits.mjs`, which reads the same
 * file for the same reason.
 */
const readJsonc = (name) =>
  JSON.parse(
    readFileSync(join(root, name), 'utf8').replace(
      /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
      (_match, literal) => literal ?? '',
    ),
  )

const vars = readJsonc('wrangler.jsonc').vars ?? {}
const environment = (vars.ENVIRONMENT ?? '').trim().toLowerCase()
const transport = (vars.SCANNER_TRANSPORT ?? '').trim().toLowerCase()

if (transport !== '' && transport !== 'none' && !REAL_TRANSPORTS.has(transport)) {
  console.error(
    `wrangler.jsonc names SCANNER_TRANSPORT "${transport}", which does not exist.\n` +
      `Known values: none, ${[...REAL_TRANSPORTS].join(', ')}.`,
  )
  process.exit(1)
}

if (SCANNING_REQUIRED.has(environment) && !REAL_TRANSPORTS.has(transport)) {
  console.error(
    `ENVIRONMENT is "${environment}" but SCANNER_TRANSPORT is ` +
      `"${transport || 'unset'}".\n\n` +
      `Nothing in ${environment} may accept a document that was never ` +
      `examined. Deployed like this the Worker would start, accept uploads, ` +
      `and fail on every queued scan — leaving each document PENDING and ` +
      `permanently unopenable.\n\n` +
      `Set SCANNER_TRANSPORT to one of: ${[...REAL_TRANSPORTS].join(', ')}, ` +
      `and provision its key with \`wrangler secret put\`.`,
  )
  process.exit(1)
}

const described = REAL_TRANSPORTS.has(transport)
  ? `scanning with "${transport}"`
  : 'accepting documents unexamined, which this environment permits'
console.log(`Scanner configuration agrees: ENVIRONMENT "${environment || 'local'}", ${described}.`)
