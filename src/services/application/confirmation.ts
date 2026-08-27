/**
 * The application as a document: one PDF an applicant can keep, print, and
 * hand to a bank.
 *
 * Deliberately dumb about workflow. It is handed everything it renders — the
 * template, the answers, the cycle's name, a heading and whatever extra rows
 * the occasion adds — so the same builder serves the submission receipt, the
 * approval letter's enclosure and the sanction notice without knowing which
 * one it is producing.
 *
 * The one guarantee that matters: **content can never make this throw.** The
 * PDF travels on a best-effort email after a write that has already
 * succeeded, so a strange answer breaking the renderer must degrade to an
 * ugly line in a PDF, never to an applicant not being told.
 */
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import type {
  AnswerEntry,
  AnswerMap,
  FormField,
  ResolvedFormTemplate,
} from './form/types'

/**
 * Mirrors `rupees` in `form/rules.ts`, which is deliberately unexported —
 * that file is the validation engine's and nothing of it leaks. Exported from
 * here instead so the three notification hooks format one amount one way.
 */
export const formatPaise = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** ISO 216 A4 in PDF points. */
const A4: [number, number] = [595.28, 841.89]
const MARGIN = 50
const LINE_GAP = 4

/**
 * Text the standard fonts can carry.
 *
 * The standard fonts encode WinAnsi only, and this programme's applicants
 * really do write ₹, Bengali and Kokborok. Embedding a full Unicode font is
 * the honest fix and a follow-up; until then money keeps its meaning
 * (`₹` → `Rs. `) and any other unencodable character becomes `?` — because a
 * question mark in a PDF is recoverable and a thrown encode error is a
 * confirmation that never arrives.
 */
const sanitise = (font: PDFFont, text: string): string => {
  const swapped = text.replaceAll('₹', 'Rs. ')
  // The overwhelmingly common case: plain printable ASCII needs no per-char work.
  if (/^[\x20-\x7e]*$/u.test(swapped)) return swapped
  let out = ''
  for (const char of swapped.replaceAll(/[\r\n\t]/gu, ' ')) {
    try {
      font.encodeText(char)
      out += char
    } catch {
      out += '?'
    }
  }
  return out
}

/** A formatter that cannot fail: whatever goes wrong reads as unanswered. */
const totally = (produce: () => string): string => {
  try {
    return produce()
  } catch {
    return '—'
  }
}

const formatValue = (field: FormField, value: unknown): string => totally(() => {
  if (value === null || value === undefined || value === '') return '—'
  switch (field.type) {
    case 'MONEY_PAISE': {
      const paise = typeof value === 'number' ? value : Number(value)
      return Number.isSafeInteger(paise) ? formatPaise(paise) : String(value)
    }
    case 'BOOLEAN':
    case 'ATTESTATION':
      return value === true || value === 'true' ? 'Yes' : 'No'
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE': {
      // The applicant chose a label; the value is the template's spelling of it.
      const labelOf = (choice: unknown): string =>
        field.options.find((option) => option.value === choice)?.label ?? String(choice)
      if (Array.isArray(value)) {
        return value.length > 0 ? value.map(labelOf).join(', ') : '—'
      }
      return labelOf(value)
    }
    default:
      return String(value)
  }
})

/**
 * A cursor that wraps and paginates so nothing else has to.
 *
 * Wrapping measures through the font rather than counting characters, because
 * Helvetica is proportional and a counted wrap either wastes half the line or
 * runs off it. A single word wider than the page is hard-broken: an applicant
 * pasting an unbroken reference string must not push text off the page.
 */
type Writer = {
  document: PDFDocument
  page: PDFPage
  cursor: number
}

const wrapLines = (
  font: PDFFont,
  size: number,
  clean: string,
  width: number,
): string[] => {
  const lines: string[] = []
  let line = ''
  const push = (candidate: string) => {
    if (candidate !== '') lines.push(candidate)
  }
  for (const word of clean.split(/ +/u)) {
    const attempt = line === '' ? word : `${line} ${word}`
    if (font.widthOfTextAtSize(attempt, size) <= width) {
      line = attempt
      continue
    }
    push(line)
    if (font.widthOfTextAtSize(word, size) <= width) {
      line = word
      continue
    }
    // A word wider than the page: break it wherever the page ends.
    let piece = ''
    for (const char of word) {
      if (font.widthOfTextAtSize(piece + char, size) > width) {
        push(piece)
        piece = char
      } else {
        piece += char
      }
    }
    line = piece
  }
  push(line)
  if (lines.length === 0) lines.push('')
  return lines
}

const write = (
  writer: Writer,
  font: PDFFont,
  size: number,
  text: string,
  indent = 0,
): void => {
  const clean = sanitise(font, text)
  const lines = wrapLines(font, size, clean, A4[0] - MARGIN * 2 - indent)
  for (const each of lines) {
    if (writer.cursor - size < MARGIN) {
      writer.page = writer.document.addPage(A4)
      writer.cursor = A4[1] - MARGIN
    }
    writer.cursor -= size
    writer.page.drawText(each, {
      x: MARGIN + indent,
      y: writer.cursor,
      size,
      font,
    })
    writer.cursor -= LINE_GAP
  }
}

export const buildApplicationPdf = async (input: {
  referenceNumber: string | null
  cycleCode: string
  cycleDisplayName: string
  submittedAt: Date | null
  template: ResolvedFormTemplate
  answers: AnswerMap
  heading: string
  extra?: readonly { label: string; value: string }[]
}): Promise<Uint8Array> => {
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const writer: Writer = {
    document,
    page: document.addPage(A4),
    cursor: A4[1] - MARGIN,
  }
  const gap = (points: number) => {
    writer.cursor -= points
  }


  // The programme banner, the reference the applicant will quote back, and
  // whatever extra rows the caller adds (decision reference, sanction order).
  const renderHeader = () => {
    write(writer, bold, 16, 'Mission SEP — TTAADC')
    gap(2)
    write(writer, regular, 11, totally(() =>
      `${input.cycleDisplayName} (${input.cycleCode})`))
    gap(8)
    write(writer, bold, 13, totally(() => String(input.heading)))
    gap(4)
    if (input.referenceNumber !== null && input.referenceNumber !== undefined) {
      write(writer, bold, 14, totally(() => `Reference: ${input.referenceNumber}`))
      gap(4)
    }
    if (input.submittedAt instanceof Date && !Number.isNaN(input.submittedAt.getTime())) {
      write(writer, regular, 10, `Submitted: ${input.submittedAt.toISOString()}`)
      gap(2)
    }
    for (const extra of input.extra ?? []) {
      write(writer, regular, 10, totally(() => `${extra.label}: ${extra.value}`))
      gap(2)
    }
    gap(10)
  }

  const row = (label: string, value: string, indent = 0) => {
    write(writer, bold, 9.5, label, indent)
    write(writer, regular, 10, value, indent + 10)
    gap(3)
  }

  // One repeated group: its entries enumerated, each member per entry.
  const renderGroup = (field: (typeof input.template.fields)[number]) => {
    const value = input.answers[field.key]
    const entries: readonly AnswerEntry[] = Array.isArray(value) ? value : []
    const members = input.template.fields.filter(
      (member) =>
        member.repeatGroupKey === field.key
        && member.type !== 'FILE'
        && member.type !== 'STATEMENT',
    )
    if (entries.length === 0) {
      row(totally(() => String(field.label)), '—')
      return
    }
    entries.forEach((entry, index) => {
      write(writer, bold, 10.5, totally(() => `${field.label} ${index + 1}`))
      gap(2)
      const record: AnswerEntry =
        typeof entry === 'object' && entry !== null ? entry : {}
      for (const member of members) {
        row(
          totally(() => String(member.label)),
          formatValue(member, record[member.key]),
          10,
        )
      }
    })
  }

  // One stage: its heading, then each printable question in template order.
  const renderStage = (stage: (typeof input.template.stages)[number]) => {
    write(writer, bold, 12, totally(() => String(stage.title)))
    gap(4)
    for (const field of input.template.fields) {
      if (field.stageKey !== stage.key) continue
      // Group members appear under their group's entries, not at top level.
      if (field.repeatGroupKey !== null) continue
      // FILE carries evidence rather than an answer, and STATEMENT is prose
      // the applicant only read — neither has anything to print here.
      if (field.type === 'FILE' || field.type === 'STATEMENT') continue
      if (input.template.documentFieldKeys.has(field.key)) continue
      if (field.type === 'REPEAT_GROUP') {
        renderGroup(field)
        continue
      }
      row(totally(() => String(field.label)), formatValue(field, input.answers[field.key]))
    }
  }

  renderHeader()

  for (const stage of input.template.stages) {
    renderStage(stage)
    gap(8)
  }

  return document.save()
}
