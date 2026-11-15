import { ErrorCodes } from '@platform/core/errors'

import {
  automaticEntryDate,
  dayAfter,
  entryDateProblem,
  isLatestClosed,
  type LedgerCalendar,
  lockedThroughAfterReopen,
  nextPeriod,
  periodBounds,
  periodOfDate,
  reversalDate
} from './period-rules'

const open: LedgerCalendar = { accountingStartDate: '2026-10-01', lockedThrough: null }
const closedOctober: LedgerCalendar = {
  accountingStartDate: '2026-10-01',
  lockedThrough: '2026-10-31'
}

describe('periods', () => {
  it('are calendar months with their last day', () => {
    expect(periodBounds(2026, 2)).toEqual({
      year: 2026,
      month: 2,
      startsOn: '2026-02-01',
      endsOn: '2026-02-28'
    })
    expect(periodBounds(2028, 2).endsOn).toBe('2028-02-29')
    expect(periodBounds(2026, 12).endsOn).toBe('2026-12-31')
    expect(periodOfDate('2026-11-15')).toMatchObject({ year: 2026, month: 11 })
  })
  it('refuse a month or a year that is not one', () => {
    expect(() => periodBounds(2026, 0)).toThrow(RangeError)
    expect(() => periodBounds(2026, 13)).toThrow(RangeError)
    expect(() => periodBounds(1999, 1)).toThrow(RangeError)
    expect(() => periodBounds(2026.5, 1)).toThrow(RangeError)
    expect(() => periodOfDate('2026-02-30')).toThrow(RangeError)
  })
  it('follow each other across the year', () => {
    expect(nextPeriod({ year: 2026, month: 11 })).toMatchObject({ year: 2026, month: 12 })
    expect(nextPeriod({ year: 2026, month: 12 })).toMatchObject({ year: 2027, month: 1 })
  })
  it('have a day after every day', () => {
    expect(dayAfter('2026-01-31')).toBe('2026-02-01')
    expect(dayAfter('2026-12-31')).toBe('2027-01-01')
    expect(dayAfter('2028-02-28')).toBe('2028-02-29')
    expect(() => dayAfter('nope')).toThrow(RangeError)
  })
})

describe('entryDateProblem', () => {
  it('allows a day in the open books', () => {
    expect(entryDateProblem('2026-11-01', closedOctober)).toBeNull()
    expect(entryDateProblem('2026-10-01', open)).toBeNull()
  })
  it('says the lock before the start of the books, as the trigger does', () => {
    expect(
      entryDateProblem('2026-09-30', {
        accountingStartDate: '2026-10-01',
        lockedThrough: '2026-10-31'
      })
    ).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
  })
  it('refuses a day before the books start, and a day in a closed period', () => {
    expect(entryDateProblem('2026-09-30', open)).toBe(ErrorCodes.FINANCE_BEFORE_START_DATE)
    expect(entryDateProblem('2026-10-31', closedOctober)).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
    expect(entryDateProblem('2026-10-01', closedOctober)).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
  })
})

describe('automaticEntryDate', () => {
  it('posts on the day of the event while its period is open', () => {
    expect(automaticEntryDate('2026-11-05', closedOctober)).toEqual({
      post: true,
      entryDate: '2026-11-05',
      late: false
    })
  })
  it('moves a late event to the first day of the open period, keeping that it was late', () => {
    expect(automaticEntryDate('2026-10-20', closedOctober)).toEqual({
      post: true,
      entryDate: '2026-11-01',
      late: true
    })
  })
  it('never posts what happened before the books started', () => {
    expect(automaticEntryDate('2026-09-30', open)).toEqual({ post: false, reason: 'before_start' })
  })
})

describe('reversalDate', () => {
  it('keeps the date of the original, or the one chosen, or the open period when the original is closed', () => {
    expect(reversalDate('2026-11-05', null, closedOctober)).toBe('2026-11-05')
    expect(reversalDate('2026-10-05', null, closedOctober)).toBe('2026-11-01')
    expect(reversalDate('2026-10-05', '2026-11-20', closedOctober)).toBe('2026-11-20')
  })
})

describe('reopening', () => {
  const periods = [
    { id: 'p9', year: 2026, month: 9, closed: true, endsOn: '2026-09-30' },
    { id: 'p10', year: 2026, month: 10, closed: true, endsOn: '2026-10-31' },
    { id: 'p11', year: 2026, month: 11, closed: false, endsOn: '2026-11-30' }
  ]
  it('is for the latest closed period only', () => {
    expect(isLatestClosed(periods, 'p10')).toBe(true)
    expect(isLatestClosed(periods, 'p9')).toBe(false)
    expect(isLatestClosed(periods, 'p11')).toBe(false)
    expect(isLatestClosed(periods, 'missing')).toBe(false)
    expect(
      isLatestClosed(
        [
          { id: 'a', year: 2026, month: 3, closed: true },
          { id: 'b', year: 2027, month: 1, closed: true }
        ],
        'a'
      )
    ).toBe(false)
  })
  it('moves the lock back to the end of the period before', () => {
    expect(lockedThroughAfterReopen(periods, 'p10')).toBe('2026-09-30')
    expect(lockedThroughAfterReopen(periods.slice(1), 'p10')).toBeNull()
  })
})
