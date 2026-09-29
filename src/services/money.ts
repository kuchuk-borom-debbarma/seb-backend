/**
 * Money written for a person to read, on the server.
 *
 * The ledger holds integer paise and every stored or transmitted amount stays
 * in paise. This exists only for the few sentences the server writes itself —
 * a form rule's refusal, an activity-history summary — and is shared so the two
 * cannot come to show one amount two ways.
 */
export const rupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
