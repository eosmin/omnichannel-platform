import { dayOfClock, isCalendarDay, nextDay } from './dates'

describe('isCalendarDay', () => {
  it.each(['2026-11-01', '2024-02-29', '2000-12-31'])('accepts %s', text => {
    expect(isCalendarDay(text)).toBe(true)
  })

  it.each([
    '',
    '2026-11',
    '2026-13-01',
    '2026-02-30',
    '2025-02-29',
    '26-11-01',
    '2026-1-1',
    '2026-11-01 '
  ])('refuses %j', text => {
    expect(isCalendarDay(text)).toBe(false)
  })
})

describe('dayOfClock and nextDay', () => {
  it('writes the day of a clock as the books do', () => {
    expect(dayOfClock(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(dayOfClock(new Date(2026, 10, 16, 0, 1))).toBe('2026-11-16')
  })

  it('goes to the next day by the calendar, across a month, a year and a leap day', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(nextDay('2024-02-28')).toBe('2024-02-29')
    expect(nextDay('2025-02-28')).toBe('2025-03-01')
  })
})
