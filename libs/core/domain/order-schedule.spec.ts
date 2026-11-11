import { OrderScheduledDeliveryShortcuts } from './order-constants'
import {
  calendarDayIn,
  calendarDayToDate,
  dateToCalendarDay,
  nextCalendarDay,
  scheduledDeliveryShortcutRange,
  startOfCalendarDayIn
} from './order-schedule'

// 2026-11-11 03:30 UTC is still the evening of the 10th in El Salvador (UTC-6, no daylight saving)
const LATE_EVENING_IN_SV = new Date('2026-11-11T03:30:00Z')

describe('calendarDayIn', () => {
  it('reads the day on the clock of the timezone, not the one of the server', () => {
    expect(calendarDayIn('America/El_Salvador', LATE_EVENING_IN_SV)).toBe('2026-11-10')
    expect(calendarDayIn('UTC', LATE_EVENING_IN_SV)).toBe('2026-11-11')
    expect(calendarDayIn('Pacific/Auckland', LATE_EVENING_IN_SV)).toBe('2026-11-11')
  })
})

describe('the day of the column', () => {
  it('goes from the API day to the Date of a DATE column and back, with no shift of day', () => {
    const date = calendarDayToDate('2026-11-10')
    expect(date.toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(dateToCalendarDay(date)).toBe('2026-11-10')
    expect(dateToCalendarDay(calendarDayToDate('2028-02-29'))).toBe('2028-02-29')
  })
})

describe('a day that does not exist', () => {
  it('is an error, not a rolled-over day', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'garbage', '', '2026-2-3']) {
      expect(() => calendarDayToDate(bad)).toThrow(RangeError)
      expect(() => nextCalendarDay(bad)).toThrow(RangeError)
    }
  })
})

describe('nextCalendarDay', () => {
  it('carries into the next month and year, and through a leap day', () => {
    expect(nextCalendarDay('2026-11-10')).toBe('2026-11-11')
    expect(nextCalendarDay('2026-11-30')).toBe('2026-12-01')
    expect(nextCalendarDay('2026-12-31')).toBe('2027-01-01')
    expect(nextCalendarDay('2028-02-28')).toBe('2028-02-29')
    expect(nextCalendarDay('2028-02-29')).toBe('2028-03-01')
  })
})

describe('scheduledDeliveryShortcutRange', () => {
  it('turns today into one day on both sides, in the store timezone', () => {
    expect(
      scheduledDeliveryShortcutRange(
        OrderScheduledDeliveryShortcuts.TODAY,
        'America/El_Salvador',
        LATE_EVENING_IN_SV
      )
    ).toEqual({ from: '2026-11-10', to: '2026-11-10' })
  })

  it('turns tomorrow into the day after today of the store, not of the server', () => {
    expect(
      scheduledDeliveryShortcutRange(
        OrderScheduledDeliveryShortcuts.TOMORROW,
        'America/El_Salvador',
        LATE_EVENING_IN_SV
      )
    ).toEqual({ from: '2026-11-11', to: '2026-11-11' })
    expect(
      scheduledDeliveryShortcutRange(
        OrderScheduledDeliveryShortcuts.TOMORROW,
        'UTC',
        LATE_EVENING_IN_SV
      )
    ).toEqual({ from: '2026-11-12', to: '2026-11-12' })
  })
})

describe('startOfCalendarDayIn', () => {
  it('starts the day at midnight on the clock of the zone', () => {
    expect(startOfCalendarDayIn('America/El_Salvador', '2026-11-10').toISOString()).toBe(
      '2026-11-10T06:00:00.000Z'
    )
    expect(startOfCalendarDayIn('UTC', '2026-11-10').toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(startOfCalendarDayIn('Pacific/Auckland', '2026-11-10').toISOString()).toBe(
      '2026-11-09T11:00:00.000Z'
    )
  })

  it('puts the late evening of a day inside it and the next instant outside', () => {
    const start = startOfCalendarDayIn('America/El_Salvador', '2026-11-10')
    const next = startOfCalendarDayIn('America/El_Salvador', nextCalendarDay('2026-11-10'))
    expect(calendarDayIn('America/El_Salvador', LATE_EVENING_IN_SV)).toBe('2026-11-10')
    expect(LATE_EVENING_IN_SV.getTime()).toBeGreaterThanOrEqual(start.getTime())
    expect(LATE_EVENING_IN_SV.getTime()).toBeLessThan(next.getTime())
  })

  it('settles a day with a clock change (23 hours long) in a zone that has one', () => {
    const start = startOfCalendarDayIn('America/New_York', '2026-03-08')
    const next = startOfCalendarDayIn('America/New_York', '2026-03-09')
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(next.toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('refuses a day that does not exist', () => {
    expect(() => startOfCalendarDayIn('UTC', '2026-02-30')).toThrow(RangeError)
  })
})
