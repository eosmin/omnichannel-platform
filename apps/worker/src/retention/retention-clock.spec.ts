import { localDayOf, localHourOf, startOfNextUtcMonth, startOfUtcMonth } from './retention-clock'

describe('the clock of a store', () => {
  it('reads the hour and the day of the zone, not the ones of UTC', () => {
    // 09:30 UTC: 03:30 in El Salvador (UTC-6, no daylight time), 18:30 in Tokyo (UTC+9)
    const now = new Date('2026-11-14T09:30:00Z')
    expect(localHourOf(now, 'America/El_Salvador')).toBe(3)
    expect(localHourOf(now, 'Asia/Tokyo')).toBe(18)
    expect(localDayOf(now, 'America/El_Salvador')).toBe('2026-11-14')
  })

  it('names the local day, which can be another one than the UTC day', () => {
    const now = new Date('2026-11-14T02:00:00Z')
    expect(localDayOf(now, 'America/El_Salvador')).toBe('2026-11-13')
    expect(localHourOf(now, 'America/El_Salvador')).toBe(20)
    expect(localDayOf(now, 'Asia/Tokyo')).toBe('2026-11-14')
  })

  it('reads midnight as 0 and never as 24', () => {
    expect(localHourOf(new Date('2026-11-14T06:10:00Z'), 'America/El_Salvador')).toBe(0)
  })

  it('follows the clock changes of a zone with daylight time', () => {
    // New York is UTC-5 in winter and UTC-4 in summer: 03:00 local is another instant of UTC
    expect(localHourOf(new Date('2026-01-15T08:00:00Z'), 'America/New_York')).toBe(3)
    expect(localHourOf(new Date('2026-07-15T07:00:00Z'), 'America/New_York')).toBe(3)
    expect(localHourOf(new Date('2026-07-15T08:00:00Z'), 'America/New_York')).toBe(4)
  })

  it('answers null for a zone that is not one, instead of guessing an hour', () => {
    expect(localHourOf(new Date(), 'Not/AZone')).toBeNull()
    expect(localDayOf(new Date(), 'Not/AZone')).toBeNull()
  })
})

describe('the months of the cold export', () => {
  it('begins a month on its first instant in UTC and ends it where the next one begins', () => {
    const at = new Date('2026-03-31T23:59:59.999Z')
    expect(startOfUtcMonth(at).toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(startOfNextUtcMonth(at).toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('goes over the end of a year', () => {
    const at = new Date('2026-12-15T00:00:00Z')
    expect(startOfNextUtcMonth(at).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})
