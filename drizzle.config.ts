import { loadEnvFile } from 'node:process'
import { defineConfig } from 'drizzle-kit'

/**
 * `database/schema.sql` is the schema's canonical description, and
 * `npm run db:schema:check` is what keeps it one — it regenerates the file
 * from this schema and fails on any diff, so the SQL can never drift into a
 * second opinion.
 *
 * Databases are built and changed by the ordered chain under `out`, and by
 * nothing else: `npm run db:generate` writes the next migration from this
 * schema's diff against the chain, and `npm run db:migrate` applies what the
 * database `DATABASE_URL` names has not seen. The chain was collapsed to a
 * single `0000_baseline` while the programme was still in development — every
 * database that existed was first migrated to that shape and had its
 * bookkeeping re-marked by hand, a rewrite the chain's own header forecloses
 * from repeating now that real state exists. On an empty database the chain
 * builds everything, seed row included.
 *
 * `drizzle-kit push` is deliberately not offered. Rehearsed against a copy of
 * the deployed schema it planned to drop `seb_application_case_id_uq`, a
 * unique index two foreign keys depend on — its introspection reads this
 * schema's FK-referenced `uniqueIndex` columns as constraints to rebuild, and
 * it applies statement by statement with no transaction around the plan.
 *
 * The env files are loaded here so `DATABASE_URL` can live in `.env.local`
 * rather than demand an export. `loadEnvFile` never overwrites a variable
 * already set, so the real environment wins over both files, and `.env.local`
 * is loaded first so it wins over `.env` — the same precedence Wrangler
 * gives them. npm runs scripts from the package root, which is where both
 * files and this config live.
 */
for (const name of ['.env.local', '.env']) {
  try {
    loadEnvFile(name)
  } catch {
    // Absent is an ordinary state for either file.
  }
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './database/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
