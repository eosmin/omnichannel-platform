import { AccountType, CashKind, FinanceTransactionKind, TaxRounding } from '@platform/core/domain'

import {
  type AccountFacts,
  type TransactionDraft,
  type TransactionTaxRate,
  transactionLines,
  transactionProblems,
  TransactionRule,
  transactionTax
} from './transaction-rules'

const CASH = 'cash'
const BANK = 'bank'
const ASSET = 'asset-no-cash'
const EXPENSE = 'expense'
const INCOME = 'income'
const VAT_IN = 'vat-input'
const VAT_OUT = 'vat-output'

const accounts: Record<string, { type: AccountType; cashKind: CashKind | null }> = {
  [CASH]: { type: AccountType.ASSET, cashKind: CashKind.CASH },
  [BANK]: { type: AccountType.ASSET, cashKind: CashKind.BANK },
  [ASSET]: { type: AccountType.ASSET, cashKind: null },
  [EXPENSE]: { type: AccountType.EXPENSE, cashKind: null },
  [INCOME]: { type: AccountType.INCOME, cashKind: null }
}
const facts: AccountFacts = id => accounts[id]

const vat: TransactionTaxRate = {
  id: 'vat-13',
  rateBps: 1300,
  outputAccountId: VAT_OUT,
  inputAccountId: VAT_IN
}

const expense = (extra: Partial<TransactionDraft> = {}): TransactionDraft => ({
  kind: FinanceTransactionKind.EXPENSE,
  amountCents: 11_300,
  fromAccountId: CASH,
  toAccountId: null,
  categoryAccountId: EXPENSE,
  taxRate: null,
  taxCreditable: false,
  storeId: null,
  memo: null,
  ...extra
})
const income = (extra: Partial<TransactionDraft> = {}): TransactionDraft => ({
  ...expense(),
  kind: FinanceTransactionKind.INCOME,
  fromAccountId: null,
  toAccountId: BANK,
  categoryAccountId: INCOME,
  ...extra
})
const transfer = (extra: Partial<TransactionDraft> = {}): TransactionDraft => ({
  ...expense(),
  kind: FinanceTransactionKind.TRANSFER,
  fromAccountId: CASH,
  toAccountId: BANK,
  categoryAccountId: null,
  ...extra
})

const problems = (draft: TransactionDraft): string[] =>
  transactionProblems(draft, transactionTax(draft, TaxRounding.HALF_UP), facts)

const sides = (draft: TransactionDraft): [string, number, number][] =>
  transactionLines(draft, transactionTax(draft, TaxRounding.HALF_UP)).map(line => [
    line.accountId,
    line.debitCents,
    line.creditCents
  ])

describe('transactionTax', () => {
  it('takes the tax out of what was paid, tax included, and none when no rate is named', () => {
    expect(transactionTax({ amountCents: 11_300, taxRate: vat }, TaxRounding.HALF_UP)).toBe(1300)
    expect(transactionTax({ amountCents: 11_300, taxRate: null }, TaxRounding.HALF_UP)).toBe(0)
    // 1000 x 1300 / 11300 = 115.04
    expect(transactionTax({ amountCents: 1000, taxRate: vat }, TaxRounding.HALF_UP)).toBe(115)
    expect(transactionTax({ amountCents: 1000, taxRate: vat }, TaxRounding.UP)).toBe(116)
  })
})

describe('transactionProblems', () => {
  it('accepts a valid expense, income and transfer', () => {
    expect(problems(expense())).toEqual([])
    expect(problems(income())).toEqual([])
    expect(problems(transfer())).toEqual([])
    expect(problems(expense({ taxRate: vat, taxCreditable: true }))).toEqual([])
    expect(problems(income({ taxRate: vat }))).toEqual([])
  })

  it('refuses an amount that is not whole positive cents within an Int', () => {
    for (const amountCents of [0, -1, 1.5, 2_147_483_648]) {
      expect(problems(expense({ amountCents }))).toContain(TransactionRule.AMOUNT)
    }
  })

  it('needs a cash-kind account where the money comes from or goes to, and only there', () => {
    expect(problems(expense({ fromAccountId: null }))).toContain(TransactionRule.FROM_REQUIRED)
    expect(problems(expense({ fromAccountId: ASSET }))).toContain(TransactionRule.FROM_NOT_CASH)
    expect(problems(expense({ fromAccountId: 'nope' }))).toContain(TransactionRule.FROM_NOT_CASH)
    expect(problems(expense({ toAccountId: BANK }))).toContain(TransactionRule.TO_NOT_ALLOWED)
    expect(problems(income({ toAccountId: null }))).toContain(TransactionRule.TO_REQUIRED)
    expect(problems(income({ toAccountId: ASSET }))).toContain(TransactionRule.TO_NOT_CASH)
    expect(problems(income({ fromAccountId: CASH }))).toContain(TransactionRule.FROM_NOT_ALLOWED)
    expect(problems(transfer({ fromAccountId: null }))).toContain(TransactionRule.FROM_REQUIRED)
    expect(problems(transfer({ toAccountId: ASSET }))).toContain(TransactionRule.TO_NOT_CASH)
  })

  it('needs two distinct cash-kind accounts for a transfer', () => {
    expect(problems(transfer({ toAccountId: CASH }))).toEqual([TransactionRule.SAME_ACCOUNT])
  })

  it('classifies an expense under an expense account and an income under an income account', () => {
    expect(problems(expense({ categoryAccountId: null }))).toContain(
      TransactionRule.CATEGORY_REQUIRED
    )
    expect(problems(expense({ categoryAccountId: INCOME }))).toContain(
      TransactionRule.CATEGORY_TYPE
    )
    expect(problems(expense({ categoryAccountId: CASH }))).toContain(TransactionRule.CATEGORY_TYPE)
    expect(problems(income({ categoryAccountId: EXPENSE }))).toContain(
      TransactionRule.CATEGORY_TYPE
    )
    expect(problems(transfer({ categoryAccountId: EXPENSE }))).toContain(
      TransactionRule.CATEGORY_NOT_ALLOWED
    )
  })

  it('takes no tax on a transfer and credits it only on an expense that names a rate', () => {
    expect(problems(transfer({ taxRate: vat }))).toContain(TransactionRule.TAX_NOT_ALLOWED)
    expect(problems(transfer({ taxCreditable: true }))).toContain(TransactionRule.TAX_NOT_ALLOWED)
    expect(problems(income({ taxRate: vat, taxCreditable: true }))).toContain(
      TransactionRule.CREDITABLE_ONLY_EXPENSE
    )
    expect(problems(expense({ taxCreditable: true }))).toContain(
      TransactionRule.CREDITABLE_NEEDS_TAX
    )
  })

  it('refuses a tax that leaves no net', () => {
    const all: TransactionTaxRate = { ...vat, rateBps: 10_000 }
    // 1 x 10000 / 20000 = 0.5, half up is 1: the whole amount would be tax
    expect(problems(expense({ amountCents: 1, taxRate: all }))).toContain(
      TransactionRule.TAX_EXCEEDS_AMOUNT
    )
    expect(problems(expense({ amountCents: 2, taxRate: all }))).toEqual([])
  })

  it('reports every rule at once, in a fixed order', () => {
    expect(
      problems(
        expense({ amountCents: 0, fromAccountId: null, toAccountId: BANK, categoryAccountId: null })
      )
    ).toEqual([
      TransactionRule.AMOUNT,
      TransactionRule.FROM_REQUIRED,
      TransactionRule.TO_NOT_ALLOWED,
      TransactionRule.CATEGORY_REQUIRED
    ])
  })
})

describe('transactionLines', () => {
  it('posts an expense without tax as the category against the source', () => {
    expect(sides(expense())).toEqual([
      [EXPENSE, 11_300, 0],
      [CASH, 0, 11_300]
    ])
  })

  it('splits the input VAT of an expense with a creditable document', () => {
    expect(sides(expense({ taxRate: vat, taxCreditable: true }))).toEqual([
      [EXPENSE, 10_000, 0],
      [VAT_IN, 1300, 0],
      [CASH, 0, 11_300]
    ])
  })

  it('books the whole expense to the category when its tax is not creditable', () => {
    expect(sides(expense({ taxRate: vat, taxCreditable: false }))).toEqual([
      [EXPENSE, 11_300, 0],
      [CASH, 0, 11_300]
    ])
  })

  it('posts an income as the destination against the category and the output VAT', () => {
    expect(sides(income({ taxRate: vat }))).toEqual([
      [BANK, 11_300, 0],
      [INCOME, 0, 10_000],
      [VAT_OUT, 0, 1300]
    ])
    expect(sides(income())).toEqual([
      [BANK, 11_300, 0],
      [INCOME, 0, 11_300]
    ])
  })

  it('posts a transfer as the destination against the source', () => {
    expect(sides(transfer())).toEqual([
      [BANK, 11_300, 0],
      [CASH, 0, 11_300]
    ])
  })

  it('leaves out the tax line of a rate of zero', () => {
    const zero: TransactionTaxRate = { ...vat, rateBps: 0 }
    expect(sides(expense({ taxRate: zero, taxCreditable: true }))).toEqual([
      [EXPENSE, 11_300, 0],
      [CASH, 0, 11_300]
    ])
  })

  it('carries the store of the transaction on every line and the rate on the lines of tax only', () => {
    const lines = transactionLines(
      expense({ taxRate: vat, taxCreditable: true, storeId: 'store-1' }),
      1300
    )
    expect(lines.map(line => line.storeId)).toEqual(['store-1', 'store-1', 'store-1'])
    expect(lines.map(line => line.taxRateId ?? null)).toEqual([null, 'vat-13', null])
  })

  it('always balances, to the cent, whatever the amount and the rounding', () => {
    for (const rounding of Object.values(TaxRounding)) {
      for (const amountCents of [2, 3, 99, 1000, 1001, 11_299, 2_147_483_647]) {
        for (const draft of [
          expense({ amountCents, taxRate: vat, taxCreditable: true }),
          income({ amountCents, taxRate: vat })
        ]) {
          const tax = transactionTax(draft, rounding)
          const lines = transactionLines(draft, tax)
          const debit = lines.reduce((sum, line) => sum + line.debitCents, 0)
          const credit = lines.reduce((sum, line) => sum + line.creditCents, 0)
          expect(debit).toBe(amountCents)
          expect(credit).toBe(amountCents)
        }
      }
    }
  })
})
