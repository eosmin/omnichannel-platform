import {
  AccountType,
  type CashKind,
  FinanceLimits,
  FinanceTransactionKind,
  type TaxRounding
} from '@platform/core/domain'

import type { DraftLine } from './entry-rules'
import { taxOfAmount } from './tax-rules'

// The rules of an expense, an income and a transfer registered by hand (TDD_18 §2.6, §4.3, E12), pure: what the transaction may
// name, the tax inside its amount and the lines of the entry it posts. The service loads the rows, asks these rules and only then
// posts; the database holds the same shape (CHECKs and a trigger) as the net under a bug of the service.

// The names of the rules a transaction can break: for the log and the tests, never shown to a person
export const TransactionRule = {
  AMOUNT: 'amount',
  FROM_REQUIRED: 'from_required',
  FROM_NOT_ALLOWED: 'from_not_allowed',
  FROM_NOT_CASH: 'from_not_cash',
  TO_REQUIRED: 'to_required',
  TO_NOT_ALLOWED: 'to_not_allowed',
  TO_NOT_CASH: 'to_not_cash',
  SAME_ACCOUNT: 'same_account',
  CATEGORY_REQUIRED: 'category_required',
  CATEGORY_NOT_ALLOWED: 'category_not_allowed',
  CATEGORY_TYPE: 'category_type',
  TAX_NOT_ALLOWED: 'tax_not_allowed',
  CREDITABLE_NEEDS_TAX: 'creditable_needs_tax',
  CREDITABLE_ONLY_EXPENSE: 'creditable_only_expense',
  TAX_EXCEEDS_AMOUNT: 'tax_exceeds_amount',
  // Beside the rules of the shape, the ones the state of the books decides: the service names them in the same list
  TAX_RATE_INACTIVE: 'tax_rate_inactive',
  DATE_IN_FUTURE: 'date_in_future'
} as const
export type TransactionRuleName = (typeof TransactionRule)[keyof typeof TransactionRule]

// What the rules need to know about an account the transaction names
export interface TransactionAccount {
  type: AccountType
  cashKind: CashKind | null
}

// The rate a transaction is taxed at, and the account its tax lands on by kind
export interface TransactionTaxRate {
  id: string
  rateBps: number
  outputAccountId: string
  inputAccountId: string
}

export interface TransactionDraft {
  kind: FinanceTransactionKind
  amountCents: number
  fromAccountId: string | null
  toAccountId: string | null
  categoryAccountId: string | null
  taxRate: TransactionTaxRate | null
  taxCreditable: boolean
  // The dimension of every line: the store the transaction belongs to for the reports
  storeId: string | null
  memo: string | null
}

export type AccountFacts = (accountId: string) => TransactionAccount | undefined

const isCash = (account: TransactionAccount | undefined): boolean =>
  account !== undefined && account.cashKind !== null

// The tax INSIDE the amount (a person types what was paid, tax included), or 0 when no rate is named. The server computes it: it
// is never taken from the client, so the entry and the VAT report agree to the cent with the rule of the orders (TDD_18 §6.4).
export function transactionTax(
  draft: Pick<TransactionDraft, 'amountCents' | 'taxRate'>,
  rounding: TaxRounding
): number {
  if (draft.taxRate === null) return 0
  return taxOfAmount({
    amountCents: draft.amountCents,
    rateBps: draft.taxRate.rateBps,
    includesTax: true,
    rounding
  })
}

// Every rule the transaction breaks, in a fixed order (empty when it is valid). The tax is the one `transactionTax` computed.
export function transactionProblems(
  draft: TransactionDraft,
  taxCents: number,
  account: AccountFacts
): TransactionRuleName[] {
  const problems: TransactionRuleName[] = []
  const add = (rule: TransactionRuleName): void => {
    problems.push(rule)
  }
  if (
    !Number.isInteger(draft.amountCents) ||
    draft.amountCents <= 0 ||
    draft.amountCents > FinanceLimits.MAX_LINE_CENTS
  ) {
    add(TransactionRule.AMOUNT)
  }
  const { kind } = draft
  const spends = kind === FinanceTransactionKind.EXPENSE
  const earns = kind === FinanceTransactionKind.INCOME
  const moves = kind === FinanceTransactionKind.TRANSFER

  // The money source: an expense and a transfer take it from somewhere, an income never
  if (spends || moves) {
    if (draft.fromAccountId === null) add(TransactionRule.FROM_REQUIRED)
    else if (!isCash(account(draft.fromAccountId))) add(TransactionRule.FROM_NOT_CASH)
  } else if (draft.fromAccountId !== null) add(TransactionRule.FROM_NOT_ALLOWED)

  // The money destination: an income and a transfer put it somewhere, an expense never
  if (earns || moves) {
    if (draft.toAccountId === null) add(TransactionRule.TO_REQUIRED)
    else if (!isCash(account(draft.toAccountId))) add(TransactionRule.TO_NOT_CASH)
  } else if (draft.toAccountId !== null) add(TransactionRule.TO_NOT_ALLOWED)

  if (moves && draft.fromAccountId !== null && draft.fromAccountId === draft.toAccountId) {
    add(TransactionRule.SAME_ACCOUNT)
  }

  // The category is the account the chart classifies it under: an expense account for an expense, an income account for an income
  if (moves) {
    if (draft.categoryAccountId !== null) add(TransactionRule.CATEGORY_NOT_ALLOWED)
  } else if (draft.categoryAccountId === null) add(TransactionRule.CATEGORY_REQUIRED)
  else if (
    account(draft.categoryAccountId)?.type !== (spends ? AccountType.EXPENSE : AccountType.INCOME)
  ) {
    add(TransactionRule.CATEGORY_TYPE)
  }

  // A transfer moves money and carries no tax; the input tax is only credited on an expense, by a rate it names
  if (moves && (draft.taxRate !== null || draft.taxCreditable)) add(TransactionRule.TAX_NOT_ALLOWED)
  if (draft.taxCreditable) {
    if (!spends) add(TransactionRule.CREDITABLE_ONLY_EXPENSE)
    if (draft.taxRate === null) add(TransactionRule.CREDITABLE_NEEDS_TAX)
  }
  // The net that is left after the tax is a positive amount, because a line of the entry takes it
  if (taxCents > 0 && taxCents >= draft.amountCents) add(TransactionRule.TAX_EXCEEDS_AMOUNT)
  return problems
}

// The lines of the entry (TDD_18 §4.2, E12), for a transaction that passed `transactionProblems`:
//   expense   Dr category (net of the creditable tax) · Dr input VAT (a creditable tax) · Cr the source account
//   income    Dr the destination account · Cr category (net of the tax) · Cr output VAT
//   transfer  Dr the destination · Cr the source
// An expense whose tax is not creditable (no valid document, [ACCOUNTANT]) is booked whole to the category: the tax is a cost.
// Every line carries the store of the transaction, and a line that books tax names the rate (the VAT report reads it).
export function transactionLines(draft: TransactionDraft, taxCents: number): DraftLine[] {
  const store = { storeId: draft.storeId }
  const { amountCents, taxRate } = draft
  const line = (
    accountId: string | null,
    side: 'debit' | 'credit',
    cents: number,
    extra: Pick<DraftLine, 'taxRateId'> = {}
  ): DraftLine[] =>
    accountId === null || cents <= 0
      ? []
      : [
          {
            accountId,
            debitCents: side === 'debit' ? cents : 0,
            creditCents: side === 'credit' ? cents : 0,
            ...store,
            ...extra
          }
        ]
  switch (draft.kind) {
    case FinanceTransactionKind.EXPENSE: {
      const credited = draft.taxCreditable ? taxCents : 0
      return [
        ...line(draft.categoryAccountId, 'debit', amountCents - credited),
        ...line(taxRate?.inputAccountId ?? null, 'debit', credited, {
          taxRateId: taxRate?.id ?? null
        }),
        ...line(draft.fromAccountId, 'credit', amountCents)
      ]
    }
    case FinanceTransactionKind.INCOME:
      return [
        ...line(draft.toAccountId, 'debit', amountCents),
        ...line(draft.categoryAccountId, 'credit', amountCents - taxCents),
        ...line(taxRate?.outputAccountId ?? null, 'credit', taxCents, {
          taxRateId: taxRate?.id ?? null
        })
      ]
    case FinanceTransactionKind.TRANSFER:
      return [
        ...line(draft.toAccountId, 'debit', amountCents),
        ...line(draft.fromAccountId, 'credit', amountCents)
      ]
  }
}
