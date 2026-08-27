import { defineConfig } from 'drizzle-kit'

/**
 * `database/schema.sql` is the schema, and there is no migration chain.
 *
 * Nothing is deployed and no database holds anything that has to survive, so
 * applying the schema means recreating it. `npm run db:schema:check` regenerates
 * that file and fails on any diff — which is what keeps it a description rather
 * than a second copy that can drift. `scripts/check-schema.mjs` says the same,
 * and `docs/rules/code.md` records why.
 *
 * **This used to claim the check covered a migration chain under `out`.** It
 * did not: `db:schema:check` runs `drizzle-kit export` and never reads that
 * directory, so a generated baseline sat there being neither checked nor
 * applied while `npm run check` passed green over it. The directory is gone;
 * `out` stays because `drizzle-kit generate --custom` is the escape hatch for a
 * hand-written data migration, and that is the day the chain begins.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './database/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
