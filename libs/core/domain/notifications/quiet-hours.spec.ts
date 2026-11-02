import { hourIn, isInQuietRange } from './quiet-hours'

const SV = 'America/El_Salvador' // UTC-6, no daylight saving

describe('hourIn', () => {
  it('reads the hour on the clock of the timezone', () => {
    expect(hourIn(SV, new Date('2026-11-02T04:30:00Z'))).toBe(22)
    expect(hourIn('UTC', new Date('2026-11-02T00:00:00Z'))).toBe(0)
  })
})

describe('isInQuietRange', () => {
  const night = { start: 22, end: 7, timezone: SV }
  const at = (utc: string): Date => new Date(`2026-11-02T${utc}:00Z`)

  it('wraps a range that crosses midnight', () => {
    expect(isInQuietRange(night, at('04:00'))).toBe(true) // 22:00 local
    expect(isInQuietRange(night, at('10:00'))).toBe(true) // 04:00 local
    expect(isInQuietRange(night, at('13:00'))).toBe(false) // 07:00 local: the end is out
    expect(isInQuietRange(night, at('20:00'))).toBe(false) // 14:00 local
  })

  it('holds the start and not the end of a range inside one day', () => {
    const lunch = { start: 12, end: 14, timezone: 'UTC' }

    expect(isInQuietRange(lunch, at('12:00'))).toBe(true)
    expect(isInQuietRange(lunch, at('13:59'))).toBe(true)
    expect(isInQuietRange(lunch, at('14:00'))).toBe(false)
  })

  it('treats equal start and end as empty', () => {
    expect(isInQuietRange({ start: 9, end: 9, timezone: 'UTC' }, at('09:00'))).toBe(false)
  })
})
