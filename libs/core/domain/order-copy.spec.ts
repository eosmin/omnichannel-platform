import { OrderCopyWarnings } from './order-constants'
import {
  buildOrderCopyDraft,
  copyStockKey,
  type CopyCatalogProduct,
  type CopySourceOrder,
  type CopyStock
} from './order-copy'
import { createOrderSchema } from './order-schemas'
import { PaymentMethod } from './status-enums'

const CUSTOMER = '11111111-1111-4111-8111-111111111111'
const ORDER = '22222222-2222-4222-8222-222222222222'
const P1 = '33333333-3333-4333-8333-333333333333'
const P2 = '44444444-4444-4444-8444-444444444444'
const V1 = '55555555-5555-4555-8555-555555555555'

const ADDRESS = { line1: 'Calle 1', city: 'Quito', country: 'EC' }

function source(over: Partial<CopySourceOrder> = {}): CopySourceOrder {
  return {
    id: ORDER,
    customerId: CUSTOMER,
    shippingCents: 350,
    paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
    shippingAddress: ADDRESS,
    recipientPhones: ['0991234567'],
    customerNotes: 'ring twice',
    internalNotes: 'good customer',
    packingNotes: null,
    items: [
      {
        productId: P1,
        variantId: null,
        productName: 'Mug',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        originalUnitPriceCents: null
      }
    ],
    ...over
  }
}

function product(over: Partial<CopyCatalogProduct> = {}): CopyCatalogProduct {
  return { id: P1, active: true, priceCents: 1000, trackInventory: false, variants: [], ...over }
}

const W1 = 'w1'
const W2 = 'w2'

function stockOf(levels: Record<string, number>, over: Partial<CopyStock> = {}): CopyStock {
  return {
    warehouseIds: [W1, W2],
    available: new Map(Object.entries(levels)),
    allowSplitFulfillment: false,
    allowNegativeStock: false,
    ...over
  }
}

// A product that does not track stock never reads it
const PLENTY: CopyStock = stockOf({})

describe('buildOrderCopyDraft', () => {
  it('carries the customer, the lines, the address, the fee, the payment method and the notes, and no price', () => {
    const { draft, warnings, lines } = buildOrderCopyDraft(source(), [product()], PLENTY)
    expect(draft).toEqual({
      customerId: CUSTOMER,
      items: [{ productId: P1, quantity: 2 }],
      shippingCents: 350,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      shippingAddress: { ...ADDRESS },
      recipientPhones: ['0991234567'],
      customerNotes: 'ring twice',
      internalNotes: 'good customer',
      copiedFromOrderId: ORDER
    })
    expect(warnings).toEqual([])
    expect(lines).toEqual([
      {
        productId: P1,
        variantId: null,
        productName: 'Mug',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        previousUnitPriceCents: 1000
      }
    ])
  })

  it('produces a body that the create schema accepts as it is', () => {
    const { draft } = buildOrderCopyDraft(source(), [product()], PLENTY)
    expect(createOrderSchema.safeParse(draft).success).toBe(true)
  })

  it('never copies a price, a discount, a day or a thread, whatever the old order had', () => {
    const { draft } = buildOrderCopyDraft(
      source({
        items: [
          {
            productId: P1,
            variantId: null,
            productName: 'Mug',
            variantName: null,
            quantity: 1,
            unitPriceCents: 500,
            originalUnitPriceCents: 1000
          }
        ]
      }),
      [product()],
      PLENTY
    )
    expect(draft.items).toEqual([{ productId: P1, quantity: 1 }])
    for (const key of [
      'unitPriceCents',
      'discountCents',
      'scheduledDeliveryDate',
      'conversationId'
    ]) {
      expect(draft).not.toHaveProperty(key)
    }
  })

  it('reads the current catalog price and warns when it is not the one the line had', () => {
    const { lines, warnings } = buildOrderCopyDraft(
      source(),
      [product({ priceCents: 1200 })],
      PLENTY
    )
    expect(lines[0]?.unitPriceCents).toBe(1200)
    expect(lines[0]?.previousUnitPriceCents).toBe(1000)
    expect(warnings).toEqual([
      { code: OrderCopyWarnings.PRICE_CHANGED, itemIndex: 0, productId: P1, variantId: null }
    ])
  })

  it('compares with the catalog price the old line had, not with a price an agent overrode', () => {
    const overridden = source({
      items: [
        {
          productId: P1,
          variantId: null,
          productName: 'Mug',
          variantName: null,
          quantity: 1,
          unitPriceCents: 800,
          originalUnitPriceCents: 1000
        }
      ]
    })
    expect(buildOrderCopyDraft(overridden, [product()], PLENTY).warnings).toEqual([])
    const changed = buildOrderCopyDraft(overridden, [product({ priceCents: 900 })], PLENTY)
    expect(changed.lines[0]?.previousUnitPriceCents).toBe(1000)
    expect(changed.warnings.map(w => w.code)).toEqual([OrderCopyWarnings.PRICE_CHANGED])
  })

  it('uses the price of the variant, or the one of its product when the variant has none', () => {
    const withVariant = source({
      items: [
        {
          productId: P1,
          variantId: V1,
          productName: 'Shirt',
          variantName: 'L',
          quantity: 1,
          unitPriceCents: 2000,
          originalUnitPriceCents: null
        }
      ]
    })
    const own = buildOrderCopyDraft(
      withVariant,
      [product({ priceCents: 1500, variants: [{ id: V1, active: true, priceCents: 2000 }] })],
      PLENTY
    )
    expect(own.warnings).toEqual([])
    expect(own.draft.items).toEqual([{ productId: P1, variantId: V1, quantity: 1 }])
    const inherited = buildOrderCopyDraft(
      withVariant,
      [product({ priceCents: 2000, variants: [{ id: V1, active: true, priceCents: null }] })],
      PLENTY
    )
    expect(inherited.lines[0]?.unitPriceCents).toBe(2000)
    expect(inherited.warnings).toEqual([])
  })

  it('warns, and keeps the line, when the product is switched off or gone', () => {
    const off = buildOrderCopyDraft(source(), [product({ active: false })], PLENTY)
    expect(off.warnings.map(w => w.code)).toEqual([OrderCopyWarnings.PRODUCT_INACTIVE])
    expect(off.lines[0]?.unitPriceCents).toBeNull()
    expect(off.draft.items).toHaveLength(1)
    const gone = buildOrderCopyDraft(source(), [], PLENTY)
    expect(gone.warnings.map(w => w.code)).toEqual([OrderCopyWarnings.PRODUCT_INACTIVE])
  })

  it('warns when the variant is switched off or gone, and when the product now needs one', () => {
    const withVariant = source({
      items: [
        {
          productId: P1,
          variantId: V1,
          productName: 'Shirt',
          variantName: 'L',
          quantity: 1,
          unitPriceCents: 1000,
          originalUnitPriceCents: null
        }
      ]
    })
    const off = buildOrderCopyDraft(
      withVariant,
      [product({ variants: [{ id: V1, active: false, priceCents: null }] })],
      PLENTY
    )
    expect(off.warnings.map(w => w.code)).toEqual([OrderCopyWarnings.VARIANT_UNAVAILABLE])
    const gone = buildOrderCopyDraft(withVariant, [product()], PLENTY)
    expect(gone.warnings.map(w => w.code)).toEqual([OrderCopyWarnings.VARIANT_UNAVAILABLE])
    const needsOne = buildOrderCopyDraft(
      source(),
      [product({ variants: [{ id: V1, active: true, priceCents: null }] })],
      PLENTY
    )
    expect(needsOne.warnings.map(w => w.code)).toEqual([OrderCopyWarnings.VARIANT_REQUIRED])
  })

  it('warns about stock only for a product that tracks it, and not when the store allows negative stock', () => {
    const tracked = product({ trackInventory: true })
    const short = stockOf({ [copyStockKey(P1, null, W1)]: 1 })
    expect(buildOrderCopyDraft(source(), [tracked], short).warnings.map(w => w.code)).toEqual([
      OrderCopyWarnings.OUT_OF_STOCK
    ])
    // No level at all is no stock
    expect(buildOrderCopyDraft(source(), [tracked], PLENTY).warnings.map(w => w.code)).toEqual([
      OrderCopyWarnings.OUT_OF_STOCK
    ])
    const enough = stockOf({ [copyStockKey(P1, null, W1)]: 2 })
    expect(buildOrderCopyDraft(source(), [tracked], enough).warnings).toEqual([])
    expect(
      buildOrderCopyDraft(source(), [tracked], { ...short, allowNegativeStock: true }).warnings
    ).toEqual([])
    expect(buildOrderCopyDraft(source(), [product()], short).warnings).toEqual([])
  })

  it('warns exactly when the reservation would refuse: one warehouse must hold the line unless the store splits', () => {
    const tracked = product({ trackInventory: true })
    const halves = stockOf({
      [copyStockKey(P1, null, W1)]: 1,
      [copyStockKey(P1, null, W2)]: 1
    })
    // 1 + 1 is the 2 units asked for, but no warehouse has both
    expect(buildOrderCopyDraft(source(), [tracked], halves).warnings.map(w => w.code)).toEqual([
      OrderCopyWarnings.OUT_OF_STOCK
    ])
    expect(
      buildOrderCopyDraft(source(), [tracked], { ...halves, allowSplitFulfillment: true }).warnings
    ).toEqual([])
    // A negative level is not stock to lend to the other warehouse's count
    const negative = stockOf({
      [copyStockKey(P1, null, W1)]: -5,
      [copyStockKey(P1, null, W2)]: 1
    })
    expect(
      buildOrderCopyDraft(source(), [tracked], {
        ...negative,
        allowSplitFulfillment: true
      }).warnings.map(w => w.code)
    ).toEqual([OrderCopyWarnings.OUT_OF_STOCK])
    // A store that sells from no warehouse has nowhere to take the units from, whatever its setting
    expect(
      buildOrderCopyDraft(source(), [tracked], {
        ...PLENTY,
        warehouseIds: [],
        allowNegativeStock: true
      }).warnings.map(w => w.code)
    ).toEqual([OrderCopyWarnings.OUT_OF_STOCK])
  })

  it('reads the level of the variant of the line, not the one of its product', () => {
    const withVariant = source({
      items: [
        {
          productId: P1,
          variantId: V1,
          productName: 'Shirt',
          variantName: 'L',
          quantity: 1,
          unitPriceCents: 1000,
          originalUnitPriceCents: null
        }
      ]
    })
    const catalog = [
      product({ trackInventory: true, variants: [{ id: V1, active: true, priceCents: null }] })
    ]
    const onlyTheProduct = stockOf({ [copyStockKey(P1, null, W1)]: 9 })
    expect(
      buildOrderCopyDraft(withVariant, catalog, onlyTheProduct).warnings.map(w => w.code)
    ).toEqual([OrderCopyWarnings.OUT_OF_STOCK])
    const ofTheVariant = stockOf({ [copyStockKey(P1, V1, W1)]: 1 })
    expect(buildOrderCopyDraft(withVariant, catalog, ofTheVariant).warnings).toEqual([])
  })

  it('points each warning at its line', () => {
    const two = source({
      items: [
        ...source().items,
        {
          productId: P2,
          variantId: null,
          productName: 'Cup',
          variantName: null,
          quantity: 1,
          unitPriceCents: 300,
          originalUnitPriceCents: null
        }
      ]
    })
    const { warnings } = buildOrderCopyDraft(
      two,
      [product(), product({ id: P2, active: false })],
      PLENTY
    )
    expect(warnings).toEqual([
      { code: OrderCopyWarnings.PRODUCT_INACTIVE, itemIndex: 1, productId: P2, variantId: null }
    ])
  })

  it('leaves out an address that does not parse and the notes that are empty', () => {
    const { draft } = buildOrderCopyDraft(
      source({
        shippingAddress: { nonsense: true },
        customerNotes: null,
        internalNotes: null,
        packingNotes: 'fragile'
      }),
      [product()],
      PLENTY
    )
    expect(draft).not.toHaveProperty('shippingAddress')
    expect(draft).not.toHaveProperty('customerNotes')
    expect(draft).not.toHaveProperty('internalNotes')
    expect(draft.packingNotes).toBe('fragile')
    expect(
      buildOrderCopyDraft(source({ shippingAddress: null }), [product()], PLENTY).draft
    ).not.toHaveProperty('shippingAddress')
  })
})
