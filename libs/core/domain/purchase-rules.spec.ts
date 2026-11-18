import { PartyType, PurchaseOrderStatus, TaxRounding } from './finance-constants'
import {
  billBalances,
  canTransition,
  documentNumberKey,
  dueDay,
  needsUncreditableTaxAccount,
  paymentLines,
  paymentProblems,
  PaymentRule,
  PurchaseRule,
  receiptEntryLines,
  receiptMoney,
  receiptProblems,
  statusAfterReceipt
} from './purchase-rules'

const sum = (
  lines: { debitCents: number; creditCents: number }[],
  side: 'debitCents' | 'creditCents'
): number => lines.reduce((total, line) => total + line[side], 0)

describe('receiptMoney', () => {
  it('taxes each line on top of its cost, line by line', () => {
    const money = receiptMoney(
      [
        { quantity: 3, unitCostCents: 333, rateBps: 1300 },
        { quantity: 1, unitCostCents: 1000, rateBps: null }
      ],
      TaxRounding.HALF_UP
    )
    // 999 x 13 % = 129.87 -> 130
    expect(money.lines).toEqual([
      { subtotalCents: 999, taxCents: 130 },
      { subtotalCents: 1000, taxCents: 0 }
    ])
    expect(money).toMatchObject({ subtotalCents: 1999, taxCents: 130, totalCents: 2129 })
  })

  it('follows the rounding of the organization', () => {
    const lines = [{ quantity: 1, unitCostCents: 1050, rateBps: 1300 }]
    // 136.5
    expect(receiptMoney(lines, TaxRounding.HALF_UP).taxCents).toBe(137)
    expect(receiptMoney(lines, TaxRounding.HALF_EVEN).taxCents).toBe(136)
    expect(receiptMoney(lines, TaxRounding.DOWN).taxCents).toBe(136)
    expect(receiptMoney(lines, TaxRounding.UP).taxCents).toBe(137)
  })
})

describe('receiptProblems', () => {
  const ok = [{ quantity: 2, unitCostCents: 500, rateBps: 1300 }]

  it('has none for a valid receipt', () => {
    expect(receiptProblems(ok, receiptMoney(ok, TaxRounding.HALF_UP))).toEqual([])
  })

  it('refuses no lines, a bad quantity and a bad cost', () => {
    expect(receiptProblems([], receiptMoney([], TaxRounding.HALF_UP))).toEqual([
      PurchaseRule.NO_LINES
    ])
    const bad = [{ quantity: 0, unitCostCents: -1, rateBps: null }]
    expect(receiptProblems(bad, receiptMoney(bad, TaxRounding.HALF_UP))).toEqual(
      expect.arrayContaining([PurchaseRule.QUANTITY, PurchaseRule.UNIT_COST])
    )
  })

  it('refuses a line and a receipt that pass the Int of the database', () => {
    const big = [{ quantity: 1_000_000, unitCostCents: 2_000_000, rateBps: null }]
    expect(receiptProblems(big, receiptMoney(big, TaxRounding.HALF_UP))).toContain(
      PurchaseRule.LINE_TOTAL_TOO_BIG
    )
    const many = [
      { quantity: 1, unitCostCents: 1_500_000_000, rateBps: null },
      { quantity: 1, unitCostCents: 1_500_000_000, rateBps: null }
    ]
    expect(receiptProblems(many, receiptMoney(many, TaxRounding.HALF_UP))).toContain(
      PurchaseRule.RECEIPT_TOTAL_TOO_BIG
    )
  })

  it('refuses a receipt that owes nothing', () => {
    const free = [{ quantity: 1, unitCostCents: 0, rateBps: null }]
    expect(receiptProblems(free, receiptMoney(free, TaxRounding.HALF_UP))).toEqual([
      PurchaseRule.AMOUNT
    ])
  })
})

describe('receiptEntryLines (E10)', () => {
  const accounts = {
    inventoryAccountId: 'inv',
    payableAccountId: 'ap',
    uncreditableTaxAccountId: 'exp',
    supplierId: 'sup'
  }
  const lines = [
    {
      subtotalCents: 1000,
      taxCents: 130,
      storeId: 'a',
      taxRateId: 'r13',
      inputTaxAccountId: 'vat-in'
    },
    {
      subtotalCents: 500,
      taxCents: 65,
      storeId: 'a',
      taxRateId: 'r13',
      inputTaxAccountId: 'vat-in'
    },
    { subtotalCents: 200, taxCents: 0, storeId: 'b', taxRateId: null, inputTaxAccountId: null }
  ]

  it('debits inventory by store and input VAT, credits the supplier for the total', () => {
    const entry = receiptEntryLines(lines, accounts, true)
    expect(sum(entry, 'debitCents')).toBe(sum(entry, 'creditCents'))
    expect(entry).toEqual([
      { accountId: 'inv', debitCents: 1500, creditCents: 0, storeId: 'a', taxRateId: null },
      { accountId: 'inv', debitCents: 200, creditCents: 0, storeId: 'b', taxRateId: null },
      { accountId: 'vat-in', debitCents: 195, creditCents: 0, storeId: 'a', taxRateId: 'r13' },
      {
        accountId: 'ap',
        debitCents: 0,
        creditCents: 1895,
        partyType: PartyType.SUPPLIER,
        partyId: 'sup'
      }
    ])
  })

  it('books a tax that is not creditable to the expense account, keeping the stock at its cost', () => {
    const entry = receiptEntryLines(lines, accounts, false)
    expect(sum(entry, 'debitCents')).toBe(sum(entry, 'creditCents'))
    expect(entry.find(line => line.accountId === 'exp')).toMatchObject({
      debitCents: 195,
      taxRateId: 'r13'
    })
    expect(entry.find(line => line.accountId === 'vat-in')).toBeUndefined()
    expect(entry.filter(line => line.accountId === 'inv').map(line => line.debitCents)).toEqual([
      1500, 200
    ])
  })

  it('says when a tax has nowhere to go without the expense role', () => {
    const money = receiptMoney(
      [{ quantity: 1, unitCostCents: 100, rateBps: 1300 }],
      TaxRounding.HALF_UP
    )
    expect(needsUncreditableTaxAccount(money, false)).toBe(true)
    expect(needsUncreditableTaxAccount(money, true)).toBe(false)
    expect(
      needsUncreditableTaxAccount(
        receiptMoney([{ quantity: 1, unitCostCents: 100, rateBps: null }], TaxRounding.HALF_UP),
        false
      )
    ).toBe(false)
  })
})

describe('payments (E11)', () => {
  it('debits the payable with the supplier as party and credits the account the money leaves', () => {
    const entry = paymentLines({
      payableAccountId: 'ap',
      paidFromAccountId: 'bank',
      supplierId: 's',
      amountCents: 700
    })
    expect(entry).toEqual([
      {
        accountId: 'ap',
        debitCents: 700,
        creditCents: 0,
        partyType: PartyType.SUPPLIER,
        partyId: 's'
      },
      { accountId: 'bank', debitCents: 0, creditCents: 700 }
    ])
  })

  it('refuses a bad amount and an account that is not cash', () => {
    expect(paymentProblems({ amountCents: 1, paidFromIsCash: true })).toEqual([])
    expect(paymentProblems({ amountCents: 0, paidFromIsCash: false })).toEqual([
      PaymentRule.AMOUNT,
      PaymentRule.FROM_NOT_CASH
    ])
    expect(paymentProblems({ amountCents: 1.5, paidFromIsCash: true })).toEqual([
      PaymentRule.AMOUNT
    ])
  })
})

describe('dueDay', () => {
  it('adds the terms of the supplier, across months and years', () => {
    expect(dueDay('2026-11-16', 0)).toBe('2026-11-16')
    expect(dueDay('2026-11-16', 30)).toBe('2026-12-16')
    expect(dueDay('2026-12-20', 30)).toBe('2027-01-19')
    expect(dueDay('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('billBalances', () => {
  const bills = [
    { id: 'b2', supplierId: 's', dueOn: '2026-12-01', totalCents: 500, paidCents: 0 },
    { id: 'b1', supplierId: 's', dueOn: '2026-11-01', totalCents: 1000, paidCents: 200 },
    { id: 'b3', supplierId: 't', dueOn: '2026-11-05', totalCents: 300, paidCents: 300 }
  ]

  it('applies the payments that name no bill to the oldest due first', () => {
    const result = billBalances(bills, new Map([['s', 900]]), '2026-11-16')
    expect(result.map(bill => [bill.id, bill.openCents, bill.overdue])).toEqual([
      ['b1', 0, false],
      ['b3', 0, false],
      ['b2', 400, false]
    ])
  })

  it('marks an open bill past its due day and keeps the supplier total exact', () => {
    const result = billBalances(bills, new Map(), '2026-11-16')
    expect(result.find(bill => bill.id === 'b1')).toMatchObject({ openCents: 800, overdue: true })
    expect(result.find(bill => bill.id === 'b2')).toMatchObject({ openCents: 500, overdue: false })
    expect(result.find(bill => bill.id === 'b3')).toMatchObject({ openCents: 0, overdue: false })
    const owed = result
      .filter(bill => bill.supplierId === 's')
      .reduce((total, bill) => total + bill.openCents, 0)
    expect(owed).toBe(1500 - 200)
  })
})

describe('order status', () => {
  it('follows the transition table', () => {
    expect(canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.ORDERED)).toBe(true)
    expect(canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.RECEIVED)).toBe(false)
    expect(
      canTransition(PurchaseOrderStatus.PARTIALLY_RECEIVED, PurchaseOrderStatus.CANCELLED)
    ).toBe(false)
    expect(canTransition(PurchaseOrderStatus.CLOSED, PurchaseOrderStatus.ORDERED)).toBe(false)
  })

  it('is received only when every line has all its units', () => {
    expect(statusAfterReceipt([{ quantity: 2, receivedQuantity: 2 }])).toBe(
      PurchaseOrderStatus.RECEIVED
    )
    expect(
      statusAfterReceipt([
        { quantity: 2, receivedQuantity: 2 },
        { quantity: 3, receivedQuantity: 1 }
      ])
    ).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED)
  })
})

describe('the key of a supplier document (HC-124)', () => {
  it.each([
    ['fac-001', 'FAC001'],
    ['FAC 001', 'FAC001'],
    ['  Fac_001 ', 'FAC001'],
    ['f.a.c/001', 'FAC001'],
    ['Nº 12', 'Nº12'],
    ['１２３', '123']
  ])('reads %j as %j', (text, key) => {
    expect(documentNumberKey(text)).toBe(key)
  })

  it('gives two writings of one invoice one key and two invoices two', () => {
    expect(documentNumberKey('ab-1')).toBe(documentNumberKey('AB 1'))
    expect(documentNumberKey('AB-1')).not.toBe(documentNumberKey('AB-10'))
  })

  it('ignores where the separators are, so two such numbers share a key (accepted, to be confirmed by the accountant)', () => {
    expect(documentNumberKey('12-3')).toBe(documentNumberKey('1-23'))
  })

  it('has no key for a text with no letter or digit', () => {
    expect(documentNumberKey('---')).toBe('')
    expect(documentNumberKey('')).toBe('')
  })
})
