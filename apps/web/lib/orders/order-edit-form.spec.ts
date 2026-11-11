import type { OrderDetailView } from '@platform/api-client'

import {
  buildUpdate,
  draftFromOrder,
  editablePartsOf,
  type EditableParts,
  isReasonLocked,
  releasedOf,
  restoreRemovedLines
} from './order-edit-form'
import type { StockRules } from './order-form'
import { shownPriceCents, withReleased } from './order-form'

const item = (
  over: Partial<OrderDetailView['items'][number]> = {}
): OrderDetailView['items'][number] => ({
  id: 'i1',
  productId: 'p1',
  variantId: null,
  productName: 'Shirt',
  variantName: null,
  quantity: 2,
  unitPriceCents: 1000,
  originalUnitPriceCents: null,
  priceOverrideReason: null,
  priceOverriddenBy: null,
  freeShipping: false,
  allocations: [{ warehouseId: 'wa', quantity: 2 }],
  ...over
})

const order = (over: Partial<OrderDetailView> = {}): OrderDetailView =>
  ({
    shippingCents: 500,
    discountCents: 0,
    discountReason: null,
    items: [item()],
    ...over
  }) as OrderDetailView

const all: EditableParts = { items: true, shipping: true, discount: true }
const none = new Map<string, StockRules>()
const plain = { canOverridePrice: false }
const override = { canOverridePrice: true }

describe('draftFromOrder', () => {
  it('shows the price each line was sold at and the catalog price it had before an override', () => {
    const draft = draftFromOrder(
      order({
        items: [
          item({ unitPriceCents: 800, originalUnitPriceCents: 1000, priceOverrideReason: 'sample' })
        ]
      })
    )
    expect(draft.lines[0]).toMatchObject({
      catalogPriceCents: 1000,
      priceText: '8.00',
      priceReason: 'sample',
      quantity: '2',
      allocations: null
    })
    expect(draft.shippingText).toBe('5.00')
  })
})

describe('buildUpdate', () => {
  it('says nothing changed when nothing did, and sends nothing', () => {
    expect(buildUpdate(draftFromOrder(order()), order(), all, plain, none)).toEqual({
      ok: false,
      field: 'nothing'
    })
  })

  it('sends the items when a quantity changes, with no price, and the other fields not at all', () => {
    const draft = draftFromOrder(order())
    const first = draft.lines[0]
    if (first === undefined) throw new Error('no line')
    first.quantity = '3'
    const result = buildUpdate(draft, order(), all, plain, none)
    expect(result).toEqual({
      ok: true,
      value: { items: [{ productId: 'p1', quantity: 3 }] }
    })
  })

  it('sends the items when a line is removed or added', () => {
    const draft = draftFromOrder(order({ items: [item(), item({ id: 'i2', productId: 'p2' })] }))
    draft.lines.pop()
    const result = buildUpdate(
      draft,
      order({ items: [item(), item({ id: 'i2', productId: 'p2' })] }),
      all,
      plain,
      none
    )
    expect(result.ok && result.value.items).toEqual([{ productId: 'p1', quantity: 2 }])
  })

  it('refuses an order with no line left', () => {
    const draft = draftFromOrder(order())
    draft.lines = []
    expect(buildUpdate(draft, order(), all, plain, none)).toEqual({ ok: false, field: 'lines' })
  })

  it('sends a new price only for who may override it, with its reason, and asks for the reason', () => {
    const draft = draftFromOrder(order())
    const first = draft.lines[0]
    if (first === undefined) throw new Error('no line')
    first.priceText = '9'
    expect(buildUpdate(draft, order(), all, plain, none)).toEqual({ ok: false, field: 'nothing' })
    expect(buildUpdate(draft, order(), all, override, none)).toMatchObject({
      ok: false,
      field: 'priceReason'
    })
    first.priceReason = ' sale '
    expect(buildUpdate(draft, order(), all, override, none)).toEqual({
      ok: true,
      value: { items: [{ productId: 'p1', quantity: 2, unitPriceCents: 900, priceReason: 'sale' }] }
    })
  })

  it('takes a price back to the catalog without a reason', () => {
    const sold = order({
      items: [
        item({ unitPriceCents: 800, originalUnitPriceCents: 1000, priceOverrideReason: 'sample' })
      ]
    })
    const draft = draftFromOrder(sold)
    const first = draft.lines[0]
    if (first === undefined) throw new Error('no line')
    first.priceText = '10'
    first.priceReason = ''
    expect(buildUpdate(draft, sold, all, override, none)).toEqual({
      ok: true,
      value: { items: [{ productId: 'p1', quantity: 2, unitPriceCents: 1000 }] }
    })
  })

  it('changes the shipping fee and the discount with its reason, and drops the reason of a discount taken back', () => {
    const draft = draftFromOrder(order())
    draft.shippingText = '7.50'
    draft.discountText = '2'
    expect(buildUpdate(draft, order(), all, plain, none)).toMatchObject({ field: 'discountReason' })
    draft.discountReason = 'loyal'
    expect(buildUpdate(draft, order(), all, plain, none)).toEqual({
      ok: true,
      value: { shippingCents: 750, discountCents: 200, discountReason: 'loyal' }
    })
    const discounted = order({ discountCents: 200, discountReason: 'loyal' })
    const back = draftFromOrder(discounted)
    back.discountText = '0'
    expect(buildUpdate(back, discounted, all, plain, none)).toEqual({
      ok: true,
      value: { discountCents: 0, discountReason: null }
    })
  })

  it('leaves out what the status locks', () => {
    const draft = draftFromOrder(order())
    draft.shippingText = '9'
    draft.lines[0] = { ...(draft.lines[0] as (typeof draft.lines)[number]), quantity: '5' }
    expect(
      buildUpdate(draft, order(), { items: false, shipping: false, discount: false }, plain, none)
    ).toEqual({ ok: false, field: 'nothing' })
  })

  it('names a field that is not a number', () => {
    const draft = draftFromOrder(order())
    draft.shippingText = '1.234'
    expect(buildUpdate(draft, order(), all, plain, none)).toEqual({ ok: false, field: 'shipping' })
  })
})

describe('buildUpdate, the money rules', () => {
  const sold = order({
    items: [
      item({ unitPriceCents: 800, originalUnitPriceCents: 1000, priceOverrideReason: 'sample' })
    ]
  })

  it('sends no price for an overridden line the member only changes the units of, even if they may override', () => {
    const draft = draftFromOrder(sold)
    ;(draft.lines[0] as (typeof draft.lines)[number]).quantity = '4'
    expect(buildUpdate(draft, sold, all, override, none)).toEqual({
      ok: true,
      value: { items: [{ productId: 'p1', quantity: 4 }] }
    })
  })

  it('sends a new reason for an override that stays at the same price', () => {
    const draft = draftFromOrder(sold)
    ;(draft.lines[0] as (typeof draft.lines)[number]).priceReason = 'damaged box'
    expect(buildUpdate(draft, sold, all, override, none)).toEqual({
      ok: true,
      value: {
        items: [{ productId: 'p1', quantity: 2, unitPriceCents: 800, priceReason: 'damaged box' }]
      }
    })
  })

  it('sends a line that was added, at the catalog price, with no price of its own', () => {
    const draft = draftFromOrder(order())
    draft.lines.push({
      key: 'p2:',
      productId: 'p2',
      variantId: null,
      productName: 'Hat',
      variantName: null,
      sku: null,
      catalogPriceCents: 300,
      quantity: '1',
      priceText: null,
      priceReason: '',
      allocations: null
    })
    const result = buildUpdate(draft, order(), all, override, none)
    expect(result.ok && result.value.items).toEqual([
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 }
    ])
  })

  it('sends the warehouses the member chose only when they pass the stock rules', () => {
    const draft = draftFromOrder(order())
    const first = draft.lines[0] as (typeof draft.lines)[number]
    first.allocations = { wa: '1', wb: '1' }
    const rules: StockRules = {
      warehouses: [
        { warehouseId: 'wa', available: 5 },
        { warehouseId: 'wb', available: 5 }
      ],
      allowSplitFulfillment: true,
      allowNegativeStock: false
    }
    expect(buildUpdate(draft, order(), all, plain, new Map([[first.key, rules]]))).toEqual({
      ok: true,
      value: {
        items: [
          {
            productId: 'p1',
            quantity: 2,
            allocations: [
              { warehouseId: 'wa', quantity: 1 },
              { warehouseId: 'wb', quantity: 1 }
            ]
          }
        ]
      }
    })
    expect(buildUpdate(draft, order(), all, plain, none)).toMatchObject({
      ok: false,
      field: 'allocations'
    })
    expect(
      buildUpdate(
        draft,
        order(),
        all,
        plain,
        new Map([[first.key, { ...rules, allowSplitFulfillment: false }]])
      )
    ).toMatchObject({ ok: false, field: 'allocations' })
  })

  it('sends a changed reason of a discount that stays the same, and nothing when it did not change', () => {
    const discounted = order({ discountCents: 200, discountReason: 'loyal' })
    const draft = draftFromOrder(discounted)
    expect(buildUpdate(draft, discounted, all, plain, none)).toEqual({
      ok: false,
      field: 'nothing'
    })
    draft.discountReason = 'long-time customer'
    expect(buildUpdate(draft, discounted, all, plain, none)).toEqual({
      ok: true,
      value: { discountCents: 200, discountReason: 'long-time customer' }
    })
  })

  it('sends the reason typed for a new shipping fee even when the discount stays at 0, and does not erase it', () => {
    const draft = draftFromOrder(order())
    draft.shippingText = '9'
    draft.discountReason = 'far away'
    expect(buildUpdate(draft, order(), all, plain, none)).toEqual({
      ok: true,
      value: { shippingCents: 900, discountReason: 'far away' }
    })
    const discounted = order({ discountCents: 200, discountReason: 'loyal' })
    const back = draftFromOrder(discounted)
    back.discountText = '0'
    back.shippingText = '9'
    back.discountReason = 'far away'
    expect(buildUpdate(back, discounted, all, plain, none)).toEqual({
      ok: true,
      value: { shippingCents: 900, discountCents: 0, discountReason: 'far away' }
    })
  })

  it('takes the changes against the order the form was made from, not against a refreshed one', () => {
    const draft = draftFromOrder(order())
    ;(draft.lines[0] as (typeof draft.lines)[number]).quantity = '3'
    // somebody else changed the fee meanwhile: the form was made with 5.00 and sends none of it back
    const result = buildUpdate(draft, order(), all, plain, none)
    expect(result.ok && 'shippingCents' in result.value).toBe(false)
  })

  it('locks one field and leaves the others, per field', () => {
    const draft = draftFromOrder(order())
    draft.shippingText = '9'
    ;(draft.lines[0] as (typeof draft.lines)[number]).quantity = '5'
    expect(
      buildUpdate(draft, order(), { items: false, shipping: true, discount: false }, plain, none)
    ).toEqual({ ok: true, value: { shippingCents: 900 } })
  })
})

describe('editablePartsOf', () => {
  const canEdit = () => true
  it('offers items, shipping and discount where the status accepts them, none once the payment is completed', () => {
    const open = editablePartsOf(
      { status: 'PENDING_CONFIRMATION', paymentStatus: 'PENDING' },
      canEdit
    )
    expect(open).toEqual({ items: true, shipping: true, discount: true })
    expect(
      editablePartsOf({ status: 'PENDING_CONFIRMATION', paymentStatus: 'COMPLETED' }, canEdit)
    ).toEqual({
      items: false,
      shipping: false,
      discount: false
    })
  })

  it('offers nothing without the permission to edit, nor in a closed status', () => {
    expect(
      editablePartsOf({ status: 'PENDING_CONFIRMATION', paymentStatus: 'PENDING' }, () => false)
    ).toEqual({
      items: false,
      shipping: false,
      discount: false
    })
    expect(editablePartsOf({ status: 'DELIVERED', paymentStatus: 'PENDING' }, canEdit).items).toBe(
      false
    )
  })
})

describe('the lines of an existing order', () => {
  it('show the price they were sold at to a member who cannot change it, and the units they hold per warehouse', () => {
    const sold = order({
      items: [item({ unitPriceCents: 800, originalUnitPriceCents: 1000 })]
    })
    const line = draftFromOrder(sold).lines[0] as ReturnType<typeof draftFromOrder>['lines'][number]
    expect(shownPriceCents(line)).toBe(800)
    expect(releasedOf(sold).get(line.key)).toEqual([{ warehouseId: 'wa', quantity: 2 }])
  })
})

describe('the reason of a fee, the units an order holds and the lines put back', () => {
  it('does not leave the reason of a discount taken back behind, and sends a new one typed for the fee', () => {
    const discounted = order({ discountCents: 200, discountReason: 'loyal' })
    const draft = draftFromOrder(discounted)
    draft.discountText = '0'
    draft.shippingText = '9'
    // the reason box still holds the old reason
    expect(buildUpdate(draft, discounted, all, plain, none)).toEqual({
      ok: true,
      value: { shippingCents: 900, discountCents: 0, discountReason: null }
    })
  })

  it('takes the reason of a fee when the status locks the discount and the order has none, and not when it has one', () => {
    const locked: EditableParts = { items: false, shipping: true, discount: false }
    const draft = draftFromOrder(order())
    draft.shippingText = '9'
    draft.discountReason = 'far away'
    expect(isReasonLocked(order(), locked)).toBe(false)
    expect(buildUpdate(draft, order(), locked, plain, none)).toEqual({
      ok: true,
      value: { shippingCents: 900, discountReason: 'far away' }
    })
    const discounted = order({ discountCents: 200, discountReason: 'loyal' })
    expect(isReasonLocked(discounted, locked)).toBe(true)
    const other = draftFromOrder(discounted)
    other.shippingText = '9'
    other.discountReason = 'changed'
    expect(buildUpdate(other, discounted, locked, plain, none)).toEqual({
      ok: true,
      value: { shippingCents: 900 }
    })
  })

  it('counts the units the order holds as available again for its own edit', () => {
    const rules: StockRules = {
      warehouses: [
        { warehouseId: 'wa', available: 0 },
        { warehouseId: 'wb', available: 3 }
      ],
      allowSplitFulfillment: false,
      allowNegativeStock: false
    }
    expect(withReleased(rules, [{ warehouseId: 'wa', quantity: 5 }]).warehouses).toEqual([
      { warehouseId: 'wa', available: 5 },
      { warehouseId: 'wb', available: 3 }
    ])
    expect(withReleased(rules, [])).toEqual(rules)
  })

  it('puts a line taken out and added again back as the order had it', () => {
    const sold = order({ items: [item({ unitPriceCents: 800, originalUnitPriceCents: 1000 })] })
    const original = new Map(draftFromOrder(sold).lines.map(line => [line.key, line]))
    const fresh = {
      ...(draftFromOrder(sold).lines[0] as ReturnType<typeof draftFromOrder>['lines'][number]),
      priceText: null,
      soldPriceCents: null,
      quantity: '1'
    }
    const back = restoreRemovedLines([fresh], [], original)
    expect(back[0]).toMatchObject({ priceText: '8.00', soldPriceCents: 800, quantity: '2' })
    // a line that was never removed is left alone, and a new product stays as it is
    expect(restoreRemovedLines([fresh], [fresh], original)[0]).toBe(fresh)
    const hat = { ...fresh, key: 'p9:', productId: 'p9' }
    expect(restoreRemovedLines([hat], [], original)[0]).toBe(hat)
  })

  it('refuses the edit of a paid order whatever the status', () => {
    const can = () => true
    for (const status of ['PENDING_CONFIRMATION', 'CONFIRMED', 'PREPARING']) {
      expect(editablePartsOf({ status, paymentStatus: 'COMPLETED' }, can)).toEqual({
        items: false,
        shipping: false,
        discount: false
      })
    }
  })
})
