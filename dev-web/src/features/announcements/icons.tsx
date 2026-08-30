/**
 * The banner's fixed pictogram set.
 *
 * The API sends a key because a component cannot cross the wire; this map is
 * the client's half of that contract, and an unknown key falls back to the
 * megaphone rather than crashing a public page over a vocabulary drift.
 */
import {
  CalendarDays,
  FileText,
  HelpCircle,
  IndianRupee,
  Landmark,
  Megaphone,
  ShieldCheck,
} from 'lucide-react'
import type { AnnouncementIcon } from '#/graphql/generated/schema'

/** The programme's own mark, moved verbatim from the Hero's local SVG. */
export function HandSeedlingIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M32 36V18" />
      <path d="M32 23C32 16 26 12 21 13C21 19 25 23 32 23Z" />
      <path d="M32 28C35 22 41 21 44 24C44 29 37 30 32 30" />
      <path d="M26 36C28 35 36 35 38 36" />
      <path d="M16 46C16 46 20 49 28 49C36 49 42 45 46 41L51 36C52 34.5 50.5 32.5 48 32.5L40 35C36 36.5 33 36.5 29 36.5L24 38" />
      <path d="M16 46L11 42C9.5 41 9.5 38.5 11 37.5L19 35" />
    </svg>
  )
}

export const ANNOUNCEMENT_ICONS: Record<AnnouncementIcon, React.ElementType> = {
  SEEDLING: HandSeedlingIcon,
  FILE_TEXT: FileText,
  SHIELD_CHECK: ShieldCheck,
  LANDMARK: Landmark,
  HELP_CIRCLE: HelpCircle,
  MEGAPHONE: Megaphone,
  CALENDAR: CalendarDays,
  INDIAN_RUPEE: IndianRupee,
}

/** What the icon picker calls each key. */
export const ANNOUNCEMENT_ICON_LABELS: Record<AnnouncementIcon, string> = {
  SEEDLING: 'Seedling',
  FILE_TEXT: 'Document',
  SHIELD_CHECK: 'Verification',
  LANDMARK: 'Institution',
  HELP_CIRCLE: 'Help',
  MEGAPHONE: 'Announcement',
  CALENDAR: 'Dates',
  INDIAN_RUPEE: 'Funding',
}

export const announcementIconFor = (icon: string): React.ElementType =>
  ANNOUNCEMENT_ICONS[icon as AnnouncementIcon] ?? Megaphone
