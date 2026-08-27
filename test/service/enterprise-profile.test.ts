/**
 * What a person may say about their enterprise, and exactly what they are told
 * when it is refused.
 *
 * The one part of the old 747-line validator that survived the move to a
 * template-driven form, because an enterprise is not a cycle's question — it
 * exists before any application and outlives every one of them.
 *
 * Each row asserts the **exact sentence**, for the reason the authoring
 * refusals do: the sentence is what the person acts on, and "the details are
 * invalid" leaves them to find the fault in a form of a dozen fields.
 */
import { describe, expect, it } from 'vitest'
import {
  addUtcCalendarMonths,
  fullUtcCalendarMonths,
  normalizeEnterpriseProfile,
  parseDateOnly,
} from '../../src/services/application/validation'
import type { SuppliedEnterpriseProfile } from '../../src/services/application/types'

/** The smallest profile the rules accept, which every case below varies. */
const COMPLETE: SuppliedEnterpriseProfile = {
  name: 'Sri Devi Handlooms',
  registrationType: 'PRIVATE_LIMITED',
  registrationNumber: 'U17299TR2024PTC000123',
  establishmentDate: '2024-04-01',
  gstin: '16AAACT2727Q1ZW',
  businessSector: 'HANDLOOM_TEXTILE_AND_HANDICRAFTS',
  otherBusinessSector: null,
  businessBlockOrVillage: 'Khowai',
  businessDistrict: 'WEST_TRIPURA',
  businessPinCode: '799001',
  contactNumber: '9876543210',
  contactEmail: 'contact@example.test',
}

const supplied = (overrides: Partial<SuppliedEnterpriseProfile> = {}) =>
  normalizeEnterpriseProfile({ ...COMPLETE, ...overrides })

describe('what an enterprise may say about itself', () => {
  it('accepts a complete profile', () => {
    const { value, message } = supplied()
    expect(message).toBeNull()
    expect(value).toMatchObject({ name: 'Sri Devi Handlooms', gstin: '16AAACT2727Q1ZW' })
  })

  /*
   * Tidied rather than refused, so two spellings of one enterprise compare
   * equal — which is what the per-owner uniqueness rule rests on.
   */
  it('tidies what carries no meaning', () => {
    const { value } = supplied({
      name: '  Sri   Devi  Handlooms ',
      registrationNumber: ' u17299tr2024ptc000123 ',
      gstin: '16aaact2727q1zw',
      contactNumber: '+91 (98765) 43-210',
      contactEmail: '  Contact@Example.Test ',
    })
    expect(value).toMatchObject({
      name: 'Sri Devi Handlooms',
      registrationNumber: 'U17299TR2024PTC000123',
      gstin: '16AAACT2727Q1ZW',
      contactNumber: '9876543210',
      contactEmail: 'contact@example.test',
    })
  })

  /*
   * The country code is presentation, not identity: '+919876543210' and
   * '9876543210' name the same phone, and keeping both spellings would let the
   * same contact read as two different ones.
   */
  it.each(['+919876543210', '9876543210'])(
    'stores %s as the bare ten digits', (given) => {
      const { value, message } = supplied({ contactNumber: given })
      expect(message).toBeNull()
      expect(value?.contactNumber).toBe('9876543210')
    })

  it('reads every optional answer left out as absent rather than invalid', () => {
    const { value, message } = normalizeEnterpriseProfile({
      name: 'Bare Minimum Weaves',
      registrationType: 'SOLE_PROPRIETORSHIP',
    })
    expect(message).toBeNull()
    expect(value).toMatchObject({ businessSector: null, gstin: null, contactEmail: null })
  })

  /*
   * A sole proprietorship has no incorporation instrument, so there may be
   * nothing to quote — and one that does hold a number (Udyam, a shop licence)
   * is not thereby wrong. Both directions are ordinary.
   */
  it.each([
    ['without any registration number', null],
    ['with one it happens to hold', 'UDYAM-TR-01-0000001'],
  ])('accepts a sole proprietorship %s', (_name, registrationNumber) => {
    const { message } = supplied({
      registrationType: 'SOLE_PROPRIETORSHIP',
      registrationNumber,
    })
    expect(message).toBeNull()
  })

  it.each([
    'DHALAI', 'GOMATI', 'KHOWAI', 'NORTH_TRIPURA',
    'SEPAHIJALA', 'SOUTH_TRIPURA', 'UNAKOTI', 'WEST_TRIPURA',
  ])('accepts the district %s', (district) => {
    const { value, message } = supplied({ businessDistrict: district })
    expect(message).toBeNull()
    expect(value?.businessDistrict).toBe(district)
  })

  // The district stays optional: not naming one is absence, not error.
  it('accepts a profile that names no district', () => {
    const { message } = supplied({ businessDistrict: null })
    expect(message).toBeNull()
  })

  it.each([
    ['a name of one character', { name: 'A' }, 'Enterprise name must contain 2 to 200 characters.'],
    ['a name of nothing at all', { name: '   ' }, 'Enterprise name must contain 2 to 200 characters.'],
    ['a name past 200 characters', { name: 'A'.repeat(201) },
      'Enterprise name must contain 2 to 200 characters.'],
    ['a registration type it does not have',
      { registrationType: 'UDYAM' as never }, 'Select a valid registration type.'],
    ['a private limited company with no number',
      { registrationType: 'PRIVATE_LIMITED' as const, registrationNumber: null },
      'Enter the registration number for this registration type.'],
    ['an LLP with no number',
      { registrationType: 'LLP' as const, registrationNumber: null },
      'Enter the registration number for this registration type.'],
    ['a one person company with no number',
      { registrationType: 'OPC' as const, registrationNumber: null },
      'Enter the registration number for this registration type.'],
    ['a date that is not one', { establishmentDate: '01-04-2024' },
      'Enter a real establishment date in YYYY-MM-DD format.'],
    ['a day that does not exist', { establishmentDate: '2025-02-31' },
      'Enter a real establishment date in YYYY-MM-DD format.'],
    ['a GSTIN of the wrong shape', { gstin: 'NOT-A-GSTIN' }, 'Enter a valid GSTIN.'],
    ['a sector the programme does not list',
      { businessSector: 'CRYPTO' as never }, 'Select a valid business sector.'],
    ['"other" with nothing said about it',
      { businessSector: 'OTHER' as const, otherBusinessSector: null },
      'Describe the other business sector.'],
    ['a district written as prose rather than chosen',
      { businessDistrict: 'West Tripura' }, 'Select one of the eight districts of Tripura.'],
    ['a place that is not a district',
      { businessDistrict: 'AGARTALA' }, 'Select one of the eight districts of Tripura.'],
    ['a PIN code of five digits', { businessPinCode: '79900' }, 'Enter a six-digit PIN code.'],
    ['a PIN code with a letter in it', { businessPinCode: '79900A' }, 'Enter a six-digit PIN code.'],
    ['a contact number of nine digits',
      { contactNumber: '987654321' }, 'Enter a 10-digit mobile number.'],
    ['a contact number of eleven digits',
      { contactNumber: '98765432101' }, 'Enter a 10-digit mobile number.'],
    ['a contact number with letters in it',
      { contactNumber: '98765abc21' }, 'Enter a 10-digit mobile number.'],
    ['an address that is not one', { contactEmail: 'not-an-email' },
      'Enter a valid email address.'],
  ] as const)('refuses %s', (_name, override, message) => {
    const result = supplied(override as Partial<SuppliedEnterpriseProfile>)
    expect(result.message).toBe(message)
    // A refusal writes nothing, so a partially-normalised profile cannot reach
    // the caller and be stored by a path that only checked the message.
    expect(result.value).toBeNull()
  })

  it.each([
    ['registration number', { registrationNumber: `UDYAM-${'A'.repeat(200)}` }, 200],
    ['other business sector',
      { businessSector: 'OTHER' as const, otherBusinessSector: 'A'.repeat(201) }, 200],
    ['block or village', { businessBlockOrVillage: 'A'.repeat(501) }, 500],
    ['email address', { contactEmail: `${'a'.repeat(250)}@example.test` }, 254],
  ] as const)('refuses a %s past its own limit', (fieldName, override, maximum) => {
    expect(supplied(override as Partial<SuppliedEnterpriseProfile>).message)
      .toBe(`Enterprise ${fieldName} must contain at most ${maximum} characters.`)
  })
})

/**
 * The calendar arithmetic the expansion rules rest on.
 *
 * Months are not thirty days and years are not 365 of them. Every case here is
 * one where treating them as either gives a different answer — and the answer
 * decides whether somebody may apply for expansion funding at all.
 */
describe('counting whole months across a calendar', () => {
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`)

  it.each([
    ['the end of a shorter month', '2026-01-31', 1, '2026-02-28'],
    ['a leap February', '2028-01-31', 1, '2028-02-29'],
    ['a whole year', '2025-03-15', 12, '2026-03-15'],
    ['the end of a month that stays the end', '2026-01-31', 3, '2026-04-30'],
    ['no months at all', '2026-06-15', 0, '2026-06-15'],
  ])('adds %s', (_name, from, months, expected) => {
    expect(addUtcCalendarMonths(at(from), months).toISOString().slice(0, 10)).toBe(expected)
  })

  it.each([
    ['a day short of a month', '2026-01-15', '2026-02-14', 0],
    ['exactly a month', '2026-01-15', '2026-02-15', 1],
    ['a day past a month', '2026-01-15', '2026-02-16', 1],
    ['a day short of a year', '2025-06-01', '2026-05-31', 11],
    ['exactly a year', '2025-06-01', '2026-06-01', 12],
    ['from the 31st into February', '2026-01-31', '2026-02-28', 1],
  ])('counts %s', (_name, from, to, expected) => {
    expect(fullUtcCalendarMonths(at(from), at(to))).toBe(expected)
  })

  // Never negative: a date in the future has not been trading for -3 months,
  // and a caller comparing against a threshold must not read a negative as one.
  it('never counts backwards', () => {
    expect(fullUtcCalendarMonths(at('2026-06-01'), at('2025-01-01'))).toBe(0)
  })
})

describe('reading a date that is only a date', () => {
  it.each(['2026-06-01', '2028-02-29', '2026-12-31'])('accepts %s', (given) => {
    expect(parseDateOnly(given)?.toISOString().slice(0, 10)).toBe(given)
  })

  it.each([
    '01-06-2026', '2026-6-1', '2026-06-01T00:00:00Z', '2026-02-30', '2027-02-29',
    '2026-13-01', '2026-00-01', '2026-06-00', 'not a date', '',
  ])('refuses %s', (given) => {
    expect(parseDateOnly(given)).toBeNull()
  })
})

