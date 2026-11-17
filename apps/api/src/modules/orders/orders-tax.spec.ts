import { TaxRounding, TaxTreatment } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import {
  lineTaxOf,
  planTax,
  snapshotTax,
  storedRounding,
  taxColumnsOf,
  type TaxContext
} from './orders-tax'

describe('storedRounding', () => {
  it('reads a rounding of the list, and takes anything else for none', () => {
    for (const rounding of Object.values(TaxRounding)) {
      expect(storedRounding(rounding)).toBe(rounding)
    }
    expect(storedRounding(null)).toBeNull()
    expect(storedRounding('')).toBeNull()
    expect(storedRounding('banker')).toBeNull()
  })
})

const context = (over: Partial<TaxContext> = {}): TaxContext => ({
  rounding: TaxRounding.HALF_UP,
  includesTax: true,
  shippingTaxed: true,
  defaultRateBps: 1300,
  ...over
})
// The code of the refusal a call throws
function codeOf(call: () => unknown): string | null {
  try {
    call()
  } catch (error) {
    return error instanceof PlatformException ? error.code : null
  }
  return null
}
const taxed = { taxTreatment: TaxTreatment.TAXED, taxRateBps: 1300 }

describe('lineTaxOf', () => {
  it('takes the rate of the product, else the default, and none for what is not taxed', () => {
    expect(lineTaxOf(context(), { taxTreatment: 'taxed', taxRate: { rateBps: 500 } })).toEqual({
      taxTreatment: 'taxed',
      taxRateBps: 500
    })
    expect(lineTaxOf(context(), { taxTreatment: 'taxed', taxRate: null })).toEqual({
      taxTreatment: 'taxed',
      taxRateBps: 1300
    })
    expect(lineTaxOf(context(), { taxTreatment: 'exempt', taxRate: { rateBps: 500 } })).toEqual({
      taxTreatment: 'exempt',
      taxRateBps: null
    })
  })

  it('has no treatment at all for an organization with no books', () => {
    expect(lineTaxOf(null, { taxTreatment: 'taxed', taxRate: null })).toEqual({
      taxTreatment: null,
      taxRateBps: null
    })
  })

  it('stops a taxed product with no rate to take, and never guesses one', () => {
    expect(
      codeOf(() =>
        lineTaxOf(context({ defaultRateBps: null }), { taxTreatment: 'taxed', taxRate: null })
      )
    ).toBe(ErrorCodes.FINANCE_TAX_RATE_NOT_CONFIGURED)
    // An exempt product needs none
    expect(
      lineTaxOf(context({ defaultRateBps: null }), { taxTreatment: 'exempt', taxRate: null })
        .taxRateBps
    ).toBeNull()
  })
})

describe('planTax', () => {
  it('has no plan with no books', () => {
    expect(planTax(null)).toBeNull()
  })

  it('taxes the shipping fee at the default rate, or not at all by the setting', () => {
    expect(planTax(context())).toMatchObject({ shippingRateBps: 1300, shippingNeedsRate: false })
    expect(planTax(context({ shippingTaxed: false }))).toMatchObject({
      shippingRateBps: null,
      shippingNeedsRate: false
    })
  })

  it('needs a rate for a fee to be taxed when the organization has no default one', () => {
    expect(planTax(context({ defaultRateBps: null }))).toMatchObject({
      shippingRateBps: null,
      shippingNeedsRate: true
    })
  })

  it('keeps what an order that exists fixed: its price mode, and the rate of a fee that did not change', () => {
    const plan = planTax(context({ includesTax: false, defaultRateBps: 1500 }), {
      includesTax: true,
      rounding: null,
      shippingRateBps: 1300
    })
    expect(plan).toMatchObject({
      includesTax: true,
      shippingRateBps: 1300,
      shippingNeedsRate: false
    })
    // A fee that was not taxed stays untaxed
    expect(
      planTax(context(), { includesTax: true, rounding: null, shippingRateBps: null })
        ?.shippingRateBps
    ).toBeNull()
    // A fee that changed takes today's
    expect(
      planTax(context({ defaultRateBps: 1500 }), {
        includesTax: true,
        rounding: null,
        shippingRateBps: 'current'
      })?.shippingRateBps
    ).toBe(1500)
  })

  it("keeps the rounding the order was quoted with, and takes today's only when it kept none", () => {
    const books = context({ rounding: TaxRounding.HALF_EVEN })
    expect(
      planTax(books, { includesTax: true, rounding: TaxRounding.UP, shippingRateBps: null })
        ?.rounding
    ).toBe(TaxRounding.UP)
    expect(
      planTax(books, { includesTax: true, rounding: null, shippingRateBps: null })?.rounding
    ).toBe(TaxRounding.HALF_EVEN)
    expect(planTax(books)?.rounding).toBe(TaxRounding.HALF_EVEN)
  })
})

describe('snapshotTax', () => {
  const base = planTax(context())
  if (base === null) throw new Error('the context has books')
  const plan = (over = {}) => ({ ...base, ...over })

  it('stores the tax of each line and of the order, and what the tax adds to the total', () => {
    const snapshot = snapshotTax(plan({ includesTax: false }), {
      lines: [{ unitPriceCents: 1000, quantity: 3, ...taxed }],
      discountCents: 100,
      shippingCents: 500
    })

    expect(snapshot).toMatchObject({
      taxCents: 377 + 65,
      pricesIncludeTax: false,
      taxRounding: TaxRounding.HALF_UP,
      shippingTaxRateBps: 1300,
      addedToTotalCents: 442
    })
    expect(snapshot.lines).toEqual([{ taxTreatment: 'taxed', taxRateBps: 1300, taxCents: 377 }])
  })

  it('stores no rate for a fee of zero, and refuses a fee that must be taxed with no rate to tax it at', () => {
    expect(
      snapshotTax(plan(), {
        lines: [{ unitPriceCents: 1130, quantity: 1, ...taxed }],
        discountCents: 0,
        shippingCents: 0
      }).shippingTaxRateBps
    ).toBeNull()
    expect(
      codeOf(() =>
        snapshotTax(plan({ shippingRateBps: null, shippingNeedsRate: true }), {
          lines: [{ unitPriceCents: 1130, quantity: 1, ...taxed }],
          discountCents: 0,
          shippingCents: 100
        })
      )
    ).toBe(ErrorCodes.FINANCE_TAX_RATE_NOT_CONFIGURED)
  })
})

describe('taxColumnsOf', () => {
  it('writes the four columns together, or none', () => {
    expect(taxColumnsOf(null)).toEqual({})
    expect(
      taxColumnsOf({
        taxCents: 130,
        pricesIncludeTax: true,
        taxRounding: TaxRounding.HALF_UP,
        shippingTaxRateBps: null,
        lines: [],
        addedToTotalCents: 0
      })
    ).toEqual({
      taxCents: 130,
      pricesIncludeTax: true,
      taxRounding: TaxRounding.HALF_UP,
      shippingTaxRateBps: null
    })
  })
})
