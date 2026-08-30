/**
 * The announcement banner: who may write it, what the public may read, and
 * what the guards refuse.
 *
 * Everything drives the real GraphQL surface. Raw SQL appears only to read
 * `core_audit_event` back, which no mutation exposes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabase, freshDatabase, resetDatabase } from '../support/harness'
import { env } from '../support/worker'
import { graphql, signIn } from '../support/api'

beforeAll(async () => { await freshDatabase() })
beforeEach(async () => { await resetDatabase() })
afterAll(async () => { await closeDatabase() })

const PERMISSION = 'You do not have permission to do that.'
const STALE = 'The record changed. Reload and try again.'
const BOARD_MISMATCH = 'The board changed. Reload and try again.'

const CARD_FIELDS = `id tag dateLabel title body icon link { kind target }
  endsAt published sortOrder currentVersion`

const create = (cookie: string | undefined, overrides: Record<string, unknown> = {}) =>
  graphql<any>(`mutation($input: AnnouncementInput!) {
    admin { announcement { create(input: $input) {
      success message response { ${CARD_FIELDS} }
    } } }
  }`, { input: {
    tag: 'Notice',
    dateLabel: 'Aug 2026',
    title: 'Applications open',
    body: 'Online registration is active.',
    icon: 'MEGAPHONE',
    published: true,
    ...overrides,
  } }, cookie)

const board = (cookie?: string) => graphql<any>(`query {
  admin { announcement { board {
    success message response { boardVersion announcements { ${CARD_FIELDS} } }
  } } }
}`, {}, cookie)

const publicBanner = () => graphql<any>(`query {
  public { announcementBanner {
    success message response { announcements { id tag dateLabel title body icon link { kind target } } }
  } }
}`)

const auditRows = async (action: string) =>
  env.DB.prepare(
    `SELECT actor_user_id AS actor, entity_type AS "entityType", entity_id AS "entityId",
       metadata_json AS metadata
     FROM core_audit_event WHERE action = ? ORDER BY created_at`,
  ).bind(action).all() as Promise<{ results: Array<Record<string, string | null>> }>

describe('the public banner', () => {
  it('answers an anonymous caller, and an empty board is an ordinary answer', async () => {
    const read = await publicBanner()
    expect(read.errors).toBeUndefined()
    expect(read.data.public.announcementBanner).toMatchObject({
      success: true,
      response: { announcements: [] },
    })
  })

  it('shows only published cards that have not passed their end time', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const live = await create(announcer.cookie, { title: 'Live card' })
    expect(live.data.admin.announcement.create.success,
      live.data.admin.announcement.create.message ?? '').toBe(true)
    await create(announcer.cookie, { title: 'Hidden draft', published: false })
    await create(announcer.cookie, {
      title: 'Expired card',
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await create(announcer.cookie, {
      title: 'Future-dated card',
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const removedCard = await create(announcer.cookie, { title: 'Withdrawn card' })
    const removedId = removedCard.data.admin.announcement.create.response.id
    await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $reason: String!) {
      admin { announcement { remove(id: $id, expectedVersion: $expectedVersion, reason: $reason) { success message } } }
    }`, { id: removedId, expectedVersion: 1, reason: 'No longer true.' }, announcer.cookie)

    const read = await publicBanner()
    const titles = read.data.public.announcementBanner.response.announcements
      .map((card: { title: string }) => card.title)
    expect(titles).toEqual(['Live card', 'Future-dated card'])
  })

  it('carries the link and a null date label exactly as authored', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    await create(announcer.cookie, {
      title: 'Read the order',
      dateLabel: null,
      link: { kind: 'EXTERNAL', target: 'https://ttaadc.gov.in/order.pdf' },
    })
    const read = await publicBanner()
    expect(read.data.public.announcementBanner.response.announcements[0]).toMatchObject({
      dateLabel: null,
      link: { kind: 'EXTERNAL', target: 'https://ttaadc.gov.in/order.pdf' },
    })
  })
})

describe('who may write the banner', () => {
  it('admits the announcer and the super administrator, and nobody else', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    expect((await board(announcer.cookie)).data.admin.announcement.board.success).toBe(true)
    expect((await create(announcer.cookie)).data.admin.announcement.create.success).toBe(true)

    const superAdmin = await signIn(['SUPER_ADMIN'])
    expect((await create(superAdmin.cookie)).data.admin.announcement.create.success).toBe(true)

    for (const roles of [['ADMIN'], ['REVIEWER'], ['APPLICANT']] as const) {
      const refused = await signIn([...roles])
      expect((await board(refused.cookie)).data.admin.announcement.board,
        roles.join()).toMatchObject({ success: false, message: PERMISSION })
      expect((await create(refused.cookie)).data.admin.announcement.create,
        roles.join()).toMatchObject({ success: false, message: PERMISSION })
    }
    expect((await board(undefined)).data.admin.announcement.board)
      .toMatchObject({ success: false, message: PERMISSION })
  })

  it('gives the announcer nothing beyond the banner', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const queue = await graphql<any>(`query {
      admin { intake { queues { success message } } }
    }`, {}, announcer.cookie)
    expect(queue.data.admin.intake.queues).toMatchObject({
      success: false, message: PERMISSION,
    })
  })

  it('is granted and invited by a super administrator, and never by an admin', async () => {
    const superAdmin = await signIn(['SUPER_ADMIN'])
    const admin = await signIn(['ADMIN'])
    const applicant = await signIn(['APPLICANT'])

    const invite = (cookie: string) => graphql<any>(`mutation($input: InviteRoleInput!) {
      access { inviteRole(input: $input) { success message } }
    }`, { input: {
      userId: applicant.userId, role: 'ANNOUNCER', reason: 'Joining communications.',
    } }, cookie)

    const ceiling = await invite(admin.cookie)
    expect(ceiling.data.access.inviteRole.success).toBe(false)

    const issued = await invite(superAdmin.cookie)
    expect(issued.data.access.inviteRole.success,
      issued.data.access.inviteRole.message ?? '').toBe(true)
  })
})

describe('what a card may say', () => {
  it('refuses each field past its cap, naming the field', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ tag: '   ' }, 'Provide a tag of at most 40 characters.'],
      [{ tag: 'x'.repeat(41) }, 'Provide a tag of at most 40 characters.'],
      [{ dateLabel: 'x'.repeat(41) }, 'Keep the date label to 40 characters.'],
      [{ title: 'x'.repeat(161) }, 'Provide a title of at most 160 characters.'],
      [{ body: 'x'.repeat(1001) }, 'Provide body text of at most 1,000 characters.'],
    ]
    for (const [overrides, message] of refusals) {
      const refused = await create(announcer.cookie, overrides)
      expect(refused.data.admin.announcement.create,
        JSON.stringify(overrides).slice(0, 40)).toMatchObject({ success: false, message })
    }
    // A blank optional date label is an ordinary omission, not a refusal.
    const blank = await create(announcer.cookie, { dateLabel: '   ' })
    expect(blank.data.admin.announcement.create.success).toBe(true)
    expect(blank.data.admin.announcement.create.response.dateLabel).toBeNull()
  })

  it('kills every link that could not safely become an href', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const refusals: Array<[Record<string, string>, string]> = [
      [{ kind: 'EXTERNAL', target: 'javascript:alert(1)' }, 'Provide a full http or https address.'],
      [{ kind: 'EXTERNAL', target: 'data:text/html,x' }, 'Provide a full http or https address.'],
      [{ kind: 'EXTERNAL', target: 'not a url' }, 'Provide a full http or https address.'],
      [{ kind: 'EXTERNAL', target: `https://x.test/${'a'.repeat(2000)}` }, 'That address is too long.'],
      [{ kind: 'ROUTE', target: 'apply' }, 'Provide a site path starting with a single "/".'],
      [{ kind: 'ROUTE', target: '//evil.example' }, 'Provide a site path starting with a single "/".'],
      [{ kind: 'ROUTE', target: '/\\evil.example' }, 'Provide a site path starting with a single "/".'],
      [{ kind: 'ROUTE', target: `/${'a'.repeat(500)}` }, 'Provide a site path starting with a single "/".'],
      [{ kind: 'ANCHOR', target: 'faq' }, 'Provide an anchor starting with "#".'],
      [{ kind: 'ANCHOR', target: `#${'a'.repeat(200)}` }, 'Provide an anchor starting with "#".'],
    ]
    for (const [link, message] of refusals) {
      const refused = await create(announcer.cookie, { link })
      expect(refused.data.admin.announcement.create, link.target.slice(0, 30))
        .toMatchObject({ success: false, message })
    }
    // The accepted external address is stored re-serialized by the parser.
    const accepted = await create(announcer.cookie, {
      link: { kind: 'EXTERNAL', target: 'HTTP://X.test/a?b' },
    })
    expect(accepted.data.admin.announcement.create.response.link)
      .toEqual({ kind: 'EXTERNAL', target: 'http://x.test/a?b' })
    const route = await create(announcer.cookie, { link: { kind: 'ROUTE', target: '/faq' } })
    expect(route.data.admin.announcement.create.response.link)
      .toEqual({ kind: 'ROUTE', target: '/faq' })
    const anchor = await create(announcer.cookie, { link: { kind: 'ANCHOR', target: '#eligibility' } })
    expect(anchor.data.admin.announcement.create.response.link)
      .toEqual({ kind: 'ANCHOR', target: '#eligibility' })
  })
})

describe('editing under contention', () => {
  const update = (
    cookie: string,
    id: string,
    expectedVersion: number,
    overrides: Record<string, unknown> = {},
  ) => graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $input: AnnouncementInput!) {
    admin { announcement { update(id: $id, expectedVersion: $expectedVersion, input: $input) {
      success message response { ${CARD_FIELDS} }
    } } }
  }`, { id, expectedVersion, input: {
    tag: 'Notice', dateLabel: null, title: 'Edited title',
    body: 'Edited body.', icon: 'CALENDAR', published: true,
    ...overrides,
  } }, cookie)

  it('applies an edit at the read version and refuses a stale one, writing no audit for it', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const created = await create(announcer.cookie)
    const id = created.data.admin.announcement.create.response.id

    const edited = await update(announcer.cookie, id, 1)
    expect(edited.data.admin.announcement.update.response).toMatchObject({
      title: 'Edited title', icon: 'CALENDAR', currentVersion: 2,
    })

    const stale = await update(announcer.cookie, id, 1)
    expect(stale.data.admin.announcement.update).toMatchObject({
      success: false, message: STALE,
    })
    // The refusal changed nothing and recorded nothing: one update audit row.
    const rows = await auditRows('SEB.ANNOUNCEMENT_UPDATED')
    expect(rows.results.length).toBe(1)
    const reread = await board(announcer.cookie)
    expect(reread.data.admin.announcement.board.response.announcements[0].title)
      .toBe('Edited title')
  })

  it('refuses a version that is not a positive integer, and an unknown id like a stale one', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    await create(announcer.cookie)
    expect((await update(announcer.cookie, crypto.randomUUID(), 1))
      .data.admin.announcement.update).toMatchObject({ success: false, message: STALE })
    expect((await update(announcer.cookie, crypto.randomUUID(), 0))
      .data.admin.announcement.update).toMatchObject({
        success: false, message: 'That update request is not valid.',
      })
  })

  it('flips visibility with the quick toggle and refuses it stale', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const created = await create(announcer.cookie)
    const id = created.data.admin.announcement.create.response.id
    const setPublished = (expectedVersion: number, published: boolean) =>
      graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $published: Boolean!, $reason: String) {
        admin { announcement { setPublished(id: $id, expectedVersion: $expectedVersion, published: $published, reason: $reason) {
          success message response { published currentVersion }
        } } }
      }`, { id, expectedVersion, published, reason: 'Season over.' }, announcer.cookie)

    const hidden = await setPublished(1, false)
    expect(hidden.data.admin.announcement.setPublished.response)
      .toMatchObject({ published: false, currentVersion: 2 })
    expect((await publicBanner()).data.public.announcementBanner.response.announcements)
      .toEqual([])

    expect((await setPublished(1, true)).data.admin.announcement.setPublished)
      .toMatchObject({ success: false, message: STALE })

    const reasonCap = await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $published: Boolean!, $reason: String) {
      admin { announcement { setPublished(id: $id, expectedVersion: $expectedVersion, published: $published, reason: $reason) { success message } } }
    }`, { id, expectedVersion: 2, published: true, reason: 'x'.repeat(1001) }, announcer.cookie)
    expect(reasonCap.data.admin.announcement.setPublished)
      .toMatchObject({ success: false, message: 'Keep the reason to 1,000 characters.' })
  })

  it('removes once, with a required reason, and refuses the second attempt', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const created = await create(announcer.cookie)
    const id = created.data.admin.announcement.create.response.id
    const remove = (expectedVersion: number, reason: string) =>
      graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $reason: String!) {
        admin { announcement { remove(id: $id, expectedVersion: $expectedVersion, reason: $reason) {
          success message response { boardVersion announcements { id } }
        } } }
      }`, { id, expectedVersion, reason }, announcer.cookie)

    expect((await remove(1, '   ')).data.admin.announcement.remove).toMatchObject({
      success: false, message: 'Provide a reason of at most 1,000 characters.',
    })
    const removed = await remove(1, 'Superseded by the new circular.')
    expect(removed.data.admin.announcement.remove.success).toBe(true)
    expect(removed.data.admin.announcement.remove.response.announcements).toEqual([])
    expect((await remove(2, 'Again.')).data.admin.announcement.remove)
      .toMatchObject({ success: false, message: STALE })
  })
})

describe('the board and its order', () => {
  const reorder = (cookie: string, ids: string[], expectedBoardVersion: number) =>
    graphql<any>(`mutation($ids: [ID!]!, $expectedBoardVersion: Int!) {
      admin { announcement { reorder(ids: $ids, expectedBoardVersion: $expectedBoardVersion) {
        success message response { boardVersion announcements { id title sortOrder } }
      } } }
    }`, { ids, expectedBoardVersion }, cookie)

  it('moves with creates and removes, and not with edits', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    expect((await board(announcer.cookie)).data.admin.announcement.board.response.boardVersion)
      .toBe(1)
    const first = await create(announcer.cookie, { title: 'First' })
    const firstId = first.data.admin.announcement.create.response.id
    expect((await board(announcer.cookie)).data.admin.announcement.board.response.boardVersion)
      .toBe(2)

    await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $input: AnnouncementInput!) {
      admin { announcement { update(id: $id, expectedVersion: $expectedVersion, input: $input) { success } } }
    }`, { id: firstId, expectedVersion: 1, input: {
      tag: 'Notice', title: 'First, edited', body: 'Edited.', icon: 'MEGAPHONE', published: true,
    } }, announcer.cookie)
    expect((await board(announcer.cookie)).data.admin.announcement.board.response.boardVersion)
      .toBe(2)

    await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $reason: String!) {
      admin { announcement { remove(id: $id, expectedVersion: $expectedVersion, reason: $reason) { success } } }
    }`, { id: firstId, expectedVersion: 2, reason: 'Done with it.' }, announcer.cookie)
    expect((await board(announcer.cookie)).data.admin.announcement.board.response.boardVersion)
      .toBe(3)
  })

  it('rewrites the whole order, shows it everywhere, and refuses it stale', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const a = (await create(announcer.cookie, { title: 'A' }))
      .data.admin.announcement.create.response.id
    const b = (await create(announcer.cookie, { title: 'B' }))
      .data.admin.announcement.create.response.id
    const c = (await create(announcer.cookie, { title: 'C' }))
      .data.admin.announcement.create.response.id

    const applied = await reorder(announcer.cookie, [c, a, b], 4)
    expect(applied.data.admin.announcement.reorder.success,
      applied.data.admin.announcement.reorder.message ?? '').toBe(true)
    expect(applied.data.admin.announcement.reorder.response.boardVersion).toBe(5)
    expect(applied.data.admin.announcement.reorder.response.announcements
      .map((card: { title: string }) => card.title)).toEqual(['C', 'A', 'B'])
    expect((await publicBanner()).data.public.announcementBanner.response.announcements
      .map((card: { title: string }) => card.title)).toEqual(['C', 'A', 'B'])

    expect((await reorder(announcer.cookie, [a, b, c], 4))
      .data.admin.announcement.reorder).toMatchObject({ success: false, message: STALE })
  })

  it('refuses a list that misses, repeats, invents or empties the board', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const a = (await create(announcer.cookie, { title: 'A' }))
      .data.admin.announcement.create.response.id
    const b = (await create(announcer.cookie, { title: 'B' }))
      .data.admin.announcement.create.response.id

    expect((await reorder(announcer.cookie, [a], 3)).data.admin.announcement.reorder)
      .toMatchObject({ success: false, message: BOARD_MISMATCH })
    expect((await reorder(announcer.cookie, [a, a], 3)).data.admin.announcement.reorder)
      .toMatchObject({ success: false, message: BOARD_MISMATCH })
    expect((await reorder(announcer.cookie, [a, b, crypto.randomUUID()], 3))
      .data.admin.announcement.reorder)
      .toMatchObject({ success: false, message: BOARD_MISMATCH })
    expect((await reorder(announcer.cookie, [], 3)).data.admin.announcement.reorder)
      .toMatchObject({ success: false, message: 'There is nothing to reorder.' })
    expect((await reorder(announcer.cookie, [a, b], 0)).data.admin.announcement.reorder)
      .toMatchObject({ success: false, message: 'That reorder request is not valid.' })
  })
})

describe('every door refuses alike', () => {
  it('holds the capability gate and the version shape on each mutation', async () => {
    const reviewer = await signIn(['REVIEWER'])
    const announcer = await signIn(['ANNOUNCER'])
    const id = crypto.randomUUID()
    const input = {
      tag: 'Notice', title: 'Probe', body: 'Probe.', icon: 'MEGAPHONE', published: true,
    }
    const calls: Array<[string, Record<string, unknown>, string]> = [
      [`mutation($id: ID!, $expectedVersion: Int!, $input: AnnouncementInput!) {
          admin { announcement { update(id: $id, expectedVersion: $expectedVersion, input: $input) { success message } } } }`,
        { id, expectedVersion: 1, input }, 'update'],
      [`mutation($id: ID!, $expectedVersion: Int!, $published: Boolean!) {
          admin { announcement { setPublished(id: $id, expectedVersion: $expectedVersion, published: $published) { success message } } } }`,
        { id, expectedVersion: 1, published: true }, 'setPublished'],
      [`mutation($id: ID!, $expectedVersion: Int!, $reason: String!) {
          admin { announcement { remove(id: $id, expectedVersion: $expectedVersion, reason: $reason) { success message } } } }`,
        { id, expectedVersion: 1, reason: 'Probe.' }, 'remove'],
      [`mutation($ids: [ID!]!, $expectedBoardVersion: Int!) {
          admin { announcement { reorder(ids: $ids, expectedBoardVersion: $expectedBoardVersion) { success message } } } }`,
        { ids: [id], expectedBoardVersion: 1 }, 'reorder'],
    ]
    for (const [query, variables, name] of calls) {
      const refused = await graphql<any>(query, variables, reviewer.cookie)
      expect(refused.data.admin.announcement[name], name)
        .toMatchObject({ success: false, message: PERMISSION })
    }
    // The version-shape refusal, on the two doors not probed elsewhere.
    const badVersionPublished = await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $published: Boolean!) {
      admin { announcement { setPublished(id: $id, expectedVersion: $expectedVersion, published: $published) { success message } } }
    }`, { id, expectedVersion: 0, published: true }, announcer.cookie)
    expect(badVersionPublished.data.admin.announcement.setPublished)
      .toMatchObject({ success: false, message: 'That update request is not valid.' })
    const badVersionRemove = await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $reason: String!) {
      admin { announcement { remove(id: $id, expectedVersion: $expectedVersion, reason: $reason) { success message } } }
    }`, { id, expectedVersion: 0, reason: 'Probe.' }, announcer.cookie)
    expect(badVersionRemove.data.admin.announcement.remove)
      .toMatchObject({ success: false, message: 'That update request is not valid.' })
  })

  it('refuses a link of an invented kind at the validator itself', async () => {
    // Unreachable through GraphQL — the enum refuses first — so the validator
    // is asked directly, as a hand-written caller would.
    const { validateAnnouncementLink } = await import(
      '../../src/services/announcement/support'
    )
    expect(validateAnnouncementLink({
      kind: 'MAGIC' as never, target: 'anything',
    })).toEqual({ value: null, message: 'Provide a link of a known kind.' })
  })

  it('reads an absent card as null and an unseeded board as version one', async () => {
    const { findAnnouncement, readBoard } = await import(
      '../../src/services/announcement/queries/announcement'
    )
    const { activeDatabase } = await import('../support/harness')
    expect(await findAnnouncement(activeDatabase(), crypto.randomUUID())).toBeNull()
    // A database built outside the seeded paths: the read reports what the
    // seed would have said rather than inventing a different number.
    await env.DB.prepare('DELETE FROM seb_announcement_board').run()
    expect((await readBoard(activeDatabase())).boardVersion).toBe(1)
  })
})

describe('what the history retains', () => {
  it('writes every declared action with its actor and entity', async () => {
    const announcer = await signIn(['ANNOUNCER'])
    const created = await create(announcer.cookie, { title: 'Audited' })
    const id = created.data.admin.announcement.create.response.id
    const other = (await create(announcer.cookie, { title: 'Companion' }))
      .data.admin.announcement.create.response.id

    await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $input: AnnouncementInput!) {
      admin { announcement { update(id: $id, expectedVersion: $expectedVersion, input: $input) { success } } }
    }`, { id, expectedVersion: 1, input: {
      tag: 'Notice', title: 'Audited, edited', body: 'Edited.', icon: 'CALENDAR', published: true,
    } }, announcer.cookie)
    await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $published: Boolean!, $reason: String) {
      admin { announcement { setPublished(id: $id, expectedVersion: $expectedVersion, published: $published, reason: $reason) { success } } }
    }`, { id, expectedVersion: 2, published: false, reason: 'Pausing it.' }, announcer.cookie)
    await graphql<any>(`mutation($ids: [ID!]!, $expectedBoardVersion: Int!) {
      admin { announcement { reorder(ids: $ids, expectedBoardVersion: $expectedBoardVersion) { success message } } }
    }`, { ids: [other, id], expectedBoardVersion: 3 }, announcer.cookie)
    await graphql<any>(`mutation($id: ID!, $expectedVersion: Int!, $reason: String!) {
      admin { announcement { remove(id: $id, expectedVersion: $expectedVersion, reason: $reason) { success } } }
    }`, { id, expectedVersion: 3, reason: 'Withdrawn for the record.' }, announcer.cookie)

    const createdRows = await auditRows('SEB.ANNOUNCEMENT_CREATED')
    expect(createdRows.results.length).toBe(2)
    expect(createdRows.results[0]).toMatchObject({
      actor: announcer.userId, entityType: 'SEB_ANNOUNCEMENT', entityId: id,
    })

    const updatedRows = await auditRows('SEB.ANNOUNCEMENT_UPDATED')
    expect(updatedRows.results.length).toBe(2)
    expect(JSON.parse(updatedRows.results[1]!.metadata!)).toEqual({
      published: false, reason: 'Pausing it.',
    })

    const reorderedRows = await auditRows('SEB.ANNOUNCEMENT_REORDERED')
    expect(reorderedRows.results).toEqual([expect.objectContaining({
      entityType: 'SEB_ANNOUNCEMENT_BOARD', entityId: 'BOARD',
    })])
    expect(JSON.parse(reorderedRows.results[0]!.metadata!)).toEqual({ count: 2 })

    const removedRows = await auditRows('SEB.ANNOUNCEMENT_REMOVED')
    expect(removedRows.results.length).toBe(1)
    expect(JSON.parse(removedRows.results[0]!.metadata!)).toEqual({
      reason: 'Withdrawn for the record.',
    })
  })
})
