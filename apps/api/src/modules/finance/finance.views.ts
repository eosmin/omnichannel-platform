import { NormalSide } from '@platform/core/domain'
import { balanceOf, dateToDay } from '@platform/core/finance'

// What the finance routes answer. A date is 'YYYY-MM-DD' (an accounting date is a day, not an instant), and a count that can
// pass the 32 bits of a line is a string (the sum of many lines is a BigInt of the database). Nothing here carries a secret.

export const isoDay = dateToDay

export const SETTINGS_SELECT = {
  countryCode: true,
  baseCurrency: true,
  accountingStartDate: true,
  lockedThrough: true,
  recognizeSaleOn: true,
  roundingAccountId: true,
  taxRounding: true,
  shippingTaxed: true,
  updatedAt: true
} as const

export interface SettingsRow {
  countryCode: string
  baseCurrency: string
  accountingStartDate: Date
  lockedThrough: Date | null
  recognizeSaleOn: string
  roundingAccountId: string | null
  taxRounding: string
  shippingTaxed: boolean
  updatedAt: Date
}

export interface SettingsView {
  countryCode: string
  baseCurrency: string
  accountingStartDate: string
  lockedThrough: string | null
  recognizeSaleOn: string
  roundingAccountId: string | null
  taxRounding: string
  shippingTaxed: boolean
  updatedAt: string
}

export const settingsView = (row: SettingsRow): SettingsView => ({
  countryCode: row.countryCode,
  baseCurrency: row.baseCurrency,
  accountingStartDate: isoDay(row.accountingStartDate),
  lockedThrough: row.lockedThrough === null ? null : isoDay(row.lockedThrough),
  recognizeSaleOn: row.recognizeSaleOn,
  roundingAccountId: row.roundingAccountId,
  taxRounding: row.taxRounding,
  shippingTaxed: row.shippingTaxed,
  updatedAt: row.updatedAt.toISOString()
})

export interface SetupState {
  // true once the organization has its books
  ready: boolean
  // The countries that have a template to start from
  countries: string[]
  settings: SettingsView | null
}

export const ACCOUNT_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  normalSide: true,
  parentId: true,
  isPostable: true,
  cashKind: true,
  isSystem: true,
  active: true,
  currency: true,
  createdAt: true
} as const

export interface AccountRow {
  id: string
  code: string
  name: string
  type: string
  normalSide: string
  parentId: string | null
  isPostable: boolean
  cashKind: string | null
  isSystem: boolean
  active: boolean
  currency: string
  createdAt: Date
}

export interface AccountView {
  id: string
  code: string
  name: string
  type: string
  normalSide: string
  parentId: string | null
  isPostable: boolean
  cashKind: string | null
  isSystem: boolean
  active: boolean
  currency: string
  createdAt: string
}

export const accountView = (row: AccountRow): AccountView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  type: row.type,
  normalSide: row.normalSide,
  parentId: row.parentId,
  isPostable: row.isPostable,
  cashKind: row.cashKind,
  isSystem: row.isSystem,
  active: row.active,
  currency: row.currency,
  createdAt: row.createdAt.toISOString()
})

export interface AccountPage {
  data: AccountView[]
  nextCursor: string | null
  hasMore: boolean
}

export interface RoleMappingView {
  role: string
  accountId: string
}

export interface PaymentAccountView {
  id: string
  paymentMethod: string
  // null is the default of the organization
  storeId: string | null
  accountId: string
}

export const PERIOD_SELECT = {
  id: true,
  year: true,
  month: true,
  startsOn: true,
  endsOn: true,
  status: true,
  closedAt: true,
  closedBy: true,
  reopenedAt: true,
  reopenedBy: true,
  reopenReason: true
} as const

export interface PeriodRow {
  id: string
  year: number
  month: number
  startsOn: Date
  endsOn: Date
  status: string
  closedAt: Date | null
  closedBy: string | null
  reopenedAt: Date | null
  reopenedBy: string | null
  reopenReason: string | null
}

export interface PeriodView {
  id: string
  year: number
  month: number
  startsOn: string
  endsOn: string
  status: string
  closedAt: string | null
  closedBy: string | null
  reopenedAt: string | null
  reopenedBy: string | null
  reopenReason: string | null
}

export const periodView = (row: PeriodRow): PeriodView => ({
  id: row.id,
  year: row.year,
  month: row.month,
  startsOn: isoDay(row.startsOn),
  endsOn: isoDay(row.endsOn),
  status: row.status,
  closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
  closedBy: row.closedBy,
  reopenedAt: row.reopenedAt === null ? null : row.reopenedAt.toISOString(),
  reopenedBy: row.reopenedBy,
  reopenReason: row.reopenReason
})

export interface PeriodPage {
  data: PeriodView[]
  nextCursor: string | null
  hasMore: boolean
}

export const ENTRY_SELECT = {
  id: true,
  number: true,
  entryDate: true,
  periodId: true,
  type: true,
  sourceType: true,
  sourceId: true,
  sourceDate: true,
  idempotencyKey: true,
  reversesEntryId: true,
  memo: true,
  currency: true,
  totalCents: true,
  createdBy: true,
  origin: true,
  createdAt: true,
  prevHash: true,
  hash: true
} as const

export interface EntryRow {
  id: string
  number: bigint
  entryDate: Date
  periodId: string
  type: string
  sourceType: string | null
  sourceId: string | null
  sourceDate: Date | null
  idempotencyKey: string
  reversesEntryId: string | null
  memo: string | null
  currency: string
  totalCents: number
  createdBy: string | null
  origin: string
  createdAt: Date
  prevHash: string | null
  hash: string
}

export const LINE_SELECT = {
  id: true,
  lineNo: true,
  accountId: true,
  storeId: true,
  debitCents: true,
  creditCents: true,
  partyType: true,
  partyId: true,
  taxRateId: true,
  memo: true
} as const

export interface LineRow {
  id: string
  lineNo: number
  accountId: string
  storeId: string | null
  debitCents: number
  creditCents: number
  partyType: string | null
  partyId: string | null
  taxRateId: string | null
  memo: string | null
}

export interface LineView {
  id: string
  lineNo: number
  accountId: string
  storeId: string | null
  debitCents: number
  creditCents: number
  partyType: string | null
  partyId: string | null
  taxRateId: string | null
  memo: string | null
}

export const lineView = (row: LineRow): LineView => ({ ...row })

export interface EntryView {
  id: string
  // The gapless number of the journal: a BigInt of the database, a string here
  number: string
  entryDate: string
  periodId: string
  type: string
  sourceType: string | null
  sourceId: string | null
  sourceDate: string | null
  reversesEntryId: string | null
  // The entry that reversed this one, when one did (derived: some entry reverses it)
  reversedByEntryId: string | null
  memo: string | null
  currency: string
  totalCents: number
  createdBy: string | null
  origin: string
  createdAt: string
  prevHash: string | null
  hash: string
}

export const entryView = (row: EntryRow, reversedByEntryId: string | null): EntryView => ({
  id: row.id,
  number: row.number.toString(),
  entryDate: isoDay(row.entryDate),
  periodId: row.periodId,
  type: row.type,
  sourceType: row.sourceType,
  sourceId: row.sourceId,
  sourceDate: row.sourceDate === null ? null : isoDay(row.sourceDate),
  reversesEntryId: row.reversesEntryId,
  reversedByEntryId,
  memo: row.memo,
  currency: row.currency,
  totalCents: row.totalCents,
  createdBy: row.createdBy,
  origin: row.origin,
  createdAt: row.createdAt.toISOString(),
  prevHash: row.prevHash,
  hash: row.hash
})

export interface EntryDetailView extends EntryView {
  lines: LineView[]
}

export interface EntryPage {
  data: EntryView[]
  nextCursor: string | null
  hasMore: boolean
}

export interface BalanceRow {
  accountId: string
  normalSide: string
  debitCents: bigint
  creditCents: bigint
}

export interface BalanceView {
  accountId: string
  debitCents: string
  creditCents: string
  // On the side where the account grows: a positive number is a balance where the account normally sits
  balanceCents: string
}

export const balanceView = (row: BalanceRow): BalanceView => ({
  accountId: row.accountId,
  debitCents: row.debitCents.toString(),
  creditCents: row.creditCents.toString(),
  balanceCents: balanceOf(
    row.debitCents,
    row.creditCents,
    (row.normalSide as NormalSide) === NormalSide.DEBIT
  ).toString()
})

export const POSTING_SELECT = {
  id: true,
  sourceType: true,
  sourceId: true,
  eventKind: true,
  reason: true,
  attempts: true,
  createdAt: true,
  updatedAt: true
} as const

export interface PostingRow {
  id: string
  sourceType: string
  sourceId: string
  eventKind: string
  reason: string
  attempts: number
  createdAt: Date
  updatedAt: Date
}

export interface PostingView {
  id: string
  sourceType: string
  sourceId: string
  eventKind: string
  reason: string
  attempts: number
  createdAt: string
  updatedAt: string
}

export const postingView = (row: PostingRow): PostingView => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString()
})

export interface PostingPage {
  data: PostingView[]
  nextCursor: string | null
  hasMore: boolean
}

export const TAX_RATE_SELECT = {
  id: true,
  code: true,
  name: true,
  rateBps: true,
  kind: true,
  outputAccountId: true,
  inputAccountId: true,
  active: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true
} as const

export interface TaxRateRow {
  id: string
  code: string
  name: string
  rateBps: number
  kind: string
  outputAccountId: string
  inputAccountId: string
  active: boolean
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}

export interface TaxRateView {
  id: string
  code: string
  name: string
  // Basis points: 13 % is 1300
  rateBps: number
  kind: string
  outputAccountId: string
  inputAccountId: string
  active: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export const taxRateView = (row: TaxRateRow): TaxRateView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  rateBps: row.rateBps,
  kind: row.kind,
  outputAccountId: row.outputAccountId,
  inputAccountId: row.inputAccountId,
  active: row.active,
  isDefault: row.isDefault,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString()
})

// The tax preferences of the store of the request (TDD_18 §7): whether the prices of its catalog already include the tax
export interface StoreTaxSettingsView {
  pricesIncludeTax: boolean
}

export const TRANSACTION_SELECT = {
  id: true,
  storeId: true,
  kind: true,
  occurredOn: true,
  amountCents: true,
  fromAccountId: true,
  toAccountId: true,
  categoryAccountId: true,
  taxRateId: true,
  taxCents: true,
  taxCreditable: true,
  documentNumber: true,
  memo: true,
  entryId: true,
  voidedByEntryId: true,
  replacesTransactionId: true,
  createdBy: true,
  createdAt: true
} as const

export interface TransactionRow {
  id: string
  storeId: string | null
  kind: string
  occurredOn: Date
  amountCents: number
  fromAccountId: string | null
  toAccountId: string | null
  categoryAccountId: string | null
  taxRateId: string | null
  taxCents: number
  taxCreditable: boolean
  documentNumber: string | null
  memo: string | null
  entryId: string
  voidedByEntryId: string | null
  replacesTransactionId: string | null
  createdBy: string
  createdAt: Date
}

export interface TransactionView {
  id: string
  storeId: string | null
  kind: string
  occurredOn: string
  amountCents: number
  fromAccountId: string | null
  toAccountId: string | null
  categoryAccountId: string | null
  taxRateId: string | null
  taxCents: number
  taxCreditable: boolean
  documentNumber: string | null
  memo: string | null
  // The entry it posted, and the one that reversed it once it was voided
  entryId: string
  voidedByEntryId: string | null
  voided: boolean
  // The transaction this one replaced when it was changed
  replacesTransactionId: string | null
  createdBy: string
  createdAt: string
}

export const transactionView = (row: TransactionRow): TransactionView => ({
  ...row,
  occurredOn: isoDay(row.occurredOn),
  voided: row.voidedByEntryId !== null,
  createdAt: row.createdAt.toISOString()
})

export interface TransactionPage {
  data: TransactionView[]
  nextCursor: string | null
  hasMore: boolean
}
