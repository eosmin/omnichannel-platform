export interface StoreZoneRow {
  name: string
  // Whether the database has the zone in `pg_timezone_names`
  known: boolean
}

// The zones of the stores of an organization, split by what the database can tell. The zone is validated when the store is saved, so an
// unknown one only comes from data written by hand; the books read it as UTC (as the entries do), and the caller says so in the log
export function splitStoreZones(rows: readonly StoreZoneRow[]): {
  known: string[]
  unknown: string[]
} {
  return {
    known: rows.filter(row => row.known).map(row => row.name),
    unknown: rows.filter(row => !row.known).map(row => row.name)
  }
}

// The zones already reported by this process, by organization: a book is read many times (pages, files), and a zone written by hand does
// not change between two reads, so one line per process is what the person who fixes it needs
const reported = new Set<string>()

export function reportUnknownZones(
  logger: { warn: (context: { organizationId: string; zones: string[] }, message: string) => void },
  organizationId: string,
  zones: readonly string[]
): void {
  if (zones.length === 0) return
  const key = `${organizationId}:${[...zones].sort().join('|')}`
  if (reported.has(key)) return
  reported.add(key)
  logger.warn(
    { organizationId, zones: [...zones] },
    'a store of the organization has a time zone the database does not know; its books are read as UTC'
  )
}
