/**
 * The announcement board: where the landing page's notice cards are written.
 *
 * The whole screen renders from one board read, so the list and the reorder
 * version can never come from two moments — and every write quotes a version
 * from that read. A refusal keeps its modal open with the message inside;
 * closing on failure would move the refusal off-screen (the cycle page
 * learned that the hard way).
 */
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Megaphone, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '#/components/PageHeader'
import { AnnouncementCard } from '#/features/announcements/AnnouncementCard'
import {
  ANNOUNCEMENT_ICON_LABELS,
  ANNOUNCEMENT_ICONS,
  announcementIconFor,
} from '#/features/announcements/icons'
import { resolveAnnouncementLink } from '#/features/announcements/link'
import { announcementBoardQuery } from '#/features/announcements/queries'
import styles from '#/features/announcements/Announcements.module.css'
import { CapabilityRefusal } from '#/features/portal/CapabilityRefusal'
import {
  CreateAnnouncementDocument,
  RemoveAnnouncementDocument,
  ReorderAnnouncementsDocument,
  SetAnnouncementPublishedDocument,
  UpdateAnnouncementDocument,
} from '#/graphql/generated/operations'
import type {
  AnnouncementIcon,
  AnnouncementLinkKind,
} from '#/graphql/generated/schema'
import { formatDate, toLocalDateTimeInput } from '#/lib/format'
import { gql } from '#/lib/graphql'
import { messageFor } from '#/lib/result'
import { can } from '#/lib/session'

export const Route = createFileRoute('/_shell/admin/announcements')({
  loader: ({ context }) => context.queryClient.ensureQueryData(announcementBoardQuery),
  component: AnnouncementsGate,
})

type Card = {
  id: string
  tag: string
  dateLabel?: string | null
  title: string
  body: string
  icon: string
  link?: { kind: string; target: string } | null
  endsAt?: string | null
  published: boolean
  sortOrder: number
  currentVersion: number
}

/** The editor's working copy: everything a card says, as form state. */
type DraftCard = {
  tag: string
  dateLabel: string
  title: string
  body: string
  icon: AnnouncementIcon
  linkKind: AnnouncementLinkKind | 'NONE'
  linkTarget: string
  endsAt: string
  published: boolean
}

const EMPTY_DRAFT: DraftCard = {
  tag: '',
  dateLabel: '',
  title: '',
  body: '',
  icon: 'MEGAPHONE',
  linkKind: 'NONE',
  linkTarget: '',
  endsAt: '',
  published: true,
}

const draftFrom = (card: Card): DraftCard => ({
  tag: card.tag,
  dateLabel: card.dateLabel ?? '',
  title: card.title,
  body: card.body,
  icon: (card.icon in ANNOUNCEMENT_ICONS ? card.icon : 'MEGAPHONE') as AnnouncementIcon,
  linkKind: (card.link?.kind as AnnouncementLinkKind | undefined) ?? 'NONE',
  linkTarget: card.link?.target ?? '',
  endsAt: toLocalDateTimeInput(card.endsAt),
  published: card.published,
})

const inputFrom = (draft: DraftCard) => ({
  tag: draft.tag,
  dateLabel: draft.dateLabel.trim() ? draft.dateLabel : null,
  title: draft.title,
  body: draft.body,
  icon: draft.icon,
  link:
    draft.linkKind === 'NONE'
      ? null
      : { kind: draft.linkKind, target: draft.linkTarget },
  endsAt: draft.endsAt ? new Date(draft.endsAt).toISOString() : null,
  published: draft.published,
})

/** What the announcer sees under the target input, per kind. */
const LINK_HINTS: Record<AnnouncementLinkKind | 'NONE', { placeholder: string; hint: string }> = {
  NONE: { placeholder: '', hint: 'The card is a statement and leads nowhere.' },
  EXTERNAL: {
    placeholder: 'https://ttaadc.gov.in/order.pdf',
    hint: 'A full http or https address. Opens in a new tab.',
  },
  ROUTE: { placeholder: '/faq', hint: 'A page on this portal, starting with a single "/".' },
  ANCHOR: {
    placeholder: '#eligibility',
    hint: 'A section of the landing page, starting with "#".',
  },
}

function AnnouncementsGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'ANNOUNCE')) {
    return (
      <CapabilityRefusal
        title="Announcement banner"
        needs="announcers and super administrators"
      />
    )
  }
  return <AnnouncementsPage />
}

function AnnouncementsPage() {
  const queryClient = useQueryClient()
  const { data: board } = useSuspenseQuery(announcementBoardQuery)
  const [editing, setEditing] = useState<
    | { mode: 'create'; draft: DraftCard }
    | { mode: 'edit'; card: Card; draft: DraftCard }
    | null
  >(null)
  const [removing, setRemoving] = useState<Card | null>(null)
  const [removeReason, setRemoveReason] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-announcement-board'] })
    // The landing page renders from this key; an edit must reach it too.
    await queryClient.invalidateQueries({ queryKey: ['public-announcements'] })
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error('Nothing is being edited.')
      const input = inputFrom(editing.draft)
      if (editing.mode === 'create') {
        const result = await gql(CreateAnnouncementDocument, { input })
        return result.admin.announcement.create
      }
      const result = await gql(UpdateAnnouncementDocument, {
        id: editing.card.id,
        expectedVersion: editing.card.currentVersion,
        input,
      })
      return result.admin.announcement.update
    },
    onSuccess: async (result) => {
      if (!result.success) {
        setNotice(result.message ?? 'The card could not be saved.')
        await refresh()
        return
      }
      setNotice(null)
      setEditing(null)
      await refresh()
    },
    onError: (error) => setNotice(messageFor(error)),
  })

  const togglePublished = useMutation({
    mutationFn: async (card: Card) => {
      const result = await gql(SetAnnouncementPublishedDocument, {
        id: card.id,
        expectedVersion: card.currentVersion,
        published: !card.published,
        reason: null,
      })
      return result.admin.announcement.setPublished
    },
    onSuccess: async (result) => {
      setNotice(result.success ? null : (result.message ?? 'The card did not change.'))
      await refresh()
    },
    onError: (error) => setNotice(messageFor(error)),
  })

  const remove = useMutation({
    mutationFn: async () => {
      if (!removing) throw new Error('Nothing is being removed.')
      const result = await gql(RemoveAnnouncementDocument, {
        id: removing.id,
        expectedVersion: removing.currentVersion,
        reason: removeReason,
      })
      return result.admin.announcement.remove
    },
    onSuccess: async (result) => {
      if (!result.success) {
        setNotice(result.message ?? 'The card could not be removed.')
        await refresh()
        return
      }
      setNotice(null)
      setRemoving(null)
      setRemoveReason('')
      await refresh()
    },
    onError: (error) => setNotice(messageFor(error)),
  })

  const reorder = useMutation({
    mutationFn: async (ids: string[]) => {
      const result = await gql(ReorderAnnouncementsDocument, {
        ids,
        expectedBoardVersion: board.boardVersion,
      })
      return result.admin.announcement.reorder
    },
    onSuccess: async (result) => {
      setNotice(result.success ? null : (result.message ?? 'The order did not change.'))
      await refresh()
    },
    onError: (error) => setNotice(messageFor(error)),
  })

  const move = (index: number, direction: -1 | 1) => {
    const ids = board.announcements.map((card) => card.id)
    const target = index + direction
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    reorder.mutate(ids)
  }

  const now = Date.now()

  return (
    <main className="page">
      <PageHeader
        title="Announcement banner"
        description="What the landing page's notice board says, in the order it says it."
        actions={
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => setEditing({ mode: 'create', draft: EMPTY_DRAFT })}
          >
            New announcement
          </button>
        }
      />

      {notice ? (
        <p className="notice" data-tone="error" role="alert">
          {notice}
        </p>
      ) : null}

      {board.announcements.length === 0 ? (
        <div className={styles.emptyCard}>
          <Megaphone size={32} aria-hidden="true" />
          <p>
            Nothing is on the banner yet. The landing page hides the board until
            the first card is published.
          </p>
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => setEditing({ mode: 'create', draft: EMPTY_DRAFT })}
          >
            Write the first announcement
          </button>
        </div>
      ) : (
        <div className={styles.boardCard}>
          {board.announcements.map((card, index) => {
            const Icon = announcementIconFor(card.icon)
            const expired = card.endsAt !== null && card.endsAt !== undefined
              && new Date(card.endsAt).getTime() <= now
            return (
              <div key={card.id} className={styles.row}>
                <div className={styles.moveButtons}>
                  <button
                    type="button"
                    className="button"
                    data-variant="ghost"
                    aria-label={`Move ${card.title} earlier`}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-variant="ghost"
                    aria-label={`Move ${card.title} later`}
                    disabled={index === board.announcements.length - 1 || reorder.isPending}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                </div>
                <div className={styles.rowIcon}>
                  <Icon className="size-5" aria-hidden="true" />
                </div>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>{card.title}</div>
                  <div className={styles.rowMeta}>
                    <span className="badge">{card.tag}</span>
                    {card.dateLabel ? <span>{card.dateLabel}</span> : null}
                    {card.endsAt ? <span>until {formatDate(card.endsAt)}</span> : null}
                    {expired ? <span className={styles.expiredBadge}>Expired</span> : null}
                  </div>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.liveBadge}
                    data-live={card.published ? 'true' : 'false'}
                    title={card.published ? 'Shown to the public — click to hide' : 'Hidden draft — click to publish'}
                    disabled={togglePublished.isPending}
                    onClick={() => togglePublished.mutate(card)}
                  >
                    {card.published ? 'Live' : 'Hidden'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-variant="ghost"
                    aria-label={`Edit ${card.title}`}
                    onClick={() => {
                      setNotice(null)
                      setEditing({ mode: 'edit', card, draft: draftFrom(card) })
                    }}
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="button"
                    data-variant="ghost"
                    aria-label={`Remove ${card.title}`}
                    onClick={() => {
                      setNotice(null)
                      setRemoveReason('')
                      setRemoving(card)
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing ? (
        <AnnouncementEditor
          mode={editing.mode}
          draft={editing.draft}
          busy={save.isPending}
          notice={notice}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onCancel={() => {
            setEditing(null)
            setNotice(null)
          }}
          onSave={() => save.mutate()}
        />
      ) : null}

      {removing ? (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={`${styles.modalDialog} ${styles.modalDialogNarrow}`}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Remove this announcement?</h3>
              <button
                type="button"
                className={styles.modalCloseButton}
                onClick={() => setRemoving(null)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className={styles.modalBody}>
              <p>
                <strong>{removing.title}</strong> comes off the board. The card and
                the reason are retained.
              </p>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="removeReason">
                  Why it is being removed
                </label>
                <input
                  id="removeReason"
                  className={styles.inputField}
                  placeholder="Kept with the card"
                  value={removeReason}
                  onChange={(event) => setRemoveReason(event.target.value)}
                />
              </div>
              {notice ? (
                <p className="notice" data-tone="error" role="alert">
                  {notice}
                </p>
              ) : null}
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className="button"
                onClick={() => setRemoving(null)}
                disabled={remove.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button"
                data-variant="danger"
                disabled={remove.isPending || !removeReason.trim()}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function AnnouncementEditor({
  mode,
  draft,
  busy,
  notice,
  onChange,
  onCancel,
  onSave,
}: {
  mode: 'create' | 'edit'
  draft: DraftCard
  busy: boolean
  notice: string | null
  onChange: (draft: DraftCard) => void
  onCancel: () => void
  onSave: () => void
}) {
  const set = <K extends keyof DraftCard>(key: K, value: DraftCard[K]) =>
    onChange({ ...draft, [key]: value })

  const linkHint = LINK_HINTS[draft.linkKind]
  // The same chokepoint the landing page renders through, so what validates
  // here is exactly what will draw.
  const linkInvalid =
    draft.linkKind !== 'NONE' &&
    draft.linkTarget.trim() !== '' &&
    resolveAnnouncementLink({ kind: draft.linkKind, target: draft.linkTarget.trim() }) === null
  const previewData = {
    tag: draft.tag || 'Tag',
    dateLabel: draft.dateLabel.trim() ? draft.dateLabel : null,
    title: draft.title || 'The headline, as the public reads it',
    body: draft.body || 'A sentence or two under the headline.',
    icon: draft.icon,
    link:
      draft.linkKind === 'NONE' || linkInvalid || !draft.linkTarget.trim()
        ? null
        : { kind: draft.linkKind, target: draft.linkTarget.trim() },
  }
  const incomplete =
    !draft.tag.trim() ||
    !draft.title.trim() ||
    !draft.body.trim() ||
    (draft.linkKind !== 'NONE' && (!draft.linkTarget.trim() || linkInvalid))

  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal="true">
      <div className={styles.modalDialog}>
        <div className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            {mode === 'create' ? 'New announcement' : 'Edit announcement'}
          </h3>
          <button type="button" className={styles.modalCloseButton} onClick={onCancel}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.editorGrid}>
            <div>
              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="announcementTag">
                    Tag
                    <span className={styles.charCount}>{draft.tag.length}/40</span>
                  </label>
                  <input
                    id="announcementTag"
                    className={styles.inputField}
                    placeholder="Notice"
                    maxLength={40}
                    value={draft.tag}
                    onChange={(event) => set('tag', event.target.value)}
                  />
                </div>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="announcementDateLabel">
                    Date label <span className={styles.charCount}>optional</span>
                  </label>
                  <input
                    id="announcementDateLabel"
                    className={styles.inputField}
                    placeholder="Aug 2026 · Official · Advisory"
                    maxLength={40}
                    value={draft.dateLabel}
                    onChange={(event) => set('dateLabel', event.target.value)}
                  />
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="announcementTitle">
                  Headline
                  <span className={styles.charCount}>{draft.title.length}/160</span>
                </label>
                <input
                  id="announcementTitle"
                  className={styles.inputField}
                  placeholder="What the public reads first"
                  maxLength={160}
                  value={draft.title}
                  onChange={(event) => set('title', event.target.value)}
                />
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="announcementBody">
                  Text
                  <span className={styles.charCount}>{draft.body.length}/1000</span>
                </label>
                <textarea
                  id="announcementBody"
                  className={styles.textareaField}
                  placeholder="A sentence or two. The card clamps long text."
                  maxLength={1000}
                  value={draft.body}
                  onChange={(event) => set('body', event.target.value)}
                />
              </div>

              <div className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>Pictogram</span>
                <div className={styles.iconGrid} role="radiogroup" aria-label="Pictogram">
                  {(Object.keys(ANNOUNCEMENT_ICONS) as AnnouncementIcon[]).map((key) => {
                    const Icon = ANNOUNCEMENT_ICONS[key]
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={draft.icon === key}
                        data-selected={draft.icon === key ? 'true' : undefined}
                        className={styles.iconOption}
                        onClick={() => set('icon', key)}
                      >
                        <Icon className="size-5" aria-hidden="true" />
                        {ANNOUNCEMENT_ICON_LABELS[key]}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="announcementLinkKind">
                    Leads to
                  </label>
                  <select
                    id="announcementLinkKind"
                    className={styles.selectField}
                    value={draft.linkKind}
                    onChange={(event) =>
                      set('linkKind', event.target.value as DraftCard['linkKind'])
                    }
                  >
                    <option value="NONE">Nowhere — just a statement</option>
                    <option value="EXTERNAL">An outside address</option>
                    <option value="ROUTE">A page on this portal</option>
                    <option value="ANCHOR">A section of the landing page</option>
                  </select>
                </div>
                {draft.linkKind !== 'NONE' ? (
                  <div className={styles.fieldGroup}>
                    <label className={styles.fieldLabel} htmlFor="announcementLinkTarget">
                      Destination
                    </label>
                    <input
                      id="announcementLinkTarget"
                      className={styles.inputField}
                      placeholder={linkHint.placeholder}
                      value={draft.linkTarget}
                      onChange={(event) => set('linkTarget', event.target.value)}
                    />
                    {linkInvalid ? (
                      <span className={styles.fieldError}>{linkHint.hint}</span>
                    ) : (
                      <span className={styles.fieldHint}>{linkHint.hint}</span>
                    )}
                  </div>
                ) : null}
              </div>

              <div className={styles.formGrid2}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel} htmlFor="announcementEndsAt">
                    Stops showing <span className={styles.charCount}>optional</span>
                  </label>
                  <input
                    id="announcementEndsAt"
                    className={styles.inputField}
                    type="datetime-local"
                    value={draft.endsAt}
                    onChange={(event) => set('endsAt', event.target.value)}
                  />
                  <span className={styles.fieldHint}>
                    Left empty, the card stays up until it is removed.
                  </span>
                </div>
                <div className={styles.fieldGroup}>
                  <span className={styles.fieldLabel}>Visibility</span>
                  <label className={styles.publishedToggle} htmlFor="announcementPublished">
                    <input
                      id="announcementPublished"
                      type="checkbox"
                      aria-label="Published"
                      checked={draft.published}
                      onChange={(event) => set('published', event.target.checked)}
                    />
                    <span
                      className={styles.liveBadge}
                      data-live={draft.published ? 'true' : 'false'}
                    >
                      {draft.published ? 'Live' : 'Hidden'}
                    </span>
                    <span className={styles.fieldHint}>
                      {draft.published
                        ? 'Shown to the public on save.'
                        : 'Kept as a draft until published.'}
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className={styles.previewPane}>
              <span className={styles.previewCaption}>
                As it appears on the landing page
              </span>
              <div className={styles.previewDock}>
                <AnnouncementCard announcement={previewData} size="desktop" />
              </div>
              <span className={styles.previewCaption}>On a phone</span>
              <div className={styles.previewDockMobile}>
                <AnnouncementCard announcement={previewData} size="mobile" />
              </div>
              {notice ? (
                <p className="notice" data-tone="error" role="alert">
                  {notice}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            data-variant="primary"
            disabled={busy || incomplete}
            onClick={onSave}
          >
            {busy ? 'Saving…' : mode === 'create' ? 'Create announcement' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
