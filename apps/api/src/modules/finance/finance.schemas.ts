import { z } from 'zod'

import {
  AccountRole,
  AccountType,
  CashKind,
  FinanceLimits,
  FinancePaymentMethods,
  FinanceTaxLimits,
  FinanceTransactionKind,
  JournalEntryType,
  lowercasedUuidSchema,
  PaginationLimits,
  SaleRecognition,
  singleLineText,
  TaxRounding
} from '@platform/core/domain'
import { financeTemplateCountries, isIsoDate } from '@platform/core/finance'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = lowercasedUuidSchema

// A calendar day, not only a string that looks like one (no 31 of February)
const day = z.string().refine(isIsoDate, { message: 'not a calendar date (YYYY-MM-DD)' })

const accountName = singleLineText(FinanceLimits.ACCOUNT_NAME_MAX_LENGTH, 1)
const accountCode = z.string().regex(FinanceLimits.ACCOUNT_CODE_PATTERN)
const memo = singleLineText(FinanceLimits.MEMO_MAX_LENGTH, 1)
// Whole cents of one line, like an order total: an Int of the database
const cents = z.number().int().min(0).max(FinanceLimits.MAX_LINE_CENTS)

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(PaginationLimits.MAX)
  .default(PaginationLimits.DEFAULT)
const flag = z.enum(['true', 'false']).transform(value => value === 'true')
const nothingToChange = { message: 'nothing to change' }

export const setupSchema = z.strictObject({
  countryCode: z.enum(financeTemplateCountries() as [string, ...string[]]),
  // The first day events are posted from; the first day of the month of the setup when it is left out
  accountingStartDate: day.optional()
})

export const updateSettingsSchema = z
  .strictObject({
    recognizeSaleOn: z.enum(SaleRecognition).optional(),
    // How a fraction of a cent of tax is placed, and whether the shipping fee carries the tax (TDD_18 §7)
    taxRounding: z.enum(TaxRounding).optional(),
    shippingTaxed: z.boolean().optional(),
    // The rounding account cannot be taken away: a cent that cannot be placed needs somewhere to go (TDD_18 §6.4)
    roundingAccountId: lowercasedUuidSchema.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), nothingToChange)

export const listAccountsQuerySchema = z.strictObject({
  // The code of the last account of the page: the chart is read in the order of the codes
  cursor: z.string().regex(FinanceLimits.ACCOUNT_CODE_PATTERN).optional(),
  limit,
  active: flag.optional(),
  type: z.enum(AccountType).optional()
})

export const createAccountSchema = z.strictObject({
  code: accountCode,
  name: accountName,
  type: z.enum(AccountType),
  parentId: lowercasedUuidSchema.nullable().optional(),
  isPostable: z.boolean().optional(),
  cashKind: z.enum(CashKind).nullable().optional()
})

export const updateAccountSchema = z
  .strictObject({
    code: accountCode.optional(),
    name: accountName.optional(),
    type: z.enum(AccountType).optional(),
    parentId: lowercasedUuidSchema.nullable().optional(),
    isPostable: z.boolean().optional(),
    cashKind: z.enum(CashKind).nullable().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), nothingToChange)

const taxRateBps = z
  .number()
  .int()
  .min(FinanceTaxLimits.MIN_RATE_BPS)
  .max(FinanceTaxLimits.MAX_RATE_BPS)
const taxRateCode = z.string().regex(FinanceTaxLimits.CODE_PATTERN)
const taxRateName = singleLineText(FinanceTaxLimits.NAME_MAX_LENGTH, 1)

export const createTaxRateSchema = z.strictObject({
  code: taxRateCode,
  name: taxRateName,
  // Basis points: 13 % is 1300
  rateBps: taxRateBps,
  outputAccountId: lowercasedUuidSchema,
  inputAccountId: lowercasedUuidSchema,
  // Makes it the default rate, taking the place of the one that was
  isDefault: z.boolean().optional()
})

export const updateTaxRateSchema = z
  .strictObject({
    code: taxRateCode.optional(),
    name: taxRateName.optional(),
    rateBps: taxRateBps.optional(),
    outputAccountId: lowercasedUuidSchema.optional(),
    inputAccountId: lowercasedUuidSchema.optional(),
    // Only to make a rate the default: another rate takes the place when this one stops being it
    isDefault: z.literal(true).optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), nothingToChange)

export const updateStoreTaxSettingsSchema = z
  .strictObject({
    pricesIncludeTax: z.boolean().optional(),
    // The person has been told that the total of the same catalog moves (HC-209); a change of the mode without it is refused
    confirmPriceModeChange: z.literal(true).optional()
  })
  .refine(body => body.pricesIncludeTax !== undefined, nothingToChange)

// A range of days of the report, both ends included: at most a year, so one request is one bounded read
export const vatReportQuerySchema = z
  .strictObject({ from: day, to: day })
  .refine(range => range.from <= range.to, { message: 'from is after to' })
  .refine(
    range =>
      (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 <
      FinanceLimits.VAT_REPORT_MAX_DAYS,
    { message: `the range is longer than ${String(FinanceLimits.VAT_REPORT_MAX_DAYS)} days` }
  )

export const roleParamSchema = z.enum(AccountRole)

export const mapRoleSchema = z.strictObject({ accountId: lowercasedUuidSchema })

export const setPaymentAccountSchema = z.strictObject({
  paymentMethod: z.enum(FinancePaymentMethods as [string, ...string[]]),
  // The store whose choice it is; none (or null) is the default of the organization
  storeId: lowercasedUuidSchema.nullable().optional(),
  accountId: lowercasedUuidSchema
})

const period = z.strictObject({
  year: z.number().int().min(FinanceLimits.MIN_YEAR).max(FinanceLimits.MAX_YEAR),
  month: z.number().int().min(FinanceLimits.FIRST_MONTH).max(FinanceLimits.LAST_MONTH)
})
export const openPeriodSchema = period

export const listPeriodsQuerySchema = z.strictObject({
  // 'YYYY-MM' of the last period of the page: the newest first
  cursor: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  limit
})

export const listEntriesQuerySchema = z.strictObject({
  // The number of the last entry of the page: the newest first
  cursor: z
    .string()
    .regex(/^[1-9]\d{0,17}$/)
    .optional(),
  limit,
  periodId: lowercasedUuidSchema.optional(),
  type: z.enum(JournalEntryType).optional(),
  // The entries that touch an account
  accountId: lowercasedUuidSchema.optional(),
  from: day.optional(),
  to: day.optional()
})

// An entry a person writes (TDD_18 §4.2, E13): free lines, balanced, with the reason. It names no party and no tax rate: those
// belong to the entries the system derives from a sale, a purchase or a remittance, where the ids come from the source.
const manualLine = z.strictObject({
  accountId: lowercasedUuidSchema,
  debitCents: cents.default(0),
  creditCents: cents.default(0),
  storeId: lowercasedUuidSchema.optional(),
  memo: singleLineText(FinanceLimits.MEMO_MAX_LENGTH, 1).optional()
})

export const manualEntrySchema = z.strictObject({
  // Chosen by the screen once per form, so that a double click or a retry after a lost answer posts once
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  entryDate: day,
  type: z.enum([JournalEntryType.MANUAL, JournalEntryType.OPENING_BALANCE]),
  memo,
  lines: z.array(manualLine).min(2).max(FinanceLimits.MAX_LINES_PER_ENTRY)
})

export const reverseEntrySchema = z.strictObject({
  memo,
  // The date of the reversal when it is not the date of the entry (a closed period's entry is reversed in the open one)
  entryDate: day.optional()
})

// What a person registers by hand (TDD_18 §4.3): the key is the screen's, once per form, so a double click or a retry after a lost
// answer registers once. `amountCents` is what was paid or received, tax included; the tax is computed from the rate, never
// sent. Which accounts a kind takes (and refuses) is the rule of `transaction-rules`, not of the shape.
export const recordTransactionSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  kind: z.enum(FinanceTransactionKind),
  occurredOn: day,
  amountCents: z.number().int().min(1).max(FinanceLimits.MAX_LINE_CENTS),
  fromAccountId: lowercasedUuidSchema.optional(),
  toAccountId: lowercasedUuidSchema.optional(),
  categoryAccountId: lowercasedUuidSchema.optional(),
  storeId: lowercasedUuidSchema.optional(),
  taxRateId: lowercasedUuidSchema.optional(),
  taxCreditable: z.boolean().default(false),
  documentNumber: singleLineText(FinanceLimits.DOCUMENT_NUMBER_MAX_LENGTH, 1).optional(),
  memo: memo.optional()
})

// Voiding says why: the auditor reads it in the reversing entry
export const voidTransactionSchema = z.strictObject({ reason: memo })

// The receipt: the media id the upload gave, for a file made for this transaction
export const attachDocumentSchema = z.strictObject({ mediaId: lowercasedUuidSchema })

export const replaceTransactionSchema = z.strictObject({
  reason: memo,
  replacement: recordTransactionSchema
})

export const listTransactionsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit,
  kind: z.enum(FinanceTransactionKind).optional(),
  // The accounting date of the transaction
  from: day.optional(),
  to: day.optional(),
  // The transactions that touch an account (the source, the destination or the category)
  accountId: lowercasedUuidSchema.optional(),
  // The voided ones are listed only when asked
  includeVoided: flag.default(false)
})

export const balancesQuerySchema = z.strictObject({
  periodId: lowercasedUuidSchema.optional(),
  storeId: lowercasedUuidSchema.optional()
})

export const listPostingsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit
})

export type SetupBody = z.infer<typeof setupSchema>
export type UpdateSettingsBody = z.infer<typeof updateSettingsSchema>
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>
export type CreateAccountBody = z.infer<typeof createAccountSchema>
export type UpdateAccountBody = z.infer<typeof updateAccountSchema>
export type MapRoleBody = z.infer<typeof mapRoleSchema>
export type SetPaymentAccountBody = z.infer<typeof setPaymentAccountSchema>
export type OpenPeriodBody = z.infer<typeof openPeriodSchema>
export type ListPeriodsQuery = z.infer<typeof listPeriodsQuerySchema>
export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>
export type ManualEntryBody = z.infer<typeof manualEntrySchema>
export type ReverseEntryBody = z.infer<typeof reverseEntrySchema>
export type BalancesQuery = z.infer<typeof balancesQuerySchema>
export type ListPostingsQuery = z.infer<typeof listPostingsQuerySchema>
export type CreateTaxRateBody = z.infer<typeof createTaxRateSchema>
export type UpdateTaxRateBody = z.infer<typeof updateTaxRateSchema>
export type UpdateStoreTaxSettingsBody = z.infer<typeof updateStoreTaxSettingsSchema>
export type RecordTransactionBody = z.infer<typeof recordTransactionSchema>
export type VoidTransactionBody = z.infer<typeof voidTransactionSchema>
export type AttachDocumentBody = z.infer<typeof attachDocumentSchema>
export type ReplaceTransactionBody = z.infer<typeof replaceTransactionSchema>
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>
export type VatReportQuery = z.infer<typeof vatReportQuerySchema>
