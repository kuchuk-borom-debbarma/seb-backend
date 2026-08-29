/**
 * Loads `.env.local` and `.env` into the process for the database scripts.
 *
 * The Worker never reads these — deployed it speaks to Postgres only through
 * its Hyperdrive binding, and locally Wrangler does its own loading. This is
 * for the tooling that runs *outside* the Worker: creating a local database,
 * applying DDL to a deployed one. Those used to demand an exported
 * `DATABASE_URL`, which meant the one value an operator actually needs was
 * the one value no file would hold.
 *
 * Order matters and is not the read order: `process.loadEnvFile` never
 * overwrites a variable that is already set, so the real environment wins
 * over both files, and `.env.local` is loaded first so it wins over `.env` —
 * the same precedence Wrangler gives them.
 */
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const loadRepositoryEnv = () => {
  for (const name of ['.env.local', '.env']) {
    try {
      loadEnvFile(join(root, name))
    } catch {
      // Absent is an ordinary state for either file.
    }
  }
}
