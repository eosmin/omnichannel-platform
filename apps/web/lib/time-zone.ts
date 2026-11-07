// The zone the hours of the app are shown in: the one the person chose in their account, else the one of the
// store they are working in (the one the snooze already counts in), else the one of their browser. Before the
// browser says (the first render, which the server also draws) there is none: `undefined` leaves the zone of
// the provider as it is.
export function displayTimeZone(
  accountZone: string | null | undefined,
  browserZone: string | undefined,
  storeZone?: string | null
): string | undefined {
  for (const zone of [accountZone, storeZone]) {
    if (zone !== null && zone !== undefined && zone !== '' && isKnownTimeZone(zone)) return zone
  }
  return browserZone
}

// A zone this browser cannot format (an old name, a value that drifted) would throw in every date of the page
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}
