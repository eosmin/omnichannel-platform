// The canonical spelling of an IANA timezone name the runtime knows ("america/el_salvador" is
// "America/El_Salvador"), or null. The runtime also accepts offsets ("+05:00"), which are not zones:
// they have no daylight saving and a consumer that looks the name up in the zone database rejects them.
export function canonicalTimezone(value: string): string | null {
  if (!/^[A-Za-z]/.test(value)) return null
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

export function isTimezone(value: string): boolean {
  return canonicalTimezone(value) !== null
}
