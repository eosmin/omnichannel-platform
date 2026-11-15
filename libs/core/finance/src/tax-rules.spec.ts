import { TaxRounding, TaxTreatment } from '@platform/core/domain'

import {
  allocateByWeight,
  computeOrderTax,
  isRateBps,
  resolveLineTax,
  roundedQuotient,
  taxOfAmount
} from './tax-rules'

const VAT = 1300

describe('isRateBps', () => {
  it('takes whole basis points from 0 to 10000 and nothing else', () => {
    expect([0, 1, 1300, 10_000].map(isRateBps)).toEqual([true, true, true, true])
    expect([-1, 10_001, 13.5, Number.NaN, '1300', null, undefined].map(isRateBps)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ])
  })
})

describe('roundedQuotient', () => {
  it('places a fraction of a cent by the chosen rounding, with the half cent as the edge', () => {
    // 1 / 2 = 0.5, 3 / 2 = 1.5, 5 / 2 = 2.5, 7 / 3 = 2.33, 8 / 3 = 2.67
    const table = (rounding: TaxRounding): number[] =>
      [
        [1, 2],
        [3, 2],
        [5, 2],
        [7, 3],
        [8, 3],
        [6, 3]
      ].map(([n, d]) => roundedQuotient(n as number, d as number, rounding))
    expect(table(TaxRounding.HALF_UP)).toEqual([1, 2, 3, 2, 3, 2])
    expect(table(TaxRounding.HALF_EVEN)).toEqual([0, 2, 2, 2, 3, 2])
    expect(table(TaxRounding.DOWN)).toEqual([0, 1, 2, 2, 2, 2])
    expect(table(TaxRounding.UP)).toEqual([1, 2, 3, 3, 3, 2])
  })

  it('is exact where a float would not be', () => {
    // 1.005 x 100 is 100.49999999999999 in floating point; here the half is the half
    expect(roundedQuotient(201, 2, TaxRounding.HALF_UP)).toBe(101)
    // The biggest product an order can make: 2^31 cents at 10000 basis points
    expect(roundedQuotient(2_147_483_647 * 10_000, 10_000, TaxRounding.HALF_UP)).toBe(2_147_483_647)
  })

  it('stays exact at the edge of the safe integers, where a float division would not', () => {
    expect(roundedQuotient(Number.MAX_SAFE_INTEGER, 2, TaxRounding.DOWN)).toBe(
      4_503_599_627_370_495
    )
    expect(roundedQuotient(Number.MAX_SAFE_INTEGER, 2, TaxRounding.HALF_UP)).toBe(
      4_503_599_627_370_496
    )
  })

  it('refuses what is not a whole non-negative numerator over a positive denominator', () => {
    expect(() => roundedQuotient(-1, 2, TaxRounding.HALF_UP)).toThrow(RangeError)
    expect(() => roundedQuotient(1.5, 2, TaxRounding.HALF_UP)).toThrow(RangeError)
    expect(() => roundedQuotient(1, 0, TaxRounding.HALF_UP)).toThrow(RangeError)
  })
})

describe('taxOfAmount at 13 %', () => {
  const included = (amountCents: number, rounding = TaxRounding.HALF_UP): number =>
    taxOfAmount({ amountCents, rateBps: VAT, includesTax: true, rounding })
  const excluded = (amountCents: number, rounding = TaxRounding.HALF_UP): number =>
    taxOfAmount({ amountCents, rateBps: VAT, includesTax: false, rounding })

  it('takes the tax out of a price that includes it: amount x rate / (10000 + rate)', () => {
    // 11.30 is 10.00 plus 1.30 exactly
    expect(included(1130)).toBe(130)
    // 10.00 holds 1.1504 of tax: 1.15
    expect(included(1000)).toBe(115)
    // 9.99 holds 1.1493: half up is 1.15, down is 1.14
    expect(included(999)).toBe(115)
    expect(included(999, TaxRounding.DOWN)).toBe(114)
    expect(included(1)).toBe(0)
    expect(included(0)).toBe(0)
  })

  it('puts the tax on a price that excludes it: amount x rate / 10000', () => {
    expect(excluded(1000)).toBe(130)
    // 3.33 x 13 % = 0.4329
    expect(excluded(333)).toBe(43)
    // 3.35 x 13 % = 0.4355
    expect(excluded(335)).toBe(44)
    expect(excluded(335, TaxRounding.DOWN)).toBe(43)
    expect(excluded(333, TaxRounding.UP)).toBe(44)
  })

  it('breaks an exact half by the rounding the books chose', () => {
    // 11.50 x 13 % = 1.495 and 12.50 x 13 % = 1.625 are exact halves of a cent
    expect(excluded(1150)).toBe(150)
    expect(excluded(1150, TaxRounding.HALF_EVEN)).toBe(150)
    expect(excluded(1250)).toBe(163)
    expect(excluded(1250, TaxRounding.HALF_EVEN)).toBe(162)
  })

  it('charges nothing at a rate of zero and refuses a rate that is not basis points', () => {
    expect(
      taxOfAmount({
        amountCents: 1000,
        rateBps: 0,
        includesTax: true,
        rounding: TaxRounding.HALF_UP
      })
    ).toBe(0)
    expect(() =>
      taxOfAmount({
        amountCents: 1000,
        rateBps: 13,
        includesTax: true,
        rounding: TaxRounding.HALF_UP
      })
    ).not.toThrow()
    expect(() =>
      taxOfAmount({
        amountCents: 1000,
        rateBps: 1300.5,
        includesTax: true,
        rounding: TaxRounding.HALF_UP
      })
    ).toThrow(RangeError)
  })
})

describe('allocateByWeight', () => {
  it('shares an amount in proportion and always adds up to it', () => {
    expect(allocateByWeight(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocateByWeight(100, [1000, 1000])).toEqual([50, 50])
    expect(allocateByWeight(1, [5, 5])).toEqual([1, 0])
    expect(allocateByWeight(0, [3, 4])).toEqual([0, 0])
    expect(allocateByWeight(10, [])).toEqual([])
    // The largest remainder gets the spare cent, not the first line
    expect(allocateByWeight(10, [1, 2])).toEqual([3, 7])
    for (const total of [1, 7, 99, 1000, 123_457]) {
      const parts = allocateByWeight(total, [333, 1, 667, 2_000_000_000])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })

  it('does not lose a cent where amount x weight passes 2^53', () => {
    const parts = allocateByWeight(2_000_000_000, [2_000_000_000, 1_999_999_999, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(2_000_000_000)
  })
})

describe('computeOrderTax', () => {
  const taxed = (unitPriceCents: number, quantity = 1) => ({
    unitPriceCents,
    quantity,
    treatment: TaxTreatment.TAXED,
    rateBps: VAT
  })
  const base = {
    discountCents: 0,
    shippingCents: 0,
    shippingRateBps: null,
    rounding: TaxRounding.HALF_UP
  }

  it('prices that include the tax: the total does not change and the net is the total less the tax', () => {
    const result = computeOrderTax({ ...base, lines: [taxed(1130)], includesTax: true })
    expect(result.lines).toEqual([
      { grossCents: 1130, discountShareCents: 0, baseCents: 1130, taxCents: 130, netCents: 1000 }
    ])
    expect(result.taxCents).toBe(130)
    expect(result.addedToTotalCents).toBe(0)
  })

  it('prices that exclude the tax: the tax is added to the total', () => {
    const result = computeOrderTax({ ...base, lines: [taxed(1000, 2)], includesTax: false })
    expect(result.lines[0]).toEqual({
      grossCents: 2000,
      discountShareCents: 0,
      baseCents: 2000,
      taxCents: 260,
      netCents: 2000
    })
    expect(result.addedToTotalCents).toBe(260)
  })

  it('computes the tax of each line and sums them, not the tax of the sum', () => {
    // Three lines of 9.99 holding 1.15 each (3.45), where the 29.97 together would hold 3.4478 (3.45): same here, so use
    // 3 x 3.33 excluded, where each line is 0.4329 (0.43) and the sum of the lines is 1.29 but the whole is 1.2987 (1.30)
    const lines = [taxed(333), taxed(333), taxed(333)]
    const result = computeOrderTax({ ...base, lines, includesTax: false })
    expect(result.lines.map(line => line.taxCents)).toEqual([43, 43, 43])
    expect(result.taxCents).toBe(129)
    expect(
      taxOfAmount({
        amountCents: 999,
        rateBps: VAT,
        includesTax: false,
        rounding: TaxRounding.HALF_UP
      })
    ).toBe(130)
  })

  it('shares the discount over the lines before taxing them, so the discount lowers the tax too', () => {
    // Two lines of 10.00; a 1.00 discount is 0.50 on each; each holds 9.50 included: 1.0929, 1.09 each (2.18, not the 2.19
    // that 19.00 together would give)
    const result = computeOrderTax({
      ...base,
      lines: [taxed(1000), taxed(500, 2)],
      discountCents: 100,
      includesTax: true
    })
    expect(
      result.lines.map(line => [line.discountShareCents, line.baseCents, line.taxCents])
    ).toEqual([
      [50, 950, 109],
      [50, 950, 109]
    ])
    expect(result.taxCents).toBe(218)
  })

  it('leaves the spare cent of an uneven discount where the largest remainder says, and the lines add up', () => {
    const result = computeOrderTax({
      ...base,
      lines: [taxed(100), taxed(100), taxed(100)],
      discountCents: 100,
      includesTax: true
    })
    expect(result.lines.map(line => line.discountShareCents)).toEqual([34, 33, 33])
    expect(result.lines.reduce((a, line) => a + line.baseCents, 0)).toBe(200)
  })

  it('taxes the shipping fee at its own rate, or not at all', () => {
    const withFee = (shippingRateBps: number | null, includesTax: boolean) =>
      computeOrderTax({
        ...base,
        lines: [taxed(1130)],
        shippingCents: 500,
        shippingRateBps,
        includesTax
      })
    // 5.00 holding 0.5752 included (0.58); 5.00 x 13 % = 0.65 excluded
    expect(withFee(VAT, true)).toMatchObject({
      shippingTaxCents: 58,
      shippingNetCents: 442,
      taxCents: 188
    })
    expect(withFee(VAT, false)).toMatchObject({
      shippingTaxCents: 65,
      shippingNetCents: 500,
      addedToTotalCents: 212
    })
    expect(withFee(null, true)).toMatchObject({
      shippingTaxCents: 0,
      shippingNetCents: 500,
      taxCents: 130
    })
  })

  it('carries no tax on an exempt or a not subject line, in either mode', () => {
    for (const treatment of [TaxTreatment.EXEMPT, TaxTreatment.NOT_SUBJECT]) {
      for (const includesTax of [true, false]) {
        const result = computeOrderTax({
          ...base,
          lines: [{ unitPriceCents: 1000, quantity: 3, treatment, rateBps: null }, taxed(1130)],
          includesTax
        })
        expect(result.lines[0]).toEqual({
          grossCents: 3000,
          discountShareCents: 0,
          baseCents: 3000,
          taxCents: 0,
          netCents: 3000
        })
        expect(result.taxCents).toBe(includesTax ? 130 : 147)
      }
    }
  })

  it('ignores a rate on an exempt line and refuses a taxed line with none', () => {
    const exempt = computeOrderTax({
      ...base,
      lines: [{ unitPriceCents: 1000, quantity: 1, treatment: TaxTreatment.EXEMPT, rateBps: VAT }],
      includesTax: true
    })
    expect(exempt.taxCents).toBe(0)
    expect(() =>
      computeOrderTax({
        ...base,
        lines: [
          { unitPriceCents: 1000, quantity: 1, treatment: TaxTreatment.TAXED, rateBps: null }
        ],
        includesTax: true
      })
    ).toThrow(RangeError)
  })

  it('keeps net + tax equal to the base of every line, whatever the rounding', () => {
    for (const rounding of Object.values(TaxRounding)) {
      for (const includesTax of [true, false]) {
        const result = computeOrderTax({
          lines: [taxed(333, 3), taxed(1999), taxed(7, 11)],
          discountCents: 123,
          shippingCents: 457,
          shippingRateBps: VAT,
          includesTax,
          rounding
        })
        for (const line of result.lines) {
          expect(line.netCents + (includesTax ? line.taxCents : 0)).toBe(line.baseCents)
        }
        const grossTotal = result.lines.reduce((a, line) => a + line.grossCents, 0)
        expect(result.lines.reduce((a, line) => a + line.discountShareCents, 0)).toBe(123)
        expect(grossTotal).toBe(333 * 3 + 1999 + 7 * 11)
      }
    }
  })

  it('refuses a discount above the subtotal and an amount that is not whole cents', () => {
    expect(() =>
      computeOrderTax({ ...base, lines: [taxed(100)], discountCents: 101, includesTax: true })
    ).toThrow(RangeError)
    expect(() => computeOrderTax({ ...base, lines: [taxed(100.5)], includesTax: true })).toThrow(
      RangeError
    )
    expect(() => computeOrderTax({ ...base, lines: [taxed(100, 0)], includesTax: true })).toThrow(
      RangeError
    )
    expect(() =>
      computeOrderTax({ ...base, lines: [taxed(100)], shippingCents: -1, includesTax: true })
    ).toThrow(RangeError)
  })
})

describe('resolveLineTax', () => {
  it('takes the rate of the product, else the default, and none for an exempt or not subject product', () => {
    expect(
      resolveLineTax({ treatment: TaxTreatment.TAXED, productRateBps: 500, defaultRateBps: VAT })
    ).toEqual({
      treatment: TaxTreatment.TAXED,
      rateBps: 500
    })
    expect(
      resolveLineTax({ treatment: TaxTreatment.TAXED, productRateBps: null, defaultRateBps: VAT })
    ).toEqual({
      treatment: TaxTreatment.TAXED,
      rateBps: VAT
    })
    expect(
      resolveLineTax({ treatment: TaxTreatment.TAXED, productRateBps: null, defaultRateBps: null })
        .rateBps
    ).toBeNull()
    expect(
      resolveLineTax({ treatment: TaxTreatment.EXEMPT, productRateBps: 500, defaultRateBps: VAT })
    ).toEqual({
      treatment: TaxTreatment.EXEMPT,
      rateBps: null
    })
  })
})
