/**
 * Builds the client, unless the last build is already newer than every input.
 *
 * The end-to-end suite tests the built artifact rather than the dev server, and
 * that is deliberate — Vite's dependency optimizer pre-bundles on first request,
 * and a cold dev server raced with the first navigation leaves the page
 * unhydrated. So the build stays; only rebuilding it every single run goes.
 *
 * ## What counts as an input
 *
 * Everything the build reads: `src/`, and the configuration files that decide
 * how it is assembled. Miss one and the suite silently tests a stale client,
 * which is the worst outcome available here — it looks exactly like everything
 * passing. When in doubt this rebuilds, because a wasted build costs seconds and
 * a wrong answer costs trust.
 *
 * Generated files under `src/` are inputs too: `routeTree.gen.ts` and the
 * GraphQL `generated/` directory are written by other steps, and a build that
 * predates them is out of date.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The newest modification time anywhere under a directory, or 0 if absent. */
const newestUnder = (directory) => {
  let newest = 0
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestUnder(path))
    } else {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs)
      } catch {
        // Vanished between the listing and the stat. Treat it as no evidence
        // rather than as a reason to fail.
      }
    }
  }
  return newest
}

const modified = (path) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// The server entry, not the directory: `.output` also holds `nitro.json`, which
// is rewritten by a `build:cf` and would make a Cloudflare build look like a
// current Node one.
const built = modified(join(root, '.output/server/index.mjs'))

const newestInput = Math.max(
  newestUnder(join(root, 'src')),
  ...[
    'vite.config.ts',
    'package.json',
    'tsconfig.json',
    'tsr.config.json',
  ].map((name) => modified(join(root, name))),
)

if (built > 0 && built > newestInput) {
  console.log('Client build is current; reusing .output.')
  process.exit(0)
}

console.log(built === 0 ? 'No client build yet; building.' : 'Client build is stale; rebuilding.')
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
