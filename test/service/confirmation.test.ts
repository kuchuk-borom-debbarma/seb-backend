/**
 * The application PDF that travels with a confirmation email.
 *
 * pdf-lib gives no text extraction, so what is provable here is structural:
 * the bytes are a well-formed PDF that pdf-lib itself can re-open, long
 * content grows pages instead of running off one, and — the property that
 * matters most — no content whatsoever can make the builder throw. A broken
 * PDF must never break the email, and a broken email must never break the
 * submission; the first of those guarantees is this file's.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildApplicationPdf } from '../../src/services/application/confirmation'
import { resolveFormTemplate } from '../../src/services/application/form/template'
import type { AnswerMap } from '../../src/services/application/form/types'
import { completeAnswers, defaultTemplate, templateRowsFor } from '../support/form'

const template = resolveFormTemplate(templateRowsFor(defaultTemplate()))!

const build = (overrides: Partial<Parameters<typeof buildApplicationPdf>[0]> = {}) =>
  buildApplicationPdf({
    referenceNumber: 'SEP-2026-ABCDEFGH',
    cycleCode: 'SEP-2026',
    cycleDisplayName: 'Mission SEP 2026',
    submittedAt: new Date('2026-06-01T10:30:00Z'),
    template,
    answers: completeAnswers() as AnswerMap,
    heading: 'Application submitted',
    ...overrides,
  })

describe('the application PDF', () => {
  it('produces a real PDF that pdf-lib can re-open', async () => {
    const bytes = await build()
    // The magic number, read from the bytes rather than trusted from the API.
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF')
    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('grows pages rather than running past the bottom margin', async () => {
    const longText = 'A long narrative answer that has to wrap. '.repeat(12)
    const answers = Object.fromEntries(
      Object.entries(completeAnswers()).map(([key, value]) =>
        [key, typeof value === 'string' ? longText : value],
      ),
    ) as AnswerMap
    const extra = Array.from({ length: 100 }, (_, index) => ({
      label: `Additional detail ${index + 1}`,
      value: longText,
    }))
    const bytes = await build({ answers, extra })
    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getPageCount()).toBeGreaterThan(1)
  })

  it('never throws on text a WinAnsi font cannot encode', async () => {
    /*
     * Standard fonts encode WinAnsi only. Money signs, Bengali, Devanagari
     * and emoji are all things a real applicant really types; the builder
     * must sanitise them, not fail on them.
     */
    const bytes = await build({
      heading: 'আবেদন জমা হয়েছে ✅',
      answers: {
        ...(completeAnswers() as AnswerMap),
        GOVERNMENT_SCHEME_NAME: 'ত্রিপুরা খাদ্য — ₹ ब्यवसाय 🌾',
        EXISTING_BANK_NAME: 'আগরতলা ব্যাংক',
      },
      extra: [{ label: 'Approved amount', value: '₹9,000' }],
    })
    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('renders whatever it is given rather than throwing on odd values', async () => {
    const bytes = await build({
      referenceNumber: null,
      submittedAt: null,
      answers: {
        ...(completeAnswers() as AnswerMap),
        // Numbers where strings are expected, and the reverse.
        GOVERNMENT_SCHEME_NAME: 12345 as unknown as string,
        TOTAL_PROJECT_COST_PAISE: 'not a number' as unknown as number,
        EXISTING_CREDIT_STATUS: 'A_VALUE_NO_OPTION_DECLARES',
      },
    })
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined()
  })

  it('enumerates the entries of a repeated group', async () => {
    const grouped = resolveFormTemplate(templateRowsFor(defaultTemplate((each) => ({
      ...each,
      fields: [
        ...each.fields,
        {
          stageKey: 'DOCUMENTS', fieldKey: 'PARTNERS', fieldType: 'REPEAT_GROUP',
          label: 'Partners', requirement: 'OPTIONAL', repeatMin: 0, repeatMax: 5,
        },
        {
          stageKey: 'DOCUMENTS', fieldKey: 'PARTNER_NAME', fieldType: 'TEXT',
          label: 'Partner name', requirement: 'REQUIRED',
          parentFieldKey: 'PARTNERS', maxLength: 200,
        },
        {
          stageKey: 'DOCUMENTS', fieldKey: 'PARTNER_SHARE', fieldType: 'INTEGER',
          label: 'Share (%)', requirement: 'REQUIRED', parentFieldKey: 'PARTNERS',
        },
      ],
    }))))!
    const flat = await build({ template: grouped })
    const bytes = await build({
      template: grouped,
      answers: {
        ...(completeAnswers() as AnswerMap),
        PARTNERS: [
          { PARTNER_NAME: 'Rina Debbarma', PARTNER_SHARE: 60 },
          { PARTNER_NAME: 'Alok Debbarma', PARTNER_SHARE: 40 },
        ],
      },
    })
    const reopened = await PDFDocument.load(bytes)
    expect(reopened.getPageCount()).toBeGreaterThanOrEqual(1)
    /*
     * No text extraction, so the entries are shown to exist by weight: two
     * enumerated entries with their member rows must make the document
     * strictly larger than the same form with the group unanswered.
     */
    expect(bytes.byteLength).toBeGreaterThan(flat.byteLength)
  })
})
