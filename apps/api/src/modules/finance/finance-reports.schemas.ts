import { z } from 'zod'

import {
  AgingKind,
  FinanceLimits,
  FinanceReportLimits,
  lowercasedUuidSchema,
  PartyType,
  queryIntSchema,
  singleLineText
} from '@platform/core/domain'
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

// Closing takes no body and the chain status no query: the period is in the path and the organization is the caller's. A key
// the caller sends anyway (an `organizationId`, say) is refused, as every other route does, and not ignored (LED-753). A close
// sent with no body at all reads as an empty one.
export const closePeriodSchema = z.preprocess(value => value ?? {}, z.strictObject({}))
export const chainStatusQuerySchema = z.strictObject({})

// The reopen carries the reason, which is the audit trail of why the books moved.
export const reopenPeriodSchema = z.strictObject({
  reason: singleLineText(FinanceLimits.REOPEN_REASON_MAX_LENGTH, 1)
})

export const trialBalanceQuerySchema = z.strictObject({
  periodId: lowercasedUuidSchema,
  storeId: lowercasedUuidSchema.optional()
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

// The party of a line (a supplier, a carrier connection, a customer): the type alone narrows to its kind, the id needs its type
const partyFilter = {
  partyType: z.enum(PartyType).optional(),
  partyId: lowercasedUuidSchema.optional()
}
const partyIdNeedsType = (value: { partyType?: PartyType; partyId?: string }): boolean =>
  value.partyId === undefined || value.partyType !== undefined

export const ledgerQuerySchema = z
  .strictObject({
    accountId: lowercasedUuidSchema,
    from: day.optional(),
    to: day.optional(),
    storeId: lowercasedUuidSchema.optional(),
    ...partyFilter,
    cursor: ledgerCursorSchema.optional(),
    limit: queryIntSchema(1, FinanceReportLimits.LEDGER_PAGE_MAX).default(100)
  })
  .refine(value => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: 'from is after to'
  })
  .refine(partyIdNeedsType, { message: 'partyId needs partyType' })

export const journalCsvQuerySchema = range

// Each account's balance, since the books started, at the end of a day; optionally of one store
export const accountBalancesQuerySchema = z.strictObject({
  asOf: day,
  storeId: lowercasedUuidSchema.optional()
})

// The journal of a range, entries with their lines, oldest first, by pages of entries. The cursor is the number of the last entry of the page.
export const journalQuerySchema = z
  .strictObject({
    from: day,
    to: day,
    cursor: z
      .string()
      .regex(/^\d{1,19}$/)
      // A refine runs even when the regex failed, and BigInt throws on what is not digits
      .refine(value => !/^\d{1,19}$/.test(value) || BigInt(value) <= MAX_BIGINT, {
        message: 'not an entry number'
      })
      .optional(),
    limit: queryIntSchema(1, FinanceReportLimits.JOURNAL_PAGE_MAX).default(50)
  })
  .refine(value => value.from <= value.to, { message: 'from is after to' })
  .refine(value => rangeLength(value) < MAX_RANGE_DAYS, {
    message: `the range is longer than ${String(MAX_RANGE_DAYS)} days`
  })
export const ledgerCsvQuerySchema = z
  .strictObject({
    accountId: lowercasedUuidSchema,
    from: day,
    to: day,
    storeId: lowercasedUuidSchema.optional(),
    ...partyFilter
  })
  .refine(value => value.from <= value.to, { message: 'from is after to' })
  .refine(partyIdNeedsType, { message: 'partyId needs partyType' })
  .refine(value => rangeLength(value) < MAX_RANGE_DAYS, {
    message: `the range is longer than ${String(MAX_RANGE_DAYS)} days`
  })
export const trialBalanceCsvQuerySchema = trialBalanceQuerySchema

// The statements: a range of days (any length, they are sums and not files of rows) or one day, optionally of one store
export const flowQuerySchema = z
  .strictObject({ from: day, to: day, storeId: lowercasedUuidSchema.optional() })
  .refine(value => value.from <= value.to, { message: 'from is after to' })
// The margin walks the sale entries and the orders of its range in one request, so its range is bounded like the one of the VAT report
export const marginQuerySchema = flowQuerySchema.refine(
  value => rangeLength(value) <= FinanceLimits.VAT_REPORT_MAX_DAYS,
  { message: `the range is longer than ${String(FinanceLimits.VAT_REPORT_MAX_DAYS)} days` }
)
export const balanceSheetQuerySchema = z.strictObject({
  asOf: day,
  storeId: lowercasedUuidSchema.optional()
})
export const agingQuerySchema = z.strictObject({
  kind: z.enum(AgingKind),
  asOf: day,
  storeId: lowercasedUuidSchema.optional()
})

export type FlowQuery = z.infer<typeof flowQuerySchema>
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>
export type AgingQuery = z.infer<typeof agingQuerySchema>
export type ClosePeriodBody = z.infer<typeof closePeriodSchema>
export type ChainStatusQuery = z.infer<typeof chainStatusQuerySchema>
export type ReopenPeriodBody = z.infer<typeof reopenPeriodSchema>
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>
export type AccountBalancesQuery = z.infer<typeof accountBalancesQuerySchema>
export type JournalQuery = z.infer<typeof journalQuerySchema>
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>
export type JournalCsvQuery = z.infer<typeof journalCsvQuerySchema>
export type LedgerCsvQuery = z.infer<typeof ledgerCsvQuerySchema>
