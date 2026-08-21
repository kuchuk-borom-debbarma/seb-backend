import { env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import baseSchemaSql from '../database/schema.sql?raw'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends CloudflareBindings {
    AUTH_SECRET: string
    FRONTEND_ORIGINS: string
    AUTH_COOKIE_SAME_SITE: string
    APPLICANT_SIGNUP_TOKEN_ATTEMPT_COUNT: string
  }
}

const schemaStatements = baseSchemaSql
  .replace(/^--.*$/gmu, '')
  .split(';')
  .map((query) => query.trim())
  .filter(Boolean)

beforeAll(async () => {
  const prepared = schemaStatements.map((statement) => env.DB.prepare(statement))
  const [first, ...rest] = prepared
  if (!first) throw new Error('database/schema.sql did not contain any SQL statements.')
  await env.DB.batch([first, ...rest])
})
