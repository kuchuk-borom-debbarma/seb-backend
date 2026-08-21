import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import initialMigrationSql from '../migrations/0001_applicant_auth.sql?raw'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends CloudflareBindings {
    AUTH_SECRET: string
    FRONTEND_ORIGINS: string
    AUTH_COOKIE_SAME_SITE: string
    APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT: string
  }
}

const migration = (name: string, source: string) => ({
  name,
  queries: source
    .replace(/^--.*$/gmu, '')
    .split(';')
    .map((query) => query.trim())
    .filter(Boolean),
})

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    migration('0001_applicant_auth.sql', initialMigrationSql),
  ])
})
