/**
 * Gives the end-to-end suite a clean database of its own.
 *
 * Wrangler's `--persist-to` keeps this entirely separate from `.wrangler`, so
 * running the tests never disturbs the data behind `npm run local`.
 *
 * Deliberately the same two steps a real database goes through — apply the
 * baseline, then record every migration as already contained in it — so the
 * suite proves the actual setup path works rather than a shortcut that only
 * exists here.
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
    // The development configuration, which is what the suite's Worker runs on.
    // `--persist-to` keys the database by the binding's identity, so a
    // different config here would prepare a database the Worker never opens.
    '--config', 'wrangler.dev.jsonc',
    '--local',
    '--persist-to', stateDirectory,
    '--file=database/schema.sql',
  ],
  { stdio: 'inherit' },
)

execFileSync(
  process.execPath,
  ['--no-warnings', 'scripts/migrate.mjs', '--stamp', `--persist-to=${stateDirectory}`],
  { stdio: 'inherit' },
)
