import { z } from 'zod'

import { FinanceLimits, FinanceReportLimits, singleLineText } from '@platform/core/domain'
import { isIsoDate } from '@platform/core/finance'

// A calendar day, not only a string that looks like one (no 31 of February)
const day = z.string().refine(isIsoDate, { message: 'not a calendar date (YYYY-MM-DD)' })

// A range of days the CSV of a journal or a ledger may cover: a year and a leap day, so a fiscal year always fits
const MAX_RANGE_DAYS = 366
const rangeLength = (range: { from: string; to: string }): number =>
  (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000

const range = z
  .strictObject({ from: day, to: day })
  .refine(value => value.from <= value.to, { message: 'from is after to' })
  .refine(value => rangeLength(value) < MAX_RANGE_DAYS, {
    message: `the range is longer than ${String(MAX_RANGE_DAYS)} days`
  })

// Closing takes no body: the period is the one in the path. The reopen carries the reason, which is the audit trail of why the books moved.
export const reopenPeriodSchema = z.strictObject({
  reason: singleLineText(FinanceLimits.REOPEN_REASON_MAX_LENGTH, 1)
})

export const trialBalanceQuerySchema = z.strictObject({
  periodId: z.uuid(),
  storeId: z.uuid().optional()
})

// 'YYYY-MM-DD:number:lineNo': the position of the last line of the page, in the order of the ledger (date, number, line)
const MAX_BIGINT = 9_223_372_036_854_775_807n
const MAX_LINE_NO = 2_147_483_647
export const ledgerCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}:\d{1,19}:\d{1,10}$/)
  .refine(
    value => {
      const [date = '', number = '0', lineNo = '0'] = value.split(':')
      return isIsoDate(date) && BigInt(number) <= MAX_BIGINT && Number(lineNo) <= MAX_LINE_NO
    },
    { message: 'not a position of the ledger' }
  )

export const ledgerQuerySchema = z
  .strictObject({
    accountId: z.uuid(),
    from: day.optional(),
    to: day.optional(),
    storeId: z.uuid().optional(),
    cursor: ledgerCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(FinanceReportLimits.LEDGER_PAGE_MAX).default(100)
  })
  .refine(value => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'from is after to'
  })

export const journalCsvQuerySchema = range
export const ledgerCsvQuerySchema = z
  .strictObject({ accountId: z.uuid(), from: day, to: day, storeId: z.uuid().optional() })
  .refine(value => value.from <= value.to, { message: 'from is after to' })
  .refine(value => rangeLength(value) < MAX_RANGE_DAYS, {
    message: `the range is longer than ${String(MAX_RANGE_DAYS)} days`
  })
export const trialBalanceCsvQuerySchema = trialBalanceQuerySchema

export type ReopenPeriodBody = z.infer<typeof reopenPeriodSchema>
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>
export type JournalCsvQuery = z.infer<typeof journalCsvQuerySchema>
export type LedgerCsvQuery = z.infer<typeof ledgerCsvQuerySchema>
