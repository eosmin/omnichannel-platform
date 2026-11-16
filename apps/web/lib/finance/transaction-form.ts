import type {
  FinanceAccountView,
  FinanceTaxRateView,
  FinanceTransactionView,
  RecordFinanceTransactionInput
} from '@platform/api-client'
import { type Permission, ClientPermissions } from '@platform/core/auth'
import {
  AccountType,
  FinanceLimits,
  FinanceTransactionKind,
  type TaxRounding
} from '@platform/core/domain'
import { taxOfAmount } from '@platform/core/finance'

import { cashAccountsOf, postableAccountsOf } from './account-form'
import { isCalendarDay } from './dates'
import { positiveCentsOfDecimalText, decimalOfCents } from './money'

// The form of an expense, an income or a transfer registered by hand (TDD_18 §4.3). The amount is what was paid or received, tax
// included, typed as dollars and sent as whole cents; the tax is the api's to compute (the screen shows the same sum, never sends it).
// What each kind takes is the rule of `transaction-rules` of the api: the screen offers only what the api accepts.
export interface TransactionDraft {
  kind: string
  occurredOn: string
  amount: string
  fromAccountId: string
  toAccountId: string
  categoryAccountId: string
  taxRateId: string
  taxCreditable: boolean
  documentNumber: string
  memo: string
  // The store dimension of a transaction written by another client: kept when it is replaced, never chosen here
  storeId: string
}

export const TransactionFields = {
  DATE: 'date',
  AMOUNT: 'amount',
  FROM: 'from',
  TO: 'to',
  CATEGORY: 'category',
  TAX: 'tax',
  DOCUMENT_NUMBER: 'documentNumber',
  MEMO: 'memo'
} as const
export type TransactionField = (typeof TransactionFields)[keyof typeof TransactionFields]

export const emptyTransactionDraft = (kind: string, today: string): TransactionDraft => ({
  kind,
  occurredOn: today,
  amount: '',
  fromAccountId: '',
  toAccountId: '',
  categoryAccountId: '',
  taxRateId: '',
  taxCreditable: false,
  documentNumber: '',
  memo: '',
  storeId: ''
})

// The draft of the transaction that replaces another: the same content, to be changed
export const transactionDraftOf = (transaction: FinanceTransactionView): TransactionDraft => ({
  kind: transaction.kind,
  occurredOn: transaction.occurredOn,
  amount: decimalOfCents(transaction.amountCents),
  fromAccountId: transaction.fromAccountId ?? '',
  toAccountId: transaction.toAccountId ?? '',
  categoryAccountId: transaction.categoryAccountId ?? '',
  taxRateId: transaction.taxRateId ?? '',
  taxCreditable: transaction.taxCreditable,
  documentNumber: transaction.documentNumber ?? '',
  memo: transaction.memo ?? '',
  storeId: transaction.storeId ?? ''
})

// What a kind takes, and so what its form shows
export const takesSource = (kind: string): boolean =>
  kind === String(FinanceTransactionKind.EXPENSE) ||
  kind === String(FinanceTransactionKind.TRANSFER)
export const takesDestination = (kind: string): boolean =>
  kind === String(FinanceTransactionKind.INCOME) || kind === String(FinanceTransactionKind.TRANSFER)
export const takesCategory = (kind: string): boolean =>
  kind !== String(FinanceTransactionKind.TRANSFER)
export const takesTax = takesCategory
export const takesCreditableTax = (kind: string): boolean =>
  kind === String(FinanceTransactionKind.EXPENSE)

// An expense or an income is the permission of the bookkeeper, a transfer the one of who moves money: the api narrows to the
// permission of the KIND, so the screen offers a kind only to who holds its permission
export const permissionOfKind = (kind: string): Permission =>
  kind === String(FinanceTransactionKind.TRANSFER)
    ? ClientPermissions.FINANCE_MOVE_MONEY
    : ClientPermissions.FINANCE_MANAGE_TRANSACTIONS

export const KINDS_IN_ORDER: readonly string[] = [
  FinanceTransactionKind.EXPENSE,
  FinanceTransactionKind.INCOME,
  FinanceTransactionKind.TRANSFER
]

// The accounts a field offers: the ones the api accepts there (money for the source and the destination, an expense account or an
// income account for the category), the one already chosen staying in the list
export const moneyAccountsOf = (
  accounts: readonly FinanceAccountView[],
  keep: readonly string[]
): FinanceAccountView[] => cashAccountsOf(accounts, keep)

export function categoryAccountsOf(
  accounts: readonly FinanceAccountView[],
  kind: string,
  keep: readonly string[]
): FinanceAccountView[] {
  const type =
    kind === String(FinanceTransactionKind.EXPENSE) ? AccountType.EXPENSE : AccountType.INCOME
  return postableAccountsOf(accounts, keep).filter(
    account => account.type === String(type) || keep.includes(account.id)
  )
}

// The rates a transaction can name: the ones that are on (the api refuses a switched-off one), and the one already chosen
export const taxRatesOf = (
  rates: readonly FinanceTaxRateView[],
  keep: readonly string[]
): FinanceTaxRateView[] => rates.filter(rate => rate.active || keep.includes(rate.id))

// The tax inside the amount, by the same rule as the api (the rate, and how the setting rounds a fraction of a cent), or null when
// the draft names no rate or no amount yet
export function taxPreviewOf(
  draft: TransactionDraft,
  rates: readonly FinanceTaxRateView[],
  rounding: string
): number | null {
  const cents = positiveCentsOfDecimalText(draft.amount)
  const rate = rates.find(candidate => candidate.id === draft.taxRateId)
  if (cents === null || rate === undefined || !takesTax(draft.kind)) return null
  return taxOfAmount({
    amountCents: cents,
    rateBps: rate.rateBps,
    includesTax: true,
    rounding: rounding as TaxRounding
  })
}

// The first field that is wrong, or null. `latestDay` is the last day the api accepts: a day ahead of ITS today, which is the UTC day.
export function transactionProblem(
  draft: TransactionDraft,
  latestDay: string,
  rates: readonly FinanceTaxRateView[],
  rounding: string
): TransactionField | null {
  if (!isCalendarDay(draft.occurredOn) || draft.occurredOn > latestDay) {
    return TransactionFields.DATE
  }
  if (positiveCentsOfDecimalText(draft.amount) === null) return TransactionFields.AMOUNT
  if (takesSource(draft.kind) && draft.fromAccountId === '') return TransactionFields.FROM
  if (takesDestination(draft.kind) && draft.toAccountId === '') return TransactionFields.TO
  if (
    draft.kind === String(FinanceTransactionKind.TRANSFER) &&
    draft.fromAccountId === draft.toAccountId
  ) {
    return TransactionFields.TO
  }
  if (takesCategory(draft.kind) && draft.categoryAccountId === '') return TransactionFields.CATEGORY
  if (takesCreditableTax(draft.kind) && draft.taxCreditable && draft.taxRateId === '') {
    return TransactionFields.TAX
  }
  // A rate that was switched off since is refused by the api (it stays in the list only so that the select shows its value)
  if (rates.some(rate => rate.id === draft.taxRateId && !rate.active)) return TransactionFields.TAX
  const tax = taxPreviewOf(draft, rates, rounding)
  const cents = positiveCentsOfDecimalText(draft.amount)
  // The net that is left after the tax is a positive amount, because a line of the entry takes it
  if (tax !== null && cents !== null && tax > 0 && tax >= cents) return TransactionFields.TAX
  if (draft.documentNumber.trim().length > FinanceLimits.DOCUMENT_NUMBER_MAX_LENGTH) {
    return TransactionFields.DOCUMENT_NUMBER
  }
  if (draft.memo.trim().length > FinanceLimits.MEMO_MAX_LENGTH) return TransactionFields.MEMO
  return null
}

// Call only after `transactionProblem` said null. Only what the kind takes is sent (a field left over from another kind never is), and
// the key is the form's: a new content is a new key (the api refuses one key for two contents).
export function recordTransactionInputOf(
  draft: TransactionDraft,
  idempotencyKey: string
): RecordFinanceTransactionInput {
  const cents = positiveCentsOfDecimalText(draft.amount)
  if (cents === null) throw new Error('the amount of a transaction was not checked')
  const input: RecordFinanceTransactionInput = {
    idempotencyKey,
    kind: draft.kind,
    occurredOn: draft.occurredOn,
    amountCents: cents
  }
  if (takesSource(draft.kind)) input.fromAccountId = draft.fromAccountId
  if (takesDestination(draft.kind)) input.toAccountId = draft.toAccountId
  if (takesCategory(draft.kind)) input.categoryAccountId = draft.categoryAccountId
  if (takesTax(draft.kind) && draft.taxRateId !== '') input.taxRateId = draft.taxRateId
  if (takesCreditableTax(draft.kind) && draft.taxRateId !== '') {
    input.taxCreditable = draft.taxCreditable
  }
  if (draft.storeId !== '') input.storeId = draft.storeId
  if (draft.documentNumber.trim() !== '') input.documentNumber = draft.documentNumber.trim()
  if (draft.memo.trim() !== '') input.memo = draft.memo.trim()
  return input
}
