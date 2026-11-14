import { ReportFrequency } from './analytics-constants'
import {
  daysOfPeriod,
  isReportDue,
  isTimeZone,
  localMoment,
  madeOnDay,
  reportPeriod
} from './report-schedule'

describe('time zones', () => {
  it('knows a zone of the database and refuses a made-up one', () => {
    expect(isTimeZone('America/El_Salvador')).toBe(true)
    expect(isTimeZone('Etc/GMT+6')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('')).toBe(false)
  })
})

describe('localMoment', () => {
  it('reads the clock of the zone, not the one of the server', () => {
    // 2026-11-14 is a Saturday; at 03:30 UTC it is still Friday the 13th in El Salvador (UTC-6)
    const moment = localMoment(new Date('2026-11-14T03:30:00.000Z'), 'America/El_Salvador')
    expect(moment).toEqual({ day: '2026-11-13', hour: 21, weekday: 5, dayOfMonth: 13 })
  })

  it('reads midnight as hour 0, never 24', () => {
    const moment = localMoment(new Date('2026-11-14T06:00:00.000Z'), 'America/El_Salvador')
    expect(moment.hour).toBe(0)
    expect(moment.day).toBe('2026-11-14')
  })
})

describe('isReportDue', () => {
  const monday = { day: '2026-11-09', hour: 8, weekday: 1, dayOfMonth: 9 }
  const first = { day: '2026-12-01', hour: 8, weekday: 2, dayOfMonth: 1 }
  const tuesday = { day: '2026-11-10', hour: 8, weekday: 2, dayOfMonth: 10 }

  it('is never due before its hour', () => {
    expect(isReportDue(ReportFrequency.DAILY, { ...monday, hour: 7 }, 8)).toBe(false)
  })

  it('is due after its hour too, so a missed tick is made up for', () => {
    expect(isReportDue(ReportFrequency.DAILY, { ...monday, hour: 15 }, 8)).toBe(true)
    // but only on its day
    expect(isReportDue(ReportFrequency.WEEKLY, { ...tuesday, hour: 15 }, 8)).toBe(false)
  })

  it('daily is due every day at its hour', () => {
    expect(isReportDue(ReportFrequency.DAILY, tuesday, 8)).toBe(true)
  })

  it('weekly is due on Mondays only', () => {
    expect(isReportDue(ReportFrequency.WEEKLY, monday, 8)).toBe(true)
    expect(isReportDue(ReportFrequency.WEEKLY, tuesday, 8)).toBe(false)
  })

  it('monthly is due on the first only', () => {
    expect(isReportDue(ReportFrequency.MONTHLY, first, 8)).toBe(true)
    expect(isReportDue(ReportFrequency.MONTHLY, tuesday, 8)).toBe(false)
  })
})

describe('reportPeriod', () => {
  it('daily is yesterday', () => {
    expect(reportPeriod(ReportFrequency.DAILY, '2026-11-14')).toEqual({
      from: '2026-11-13',
      to: '2026-11-14'
    })
  })

  it('weekly is the seven days before the Monday it is made', () => {
    expect(reportPeriod(ReportFrequency.WEEKLY, '2026-11-09')).toEqual({
      from: '2026-11-02',
      to: '2026-11-09'
    })
  })

  it('monthly is the whole month that ended, across a year', () => {
    expect(reportPeriod(ReportFrequency.MONTHLY, '2026-12-01')).toEqual({
      from: '2026-11-01',
      to: '2026-12-01'
    })
    expect(reportPeriod(ReportFrequency.MONTHLY, '2027-01-01')).toEqual({
      from: '2026-12-01',
      to: '2027-01-01'
    })
  })

  it('monthly after a short month and a leap year has the right length', () => {
    const february = reportPeriod(ReportFrequency.MONTHLY, '2028-03-01')
    expect(daysOfPeriod(february)).toHaveLength(29)
  })
})

describe('daysOfPeriod', () => {
  it('lists the days, the first in and the last out', () => {
    expect(daysOfPeriod({ from: '2026-11-12', to: '2026-11-15' })).toEqual([
      '2026-11-12',
      '2026-11-13',
      '2026-11-14'
    ])
  })

  it('is empty for an empty period', () => {
    expect(daysOfPeriod({ from: '2026-11-12', to: '2026-11-12' })).toEqual([])
  })
})

describe('madeOnDay', () => {
  it('compares the day of the zone, not the day in UTC', () => {
    // 03:00 UTC of the 14th is still the 13th in El Salvador
    const sent = new Date('2026-11-14T03:00:00.000Z')
    expect(madeOnDay(sent, 'America/El_Salvador', '2026-11-13')).toBe(true)
    expect(madeOnDay(sent, 'America/El_Salvador', '2026-11-14')).toBe(false)
    expect(madeOnDay(sent, 'UTC', '2026-11-14')).toBe(true)
  })

  it('is false for a report that was never made', () => {
    expect(madeOnDay(null, 'UTC', '2026-11-14')).toBe(false)
  })
})
