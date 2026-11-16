import { z } from 'zod'

import {
  BankLineFilters,
  bankProfileProblem,
  BankStatementEncodings,
  BankStatementLimits,
  BankThousandsSeparators,
  FinanceLimits,
  PaginationLimits,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  singleLineText
} from '@platform/core/domain'
import { isIsoDate } from '@platform/core/finance'

// What a client sends to read a bank's CSV and to decide on what it suggests (TDD_18 §4.4). Every shape is strict: the organization,
// the account of a line, the amount, a status, who decided and when are never taken from the request, the service works them out.

const day = z.string().refine(isIsoDate, { message: 'not a calendar date (YYYY-MM-DD)' })

// A column of the file: the text of its header, or its position (0 is the first column)
const columnRef = z.union([
  singleLineText(BankStatementLimits.COLUMN_HEADER_MAX_LENGTH, 1),
  z.number().int().min(0).max(BankStatementLimits.COLUMN_POSITION_MAX)
])

export const bankMappingSchema = z.strictObject({
  date: columnRef,
  description: columnRef.optional(),
  reference: columnRef.optional(),
  // The money is ONE signed column, or one column for debits and one for credits (the profile rules say which)
  amount: columnRef.optional(),
  debit: columnRef.optional(),
  credit: columnRef.optional()
})

const delimiter = z.enum([
  RemittanceDelimiters.COMMA,
  RemittanceDelimiters.SEMICOLON,
  RemittanceDelimiters.TAB
])
const decimal = z.enum([RemittanceDecimalSeparators.DOT, RemittanceDecimalSeparators.COMMA])
const thousands = z.enum(BankThousandsSeparators)
const dateFormat = z.enum([
  RemittanceDateFormats.ISO,
  RemittanceDateFormats.DAY_FIRST_SLASH,
  RemittanceDateFormats.MONTH_FIRST_SLASH,
  RemittanceDateFormats.DAY_FIRST_DASH
])
const encoding = z.enum([BankStatementEncodings.UTF8, BankStatementEncodings.WINDOWS_1252])
const windowDays = z.number().int().min(0).max(BankStatementLimits.DATE_WINDOW_MAX_DAYS)

const PROFILE_MESSAGE = { message: 'the profile breaks a rule of the bank import profiles' }
const profileIsValid = (value: Parameters<typeof bankProfileProblem>[0]): boolean =>
  bankProfileProblem(value) === null

const reading = {
  delimiter: delimiter.default(RemittanceDelimiters.COMMA),
  hasHeader: z.boolean().default(true),
  decimalSeparator: decimal.default(RemittanceDecimalSeparators.DOT),
  thousandsSeparator: thousands.default(BankThousandsSeparators.NONE),
  dateFormat: dateFormat.default(RemittanceDateFormats.ISO),
  encoding: encoding.default(BankStatementEncodings.UTF8),
  dateWindowDays: windowDays.default(BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS),
  columns: bankMappingSchema
}

export const createBankProfileSchema = z
  .strictObject({
    accountId: z.uuid(),
    name: singleLineText(BankStatementLimits.PROFILE_NAME_MAX_LENGTH, 1),
    ...reading
  })
  .refine(profileIsValid, PROFILE_MESSAGE)
export type CreateBankProfileBody = z.output<typeof createBankProfileSchema>

export const updateBankProfileSchema = z
  .strictObject({
    name: singleLineText(BankStatementLimits.PROFILE_NAME_MAX_LENGTH, 1).optional(),
    delimiter: delimiter.optional(),
    hasHeader: z.boolean().optional(),
    decimalSeparator: decimal.optional(),
    thousandsSeparator: thousands.optional(),
    dateFormat: dateFormat.optional(),
    encoding: encoding.optional(),
    dateWindowDays: windowDays.optional(),
    columns: bankMappingSchema.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })
export type UpdateBankProfileBody = z.output<typeof updateBankProfileSchema>

export const listBankProfilesQuerySchema = z.strictObject({ accountId: z.uuid().optional() })
export type ListBankProfilesQuery = z.output<typeof listBankProfilesQuerySchema>

// The mapper's preview: a sample of the file, already text (the browser decoded it), and the mapping being tried
export const bankPreviewSchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .refine(
      value => new TextEncoder().encode(value).length <= BankStatementLimits.PREVIEW_MAX_BYTES,
      { message: 'the sample is larger than a preview takes' }
    ),
  profile: z.strictObject(reading).refine(profileIsValid, PROFILE_MESSAGE)
})
export type BankPreviewBody = z.output<typeof bankPreviewSchema>

// The query of an import: the saved profile that reads the file (the file is the body), and, when the person knows it, the balance the
// statement ends with and the day it is of: both or neither
export const bankImportQuerySchema = z
  .strictObject({
    profileId: z.uuid(),
    // An empty value is no balance (it would be read as 0.00, a balance nobody said). The cents are written as a whole number and
    // nothing else: `Number()` would read a blank as 0, "1e3" as 1000 and "0x10" as 16
    closingBalanceCents: z.preprocess(
      value => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^(?:0|-?[1-9]\d{0,9})$/)
        .transform(Number)
        .pipe(z.number().int().min(-FinanceLimits.MAX_LINE_CENTS).max(FinanceLimits.MAX_LINE_CENTS))
        .optional()
    ),
    closingOn: day.optional(),
    // The person said the order of the day and the month of the file is the profile's, when every date reads in both orders
    dateFormatConfirmed: z
      .enum(['true', 'false'])
      .transform(value => value === 'true')
      .optional()
  })
  .refine(query => (query.closingBalanceCents === undefined) === (query.closingOn === undefined), {
    message: 'the closing balance and its day come together'
  })
export type BankImportQuery = z.output<typeof bankImportQuerySchema>

export const listBankImportsQuerySchema = z.strictObject({
  accountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})
export type ListBankImportsQuery = z.output<typeof listBankImportsQuerySchema>

export const listBankLinesQuerySchema = z.strictObject({
  filter: z.enum(BankLineFilters).default(BankLineFilters.ALL),
  // The row of the last line of the page: the lines are read in the order of the file
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
})
export type ListBankLinesQuery = z.output<typeof listBankLinesQuerySchema>

// A pair: the journal line a person says is the same movement as the statement line of the path
export const bankPairSchema = z.strictObject({ journalLineId: z.uuid() })
export type BankPairBody = z.output<typeof bankPairSchema>

export const bankStatusQuerySchema = z.strictObject({
  accountId: z.uuid(),
  year: z.coerce.number().int().min(FinanceLimits.MIN_YEAR).max(FinanceLimits.MAX_YEAR),
  month: z.coerce.number().int().min(FinanceLimits.FIRST_MONTH).max(FinanceLimits.LAST_MONTH)
})
export type BankStatusQuery = z.output<typeof bankStatusQuerySchema>
