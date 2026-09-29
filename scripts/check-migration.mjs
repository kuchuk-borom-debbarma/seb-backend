#!/usr/bin/env node
/**
 * Rehearses the migration chain against seeded data, and asserts what survives.
 *
 * `db:schema:check` proves the chain's *destination* matches the Drizzle schema.
 * It says nothing about the journey, and the journey is where authorization data
 * can be silently lost: a migration that drops a column, or reorders a statement
 * past the constraint that validates it, applies cleanly and reports success.
 *
 * The failure this exists for is specific. `firstSuperAdminNeverGranted` closes
 * `/internal/bootstrap/first-super-admin` permanently by finding *any*
 * historical `SUPER_ADMIN` grant — revoked ones included. If a migration ever
 * moves, renames or drops the column that lock reads, the lock silently reads as
 * never-granted and an unauthenticated privilege-escalation endpoint reopens on
 * a live system. Nothing else in the build would notice: the schema would still
 * match, every test would still pass, and the endpoint would simply start
 * answering again.
 *
 * So the assertions below are about **retained authorization history**, not
 * about shape. They are deliberately written against the same predicates the
 * services use rather than against column names, so a rename that keeps the
 * meaning passes and one that loses it fails.
 *
 * Excluded from `fallow`'s health scores with the rest of `scripts/**`: running
 * it is the test.
 */
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const journal = JSON.parse(readFileSync('database/migrations/meta/_journal.json', 'utf8'))
const db = new PGlite()

/* The chain from nothing, in journal order — not `schema.sql`, which is the
 * destination and would skip every statement being rehearsed. */
const applied = []
for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
  try {
    await db.exec(readFileSync(`database/migrations/${entry.tag}.sql`, 'utf8'))
  } catch (error) {
    /*
     * A refusal here is usually ordering: a constraint added above the statement
     * that makes the existing rows satisfy it. Naming the migration and the
     * database's own message is enough to find it; the stack is not.
     */
    console.error(`Migration ${entry.tag} refused to apply against seeded data.`)
    console.error(`  ${error.message}`)
    process.exit(1)
  }
  applied.push(entry.tag)
  /*
   * Seeded after the baseline rather than at the end, because the rows have to
   * be *older* than the migrations under test. Seeding afterwards would rehearse
   * nothing: every statement would have already run against an empty table.
   */
  if (entry.idx === 0) await seed()
}

if (applied.length < 2) {
  console.error('Only the baseline exists, so this rehearses nothing. Has the chain been reset?')
  process.exit(1)
}

const failures = []
const assert = (what, condition) => {
  if (!condition) failures.push(what)
}

const one = async (sql) => (await db.query(sql)).rows[0]

/* ------------------------------------------------------------------ seeding */

/**
 * The grant shapes that carry meaning, seeded between the baseline and
 * everything after it — which is where a real database's rows already sit when
 * a new migration arrives.
 */
async function seed() {
  const user = async (id, email) => {
    await db.query(
      `INSERT INTO core_user (id, email, password_hash, email_verified_at, row_version,
         created_at, updated_at)
       VALUES ($1, $2, 'unused', now(), 1, now(), now())`,
      [id, email],
    )
  }
  // Both timestamps come from the database's `now()`. A revocation time taken
  // from the JS clock is read *before* the statement runs, so it lands a few
  // microseconds earlier than `granted_at` and the revocation check refuses it.
  const grant = async (id, userId, role, revoked) => {
    await db.query(
      `INSERT INTO core_user_role_grant (id, user_id, role, grant_reason, granted_at,
         revoked_at, revocation_reason)
       VALUES ($1, $2, $3, 'FIXTURE', now(),
         CASE WHEN $4::boolean THEN now() END, $5)`,
      [id, userId, role, revoked, revoked ? 'FIXTURE' : null],
    )
  }

  await user('u-demoted', 'demoted@example.test')
  await user('u-live-super', 'live@example.test')
  await user('u-admin-only', 'admin@example.test')
  await user('u-both', 'both@example.test')

  // The one that matters most: a super administrator whose grant was closed.
  // Bootstrap must stay shut on the strength of this row alone.
  await grant('g-demoted-super', 'u-demoted', 'SUPER_ADMIN', true)
  await grant('g-live-super', 'u-live-super', 'SUPER_ADMIN', false)
  await grant('g-admin-only', 'u-admin-only', 'ADMIN', false)
  await grant('g-both-applicant', 'u-both', 'APPLICANT', false)
  await grant('g-both-admin', 'u-both', 'ADMIN', false)
}

/* --------------------------------------------------------------- assertions */

/*
 * The bootstrap lock, written as the service writes it. A revoked grant still
 * closes it, which is why the seeded demoted super administrator is the subject.
 */
const bootstrap = await one(`
  SELECT NOT EXISTS (
    SELECT 1 FROM core_user_role_grant WHERE role = 'SUPER_ADMIN'
  ) AS never_granted`)
assert(
  'bootstrap has reopened: no historical SUPER_ADMIN grant is visible where the lock reads',
  bootstrap.never_granted === false,
)

/* Nothing is ever deleted from this table, only closed. Five seeded, five now. */
const grants = await one(`SELECT count(*)::int AS n FROM core_user_role_grant`)
assert(`grant rows lost: seeded 5, found ${grants.n}`, grants.n === 5)

/* The live super administrator is still live, and still reachable as one. */
const live = await one(`
  SELECT count(*)::int AS n FROM core_user_role_grant
   WHERE role = 'SUPER_ADMIN' AND revoked_at IS NULL`)
assert(`expected 1 active SUPER_ADMIN grant, found ${live.n}`, live.n === 1)

/* Every removed staff role is closed, and closed properly. */
const open = await one(`
  SELECT count(*)::int AS n FROM core_user_role_grant
   WHERE role IN ('REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER') AND revoked_at IS NULL`)
assert(`${open.n} grant(s) in the removed vocabulary are still active`, open.n === 0)

const closed = await one(`
  SELECT count(*)::int AS n FROM core_user_role_grant
   WHERE role IN ('REVIEWER', 'APPROVER', 'ADMIN', 'ANNOUNCER')
     AND (revocation_reason IS NULL OR revoked_at IS NULL)`)
assert(`${closed.n} removed-role grant(s) were closed without a reason or a time`, closed.n === 0)

/*
 * An applicant keeps their access. Nothing can grant `APPLICANT` back, so
 * closing one here would strand that person permanently.
 */
const applicant = await one(`
  SELECT count(*)::int AS n FROM core_user_role_grant
   WHERE role = 'APPLICANT' AND revoked_at IS NULL`)
assert(`expected 1 active APPLICANT grant, found ${applicant.n}`, applicant.n === 1)

/* ------------------------------------------------------------------ verdict */

await db.close()

if (failures.length) {
  console.error(`Migration rehearsal failed after ${applied.join(', ')}:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(
  `Migration rehearsal passed: ${applied.length} migration(s) applied ` +
    `(${applied.join(', ')}), authorization history intact.`,
)
