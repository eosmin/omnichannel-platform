import {
  AccountRole,
  FinancePostingFailureReason,
  InventoryAdjustmentReason,
  InventoryMovementType
} from '@platform/core/domain'

import {
  adjustmentLines,
  issueCost,
  orderPaymentLines,
  saleAmounts,
  saleLines,
  sentLines,
  transferWriteOffCents,
  transferWriteOffLines,
  type DraftLine,
  type RoleAccounts,
  type SaleOrderRow
} from './index'

const accounts: RoleAccounts = role => `acc-${role}`
const STORE = 'store-1'

const sum = (lines: readonly DraftLine[], side: 'debitCents' | 'creditCents'): number =>
  lines.reduce((total, line) => total + line[side], 0)
const lineOf = (lines: readonly DraftLine[], role: AccountRole): DraftLine | undefined =>
  lines.find(line => line.accountId === `acc-${role}`)

describe('saleAmounts', () => {
  it('splits an order whose prices include the tax, shipping included', () => {
    // 2 x 11.30 with 13% in the price: tax 2.60, net 20.00; shipping 5.65 with 0.65 of tax: net 5.00
    const order: SaleOrderRow = {
      subtotalCents: 2260,
      shippingCents: 565,
      discountCents: 0,
      totalCents: 2825,
      taxCents: 325,
      pricesIncludeTax: true,
      lines: [{ quantity: 2, unitPriceCents: 1130, taxCents: 260 }]
    }
    expect(saleAmounts(order)).toEqual({
      ok: true,
      amounts: { revenueNetCents: 2000, shippingNetCents: 500, vatCents: 325, totalCents: 2825 }
    })
  })

  it('takes the discount out of the revenue when the prices do not include the tax', () => {
    // 2 x 10.00, discount 2.00: base 18.00, tax 2.34; shipping 5.00 with 0.65: the tax is added to the total
    const order: SaleOrderRow = {
      subtotalCents: 2000,
      shippingCents: 500,
      discountCents: 200,
      totalCents: 2599,
      taxCents: 299,
      pricesIncludeTax: false,
      lines: [{ quantity: 2, unitPriceCents: 1000, taxCents: 234 }]
    }
    expect(saleAmounts(order)).toEqual({
      ok: true,
      amounts: { revenueNetCents: 1800, shippingNetCents: 500, vatCents: 299, totalCents: 2599 }
    })
  })

  it('shares the discount across lines to the cent', () => {
    const order: SaleOrderRow = {
      subtotalCents: 1000,
      shippingCents: 0,
      discountCents: 1,
      totalCents: 999,
      taxCents: 0,
      pricesIncludeTax: false,
      lines: [
        { quantity: 1, unitPriceCents: 333, taxCents: 0 },
        { quantity: 1, unitPriceCents: 333, taxCents: 0 },
        { quantity: 1, unitPriceCents: 334, taxCents: 0 }
      ]
    }
    const result = saleAmounts(order)
    expect(result.ok && result.amounts.totalCents).toBe(999)
  })

  it('refuses an order made before the tax columns instead of inventing a tax', () => {
    const order: SaleOrderRow = {
      subtotalCents: 1000,
      shippingCents: 0,
      discountCents: 0,
      totalCents: 1000,
      taxCents: null,
      pricesIncludeTax: null,
      lines: [{ quantity: 1, unitPriceCents: 1000, taxCents: null }]
    }
    expect(saleAmounts(order)).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.TAX_MISSING
    })
  })

  it('refuses figures that do not add up to the total', () => {
    const order: SaleOrderRow = {
      subtotalCents: 1000,
      shippingCents: 0,
      discountCents: 0,
      totalCents: 1001,
      taxCents: 0,
      pricesIncludeTax: false,
      lines: [{ quantity: 1, unitPriceCents: 1000, taxCents: 0 }]
    }
    expect(saleAmounts(order)).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
  })

  it('refuses an order with a line whose net is negative even when the total net is not (HC-203)', () => {
    // The tax of the first line is above its price: its net is -1.00, and the second line hides it in the total. A return of
    // the sale refuses a line like this, so a sale that posted it could never be returned
    const order: SaleOrderRow = {
      subtotalCents: 6000,
      shippingCents: 0,
      discountCents: 0,
      totalCents: 6000,
      taxCents: 1100,
      pricesIncludeTax: true,
      lines: [
        { quantity: 1, unitPriceCents: 1000, taxCents: 1100 },
        { quantity: 1, unitPriceCents: 5000, taxCents: 0 }
      ]
    }
    expect(saleAmounts(order)).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
  })

  it('refuses a negative line net when the prices exclude the tax, and accepts a line whose net is exactly zero (HC-203)', () => {
    const base = {
      shippingCents: 0,
      pricesIncludeTax: false,
      subtotalCents: 6000,
      lines: [
        { quantity: 1, unitPriceCents: 1000, taxCents: 0 },
        { quantity: 1, unitPriceCents: 5000, taxCents: 0 }
      ]
    }
    // The discount is shared by weight, so no line goes below zero from it: the zero is the boundary, a line that costs nothing
    const free: SaleOrderRow = {
      ...base,
      discountCents: 0,
      totalCents: 6000,
      taxCents: 0,
      subtotalCents: 5000,
      lines: [
        { quantity: 1, unitPriceCents: 0, taxCents: 0 },
        { quantity: 1, unitPriceCents: 5000, taxCents: 0 }
      ]
    }
    expect(saleAmounts({ ...free, totalCents: 5000 }).ok).toBe(true)
    // A line whose tax is above its price with the prices including it: the other branch of the same veto
    const negative: SaleOrderRow = {
      ...base,
      pricesIncludeTax: true,
      discountCents: 0,
      totalCents: 6000,
      taxCents: 1001,
      lines: [
        { quantity: 1, unitPriceCents: 1000, taxCents: 1001 },
        { quantity: 1, unitPriceCents: 5000, taxCents: 0 }
      ]
    }
    expect(saleAmounts(negative)).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
  })

  it('refuses a tax of the shipping fee that is negative or above the fee', () => {
    const order: SaleOrderRow = {
      subtotalCents: 1000,
      shippingCents: 100,
      discountCents: 0,
      totalCents: 1100,
      taxCents: 50,
      pricesIncludeTax: false,
      // The lines carry more tax than the order says in all
      lines: [{ quantity: 1, unitPriceCents: 1000, taxCents: 80 }]
    }
    expect(saleAmounts(order).ok).toBe(false)
  })
})

describe('issueCost', () => {
  it('multiplies the units by the cost each carried', () => {
    expect(
      issueCost([
        { quantity: 2, unitCostCents: 350 },
        { quantity: 1, unitCostCents: 1234 }
      ])
    ).toEqual({ ok: true, costCents: 1934 })
  })

  it('is zero without movements (a service)', () => {
    expect(issueCost([])).toEqual({ ok: true, costCents: 0 })
  })

  it('takes the value the movement removed from the stock, not the rounded unit cost times the units (HC-007)', () => {
    // 5 units worth 502, an average of 100.4: two leave with a recorded cost of 100 and a value of 201 (2 x 100 would be 200)
    expect(issueCost([{ quantity: 2, unitCostCents: 100, valueCents: 201n }])).toEqual({
      ok: true,
      costCents: 201
    })
    // The rest leaves with the residue of the rounding: the books keep nothing of a level the stock emptied
    expect(
      issueCost([
        { quantity: 2, unitCostCents: 100, valueCents: 201n },
        { quantity: 3, unitCostCents: 100, valueCents: 301n }
      ])
    ).toEqual({ ok: true, costCents: 502 })
  })

  it('falls back to the units times the cost for a movement written before the value was recorded', () => {
    expect(issueCost([{ quantity: 2, unitCostCents: 100, valueCents: null }])).toEqual({
      ok: true,
      costCents: 200
    })
  })

  it('fails on a movement that left with no cost', () => {
    expect(issueCost([{ quantity: 1, unitCostCents: null }])).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.COST_MISSING
    })
  })
})

describe('orderPaymentLines (E1)', () => {
  it('debits the account of the method and credits the advance', () => {
    const result = orderPaymentLines({
      accounts,
      paymentAccountId: 'acc-bank',
      totalCents: 2825,
      storeId: STORE
    })
    expect(result).toEqual({
      ok: true,
      lines: [
        { accountId: 'acc-bank', debitCents: 2825, creditCents: 0, storeId: STORE },
        {
          accountId: `acc-${AccountRole.CUSTOMER_ADVANCES}`,
          debitCents: 0,
          creditCents: 2825,
          storeId: STORE
        }
      ]
    })
  })

  it('names the role that has no account', () => {
    expect(
      orderPaymentLines({
        accounts: () => null,
        paymentAccountId: 'x',
        totalCents: 5,
        storeId: STORE
      })
    ).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.CUSTOMER_ADVANCES
    })
  })

  it('posts nothing for a free order', () => {
    expect(
      orderPaymentLines({ accounts, paymentAccountId: 'x', totalCents: 0, storeId: STORE })
    ).toEqual({ ok: true, lines: [] })
  })
})

describe('sentLines (E2)', () => {
  it('moves the cost from inventory to inventory in transit', () => {
    const result = sentLines({ accounts, costCents: 1934, storeId: STORE })
    expect(result.ok && sum(result.lines, 'debitCents')).toBe(1934)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_IN_TRANSIT)?.debitCents).toBe(
      1934
    )
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.creditCents).toBe(1934)
  })

  it('posts nothing at no cost', () => {
    expect(sentLines({ accounts, costCents: 0, storeId: STORE })).toEqual({ ok: true, lines: [] })
  })
})

describe('saleLines (E3)', () => {
  const amounts = {
    revenueNetCents: 2000,
    shippingNetCents: 500,
    vatCents: 325,
    totalCents: 2825
  }

  it('a cash on delivery sale is the carrier receivable, with the carrier as party, and clears the transit cost', () => {
    const result = saleLines({
      accounts,
      amounts,
      collection: { kind: 'carrier', carrierConnectionId: 'conn-1' },
      costCents: 1934,
      costFromTransit: true,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
    expect(sum(result.lines, 'debitCents')).toBe(2825 + 1934)
    expect(lineOf(result.lines, AccountRole.RECEIVABLE_CARRIERS)).toMatchObject({
      debitCents: 2825,
      partyType: 'carrier_connection',
      partyId: 'conn-1'
    })
    expect(lineOf(result.lines, AccountRole.SALES_REVENUE)?.creditCents).toBe(2000)
    expect(lineOf(result.lines, AccountRole.SHIPPING_REVENUE)?.creditCents).toBe(500)
    expect(lineOf(result.lines, AccountRole.VAT_OUTPUT)?.creditCents).toBe(325)
    expect(lineOf(result.lines, AccountRole.COST_OF_GOODS_SOLD)?.debitCents).toBe(1934)
    expect(lineOf(result.lines, AccountRole.INVENTORY_IN_TRANSIT)?.creditCents).toBe(1934)
    expect(lineOf(result.lines, AccountRole.INVENTORY)).toBeUndefined()
  })

  it('a prepaid sale clears the advance, and without an E2 the cost leaves inventory itself', () => {
    const result = saleLines({
      accounts,
      amounts,
      collection: { kind: 'advance' },
      costCents: 1934,
      costFromTransit: false,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineOf(result.lines, AccountRole.CUSTOMER_ADVANCES)?.debitCents).toBe(2825)
    expect(lineOf(result.lines, AccountRole.INVENTORY)?.creditCents).toBe(1934)
    expect(lineOf(result.lines, AccountRole.RECEIVABLE_CARRIERS)).toBeUndefined()
  })

  it('leaves out a shipping fee of zero and a sale with no tax', () => {
    const result = saleLines({
      accounts,
      amounts: { revenueNetCents: 1000, shippingNetCents: 0, vatCents: 0, totalCents: 1000 },
      collection: { kind: 'advance' },
      costCents: 0,
      costFromTransit: true,
      storeId: STORE
    })
    expect(result.ok && result.lines).toHaveLength(2)
  })

  it('fails visibly, naming the role, when a mapping is missing', () => {
    const result = saleLines({
      accounts: role => (role === AccountRole.VAT_OUTPUT ? null : `acc-${role}`),
      amounts,
      collection: { kind: 'advance' },
      costCents: 0,
      costFromTransit: true,
      storeId: STORE
    })
    expect(result).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.VAT_OUTPUT
    })
  })
})

describe('adjustmentLines (E9)', () => {
  const movement = (
    type: string,
    quantity: number,
    unitCostCents: number | null,
    reason: string | null = null
  ) => ({ type, reason, quantity, unitCostCents })

  it('units out are a loss at the cost of the movement', () => {
    const result = adjustmentLines({
      accounts,
      movement: movement(InventoryMovementType.COUNT_OUT, 3, 250),
      storeId: STORE
    })
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_LOSS)?.debitCents).toBe(750)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.creditCents).toBe(750)
  })

  it('units out are a loss of exactly the value the movement removed from the stock (HC-007)', () => {
    const result = adjustmentLines({
      accounts,
      movement: { ...movement(InventoryMovementType.ADJUSTMENT_OUT, 2, 100), valueCents: 201n },
      storeId: STORE
    })
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_LOSS)?.debitCents).toBe(201)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.creditCents).toBe(201)
  })

  it('units in keep the cost times the units: only what leaves carries a value that the rounding bends', () => {
    const result = adjustmentLines({
      accounts,
      movement: {
        ...movement(InventoryMovementType.ADJUSTMENT_IN, 2, 500, InventoryAdjustmentReason.FOUND),
        valueCents: 900n
      },
      storeId: STORE
    })
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.debitCents).toBe(1000)
  })

  it('units in are a gain', () => {
    const result = adjustmentLines({
      accounts,
      movement: movement(
        InventoryMovementType.ADJUSTMENT_IN,
        2,
        500,
        InventoryAdjustmentReason.FOUND
      ),
      storeId: STORE
    })
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_GAIN)?.creditCents).toBe(1000)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.debitCents).toBe(1000)
  })

  it('opening stock goes against the opening equity, not a gain', () => {
    const result = adjustmentLines({
      accounts,
      movement: movement(
        InventoryMovementType.ADJUSTMENT_IN,
        4,
        100,
        InventoryAdjustmentReason.OPENING_STOCK
      ),
      storeId: STORE
    })
    expect(result.ok && lineOf(result.lines, AccountRole.OPENING_EQUITY)?.creditCents).toBe(400)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_GAIN)).toBeUndefined()
  })

  // RA-740-4: a count never carries a cost, so the engine values the units it counts in at the average of the level and records
  // that value on the movement. The books trust the movement (TDD_18 §4.2, E9), so that value is what the entry posts
  it('units counted in with no cost are posted at the value the movement carries', () => {
    const result = adjustmentLines({
      accounts,
      movement: { ...movement(InventoryMovementType.COUNT_IN, 2, null), valueCents: 2000n },
      storeId: STORE
    })
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.debitCents).toBe(2000)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_GAIN)?.creditCents).toBe(2000)
  })

  it('units found with no cost are posted at the value the movement carries, opening stock against the opening equity', () => {
    const found = adjustmentLines({
      accounts,
      movement: {
        ...movement(InventoryMovementType.ADJUSTMENT_IN, 3, null, InventoryAdjustmentReason.FOUND),
        valueCents: 1501n
      },
      storeId: STORE
    })
    expect(found.ok && lineOf(found.lines, AccountRole.INVENTORY)?.debitCents).toBe(1501)
    const opening = adjustmentLines({
      accounts,
      movement: {
        ...movement(
          InventoryMovementType.ADJUSTMENT_IN,
          3,
          null,
          InventoryAdjustmentReason.OPENING_STOCK
        ),
        valueCents: 900n
      },
      storeId: STORE
    })
    expect(opening.ok && lineOf(opening.lines, AccountRole.OPENING_EQUITY)?.creditCents).toBe(900)
  })

  it('units in that no cost and no value can say are still a failure, so is a negative value; a value of zero posts nothing', () => {
    expect(
      adjustmentLines({
        accounts,
        movement: { ...movement(InventoryMovementType.COUNT_IN, 2, null), valueCents: null },
        storeId: STORE
      })
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.COST_MISSING })
    expect(
      adjustmentLines({
        accounts,
        movement: { ...movement(InventoryMovementType.COUNT_IN, 2, null), valueCents: -1n },
        storeId: STORE
      })
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.COST_MISSING })
    expect(
      adjustmentLines({
        accounts,
        movement: { ...movement(InventoryMovementType.COUNT_IN, 2, null), valueCents: 0n },
        storeId: STORE
      })
    ).toEqual({ ok: true, lines: [] })
  })

  it('units in with no cost cannot be valued: a failure, not a zero', () => {
    expect(
      adjustmentLines({
        accounts,
        movement: movement(InventoryMovementType.COUNT_IN, 1, null),
        storeId: STORE
      })
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.COST_MISSING })
  })

  it('units out that carried no cost have nothing to write off', () => {
    expect(
      adjustmentLines({
        accounts,
        movement: movement(InventoryMovementType.ADJUSTMENT_OUT, 1, null),
        storeId: STORE
      })
    ).toEqual({ ok: true, lines: [] })
  })

  it.each([
    InventoryMovementType.TRANSFER_OUT,
    InventoryMovementType.TRANSFER_IN,
    InventoryMovementType.RECEIPT,
    InventoryMovementType.ISSUE,
    InventoryMovementType.RESERVE,
    InventoryMovementType.RETURN_IN
  ])('%s posts nothing here', type => {
    expect(adjustmentLines({ accounts, movement: movement(type, 1, 100), storeId: STORE })).toEqual(
      {
        ok: true,
        lines: []
      }
    )
  })
})

describe('transferWriteOffLines (E9, a transfer shortage written off)', () => {
  it('the units that never arrived are a loss at the cost they left the source with (AUT-911)', () => {
    // 4 dispatched at 250, 3 received: one unit is gone
    const row = { quantity: 4, receivedQuantity: 3, unitCostCents: 250, valueCents: 1000n }
    expect(transferWriteOffCents(row)).toBe(250)
    const result = transferWriteOffLines({ accounts, row, storeId: STORE })
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY_LOSS)?.debitCents).toBe(250)
    expect(result.ok && lineOf(result.lines, AccountRole.INVENTORY)?.creditCents).toBe(250)
  })

  it('a line that arrived in full loses nothing', () => {
    expect(transferWriteOffCents({ quantity: 4, receivedQuantity: 4, unitCostCents: 250 })).toBe(0)
  })

  it('nothing of it arrived: the whole value of the dispatch is the loss', () => {
    expect(
      transferWriteOffCents({
        quantity: 4,
        receivedQuantity: 0,
        unitCostCents: 250,
        valueCents: 1001n
      })
    ).toBe(1001)
  })

  it('the rounding of the dispatch value lands in the loss, so the books match the stock', () => {
    // the source gave 4 units at an average of 33.33 (value 133 cents, unit 33): 3 came in at 33 each (99), the stock lost 34
    expect(
      transferWriteOffCents({
        quantity: 4,
        receivedQuantity: 3,
        unitCostCents: 33,
        valueCents: 133n
      })
    ).toBe(34)
  })

  it('the loss is what the receipts really put in, to the cent, when the service has it', () => {
    expect(
      transferWriteOffCents({
        quantity: 4,
        receivedQuantity: 3,
        unitCostCents: 33,
        valueCents: 133n,
        receivedValueCents: 100n
      })
    ).toBe(33)
  })

  it('a dispatch valued with no unit cost still loses what its value says', () => {
    expect(
      transferWriteOffCents({
        quantity: 2,
        receivedQuantity: 1,
        unitCostCents: null,
        valueCents: 90n,
        receivedValueCents: 45n
      })
    ).toBe(45)
  })

  it('a dispatch with no cost (nothing on hand to average) has nothing to write off', () => {
    const row = { quantity: 4, receivedQuantity: 3, unitCostCents: null }
    expect(transferWriteOffCents(row)).toBe(0)
    expect(transferWriteOffLines({ accounts, row, storeId: STORE })).toEqual({
      ok: true,
      lines: []
    })
  })

  it('a missing mapping is a visible failure, never a guess', () => {
    const row = { quantity: 2, receivedQuantity: 1, unitCostCents: 100 }
    const result = transferWriteOffLines({ accounts: () => null, row, storeId: STORE })
    expect(result.ok).toBe(false)
  })
})
