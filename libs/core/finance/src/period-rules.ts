import { FinanceLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { isIsoDate } from './entry-rules'

// The rules of the fiscal periods (TDD_18 §2.4, §5). Calendar months: a fiscal year that is not the calendar year is a
// template setting later (TDD_18 §2.4, [ACCOUNTANT]), not a change here. Dates are 'YYYY-MM-DD' strings, which sort as
// dates, so no time zone enters: an accounting date is a day, not an instant.

export interface PeriodBounds {
  year: number
  month: number
  startsOn: string
  endsOn: string
}

// An accounting date is a day: 'YYYY-MM-DD' and the DATE column's midnight UTC are one thing, converted in these two places
export const dayToDate = (day: string): Date => new Date(`${day}T00:00:00Z`)
export const dateToDay = (date: Date): string => date.toISOString().slice(0, 10)

const pad = (value: number): string => String(value).padStart(2, '0')

export function periodBounds(year: number, month: number): PeriodBounds {
  if (
    !Number.isInteger(year) ||
    year < FinanceLimits.MIN_YEAR ||
    year > FinanceLimits.MAX_YEAR ||
    !Number.isInteger(month) ||
    month < FinanceLimits.FIRST_MONTH ||
    month > FinanceLimits.LAST_MONTH
  ) {
    throw new RangeError(`not a fiscal period: ${year}-${month}`)
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    year,
    month,
    startsOn: `${year}-${pad(month)}-01`,
    endsOn: `${year}-${pad(month)}-${pad(lastDay)}`
  }
}

export function periodOfDate(date: string): PeriodBounds {
  if (!isIsoDate(date)) throw new RangeError(`not a date: ${date}`)
  return periodBounds(Number(date.slice(0, 4)), Number(date.slice(5, 7)))
}

export function nextPeriod(period: Pick<PeriodBounds, 'year' | 'month'>): PeriodBounds {
  return period.month === FinanceLimits.LAST_MONTH
    ? periodBounds(period.year + 1, FinanceLimits.FIRST_MONTH)
    : periodBounds(period.year, period.month + 1)
}

// The day after a date ('2026-01-31' is followed by '2026-02-01')
export function dayAfter(date: string): string {
  if (!isIsoDate(date)) throw new RangeError(`not a date: ${date}`)
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

export interface LedgerCalendar {
  // The first day events are posted from (FinanceSettings.accountingStartDate)
  accountingStartDate: string
  // The last day of the last closed period; null when none is closed (FinanceSettings.lockedThrough)
  lockedThrough: string | null
}

export type EntryDateProblem =
  typeof ErrorCodes.FINANCE_BEFORE_START_DATE | typeof ErrorCodes.FINANCE_PERIOD_CLOSED

// Whether an entry dated `date` may be written: not before the day the books start, and not in a closed period. The
// lock is a date because closes are in order (TDD_18 §5.1): everything up to `lockedThrough` is closed, nothing after.
export function entryDateProblem(date: string, calendar: LedgerCalendar): EntryDateProblem | null {
  // The order of the database trigger: the lock first, then the start of the books
  if (calendar.lockedThrough !== null && date <= calendar.lockedThrough) {
    return ErrorCodes.FINANCE_PERIOD_CLOSED
  }
  if (date < calendar.accountingStartDate) return ErrorCodes.FINANCE_BEFORE_START_DATE
  return null
}

export type AutomaticDate =
  { post: true; entryDate: string; late: boolean } | { post: false; reason: 'before_start' }

// The date of an automatic posting (TDD_18 §4.1 rule 2, §5.2): the day the source event happened, unless that day is in
// a closed period (a late carrier file), and then the first day of the open period. A source before the start of the
// books is never posted (TDD_18 §6.5). `late` is true when the date moved, and the service keeps `sourceDate`.
export function automaticEntryDate(sourceDate: string, calendar: LedgerCalendar): AutomaticDate {
  if (sourceDate < calendar.accountingStartDate) return { post: false, reason: 'before_start' }
  if (calendar.lockedThrough !== null && sourceDate <= calendar.lockedThrough) {
    return { post: true, entryDate: dayAfter(calendar.lockedThrough), late: true }
  }
  return { post: true, entryDate: sourceDate, late: false }
}

// A reversal is dated like the original, in the open period when the original's is closed (TDD_18 §2.5). A date the
// person chose is returned as it is: the service checks it with `entryDateProblem` like any other entry date.
export function reversalDate(
  originalDate: string,
  chosenDate: string | null,
  calendar: LedgerCalendar
): string {
  if (chosenDate !== null) return chosenDate
  return calendar.lockedThrough !== null && originalDate <= calendar.lockedThrough
    ? dayAfter(calendar.lockedThrough)
    : originalDate
}

export interface PeriodRow {
  id: string
  year: number
  month: number
  closed: boolean
}

// Only the latest closed period can be reopened (TDD_18 §5.3): none after it is closed
export function isLatestClosed(periods: readonly PeriodRow[], periodId: string): boolean {
  const target = periods.find(period => period.id === periodId)
  if (target === undefined || !target.closed) return false
  return !periods.some(
    period =>
      period.closed &&
      (period.year > target.year || (period.year === target.year && period.month > target.month))
  )
}

// The last day a lock can have after the latest closed period is reopened: the end of the closed period before it, or
// null when none is left (TDD_18 §5.3)
export function lockedThroughAfterReopen(
  periods: readonly (PeriodRow & { endsOn: string })[],
  reopenedId: string
): string | null {
  const remaining = periods.filter(period => period.closed && period.id !== reopenedId)
  const latest = remaining.reduce<(typeof remaining)[number] | null>(
    (best, period) => (best === null || period.endsOn > best.endsOn ? period : best),
    null
  )
  return latest === null ? null : latest.endsOn
}
