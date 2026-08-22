export const pageSize = (first: number | null | undefined): number | null => {
  if (first === null || first === undefined) return 20
  return Number.isInteger(first) && first >= 1 && first <= 100 ? first : null
}

export const encodeCursor = (date: Date, id: string): string =>
  btoa(JSON.stringify([date.getTime(), id]))

export const decodeCursor = (
  cursor: string | null | undefined,
): { timestamp: Date; id: string } | null | 'INVALID' => {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(atob(cursor))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) ||
      typeof parsed[1] !== 'string' ||
      parsed[1] === ''
    ) return 'INVALID'
    const timestamp = new Date(parsed[0])
    return Number.isNaN(timestamp.getTime()) ? 'INVALID' : { timestamp, id: parsed[1] }
  } catch {
    return 'INVALID'
  }
}
