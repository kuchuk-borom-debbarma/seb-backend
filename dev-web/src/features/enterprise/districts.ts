/**
 * The eight districts of Tripura, as the API's closed set of codes.
 *
 * `businessDistrict` is a string in the schema, but the Worker refuses
 * anything outside this set, so the client offers exactly these. The form
 * shows each district with its headquarters town, as the public site does;
 * the read view shows the bare name. One list shared by both, so a code can
 * never mean different places on different screens.
 */
export const DISTRICTS = [
  { code: 'DHALAI', name: 'Dhalai', headquarters: 'Ambassa' },
  { code: 'GOMATI', name: 'Gomati', headquarters: 'Udaipur' },
  { code: 'KHOWAI', name: 'Khowai', headquarters: 'Khowai' },
  { code: 'NORTH_TRIPURA', name: 'North Tripura', headquarters: 'Dharmanagar' },
  { code: 'SEPAHIJALA', name: 'Sepahijala', headquarters: 'Bishramganj' },
  { code: 'SOUTH_TRIPURA', name: 'South Tripura', headquarters: 'Belonia' },
  { code: 'UNAKOTI', name: 'Unakoti', headquarters: 'Kailashahar' },
  { code: 'WEST_TRIPURA', name: 'West Tripura', headquarters: 'Agartala' },
] as const

/**
 * The bare district name for a stored code. Falls back to the code itself so
 * an unexpected stored value is still visible rather than blank.
 */
export const districtName = (code: string): string =>
  DISTRICTS.find((district) => district.code === code)?.name ?? code
