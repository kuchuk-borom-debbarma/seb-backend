import { defineConfig } from 'drizzle-kit'
import { loadRepositoryEnv } from './scripts/load-env.mjs'

/**
 * `database/schema.sql` is the schema's canonical description, and
 * `npm run db:schema:check` is what keeps it one — it regenerates the file
 * from this schema and fails on any diff, so the SQL can never drift into a
 * second opinion.
 *
 * A deployed database exists now, so changes reach it as an ordered chain
 * under `out`: `npm run db:generate` writes the next migration from this
 * schema's diff against the chain, and `npm run db:migrate` applies what the
 * database `DATABASE_URL` names has not seen. The chain began after the first
 * deployment, so `0000_baseline` describes the shape that was already there —
 * `npm run db:baseline` marks it applied rather than running it.
 *
 * `drizzle-kit push` is deliberately not offered. Rehearsed against a copy of
 * the deployed schema it planned to drop `seb_application_case_id_uq`, a
 * unique index two foreign keys depend on — its introspection reads this
 * schema's FK-referenced `uniqueIndex` columns as constraints to rebuild, and
 * it applies statement by statement with no transaction around the plan.
 *
 * Local scratch databases still recreate via `db:setup:local`, which is
 * cheaper than migrating and cannot leave an old shape behind.
 */
loadRepositoryEnv()

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './database/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
