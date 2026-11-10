import type { ProductDetailView, ProductVariantView } from '@platform/api-client'

import {
  EMPTY_PRODUCT_FORM,
  formFromProduct,
  formFromVariant,
  productChangesFrom,
  productInputFrom,
  variantChangesFrom,
  variantInputFrom
} from './product-form'

const product: ProductDetailView = {
  id: 'p1',
  name: 'Shoe',
  description: 'Leather',
  priceCents: 1999,
  costCents: 900,
  sku: 'SHOE-1',
  imageMediaId: null,
  trackInventory: true,
  lowStockThreshold: 5,
  active: true,
  freeShipping: false,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  variants: []
}

describe('the product form', () => {
  it('starts an edit from the product, with the money as text', () => {
    expect(formFromProduct(product)).toEqual({
      name: 'Shoe',
      sku: 'SHOE-1',
      description: 'Leather',
      price: '19.99',
      cost: '9.00',
      trackInventory: true,
      lowStockThreshold: '5',
      freeShipping: false,
      active: true
    })
  })

  it('builds a new product leaving out what is empty', () => {
    const result = productInputFrom({ ...EMPTY_PRODUCT_FORM, name: ' Hat ', price: '12,5' })
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Hat',
        priceCents: 1250,
        trackInventory: true,
        active: true,
        freeShipping: false
      }
    })
  })

  it.each([
    [{ name: '  ' }, 'name'],
    [{ price: '' }, 'price'],
    [{ price: '1.234' }, 'price'],
    [{ cost: 'abc' }, 'cost'],
    [{ lowStockThreshold: '-1' }, 'lowStockThreshold'],
    [{ lowStockThreshold: '2.5' }, 'lowStockThreshold']
  ])('points at the field that is wrong: %j', (overrides, field) => {
    const result = productInputFrom({
      ...EMPTY_PRODUCT_FORM,
      name: 'Hat',
      price: '10',
      ...overrides
    })
    expect(result).toEqual({ ok: false, field })
  })

  it('sends only what changed, and nothing when nothing did', () => {
    const same = productChangesFrom(product, formFromProduct(product))
    expect(same).toEqual({ ok: true, value: {} })
    const edited = productChangesFrom(product, {
      ...formFromProduct(product),
      price: '25',
      active: false
    })
    expect(edited).toEqual({ ok: true, value: { priceCents: 2500, active: false } })
  })

  it('does not read the threshold of a product that does not track its stock', () => {
    const typed = { ...EMPTY_PRODUCT_FORM, name: 'Hat', price: '10', lowStockThreshold: 'abc' }
    expect(productInputFrom({ ...typed, trackInventory: false })).toEqual({
      ok: true,
      value: {
        name: 'Hat',
        priceCents: 1000,
        trackInventory: false,
        active: true,
        freeShipping: false
      }
    })
    expect(productInputFrom({ ...typed, trackInventory: true })).toEqual({
      ok: false,
      field: 'lowStockThreshold'
    })
    const stopped = productChangesFrom(product, {
      ...formFromProduct(product),
      trackInventory: false,
      lowStockThreshold: 'abc'
    })
    expect(stopped).toEqual({ ok: true, value: { trackInventory: false } })
  })

  it('clears the sku, the cost, the description and the threshold when they are emptied', () => {
    const result = productChangesFrom(product, {
      ...formFromProduct(product),
      sku: '',
      cost: '',
      description: '',
      lowStockThreshold: ''
    })
    expect(result).toEqual({
      ok: true,
      value: { sku: null, costCents: null, description: null, lowStockThreshold: null }
    })
  })
})

const variant: ProductVariantView = {
  id: 'v1',
  productId: 'p1',
  name: '42',
  sku: null,
  priceCents: null,
  effectivePriceCents: 1999,
  costCents: null,
  effectiveCostCents: 900,
  attributes: {},
  active: true,
  createdAt: '2026-11-10T10:00:00.000Z'
}

describe('the variant form', () => {
  it('leaves the price and the cost out when they are empty: the product is followed', () => {
    expect(variantInputFrom({ name: '43', sku: '', price: '', cost: '' })).toEqual({
      ok: true,
      value: { name: '43' }
    })
  })

  it('sends a price of its own as cents and refuses a name that is empty or a price that is not money', () => {
    expect(variantInputFrom({ name: '43', sku: 'S-43', price: '21.5', cost: '' })).toEqual({
      ok: true,
      value: { name: '43', sku: 'S-43', priceCents: 2150 }
    })
    expect(variantInputFrom({ name: '', sku: '', price: '', cost: '' })).toEqual({
      ok: false,
      field: 'name'
    })
    expect(variantInputFrom({ name: 'x', sku: '', price: '1.999', cost: '' })).toEqual({
      ok: false,
      field: 'price'
    })
  })

  it('sends null to go back to the price of the product', () => {
    const own = { ...variant, priceCents: 2000 }
    expect(variantChangesFrom(own, { ...formFromVariant(own), price: '' })).toEqual({
      ok: true,
      value: { priceCents: null }
    })
    expect(variantChangesFrom(own, formFromVariant(own))).toEqual({ ok: true, value: {} })
  })
})
