import { startOfDayIn } from './local-day'

describe('startOfDayIn', () => {
  it('is the midnight of the zone, as an instant', () => {
    // 2026-11-10 03:00 UTC is still the 9th in El Salvador (UTC-6)
    expect(
      startOfDayIn('America/El_Salvador', new Date('2026-11-10T03:00:00Z')).toISOString()
    ).toBe('2026-11-09T06:00:00.000Z')
    expect(
      startOfDayIn('America/El_Salvador', new Date('2026-11-10T07:00:00Z')).toISOString()
    ).toBe('2026-11-10T06:00:00.000Z')
  })

  it('is the UTC day for UTC and for a zone it does not know', () => {
    const now = new Date('2026-11-10T15:30:00Z')
    expect(startOfDayIn('UTC', now).toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(startOfDayIn('Not/AZone', now).toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(startOfDayIn(undefined, now).toISOString()).toBe('2026-11-10T00:00:00.000Z')
  })

  it('looks the offset up again when daylight saving changes on that day', () => {
    // New York moved to standard time on 2026-11-01 at 02:00: midnight was still UTC-4, noon is UTC-5
    expect(startOfDayIn('America/New_York', new Date('2026-11-01T17:00:00Z')).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z'
    )
  })

  it('is a zone ahead of UTC on its own day', () => {
    // 2026-11-10 23:00 UTC is already the 11th in Tokyo (UTC+9)
    expect(startOfDayIn('Asia/Tokyo', new Date('2026-11-10T23:00:00Z')).toISOString()).toBe(
      '2026-11-10T15:00:00.000Z'
    )
  })
})
