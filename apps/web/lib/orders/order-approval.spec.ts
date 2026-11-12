import { DiscountHints, discountHint, estimatedSubtotalCents } from './order-approval'
import { type DraftLine } from './order-form'

function line(overrides: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'p1:',
    productId: 'p1',
    variantId: null,
    productName: 'Shirt',
    variantName: null,
    sku: null,
    catalogPriceCents: 1000,
    quantity: '2',
    priceText: null,
    priceReason: '',
    allocations: null,
    ...overrides
  }
}

describe('estimatedSubtotalCents', () => {
  it('multiplies the catalog price by the units', () => {
    expect(
      estimatedSubtotalCents([line(), line({ key: 'p2:', catalogPriceCents: 500 })], false)
    ).toBe(3000)
  })

  it('counts a typed price only for who may write it', () => {
    const typed = line({ priceText: '7.50' })
    expect(estimatedSubtotalCents([typed], true)).toBe(1500)
    expect(estimatedSubtotalCents([typed], false)).toBe(2000)
  })

  it('counts a line with unreadable units as nothing', () => {
    expect(estimatedSubtotalCents([line({ quantity: '' })], false)).toBe(0)
  })
})

describe('discountHint', () => {
  const base = { subtotalCents: 10000, canOverridePrice: false, limitPercent: 10 }

  it('says nothing without a discount', () => {
    expect(discountHint({ ...base, discountText: '' })).toBe(DiscountHints.NONE)
    expect(discountHint({ ...base, discountText: 'abc' })).toBe(DiscountHints.NONE)
    expect(discountHint({ ...base, discountText: '0' })).toBe(DiscountHints.NONE)
  })

  it('accepts a discount up to the limit and asks approval above it', () => {
    expect(discountHint({ ...base, discountText: '10.00' })).toBe(DiscountHints.WITHIN_LIMIT)
    expect(discountHint({ ...base, discountText: '10.01' })).toBe(DiscountHints.NEEDS_APPROVAL)
  })

  it('treats a limit of 0 as the strictest', () => {
    expect(discountHint({ ...base, limitPercent: 0, discountText: '0.01' })).toBe(
      DiscountHints.NEEDS_APPROVAL
    )
  })

  it('does not ask approval of a member who may override prices', () => {
    expect(discountHint({ ...base, canOverridePrice: true, discountText: '50' })).toBe(
      DiscountHints.OVERRIDDEN
    )
  })

  it('says nothing about the limit when it cannot be read', () => {
    expect(discountHint({ ...base, limitPercent: null, discountText: '50' })).toBe(
      DiscountHints.UNKNOWN
    )
  })
})
