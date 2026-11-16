import type { FinancePeriodView } from '@platform/api-client'
import { FinanceLimits } from '@platform/core/domain'

export interface OpenPeriodDraft {
  year: string
  month: string
}

export const OpenPeriodFields = { YEAR: 'year', MONTH: 'month' } as const
export type OpenPeriodField = (typeof OpenPeriodFields)[keyof typeof OpenPeriodFields]

// The month of today, in the zone of the person's clock, as the suggestion of the form
export const openPeriodDraftOf = (today: Date): OpenPeriodDraft => ({
  year: String(today.getFullYear()),
  month: String(today.getMonth() + 1)
})

const wholeNumber = (text: string): number | null =>
  /^\d{1,4}$/.test(text.trim()) ? Number(text) : null

export function openPeriodProblem(draft: OpenPeriodDraft): OpenPeriodField | null {
  const year = wholeNumber(draft.year)
  if (year === null || year < FinanceLimits.MIN_YEAR || year > FinanceLimits.MAX_YEAR) {
    return OpenPeriodFields.YEAR
  }
  const month = wholeNumber(draft.month)
  if (month === null || month < FinanceLimits.FIRST_MONTH || month > FinanceLimits.LAST_MONTH) {
    return OpenPeriodFields.MONTH
  }
  return null
}

// Call only after `openPeriodProblem` said null
export const openPeriodInputOf = (draft: OpenPeriodDraft): { year: number; month: number } => ({
  year: Number(draft.year),
  month: Number(draft.month)
})

// A month has ended once its last day is over, by the UTC day (the api reads it the same way and says so when it refuses)
export const periodHasEnded = (period: Pick<FinancePeriodView, 'endsOn'>, now: Date): boolean =>
  now.toISOString().slice(0, 10) > period.endsOn

// 'YYYY-MM', which is also the order of the periods: the newest first
export const periodKeyOf = (period: Pick<FinancePeriodView, 'year' | 'month'>): string =>
  `${String(period.year)}-${String(period.month).padStart(2, '0')}`
