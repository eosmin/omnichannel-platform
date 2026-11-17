import { daysPastDue } from './purchases.support'

describe('daysPastDue', () => {
  it('counts the days between the due day and the day of the books by the calendar', () => {
    expect(daysPastDue('2026-11-01', '2026-11-16')).toBe(15)
    expect(daysPastDue('2026-11-16', '2026-11-16')).toBe(0)
    // Not yet due, and across a change of month and of year
    expect(daysPastDue('2026-12-01', '2026-11-16')).toBe(0)
    expect(daysPastDue('2026-12-30', '2027-01-02')).toBe(3)
  })

  it('does not drift on a day with a change of clock', () => {
    expect(daysPastDue('2026-03-07', '2026-03-09')).toBe(2)
  })
})
