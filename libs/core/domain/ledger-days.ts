import type { PartyType } from './finance-constants'

// The pieces of the ledger rules that a screen needs too, so they live in the domain lib and the finance lib (which carries the
// database) re-exports them: a calendar day, the date of a day, and a line of an entry before it is written.

export interface DraftLine {
  accountId: string
  debitCents: number
  creditCents: number
  // The dimension of the line (the store of the order, the warehouse's owner, the store of the expense)
  storeId?: string | null
  partyType?: PartyType | null
  partyId?: string | null
  taxRateId?: string | null
  memo?: string | null
}

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

// A calendar date, not only a shape that looks like one (no 31 of February)
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export const dayToDate = (day: string): Date => new Date(`${day}T00:00:00Z`)
export const dateToDay = (date: Date): string => date.toISOString().slice(0, 10)
