import { ExchangeCreditMode, FinancePostingFailureReason, TaxRounding } from '@platform/core/domain'

import { saleAmounts } from './auto-entry-rules'
import { type ExchangeLineRow, type ExchangeOrderRow, grossExchangeView } from './exchange-gross'
import { lineBases } from './return-entry-rules'

// The replacement of the exchange of the accountant's example: 169.50 with the tax included at 13 %, the credit of the return 113.00,
// the customer pays 56.50 (its tax 6.50), the gross sale is 150.00 + 19.50
const line = (over: Partial<ExchangeLineRow> = {}): ExchangeLineRow => ({
  quantity: 1,
  unitPriceCents: 16950,
  taxCents: 650,
  taxTreatment: 'taxed',
  taxRateBps: 1300,
  ...over
})
const order = (over: Partial<ExchangeOrderRow> = {}): ExchangeOrderRow => ({
  exchangeCreditMode: ExchangeCreditMode.GROSS,
  subtotalCents: 16950,
  shippingCents: 0,
  discountCents: 11300,
  totalCents: 5650,
  taxCents: 650,
  pricesIncludeTax: true,
  taxRounding: TaxRounding.HALF_UP,
  shippingTaxRateBps: null,
  lines: [line()],
  ...over
})

describe('grossExchangeView', () => {
  it('reads a gross replacement at the full price and says what the credit consumes (the example of the accountant)', () => {
    const view = grossExchangeView(order())
    if (!view.ok) throw new Error('the order must be accepted')
    expect(view.creditConsumedCents).toBe(11300)
    expect(view.order).toMatchObject({ discountCents: 0, taxCents: 1950, totalCents: 16950 })
    expect(view.order.lines[0]?.taxCents).toBe(1950)
    const sale = saleAmounts(view.order)
    expect(sale).toEqual({
      ok: true,
      amounts: { revenueNetCents: 15000, shippingNetCents: 0, vatCents: 1950, totalCents: 16950 }
    })
  })

  it('gives the bases of a return of the replacement at the full price, so it reverses what the sale recognized', () => {
    const view = grossExchangeView(order())
    if (!view.ok) throw new Error('the order must be accepted')
    const bases = lineBases({
      ...view.order,
      lines: view.order.lines.map((row, index) => ({
        orderItemId: `i${index}`,
        quantity: row.quantity,
        unitPriceCents: row.unitPriceCents,
        taxCents: row.taxCents
      }))
    })
    expect(bases).toEqual({
      ok: true,
      lines: [{ orderItemId: 'i0', quantity: 1, netCents: 15000, vatCents: 1950 }]
    })
  })

  it.each([null, ExchangeCreditMode.NET])(
    'leaves an order whose mode is %s exactly as it is, discount and tax included (what was posted never moves)',
    mode => {
      const original = order({ exchangeCreditMode: mode })
      const view = grossExchangeView(original)
      expect(view).toEqual({ ok: true, order: original, creditConsumedCents: 0 })
      // the net reading still gives the residue of HC-138: 56.50 of revenue and tax together
      expect(saleAmounts(original)).toEqual({
        ok: true,
        amounts: { revenueNetCents: 5000, shippingNetCents: 0, vatCents: 650, totalCents: 5650 }
      })
    }
  )

  it('consumes the whole gross when the credit covers the replacement (total 0)', () => {
    const view = grossExchangeView(
      order({ discountCents: 16950, totalCents: 0, taxCents: 0, lines: [line({ taxCents: 0 })] })
    )
    if (!view.ok) throw new Error('the order must be accepted')
    expect(view.creditConsumedCents).toBe(16950)
    expect(view.order.totalCents).toBe(16950)
    expect(view.order.taxCents).toBe(1950)
  })

  it('reads a price without tax: the tax of the shipping fee goes in, and the credit consumed is what the full price adds up to less what is paid', () => {
    // 100.00 taxed at 13 % and a shipping fee of 10.00 taxed at 13 %, with a credit of 50.00 as its discount: the order pays 50.00 + 6.50 of
    // tax + 10.00 + 1.30 of tax = 67.80, and the sale at the full price is 100.00 + 10.00 + 14.30 = 124.30
    const view = grossExchangeView(
      order({
        pricesIncludeTax: false,
        subtotalCents: 10000,
        shippingCents: 1000,
        shippingTaxRateBps: 1300,
        discountCents: 5000,
        taxCents: 780,
        totalCents: 6780,
        lines: [line({ unitPriceCents: 10000, taxCents: 650 })]
      })
    )
    if (!view.ok) throw new Error('the order must be accepted')
    expect(view.order).toMatchObject({ discountCents: 0, taxCents: 1430, totalCents: 12430 })
    // Known limit (written in the plan): a price without tax takes the credit, which carries tax, off the subtotal before the tax, so
    // the advances give more than the credit (56.50 here for a credit of 50.00); the books show it as it is
    expect(view.creditConsumedCents).toBe(5650)
    expect(saleAmounts(view.order)).toEqual({
      ok: true,
      amounts: { revenueNetCents: 10000, shippingNetCents: 1000, vatCents: 1430, totalCents: 12430 }
    })
  })

  it('refuses a gross order whose stored tax is not what its own rule gives, and one with no rounding or no treatment', () => {
    expect(grossExchangeView(order({ taxCents: 651 }))).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
    expect(grossExchangeView(order({ totalCents: 5651 }))).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
    expect(grossExchangeView(order({ taxRounding: null }))).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.TAX_MISSING
    })
    expect(grossExchangeView(order({ lines: [line({ taxTreatment: null })] }))).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.TAX_MISSING
    })
  })

  it('leaves an order with no tax snapshot to be refused downstream, never invents a tax', () => {
    const view = grossExchangeView(
      order({ taxCents: null, pricesIncludeTax: null, lines: [line({ taxCents: null })] })
    )
    if (!view.ok) throw new Error('the order must be accepted')
    expect(saleAmounts(view.order)).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.TAX_MISSING
    })
  })
})
