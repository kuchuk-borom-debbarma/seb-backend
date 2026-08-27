export const TRIPURA_DISTRICTS = [
  'Dhalai',
  'Gomati',
  'Khowai',
  'North Tripura',
  'Sepahijala',
  'South Tripura',
  'Unakoti',
  'West Tripura',
] as const

export const GOVERNMENT_SUPPORT_YEARS = Array.from(
  { length: 2026 - 1900 + 1 },
  (_, index) => 2026 - index,
)
