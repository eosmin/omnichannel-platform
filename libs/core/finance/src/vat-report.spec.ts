import { TaxRounding, TaxTreatment, VatLineKind } from '@platform/core/domain'

import { computeOrderTax } from './tax-rules'
import { type ReportableOrder, vatLinesOfOrder } from './vat-report'

const VAT = 1300

// An order as the service stores it: the lines taxed by computeOrderTax, the order tax the sum, as 4B.3b writes them
function orderOf(input: {
  items: { unitPriceCents: number; quantity: number; treatment: TaxTreatment }[]
  discountCents: number
  shippingCents: number
  shippingRateBps: number | null
  includesTax: boolean
}): { order: ReportableOrder; totalCents: number } {
  const tax = computeOrderTax({
    lines: input.items.map(item => ({
      ...item,
      rateBps: item.treatment === TaxTreatment.TAXED ? VAT : null
    })),
    discountCents: input.discountCents,
    shippingCents: input.shippingCents,
    shippingRateBps: input.shippingRateBps,
    includesTax: input.includesTax,
    rounding: TaxRounding.HALF_UP
  })
  const subtotal = input.items.reduce((acc, item) => acc + item.unitPriceCents * item.quantity, 0)
  return {
    totalCents: subtotal - input.discountCents + input.shippingCents + tax.addedToTotalCents,
    order: {
      discountCents: input.discountCents,
      shippingCents: input.shippingCents,
      taxCents: tax.taxCents,
      pricesIncludeTax: input.includesTax,
      shippingTaxRateBps: input.shippingCents > 0 ? input.shippingRateBps : null,
      items: input.items.map((item, index) => ({
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        taxTreatment: item.treatment,
        taxRateBps: item.treatment === TaxTreatment.TAXED ? VAT : null,
        taxCents: tax.lines[index]?.taxCents ?? 0
      }))
    }
  }
}

describe('vatLinesOfOrder', () => {
  const items = [
    { unitPriceCents: 1130, quantity: 3, treatment: TaxTreatment.TAXED },
    { unitPriceCents: 999, quantity: 1, treatment: TaxTreatment.TAXED },
    { unitPriceCents: 500, quantity: 2, treatment: TaxTreatment.EXEMPT },
    { unitPriceCents: 250, quantity: 1, treatment: TaxTreatment.NOT_SUBJECT }
  ]

  it.each([true, false])(
    'adds up to what the customer paid, with the prices including the tax: %s',
    includesTax => {
      for (const shippingRateBps of [VAT, null]) {
        const { order, totalCents } = orderOf({
          items,
          discountCents: 333,
          shippingCents: 457,
          shippingRateBps,
          includesTax
        })
        const lines = vatLinesOfOrder(order)

        expect(lines).not.toBeNull()
        const sum = (lines ?? []).reduce((acc, line) => acc + line.baseCents + line.taxCents, 0)
        expect(sum).toBe(totalCents)
        expect((lines ?? []).reduce((acc, line) => acc + line.taxCents, 0)).toBe(order.taxCents)
      }
    }
  )

  it('groups by kind and rate, and puts a fee with no tax in its own kind', () => {
    const { order } = orderOf({
      items,
      discountCents: 0,
      shippingCents: 500,
      shippingRateBps: null,
      includesTax: true
    })
    const lines = vatLinesOfOrder(order) ?? []
    const kinds = lines.map(line => `${line.kind}:${line.rateBps ?? ''}`).sort()

    expect(kinds).toEqual(
      [
        `${VatLineKind.TAXED}:${VAT}`,
        `${VatLineKind.EXEMPT}:`,
        `${VatLineKind.NOT_SUBJECT}:`,
        `${VatLineKind.SHIPPING_NOT_TAXED}:`
      ].sort()
    )
    // Each line holds its own tax (3 x 11.30 holds 3.90, 9.99 holds 1.15): 5.05 in all, and the base of the taxed lines is the rest
    const taxed = lines.find(line => line.kind === VatLineKind.TAXED)
    expect(taxed).toMatchObject({ taxCents: 390 + 115, baseCents: 3 * 1130 + 999 - 505 })
  })

  it('reads the tax of a fee from what the order has beyond its lines', () => {
    const { order } = orderOf({
      items,
      discountCents: 0,
      shippingCents: 565,
      shippingRateBps: VAT,
      includesTax: true
    })
    // 5.65 holds 0.65 of tax at 13 %: the fee is a taxed line of 5.00
    const taxed = vatLinesOfOrder(order)?.find(
      line => line.kind === VatLineKind.TAXED && line.rateBps === VAT
    )
    const lineTax = order.items.reduce((acc, item) => acc + item.taxCents, 0)
    expect(order.taxCents - lineTax).toBe(65)
    expect(taxed?.taxCents).toBe(lineTax + 65)
  })

  it('counts the order out when its snapshot does not add up, and never guesses', () => {
    const { order } = orderOf({
      items,
      discountCents: 0,
      shippingCents: 0,
      shippingRateBps: VAT,
      includesTax: true
    })
    expect(vatLinesOfOrder({ ...order, taxCents: order.taxCents - 1 })).toBeNull()
    expect(vatLinesOfOrder({ ...order, taxCents: order.taxCents + 1 })).toBeNull()
    // A fee that cost something but whose tax is more than the fee
    expect(
      vatLinesOfOrder({
        ...order,
        shippingCents: 10,
        taxCents: order.taxCents + 11,
        shippingTaxRateBps: VAT
      })
    ).toBeNull()
  })
})

describe('vatLinesOfOrder with figures worked out by hand', () => {
  it('splits a taxed order with the prices included into its base and its tax', () => {
    // 3 x 11.30 = 33.90 holds 3.90 at 13 %, no discount, no fee
    expect(
      vatLinesOfOrder({
        discountCents: 0,
        shippingCents: 0,
        taxCents: 390,
        pricesIncludeTax: true,
        shippingTaxRateBps: null,
        items: [
          {
            unitPriceCents: 1130,
            quantity: 3,
            taxTreatment: 'taxed',
            taxRateBps: 1300,
            taxCents: 390
          }
        ]
      })
    ).toEqual([{ kind: VatLineKind.TAXED, rateBps: 1300, baseCents: 3000, taxCents: 390 }])
  })

  it('splits a taxed order with the prices excluded and a taxed fee', () => {
    // 3 x 10.00 less 1.00 = 29.00 at 13 % is 3.77; 5.00 of fee at 13 % is 0.65: the base is what was sold, the tax comes on top
    expect(
      vatLinesOfOrder({
        discountCents: 100,
        shippingCents: 500,
        taxCents: 442,
        pricesIncludeTax: false,
        shippingTaxRateBps: 1300,
        items: [
          {
            unitPriceCents: 1000,
            quantity: 3,
            taxTreatment: 'taxed',
            taxRateBps: 1300,
            taxCents: 377
          }
        ]
      })
    ).toEqual([{ kind: VatLineKind.TAXED, rateBps: 1300, baseCents: 2900 + 500, taxCents: 442 }])
  })
})
