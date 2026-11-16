import { isCalendarDay } from './dates'

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
