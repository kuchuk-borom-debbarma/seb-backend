/**
 * Refuses a deploy whose bindings are still placeholders.
 *
 * `wrangler.jsonc` ships with `REPLACE_WITH_HYPERDRIVE_ID`, because a
 * Hyperdrive id is account-specific and cannot live in a repository. Deploying
 * with it left in place does not fail at deploy time — the configuration is
 * structurally valid — it fails on the **first query of the first request**,
 * which reads as a database outage rather than as a binding that was never
 * filled in.
 *
 * Deliberately not part of `npm run check`. The placeholder is the correct
 * committed state, so a repository-wide gate would be permanently red and
 * teach people to ignore it. This runs where it is actually a problem.
 */
import { readFileSync } from 'node:fs'

const CONFIG = 'wrangler.jsonc'
const source = readFileSync(new URL(`../${CONFIG}`, import.meta.url), 'utf8')

const placeholders = [...source.matchAll(/"([A-Za-z_]*REPLACE_WITH[A-Za-z_]*)"/gu)]
  .map((match) => match[1])

if (placeholders.length > 0) {
  console.error(
    `${CONFIG} still carries ${[...new Set(placeholders)].join(', ')}.\n\n`
    + 'Create the resource on the Cloudflare account and put its id here:\n'
    + '  npx wrangler hyperdrive create seb-backend --connection-string="$DATABASE_URL"\n\n'
    + 'Left as it is, the Worker deploys and then fails on its first query,\n'
    + 'which looks like the database being down rather than a missing binding.',
  )
  process.exit(1)
}

console.log(`${CONFIG}: every binding is a real id.`)
