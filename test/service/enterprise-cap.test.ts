/**
 * The enterprise cap and per-owner name uniqueness, as SQL enforces them.
 *
 * Against a real Postgres and past the service layer entirely, because the
 * controller's count is not the guard that matters here. Two requests arriving
 * together both read "four of five" and both pass the controller; only the
 * predicate inside the insert can refuse the second, so only the predicate is
 * worth a test.
 */
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let db: PGlite

/** The predicate `insertEnterpriseAggregate` carries, and nothing else. */
const register = async (id: string, name: string, limit: number): Promise<number> => {
  const result = await db.query<{ id: string }>(
    `INSERT INTO seb_enterprise
       (id, portal_owner_user_id, current_name, registration_type, registration_number,
        gstin, status, current_version, created_at, updated_at,
        deleted_at, deleted_by_user_id, delete_reason)
     SELECT $1, 'u1', $2, 'SOLE_PROPRIETORSHIP', NULL, NULL, 'PROPOSED', 1, now(), now(), NULL, NULL, NULL
     WHERE (
       SELECT count(*)::int FROM seb_enterprise
       WHERE portal_owner_user_id = 'u1' AND deleted_at IS NULL
     ) < $3
     RETURNING id`,
    [id, name, limit],
  )
  return result.rows.length
}

beforeEach(async () => {
  db = new PGlite()
  await db.exec(readFileSync('database/schema.sql', 'utf8'))
  await db.query(
    `INSERT INTO core_user (id, email, password_hash, display_name, created_at, updated_at)
     VALUES ('u1', 'a@b.c', 'x', 'A', now(), now()),
            ('u2', 'd@e.f', 'x', 'B', now(), now())`,
  )
})

afterEach(async () => {
  await db.close()
})

describe('how many enterprises one applicant may hold', () => {
  it('accepts up to the limit and refuses the next', async () => {
    expect(await register('e1', 'One', 3)).toBe(1)
    expect(await register('e2', 'Two', 3)).toBe(1)
    expect(await register('e3', 'Three', 3)).toBe(1)
    // Refused by the predicate, not by an exception: a losing writer writes
    // nothing and the caller turns zero rows into a refusal.
    expect(await register('e4', 'Four', 3)).toBe(0)
  })

  it('counts only live enterprises, so deleting one frees a slot', async () => {
    await register('e1', 'One', 2)
    await register('e2', 'Two', 2)
    expect(await register('e3', 'Three', 2)).toBe(0)
    await db.query(`UPDATE seb_enterprise SET deleted_at = now() WHERE id = 'e1'`)
    expect(await register('e3', 'Three', 2)).toBe(1)
  })

  it('is per owner, not across the programme', async () => {
    await register('e1', 'One', 1)
    expect(await register('e2', 'Two', 1)).toBe(0)
    const other = await db.query<{ id: string }>(
      `INSERT INTO seb_enterprise
         (id, portal_owner_user_id, current_name, registration_type, registration_number,
          gstin, status, current_version, created_at, updated_at,
          deleted_at, deleted_by_user_id, delete_reason)
       SELECT 'e3', 'u2', 'Two', 'SOLE_PROPRIETORSHIP', NULL, NULL, 'PROPOSED', 1, now(), now(),
              NULL, NULL, NULL
       WHERE (
         SELECT count(*)::int FROM seb_enterprise
         WHERE portal_owner_user_id = 'u2' AND deleted_at IS NULL
       ) < 1
       RETURNING id`,
    )
    expect(other.rows.length).toBe(1)
  })
})

describe('what makes two enterprise names the same', () => {
  it('refuses the same name in a different case, for one owner', async () => {
    await register('e1', 'Sri Devi Handlooms', 9)
    await expect(register('e2', 'SRI DEVI HANDLOOMS', 9)).rejects.toThrow(
      /seb_enterprise_owner_name/u,
    )
  })

  it('allows two owners the same trading name', async () => {
    await register('e1', 'Sri Devi Handlooms', 9)
    const other = await db.query<{ id: string }>(
      `INSERT INTO seb_enterprise
         (id, portal_owner_user_id, current_name, registration_type, registration_number,
          gstin, status, current_version, created_at, updated_at,
          deleted_at, deleted_by_user_id, delete_reason)
       VALUES ('e2', 'u2', 'Sri Devi Handlooms', 'SOLE_PROPRIETORSHIP', NULL, NULL, 'PROPOSED', 1,
               now(), now(), NULL, NULL, NULL)
       RETURNING id`,
    )
    expect(other.rows.length).toBe(1)
  })

  it('frees the name when the enterprise is deleted', async () => {
    await register('e1', 'Sri Devi Handlooms', 9)
    await db.query(`UPDATE seb_enterprise SET deleted_at = now() WHERE id = 'e1'`)
    expect(await register('e2', 'sri devi handlooms', 9)).toBe(1)
  })
})
