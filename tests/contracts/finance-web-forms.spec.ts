import { FinanceTransactionKind } from '@platform/core/domain'

import {
  createTaxRateSchema,
  manualEntrySchema,
  recordTransactionSchema,
  replaceTransactionSchema,
  reverseEntrySchema,
  voidTransactionSchema
} from '../../apps/api/src/modules/finance/finance.schemas'
import {
  manualEntryInputOf,
  type ManualEntryDraft
} from '../../apps/web/lib/finance/manual-entry-form'
import { createTaxRateInputOf, emptyTaxRateDraft } from '../../apps/web/lib/finance/tax-form'
import {
  emptyTransactionDraft,
  recordTransactionInputOf
} from '../../apps/web/lib/finance/transaction-form'

// The web cannot import the api, so this is what stops a form from sending a body the api refuses: what each form of the finance screens
// builds is parsed by the schema of the route it goes to (strict objects: a key the api does not know is a refusal too).
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const KEY = 'once-per-form'
const TODAY = '2026-11-16'

describe('the body of the transaction form', () => {
  it('is an expense the api takes, with a tax and a receipt number', () => {
    const body = recordTransactionInputOf(
      {
        ...emptyTransactionDraft(FinanceTransactionKind.EXPENSE, TODAY),
        amount: '11.30',
        fromAccountId: ID(1),
        categoryAccountId: ID(2),
        taxRateId: ID(3),
        taxCreditable: true,
        documentNumber: 'F-1',
        memo: 'Office rent'
      },
      KEY
    )
    expect(recordTransactionSchema.parse(body)).toMatchObject({
      amountCents: 1130,
      kind: 'expense'
    })
  })

  it('is an income and a transfer the api takes, with no key that belongs to another kind', () => {
    const income = recordTransactionInputOf(
      {
        ...emptyTransactionDraft(FinanceTransactionKind.INCOME, TODAY),
        amount: '20',
        toAccountId: ID(1),
        categoryAccountId: ID(2),
        taxRateId: ID(3),
        // A creditable tax is the expense's: left on in the draft, it is never sent
        taxCreditable: true
      },
      KEY
    )
    expect(recordTransactionSchema.parse(income).taxCreditable).toBe(false)
    const transfer = recordTransactionInputOf(
      {
        ...emptyTransactionDraft(FinanceTransactionKind.TRANSFER, TODAY),
        amount: '5,5',
        fromAccountId: ID(1),
        toAccountId: ID(4),
        categoryAccountId: ID(2),
        taxRateId: ID(3)
      },
      KEY
    )
    expect(recordTransactionSchema.parse(transfer).amountCents).toBe(550)
  })

  it('is the replacement and the void the api takes', () => {
    const replacement = recordTransactionInputOf(
      {
        ...emptyTransactionDraft(FinanceTransactionKind.EXPENSE, TODAY),
        amount: '12',
        fromAccountId: ID(1),
        categoryAccountId: ID(2)
      },
      KEY
    )
    expect(replaceTransactionSchema.parse({ reason: 'Wrong amount', replacement })).toBeDefined()
    expect(voidTransactionSchema.parse({ reason: 'Typed twice' })).toBeDefined()
  })
})

describe('the body of the entry forms', () => {
  const draft: ManualEntryDraft = {
    entryDate: TODAY,
    type: 'opening_balance',
    memo: 'Opening',
    lines: [
      { key: 'a', accountId: ID(1), debit: '15.50', credit: '', memo: 'Cash' },
      { key: 'b', accountId: ID(2), debit: '', credit: '15.50', memo: '' }
    ]
  }

  it('is a manual entry the api takes', () => {
    const parsed = manualEntrySchema.parse(manualEntryInputOf(draft, KEY))
    expect(parsed.lines.map(line => [line.debitCents, line.creditCents])).toEqual([
      [1550, 0],
      [0, 1550]
    ])
  })

  it('is a reversal the api takes', () => {
    expect(reverseEntrySchema.parse({ memo: 'Wrong month' })).toBeDefined()
    expect(reverseEntrySchema.parse({ memo: 'Wrong month', entryDate: TODAY })).toBeDefined()
  })
})

describe('the body of the tax rate form', () => {
  it('is a rate the api takes', () => {
    const body = createTaxRateInputOf({
      ...emptyTaxRateDraft(),
      code: 'IVA13',
      name: 'IVA',
      percent: '13',
      outputAccountId: ID(1),
      inputAccountId: ID(2)
    })
    expect(createTaxRateSchema.parse(body).rateBps).toBe(1300)
  })
})
