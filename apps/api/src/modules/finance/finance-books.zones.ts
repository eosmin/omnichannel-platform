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
