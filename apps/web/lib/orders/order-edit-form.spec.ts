import type { OrderDetailView } from '@platform/api-client'

import { buildUpdate, draftFromOrder, type EditableParts } from './order-edit-form'
import type { StockRules } from './order-form'

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
