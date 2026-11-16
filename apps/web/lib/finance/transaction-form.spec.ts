import type { FinanceAccountView, FinanceTaxRateView } from '@platform/api-client'

import {
  categoryAccountsOf,
  emptyTransactionDraft,
  moneyAccountsOf,
  permissionOfKind,
  recordTransactionInputOf,
  taxPreviewOf,
  transactionDraftOf,
  TransactionFields,
  transactionProblem,
  type TransactionDraft
} from './transaction-form'

const account = (
  id: string,
  type: string,
  over: Partial<FinanceAccountView> = {}
): FinanceAccountView =>
  ({
    id,
    code: id,
    name: id,
    type,
    isPostable: true,
    active: true,
    cashKind: null,
    ...over
  }) as FinanceAccountView

const chart = [
  account('cash', 'asset', { cashKind: 'cash' }),
  account('bank', 'asset', { cashKind: 'bank' }),
  account('stock', 'asset'),
  account('rent', 'expense'),
  account('cogs', 'cost_of_sales'),
  account('sales', 'income'),
  account('group', 'expense', { isPostable: false }),
  account('old', 'expense', { active: false })
]

const rate = (over: Partial<FinanceTaxRateView> = {}): FinanceTaxRateView =>
  ({
    id: 'vat',
    code: 'IVA',
    name: 'IVA',
    rateBps: 1300,
    active: true,
    isDefault: true,
    ...over
  }) as FinanceTaxRateView

const TODAY = '2026-11-16'
const expense = (over: Partial<TransactionDraft> = {}): TransactionDraft => ({
  ...emptyTransactionDraft('expense', TODAY),
  amount: '11.30',
  fromAccountId: 'cash',
  categoryAccountId: 'rent',
  ...over
})

describe('the accounts each field offers', () => {
  it('offers money for the source and the destination, never an account that is not cash, a bank or a wallet', () => {
    expect(moneyAccountsOf(chart, []).map(a => a.id)).toEqual(['bank', 'cash'])
  })

  it('offers an expense its expense accounts and an income its income accounts, and keeps the one already chosen', () => {
    expect(categoryAccountsOf(chart, 'expense', []).map(a => a.id)).toEqual(['rent'])
    expect(categoryAccountsOf(chart, 'income', []).map(a => a.id)).toEqual(['sales'])
    expect(categoryAccountsOf(chart, 'expense', ['old']).map(a => a.id)).toEqual(['old', 'rent'])
  })
})

describe('transactionProblem', () => {
  it('accepts an expense with a source and a category', () => {
    expect(transactionProblem(expense(), TODAY, [], 'half_up')).toBeNull()
  })

  it.each([
    ['a date that is not a day', { occurredOn: '2026-02-30' }, TransactionFields.DATE],
    ['a date more than a day ahead', { occurredOn: '2026-11-18' }, TransactionFields.DATE],
    ['no amount', { amount: '' }, TransactionFields.AMOUNT],
    ['an amount of zero', { amount: '0' }, TransactionFields.AMOUNT],
    ['no source', { fromAccountId: '' }, TransactionFields.FROM],
    ['no category', { categoryAccountId: '' }, TransactionFields.CATEGORY],
    ['a creditable tax with no rate', { taxCreditable: true }, TransactionFields.TAX]
  ])('refuses %s', (_name, over, field) => {
    expect(transactionProblem(expense(over), TODAY, [], 'half_up')).toBe(field)
  })

  it('accepts a day ahead and refuses the same day of the next month', () => {
    expect(
      transactionProblem(expense({ occurredOn: '2026-11-17' }), TODAY, [], 'half_up')
    ).toBeNull()
  })

  it('asks a transfer for two different accounts of money and no category', () => {
    const transfer = {
      ...emptyTransactionDraft('transfer', TODAY),
      amount: '50',
      fromAccountId: 'cash',
      toAccountId: 'bank'
    }
    expect(transactionProblem(transfer, TODAY, [], 'half_up')).toBeNull()
    expect(transactionProblem({ ...transfer, toAccountId: 'cash' }, TODAY, [], 'half_up')).toBe(
      TransactionFields.TO
    )
    expect(transactionProblem({ ...transfer, toAccountId: '' }, TODAY, [], 'half_up')).toBe(
      TransactionFields.TO
    )
  })

  it('refuses a tax that would be the whole amount, the way the api does', () => {
    const everything = rate({ rateBps: 10_000 })
    // One cent at 100 %: half a cent, which rounds up to the cent itself and leaves nothing for the net
    expect(
      transactionProblem(
        expense({ amount: '0.01', taxRateId: 'vat' }),
        TODAY,
        [everything],
        'half_up'
      )
    ).toBe(TransactionFields.TAX)
    // The same cent rounded down is no tax at all
    expect(
      transactionProblem(expense({ amount: '0.01', taxRateId: 'vat' }), TODAY, [everything], 'down')
    ).toBeNull()
  })
})

describe('taxPreviewOf', () => {
  it('computes the tax inside the amount, by the rule of the api', () => {
    // 11.30 with 13 % inside is 1.30
    expect(taxPreviewOf(expense({ taxRateId: 'vat' }), [rate()], 'half_up')).toBe(130)
  })

  it('is nothing without a rate, an amount, or for a transfer', () => {
    expect(taxPreviewOf(expense(), [rate()], 'half_up')).toBeNull()
    expect(taxPreviewOf(expense({ amount: '', taxRateId: 'vat' }), [rate()], 'half_up')).toBeNull()
    expect(
      taxPreviewOf({ ...expense({ taxRateId: 'vat' }), kind: 'transfer' }, [rate()], 'half_up')
    ).toBeNull()
  })
})

describe('recordTransactionInputOf', () => {
  it('sends the amount in whole cents and only what the kind takes', () => {
    const input = recordTransactionInputOf(
      expense({ toAccountId: 'bank', documentNumber: ' F-1 ', memo: ' Rent ' }),
      'once-per-form'
    )
    expect(input).toEqual({
      idempotencyKey: 'once-per-form',
      kind: 'expense',
      occurredOn: TODAY,
      amountCents: 1130,
      fromAccountId: 'cash',
      categoryAccountId: 'rent',
      documentNumber: 'F-1',
      memo: 'Rent'
    })
  })

  it('names the rate and whether its tax is credited only where the kind allows it', () => {
    const withTax = recordTransactionInputOf(
      expense({ taxRateId: 'vat', taxCreditable: true }),
      'once-per-form'
    )
    expect(withTax.taxRateId).toBe('vat')
    expect(withTax.taxCreditable).toBe(true)
    const income = recordTransactionInputOf(
      {
        ...emptyTransactionDraft('income', TODAY),
        amount: '20',
        toAccountId: 'cash',
        categoryAccountId: 'sales',
        taxRateId: 'vat',
        taxCreditable: true
      },
      'once-per-form'
    )
    expect(income.taxRateId).toBe('vat')
    expect(income).not.toHaveProperty('taxCreditable')
    expect(income).not.toHaveProperty('fromAccountId')
  })

  it('sends a transfer with no category and no tax', () => {
    const input = recordTransactionInputOf(
      {
        ...emptyTransactionDraft('transfer', TODAY),
        amount: '5,5',
        fromAccountId: 'cash',
        toAccountId: 'bank',
        categoryAccountId: 'rent',
        taxRateId: 'vat'
      },
      'once-per-form'
    )
    expect(input.amountCents).toBe(550)
    expect(input).not.toHaveProperty('categoryAccountId')
    expect(input).not.toHaveProperty('taxRateId')
  })

  it('stops on an amount that was not checked, and never sends it as zero', () => {
    expect(() => recordTransactionInputOf(expense({ amount: 'x' }), 'once-per-form')).toThrow()
  })
})

describe('transactionDraftOf and permissionOfKind', () => {
  it('writes the amount of a transaction back as dollars, to be changed', () => {
    const draft = transactionDraftOf({
      kind: 'expense',
      occurredOn: TODAY,
      amountCents: 1130,
      fromAccountId: 'cash',
      toAccountId: null,
      categoryAccountId: 'rent',
      taxRateId: null,
      taxCreditable: false,
      documentNumber: null,
      memo: null
    } as never)
    expect(draft.amount).toBe('11.30')
    expect(draft.toAccountId).toBe('')
  })

  it('asks a transfer for the permission to move money and the other kinds for the bookkeeper', () => {
    expect(permissionOfKind('transfer')).toBe('finance:move_money')
    expect(permissionOfKind('expense')).toBe('finance:manage_transactions')
    expect(permissionOfKind('income')).toBe('finance:manage_transactions')
  })
})
