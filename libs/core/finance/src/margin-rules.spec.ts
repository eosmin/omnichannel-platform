import { saleAmounts } from './auto-entry-rules'
import {
  addMarginRows,
  marginBps,
  type MarginOrder,
  type MarginRow,
  marginOfOrder,
  reconcileMargin
} from './margin-rules'

const order = (over: Partial<MarginOrder> = {}): MarginOrder => ({
  storeId: 's1',
  subtotalCents: 3000,
  shippingCents: 500,
  discountCents: 300,
  totalCents: 3590,
  taxCents: 390,
  pricesIncludeTax: false,
  lines: [
    { productId: 'a', quantity: 2, unitPriceCents: 1000, taxCents: 234 },
    { productId: 'b', quantity: 1, unitPriceCents: 1000, taxCents: 117 }
  ],
  ...over
})

describe('marginOfOrder', () => {
  it('splits the revenue of the sale entry among the lines, to the cent, and costs each product at its movements', () => {
    const o = order()
    const amounts = saleAmounts(o)
    if (!amounts.ok) throw new Error('the fixture must add up')
    const result = marginOfOrder(o, [
      { productId: 'a', quantity: 2, unitCostCents: 400 },
      { productId: 'b', quantity: 1, unitCostCents: 650 }
    ])
    if (!result.ok) throw new Error('the order must be accepted')
    expect(result.revenueCents).toBe(amounts.amounts.revenueNetCents)
    expect(result.rows.reduce((sum, row) => sum + row.revenueCents, 0)).toBe(result.revenueCents)
    expect(result.rows.find(row => row.productId === 'a')).toMatchObject({
      unitsSold: 2,
      revenueCents: 1800,
      costCents: 800
    })
    expect(result.costCents).toBe(1450)
    expect(result.unvaluedUnits).toBe(0)
  })

  it('takes the tax out of the line when the prices carry it', () => {
    const o = order({
      pricesIncludeTax: true,
      totalCents: 3000,
      taxCents: 345,
      discountCents: 0,
      subtotalCents: 3000,
      shippingCents: 0,
      lines: [{ productId: 'a', quantity: 3, unitPriceCents: 1000, taxCents: 345 }]
    })
    const result = marginOfOrder(o, [])
    if (!result.ok) throw new Error('the order must be accepted')
    expect(result.rows[0]?.revenueCents).toBe(2655)
    expect(result.revenueCents).toBe(2655)
  })

  it('counts a movement with no cost apart and never takes it as free', () => {
    const result = marginOfOrder(order(), [
      { productId: 'a', quantity: 2, unitCostCents: null },
      { productId: 'b', quantity: 1, unitCostCents: 100 }
    ])
    if (!result.ok) throw new Error('the order must be accepted')
    expect(result.unvaluedUnits).toBe(2)
    expect(result.costCents).toBe(100)
  })

  it('refuses an order the books would refuse', () => {
    expect(marginOfOrder(order({ totalCents: 1 }), [])).toEqual({ ok: false })
    expect(marginOfOrder(order({ taxCents: null }), [])).toEqual({ ok: false })
  })
})

describe('addMarginRows, marginBps and reconcileMargin', () => {
  it('adds by store and product', () => {
    const into = new Map<string, MarginRow>()
    addMarginRows(into, [
      { storeId: 's1', productId: 'a', unitsSold: 1, revenueCents: 10, costCents: 4 }
    ])
    addMarginRows(into, [
      { storeId: 's1', productId: 'a', unitsSold: 2, revenueCents: 20, costCents: 8 },
      { storeId: 's2', productId: 'a', unitsSold: 1, revenueCents: 5, costCents: 1 }
    ])
    expect([...into.values()]).toEqual([
      { storeId: 's1', productId: 'a', unitsSold: 3, revenueCents: 30, costCents: 12 },
      { storeId: 's2', productId: 'a', unitsSold: 1, revenueCents: 5, costCents: 1 }
    ])
  })

  it('gives the margin in basis points toward zero, and nothing when nothing was sold for money', () => {
    expect(marginBps(1800, 800)).toBe(5555)
    expect(marginBps(1000, 1500)).toBe(-5000)
    expect(marginBps(0, 10)).toBeNull()
  })

  it('compares with the ledger and says nothing about a role the organization has not mapped', () => {
    expect(reconcileMargin(100, 40, 100, 40)).toEqual({
      ledgerRevenueCents: 100,
      ledgerCostCents: 40,
      revenueDifferenceCents: 0,
      costDifferenceCents: 0
    })
    expect(reconcileMargin(100, 40, null, 35)).toMatchObject({
      revenueDifferenceCents: null,
      costDifferenceCents: 5
    })
  })
})
