/**
 * The interior of one banner card, exactly as the landing page draws it.
 *
 * Extracted from the Hero's dock so the announcer's editor can preview the
 * real thing: Tailwind scans all of `src/` and `landing.css` loads globally,
 * so these utility classes render identically on the landing page and inside
 * the portal. The dock chrome — background, arrows, dots — stays with the
 * page that owns it.
 */
import { ArrowUpRight } from 'lucide-react'
import { announcementIconFor } from './icons'
import { resolveAnnouncementLink } from './link'

export type AnnouncementCardData = {
  tag: string
  dateLabel?: string | null
  title: string
  body: string
  icon: string
  link?: { kind: string; target: string } | null
}

export function AnnouncementCard({
  announcement,
  size,
  position,
  onAnchorClick,
}: {
  announcement: AnnouncementCardData
  size: 'desktop' | 'mobile'
  /** The "n of m" counter; omitted where there is nothing to count. */
  position?: { index: number; total: number }
  /** How an in-page anchor scrolls; without it the anchor is a plain link. */
  onAnchorClick?: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void
}) {
  const Icon = announcementIconFor(announcement.icon)
  const link = resolveAnnouncementLink(announcement.link)
  const desktop = size === 'desktop'

  const title = (
    <>
      <span className="underline decoration-[#181715]/30 underline-offset-2 group-hover:decoration-[#0c2340]">
        {announcement.title}
      </span>
      {link ? (
        <ArrowUpRight
          className={
            desktop
              ? 'inline-block size-3.5 shrink-0 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform'
              : 'inline-block size-3.5 shrink-0 opacity-70'
          }
        />
      ) : null}
    </>
  )
  const titleClass = desktop
    ? 'group mt-1 flex items-baseline gap-1 text-[14.5px] font-bold leading-snug text-[#181715] hover:text-[#0c2340] transition-colors cursor-pointer'
    : 'group mt-0.5 flex items-start gap-1 text-[13px] sm:text-[14px] font-bold leading-snug text-[#181715] hover:text-[#0c2340] transition-colors cursor-pointer'

  return (
    <div className={desktop ? 'flex items-center gap-5 md:gap-6' : 'flex items-center gap-3 sm:gap-4'}>
      <div
        className={
          desktop
            ? 'flex size-18 shrink-0 items-center justify-center rounded-full border border-[#181715]/25 text-[#181715] bg-[#e6e1d8]'
            : 'flex size-12 sm:size-13 shrink-0 items-center justify-center rounded-full border border-[#181715]/25 text-[#181715] bg-[#e6e1d8]'
        }
      >
        <Icon
          className={desktop ? 'size-9 text-[#181715]' : 'size-6 sm:size-6.5 text-[#181715]'}
          strokeWidth={1.75}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className={desktop ? 'flex items-center gap-2' : 'flex items-center gap-1.5 flex-wrap'}>
          <span
            className={
              desktop
                ? 'text-[11px] font-bold tracking-wider uppercase text-[#0c2340] bg-[#181715]/8 px-1.5 py-0.5 rounded-xs'
                : 'text-[9.5px] sm:text-[10px] font-bold tracking-wider uppercase text-[#0c2340] bg-[#181715]/8 px-1.5 py-0.5 rounded-xs'
            }
          >
            {announcement.tag}
          </span>
          {announcement.dateLabel ? (
            <span
              className={
                desktop
                  ? 'text-[11px] font-medium text-[#181715]/60'
                  : 'text-[10px] font-medium text-[#181715]/60'
              }
            >
              {announcement.dateLabel}
            </span>
          ) : null}
          {position ? (
            <span
              className={
                desktop
                  ? 'text-[10.5px] font-medium text-[#181715]/50 ml-auto'
                  : 'text-[10px] font-medium text-[#181715]/50 ml-auto'
              }
            >
              {position.index + 1} of {position.total}
            </span>
          ) : null}
        </div>

        {link ? (
          <a
            href={link.href}
            onClick={
              link.anchor && onAnchorClick
                ? (event) => onAnchorClick(event, link.href)
                : undefined
            }
            {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className={titleClass}
          >
            {title}
          </a>
        ) : (
          <span className={titleClass}>{title}</span>
        )}

        <p
          className={
            desktop
              ? 'mt-0.5 text-[12px] leading-snug text-[#181715]/75 line-clamp-1'
              : 'mt-0.5 text-[11px] sm:text-[11.5px] leading-snug text-[#181715]/75 line-clamp-1'
          }
        >
          {announcement.body}
        </p>
      </div>
    </div>
  )
}
