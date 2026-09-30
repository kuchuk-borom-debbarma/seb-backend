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
 * `0003` is rehearsed the same way: a legacy workflow graph is seeded just
 * before it runs, and afterwards the QA data is gone, what the plan keeps is
 * kept, the retired permission grants are gone, a second run changes nothing,
 * and the chain's destination is exactly `database/schema.sql`.
 *
 * Excluded from `fallow`'s health scores with the rest of `scripts/**`: running
 * it is the test.
 */
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const journal = JSON.parse(readFileSync('database/migrations/meta/_journal.json', 'utf8'))
const db = new PGlite()

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

  await seedAuditHistory()
}

/**
 * Audit rows as the baseline wrote them: twelve columns, loose metadata text.
 *
 * One per derivation `0002` makes without an application graph, plus two whose
 * entity no longer exists — the case a backfill that guessed would get wrong.
 * The application derivations are proved against real flows in
 * `test/service/audit-backfill.test.ts`, where the services build the rows.
 */
async function seedAuditHistory() {
  const legacy = async (id, entityType, entityId, actorUserId) => {
    await db.query(
      `INSERT INTO core_audit_event (id, actor_user_id, action, entity_type, entity_id, outcome,
         request_id, ip_address, user_agent, changes_json, metadata_json, created_at)
       VALUES ($1, $2, 'AUTH.FIXTURE', $3, $4, 'SUCCESS', NULL, NULL, NULL, NULL,
         '{"note":"recorded before 0002"}', now())`,
      [id, actorUserId, entityType, entityId],
    )
  }
  await legacy('a-user', 'CORE_USER', 'u-demoted', null)
  await legacy('a-grant', 'CORE_USER_ROLE_GRANT', 'g-both-applicant', 'u-live-super')
  await legacy('a-session', 'CORE_SESSION', 's-gone', 'u-admin-only')
  await legacy('a-dangling-user', 'CORE_USER', 'u-never-existed', null)
  await legacy('a-dangling-application', 'SEB_APPLICATION', 'app-never-existed', 'u-both')
}


/* -------------------------------------------------------- audit history (0002) */

/*
 * Run right after 0002 applies, because re-running 0002 is only meaningful
 * against the schema it was written for: 0003 drops tables its backfill reads.
 */
async function rehearseAuditHistory() {

  const audit = async (id) =>
    one(`SELECT subject_user_id, application_id, payload, payload_version, metadata_json
           FROM core_audit_event WHERE id = '${id}'`)

  /* Each derivation, from the entity the row already named. */
  assert('a CORE_USER row did not take its user as subject', (await audit('a-user')).subject_user_id === 'u-demoted')
  assert(
    "a grant row did not take the grant holder as subject (it must not be the actor who granted it)",
    (await audit('a-grant')).subject_user_id === 'u-both',
  )
  assert('a session row did not take its owner as subject', (await audit('a-session')).subject_user_id === 'u-admin-only')

  /* A dangling id stays unknown rather than becoming a guess. */
  for (const id of ['a-dangling-user', 'a-dangling-application']) {
    const row = await audit(id)
    assert(`${id}: derived something from an entity that does not exist`, row.subject_user_id === null && row.application_id === null)
  }

  /* Nothing recorded was rewritten, and every old row reads as the legacy generation. */
  const legacyRows = await one(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE metadata_json = '{"note":"recorded before 0002"}'
                              AND payload IS NULL AND payload_version = 0)::int AS intact
      FROM core_audit_event`)
  assert(
    `legacy audit rows were rewritten: ${legacyRows.intact} of ${legacyRows.n} still read exactly as recorded`,
    legacyRows.n === 5 && legacyRows.intact === 5,
  )

  /*
   * The deploy window. The Worker that is live while 0002 runs names only the
   * original twelve columns; its insert must still land, and read as legacy,
   * because it shares a transaction with the business write it records.
   */
  try {
    await db.query(`
      INSERT INTO core_audit_event (id, actor_user_id, action, entity_type, entity_id, outcome,
        request_id, ip_address, user_agent, changes_json, metadata_json, created_at)
      VALUES ('a-window', NULL, 'AUTH.FIXTURE', 'CORE_USER', 'u-both', 'SUCCESS',
        NULL, NULL, NULL, NULL, NULL, now())`)
    assert('an old-Worker insert did not read as legacy', (await audit('a-window')).payload_version === 0)
  } catch (error) {
    assert(`an insert naming only the original columns is refused after 0002: ${error.message}`, false)
  }

  /*
   * Idempotency. Running 0002 again — the supported way to fill rows the old
   * Worker wrote during the deploy — must change nothing but those rows. The
   * window row above is exactly such a row, so it is the one thing allowed to
   * move: it gains its subject. Everything else, and the table's constraints and
   * indexes, must be identical.
   */
  const fingerprint = async () =>
    one(`
      SELECT
        (SELECT md5(string_agg(e::text, '|' ORDER BY e.id)) FROM core_audit_event e WHERE e.id <> 'a-window') AS rows,
        (SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname)
           FROM pg_constraint WHERE conrelid = 'core_audit_event'::regclass) AS constraints,
        (SELECT string_agg(indexdef, ',' ORDER BY indexname)
           FROM pg_indexes WHERE tablename = 'core_audit_event') AS indexes`)
  const firstRun = await fingerprint()
  try {
    await db.exec(readFileSync('database/migrations/0002_audit_history.sql', 'utf8'))
  } catch (error) {
    assert(`0002 is not idempotent — a second run was refused: ${error.message}`, false)
  }
  const secondRun = await fingerprint()
  assert('0002 is not idempotent — a second run changed existing rows', firstRun.rows === secondRun.rows)
  assert('0002 is not idempotent — a second run changed the constraints', firstRun.constraints === secondRun.constraints)
  assert('0002 is not idempotent — a second run changed the indexes', firstRun.indexes === secondRun.indexes)
  assert(
    'running 0002 again did not fill the row the old Worker wrote during the deploy',
    (await audit('a-window')).subject_user_id === 'u-both',
  )

}

/* ------------------------------------------------------------ pipelines (0003) */

/**
 * A QA-era workflow graph, in the shape 0002 left it: an applicant, their
 * enterprise and funding case, an open cycle with a version, a submitted
 * application with a version, an audit row naming the application, and a
 * composed role holding both retired and surviving permissions.
 */
async function seedLegacyWorkflow() {
  await db.exec(`
    INSERT INTO core_user (id, email, password_hash, email_verified_at, row_version, created_at, updated_at)
      VALUES ('u-applicant', 'applicant@example.test', 'unused', now(), 1, now(), now());
    INSERT INTO seb_enterprise (id, portal_owner_user_id, current_name, registration_type, current_version, created_at, updated_at)
      VALUES ('e-qa', 'u-applicant', 'QA Enterprise', 'SOLE_PROPRIETORSHIP', 1, now(), now());
    INSERT INTO seb_funding_case (id, enterprise_id, current_version, created_at, updated_at)
      VALUES ('fc-qa', 'e-qa', 1, now(), now());
    INSERT INTO seb_programme_cycle (id, cycle_code, display_name, cycle_year, status, current_version, created_at, updated_at)
      VALUES ('c-qa', 'QA-2025', 'QA cycle', 2025, 'OPEN', 1, now(), now());
    INSERT INTO seb_programme_cycle_version (id, programme_cycle_id, version, cycle_code, display_name, cycle_year,
        status, expansion_wait_months, change_type, created_at)
      VALUES ('cv-qa', 'c-qa', 1, 'QA-2025', 'QA cycle', 2025, 'OPEN', 12, 'CREATED', now());
    INSERT INTO seb_application (id, applicant_user_id, enterprise_id, funding_case_id, programme_cycle_id,
        application_type, phase_number, reference_number, current_version, created_at, updated_at,
        status, status_version, status_changed_at)
      VALUES ('app-qa', 'u-applicant', 'e-qa', 'fc-qa', 'c-qa', 'INITIAL', 1, 'SEP-QA', 1, now(), now(),
        'DESK_REVIEW', 2, now());
    INSERT INTO seb_application_version (id, application_id, version, programme_cycle_id, programme_cycle_version,
        application_type, phase_number, change_type, changed_by_user_id, created_at)
      VALUES ('av-qa', 'app-qa', 1, 'c-qa', 1, 'INITIAL', 1, 'SUBMISSION', 'u-applicant', now());
    INSERT INTO core_audit_event (id, actor_user_id, action, entity_type, entity_id, outcome,
        request_id, ip_address, user_agent, changes_json, metadata_json, created_at, application_id)
      VALUES ('a-qa-application', 'u-applicant', 'SEB.APPLICATION_SUBMITTED', 'SEB_APPLICATION', 'app-qa',
        'SUCCESS', NULL, NULL, NULL, NULL, NULL, now(), 'app-qa');
    INSERT INTO core_role (id, key, name, description, current_version, created_at, updated_at, created_by_user_id)
      VALUES ('r-office', 'OFFICE_QA', 'Office', 'Works applications.', 1, now(), now(), 'u-live-super');
    INSERT INTO core_role_permission (id, role_id, resource, action, created_at) VALUES
      ('p-read', 'r-office', 'application', 'read', now()),
      ('p-note', 'r-office', 'application', 'note', now()),
      ('p-review', 'r-office', 'application', 'review', now()),
      ('p-refer', 'r-office', 'application', 'refer', now()),
      ('p-decide', 'r-office', 'decision', 'record', now()),
      ('p-award', 'r-office', 'funding', 'award', now()),
      ('p-recover', 'r-office', 'recovery', 'open', now()),
      ('p-announce', 'r-office', 'announcement', 'read', now());
  `)
}

/** Columns, constraints and indexes of the public schema, order-insensitive. */
const shapeOf = async (database) => {
  const rows = async (sql) => (await database.query(sql)).rows.map((row) => Object.values(row).join(' ')).sort()
  return {
    columns: await rows(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, coalesce(column_default, '')
        FROM information_schema.columns WHERE table_schema = 'public'`),
    constraints: await rows(`
      SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace`),
    indexes: await rows(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`),
  }
}

async function rehearsePipelines() {
  const count = async (table) => (await one(`SELECT count(*)::int AS n FROM ${table}`)).n

  /* The QA data is gone; what the plan keeps is kept. */
  for (const table of ['seb_application', 'seb_application_version', 'seb_programme_cycle', 'seb_programme_cycle_version']) {
    assert(`0003 left rows in ${table}`, (await count(table)) === 0)
  }
  assert('0003 removed the enterprise', (await count(`seb_enterprise WHERE id = 'e-qa'`)) === 1)
  assert('0003 removed the funding case', (await count(`seb_funding_case WHERE id = 'fc-qa'`)) === 1)
  assert('0003 removed a user', (await count(`core_user WHERE id = 'u-applicant'`)) === 1)
  const history = await one(`SELECT application_id FROM core_audit_event WHERE id = 'a-qa-application'`)
  assert('0003 rewrote or removed the activity history of a removed application', history?.application_id === 'app-qa')

  /* Retired permissions are gone; the role keeps everything else it held. */
  const permissions = (await db.query(
    `SELECT resource || ':' || action AS pair FROM core_role_permission WHERE role_id = 'r-office' ORDER BY 1`,
  )).rows.map((row) => row.pair)
  assert(
    `0003 kept the wrong permissions: ${permissions.join(', ')}`,
    permissions.join(',') === 'announcement:read,application:note,application:read',
  )

  /* The old workflow's tables and columns are gone. */
  for (const table of ['seb_desk_review', 'seb_partner_bank_referral', 'seb_programme_decision', 'seb_funding_award',
    'seb_disbursement', 'seb_recovery_case', 'seb_application_qualifying_award', 'seb_application_assignment_event',
    'seb_programme_cycle_reason', 'seb_programme_cycle_identifier_rule']) {
    assert(`0003 left ${table}`, (await one(`SELECT to_regclass('public.${table}') IS NULL AS gone`)).gone === true)
  }
  const legacyColumns = await one(`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name IN ('application_type', 'assigned_to_user_id', 'partner_bank_guidance',
                           'expansion_wait_months', 'reason_category_id', 'prior_sanction_order_number')`)
  assert(`0003 left ${legacyColumns.n} legacy column(s)`, legacyColumns.n === 0)

  /*
   * Idempotency, including the guard on the data removal: rows written in the
   * new shape after the first run must survive a second one.
   */
  await db.exec(`
    INSERT INTO seb_pipeline (id, key, name, description, created_at, created_by_user_id, updated_at)
      VALUES ('pl-new', 'STANDARD', 'Standard', '', now(), 'u-live-super', now());
    INSERT INTO seb_programme_cycle (id, cycle_code, display_name, cycle_year, status, current_version, created_at, updated_at)
      VALUES ('c-new', 'NEW-2026', 'New cycle', 2026, 'DRAFT', 1, now(), now());
    INSERT INTO seb_programme_cycle_version (id, programme_cycle_id, version, cycle_code, display_name, cycle_year,
        status, change_type, created_at, pipeline_id)
      VALUES ('cv-new', 'c-new', 1, 'NEW-2026', 'New cycle', 2026, 'DRAFT', 'CREATED', now(), 'pl-new');
  `)
  const before = await shapeOf(db)
  const rowsBefore = await one(`
    SELECT (SELECT count(*)::int FROM seb_programme_cycle) AS cycles,
           (SELECT count(*)::int FROM core_role_permission) AS permissions`)
  try {
    await db.exec(readFileSync('database/migrations/0003_pipelines.sql', 'utf8'))
  } catch (error) {
    assert(`0003 is not idempotent — a second run was refused: ${error.message}`, false)
  }
  const after = await shapeOf(db)
  const rowsAfter = await one(`
    SELECT (SELECT count(*)::int FROM seb_programme_cycle) AS cycles,
           (SELECT count(*)::int FROM core_role_permission) AS permissions`)
  assert('0003 is not idempotent — a second run deleted rows written in the new shape',
    rowsBefore.cycles === rowsAfter.cycles && rowsBefore.permissions === rowsAfter.permissions)
  for (const part of ['columns', 'constraints', 'indexes']) {
    assert(`0003 is not idempotent — a second run changed the ${part}`,
      JSON.stringify(before[part]) === JSON.stringify(after[part]))
  }

  /*
   * The chain's destination is `schema.sql`. `db:schema:check` proves the file
   * matches the Drizzle schema; this proves the migrations arrive at the same
   * place, so a hand-hardened statement cannot quietly diverge from it.
   */
  const reference = new PGlite()
  await reference.exec(readFileSync('database/schema.sql', 'utf8'))
  const expected = await shapeOf(reference)
  await reference.close()
  for (const part of ['columns', 'constraints', 'indexes']) {
    const missing = expected[part].filter((entry) => !after[part].includes(entry))
    const extra = after[part].filter((entry) => !expected[part].includes(entry))
    assert(
      `the migration chain does not arrive at schema.sql (${part}):`
        + missing.slice(0, 5).map((entry) => `\n    missing ${entry}`).join('')
        + extra.slice(0, 5).map((entry) => `\n    extra   ${entry}`).join(''),
      missing.length === 0 && extra.length === 0,
    )
  }
}


/* The chain from nothing, in journal order — not `schema.sql`, which is the
 * destination and would skip every statement being rehearsed. */
const applied = []
for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
  if (entry.tag === '0003_pipelines') await seedLegacyWorkflow()
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
  if (entry.tag === '0002_audit_history') await rehearseAuditHistory()
}
if (applied.includes('0003_pipelines')) await rehearsePipelines()

if (applied.length < 2) {
  console.error('Only the baseline exists, so this rehearses nothing. Has the chain been reset?')
  process.exit(1)
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
    `(${applied.join(', ')}), authorization history intact, audit history derived, 0002 and 0003 idempotent, ` +
    'and the chain arrives at schema.sql.',
)
