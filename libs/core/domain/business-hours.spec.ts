import { isWithinSchedule, type WeekSchedule } from './business-hours'

const closed = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }
const weekdays: WeekSchedule = {
  ...closed,
  mon: [{ from: '09:00', to: '18:00' }],
  tue: [
    { from: '09:00', to: '13:00' },
    { from: '15:00', to: '24:00' }
  ]
}

describe('isWithinSchedule', () => {
  it('is open from the start of a range and closed at its end', () => {
    // 2026-03-02 is a Monday
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-02T08:59:00Z'))).toBe(false)
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-02T09:00:00Z'))).toBe(true)
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-02T17:59:00Z'))).toBe(true)
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-02T18:00:00Z'))).toBe(false)
  })

  it('reads the clock of the timezone of the store, not the one of the server', () => {
    // 15:00 UTC is 09:00 in San Salvador (UTC-6, no daylight saving) and 10:00 in New York (EST)
    const at = new Date('2026-01-05T15:00:00Z')
    expect(isWithinSchedule(weekdays, 'America/El_Salvador', at)).toBe(true)
    expect(isWithinSchedule(weekdays, 'America/New_York', at)).toBe(true)
    expect(isWithinSchedule(weekdays, 'Asia/Tokyo', at)).toBe(false)
  })

  it('moves the weekday with the timezone', () => {
    // Tuesday is open all day, Monday is closed
    const tuesdayOnly: WeekSchedule = { ...closed, tue: [{ from: '00:00', to: '24:00' }] }
    // Tuesday 03:00 UTC is still Monday 21:00 in San Salvador
    const at = new Date('2026-01-06T03:00:00Z')
    expect(isWithinSchedule(tuesdayOnly, 'UTC', at)).toBe(true)
    expect(isWithinSchedule(tuesdayOnly, 'America/El_Salvador', at)).toBe(false)
  })

  it('opens at midnight for a range that starts at 00:00, in any timezone', () => {
    const fromMidnight: WeekSchedule = { ...closed, mon: [{ from: '00:00', to: '06:00' }] }
    // Monday 00:00 in UTC, and Monday 00:00 in San Salvador (06:00 UTC)
    expect(isWithinSchedule(fromMidnight, 'UTC', new Date('2026-03-02T00:00:00Z'))).toBe(true)
    expect(
      isWithinSchedule(fromMidnight, 'America/El_Salvador', new Date('2026-03-02T06:00:00Z'))
    ).toBe(true)
    expect(
      isWithinSchedule(fromMidnight, 'America/El_Salvador', new Date('2026-03-02T05:59:00Z'))
    ).toBe(false)
  })

  it('follows daylight saving', () => {
    // New York is UTC-5 in January and UTC-4 in July: 13:30 UTC is 08:30 and 09:30
    const winter = new Date('2026-01-05T13:30:00Z')
    const summer = new Date('2026-07-06T13:30:00Z')
    expect(isWithinSchedule(weekdays, 'America/New_York', winter)).toBe(false)
    expect(isWithinSchedule(weekdays, 'America/New_York', summer)).toBe(true)
  })

  it('holds several ranges in a day and a range that ends at midnight', () => {
    // 2026-03-03 is a Tuesday
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-03T13:30:00Z'))).toBe(false)
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-03T15:00:00Z'))).toBe(true)
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-03T23:59:00Z'))).toBe(true)
    expect(isWithinSchedule(weekdays, 'UTC', new Date('2026-03-04T00:00:00Z'))).toBe(false)
  })

  it('is closed on a day with no ranges', () => {
    expect(isWithinSchedule(closed, 'UTC', new Date('2026-03-02T12:00:00Z'))).toBe(false)
  })
})
