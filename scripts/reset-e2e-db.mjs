/**
 * Gives the end-to-end suite a clean database of its own.
 *
 * Wrangler's `--persist-to` keeps this entirely separate from `.wrangler`, so
 * running the tests never disturbs the data behind `npm run local`. The schema
 * is the same canonical file a new deployment applies, which means the suite
 * also proves that file still creates a working database.
 */
import { rm, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const stateDirectory = 'dev-web/.playwright/state'

await rm(stateDirectory, { recursive: true, force: true })
await mkdir(stateDirectory, { recursive: true })

execFileSync(
  'npx',
  [
    'wrangler', 'd1', 'execute', 'DB',
    '--local',
    '--persist-to', stateDirectory,
    '--file=database/schema.sql',
  ],
  { stdio: 'inherit' },
)
