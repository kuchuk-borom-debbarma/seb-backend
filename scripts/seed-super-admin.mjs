/**
 * Creates a local super administrator so development can start immediately.
 *
 * The one-time curl bootstrap is the only way the *first* administrator can be
 * created, and it closes permanently once any `SUPER_ADMIN` grant has ever
 * existed. That is deliberate, and it means a database that has already been
 * bootstrapped cannot use it again. Every later administrator is supposed to be
 * granted by an existing super administrator through the `access` namespace.
 *
 * This script exists for the case in between: a local database where bootstrap
 * is already spent and you do not have a super administrator to hand. It writes
 * the account directly, using the same password hashing the Worker uses, so the
 * result is indistinguishable from a real signup plus a real grant.
 *
 * Development only. It bypasses email verification and the grant audit trail,
 * so it must never be pointed at a deployed environment.
 *
 *   node scripts/seed-super-admin.mjs <email> <password> [--persist-to <dir>]
 */
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { scrypt } from '@noble/hashes/scrypt.js'

// These must match `src/services/auth/crypto.ts` exactly. A mismatch produces a
// hash the Worker will refuse rather than one it merely disagrees with.
const SCRYPT_VERSION = 1
const SCRYPT_N = 16_384
const SCRYPT_R = 16
const SCRYPT_P = 1
const SCRYPT_KEY_LENGTH = 64

const toBase64Url = (bytes) =>
  Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

const hashPassword = (password) => {
  const salt = randomBytes(16)
  const key = scrypt(new TextEncoder().encode(password), salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_KEY_LENGTH,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  })
  return [
    'scrypt',
    SCRYPT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    toBase64Url(salt),
    toBase64Url(key),
  ].join('$')
}

const [email, password] = process.argv.slice(2)
if (!email || !password) {
  throw new Error('Usage: node scripts/seed-super-admin.mjs <email> <password>')
}

const persistIndex = process.argv.indexOf('--persist-to')
const persistTo = persistIndex > -1 ? process.argv[persistIndex + 1] : null

/**
 * One statement per call.
 *
 * `wrangler d1 execute --command` does not reliably apply a multi-statement
 * script, which left a half-seeded account behind the first time this ran.
 */
const execute = (sql, extra = []) => {
  const args = ['wrangler', 'd1', 'execute', 'DB', '--local', '--command', sql, ...extra]
  if (persistTo) args.push('--persist-to', persistTo)
  return execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

const run = (sql) => {
  execute(sql)
}

const query = (sql) => JSON.parse(execute(sql, ['--json']))[0].results

const now = Date.now()
const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`
const address = quoted(email.trim().toLowerCase())
const hash = quoted(hashPassword(password))

/*
 * Updated in place rather than replaced.
 *
 * `core_user` is referenced by retained history — grants, audit events,
 * consumed signup challenges — through RESTRICT foreign keys, because the
 * product deliberately never loses track of who did what. Deleting the row is
 * therefore refused, and rightly so. Re-running this simply resets the password
 * and makes sure both roles are active.
 */
const existing = query(`SELECT id FROM core_user WHERE email = ${address}`)
const userId = existing[0]?.id ?? randomUUID()

if (existing.length > 0) {
  run(
    `UPDATE core_user
     SET password_hash = ${hash}, email_verified_at = ${now}, deleted_at = NULL, updated_at = ${now}
     WHERE id = ${quoted(userId)}`,
  )
} else {
  run(
    `INSERT INTO core_user (id, email, password_hash, email_verified_at, row_version, created_at, updated_at)
     VALUES (${quoted(userId)}, ${address}, ${hash}, ${now}, 1, ${now}, ${now})`,
  )
}

/*
 * Both roles. APPLICANT lets the same account walk the applicant journey and
 * SUPER_ADMIN lets it administer, which is what makes one seeded account enough
 * to exercise the whole product locally.
 *
 * `granted_by_user_id` is left null — the same marker the Worker uses for a
 * trusted system transition rather than an action by another portal user. The
 * partial unique index allows only one active grant per role, so an existing
 * one is left alone rather than duplicated.
 */
for (const role of ['APPLICANT', 'SUPER_ADMIN']) {
  const held = query(
    `SELECT id FROM core_user_role_grant
     WHERE user_id = ${quoted(userId)} AND role = '${role}' AND revoked_at IS NULL`,
  )
  if (held.length > 0) continue
  run(
    `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at)
     VALUES (${quoted(randomUUID())}, ${quoted(userId)}, '${role}', 'LOCAL_DEVELOPMENT_SEED', ${now})`,
  )
}

console.log(`Seeded ${email} with APPLICANT and SUPER_ADMIN.`)
