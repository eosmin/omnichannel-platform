import { variantView } from './products.views'

const row = {
  id: 'v1',
  productId: 'p1',
  name: 'Size 42',
  sku: null,
  priceCents: null,
  costCents: null,
  attributes: {},
  active: true,
  createdAt: new Date(0)
}

const product = { priceCents: 2000, costCents: 800 }

describe('variantView', () => {
  it('costs a variant with no cost of its own at the cost of its product, and keeps one that has it', () => {
    expect(variantView(row, product).effectiveCostCents).toBe(800)
    expect(variantView({ ...row, costCents: 0 }, product).effectiveCostCents).toBe(0)
    expect(variantView(row, { ...product, costCents: null }).effectiveCostCents).toBeNull()
  })

  it('prices a variant with no price of its own at the price of its product', () => {
    expect(variantView(row, product).effectivePriceCents).toBe(2000)
  })

  it('keeps the price of a variant that has one, even a price of zero', () => {
    expect(variantView({ ...row, priceCents: 2500 }, product).effectivePriceCents).toBe(2500)
    expect(variantView({ ...row, priceCents: 0 }, product).effectivePriceCents).toBe(0)
  })

  it('reads the attributes as text to text and drops what is not', () => {
    expect(
      variantView({ ...row, attributes: { color: 'red', size: 42, nested: { a: 1 } } }, product)
        .attributes
    ).toEqual({ color: 'red' })
  })

  it.each([[null], [['x']], ['text'], [7]])('reads %p as no attributes', value => {
    expect(variantView({ ...row, attributes: value }, product).attributes).toEqual({})
  })
})
