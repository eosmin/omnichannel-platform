import { PaymentMethod, RecipientPhones } from '@platform/core/domain'

import {
  addLine,
  allocationProblem,
  buildOrder,
  chosenAllocations,
  emptyForm,
  initialPhones,
  phoneDigits,
  plannedAllocations,
  stockRulesOf,
  type DraftForm,
  type DraftLine,
  type StockRules
} from './order-form'

const A = 'wh-a'
const B = 'wh-b'
const CUSTOMER = 'c1'

const line = (extra: Partial<DraftLine> = {}): DraftLine => ({
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
  ...extra
})

const form = (extra: Partial<DraftForm> = {}): DraftForm => ({
  ...emptyForm(),
  customerId: CUSTOMER,
  lines: [line()],
  phones: ['71234567'],
  ...extra
})

const rules: StockRules = {
  warehouses: [
    { warehouseId: A, available: 6 },
    { warehouseId: B, available: 8 }
  ],
  allowSplitFulfillment: true,
  allowNegativeStock: false
}
const allowed = { canOverridePrice: false, canConfirm: false }
const none = { stock: new Map<string, StockRules>() }

describe('buildOrder', () => {
  it('builds the body from the form and sends no total and no status', () => {
    const result = buildOrder(form(), allowed, none)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      customerId: CUSTOMER,
      items: [{ productId: 'p1', quantity: 2 }],
      shippingCents: 0,
      discountCents: 0,
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      recipientPhones: ['71234567'],
      scheduledDeliveryDate: null,
      confirmOnCreate: false
    })
    // the summary is left to the preference of the store unless the agent chose it
    expect(result.value).not.toHaveProperty('sendConfirmationMessage')
    expect(result.value).not.toHaveProperty('copiedFromOrderId')
    expect(Object.keys(result.value)).not.toEqual(
      expect.arrayContaining(['totalCents', 'subtotalCents', 'status'])
    )
  })

  it('sends what the agent chose for the summary and the order it was copied from', () => {
    const result = buildOrder(form(), allowed, {
      stock: new Map(),
      sendSummary: false,
      copiedFromOrderId: 'o9'
    })
    expect(result.ok && result.value).toMatchObject({
      sendConfirmationMessage: false,
      copiedFromOrderId: 'o9'
    })
  })

  it('sends a summary the agent asked for', () => {
    const result = buildOrder(form(), allowed, { stock: new Map(), sendSummary: true })
    expect(result.ok && result.value).toMatchObject({ sendConfirmationMessage: true })
  })

  it('names the first field that is wrong', () => {
    expect(buildOrder(form({ customerId: null }), allowed, none)).toEqual({
      ok: false,
      field: 'customer'
    })
    expect(buildOrder(form({ lines: [] }), allowed, none)).toEqual({ ok: false, field: 'lines' })
    expect(buildOrder(form({ lines: [line({ quantity: '0' })] }), allowed, none)).toMatchObject({
      field: 'quantity'
    })
    expect(buildOrder(form({ shippingText: '1.234' }), allowed, none)).toEqual({
      ok: false,
      field: 'shipping'
    })
    expect(buildOrder(form({ phones: [''] }), allowed, none)).toEqual({
      ok: false,
      field: 'phones'
    })
    expect(buildOrder(form({ phones: ['71234567', '7123-4567'] }), allowed, none)).toEqual({
      ok: false,
      field: 'phones'
    })
  })

  it('asks the reason of a discount and sends it only with one', () => {
    expect(buildOrder(form({ discountText: '5' }), allowed, none)).toEqual({
      ok: false,
      field: 'discountReason'
    })
    const result = buildOrder(form({ discountText: '5', discountReason: ' loyal ' }), allowed, none)
    expect(result.ok && result.value).toMatchObject({ discountCents: 500, discountReason: 'loyal' })
  })

  it('sends a price only from a member who may override it, only when it differs, and with its reason', () => {
    const typed = form({ lines: [line({ priceText: '8', priceReason: 'sample' })] })
    const without = buildOrder(typed, allowed, none)
    expect(without.ok && without.value.items[0]).not.toHaveProperty('unitPriceCents')
    const withOverride = buildOrder(typed, { ...allowed, canOverridePrice: true }, none)
    expect(withOverride.ok && withOverride.value.items[0]).toMatchObject({
      unitPriceCents: 800,
      priceReason: 'sample'
    })
    expect(
      buildOrder(
        form({ lines: [line({ priceText: '8', priceReason: ' ' })] }),
        { ...allowed, canOverridePrice: true },
        none
      )
    ).toMatchObject({ field: 'priceReason' })
    const same = buildOrder(
      form({ lines: [line({ priceText: '10.00' })] }),
      { ...allowed, canOverridePrice: true },
      none
    )
    expect(same.ok && same.value.items[0]).not.toHaveProperty('unitPriceCents')
  })

  it('sends confirmOnCreate only for who may confirm', () => {
    const asked = form({ confirmOnCreate: true })
    const refused = buildOrder(asked, allowed, none)
    expect(refused.ok && refused.value.confirmOnCreate).toBe(false)
    const taken = buildOrder(asked, { ...allowed, canConfirm: true }, none)
    expect(taken.ok && taken.value.confirmOnCreate).toBe(true)
  })

  it('keeps a scheduled day in the past and the three notes apart, blank ones left out', () => {
    const result = buildOrder(
      form({
        scheduledDate: '2020-01-02',
        customerNotes: ' for the customer ',
        internalNotes: '',
        packingNotes: 'wrap it twice'
      }),
      allowed,
      none
    )
    expect(result.ok && result.value).toMatchObject({
      scheduledDeliveryDate: '2020-01-02',
      customerNotes: 'for the customer',
      internalNotes: undefined,
      packingNotes: 'wrap it twice'
    })
  })

  it('sends the warehouses the agent chose when they pass the rules of the stock, and refuses them when they do not', () => {
    const chosen = line({ quantity: '5', allocations: { [A]: '3', [B]: '2' } })
    const stock = new Map([[chosen.key, rules]])
    const ok = buildOrder(form({ lines: [chosen] }), allowed, { stock })
    expect(ok.ok && ok.value.items[0]?.allocations).toEqual([
      { warehouseId: A, quantity: 3 },
      { warehouseId: B, quantity: 2 }
    ])
    const short = line({ quantity: '7', allocations: { [A]: '7' } })
    expect(
      buildOrder(form({ lines: [short] }), allowed, { stock: new Map([[short.key, rules]]) })
    ).toMatchObject({ field: 'allocations' })
    // a choice with no stock rules to check it against is not sent
    expect(buildOrder(form({ lines: [chosen] }), allowed, none)).toMatchObject({
      field: 'allocations'
    })
  })

  it('adds the conversation the order comes from', () => {
    const result = buildOrder(form(), allowed, { ...none, conversationId: 'conv-1' })
    expect(result.ok && result.value.conversationId).toBe('conv-1')
  })
})

describe('the lines', () => {
  const base: Omit<DraftLine, 'key'> = {
    productId: 'p1',
    variantId: 'v1',
    productName: 'Shirt',
    variantName: 'Red',
    sku: null,
    catalogPriceCents: 1000,
    quantity: '1',
    priceText: null,
    priceReason: '',
    allocations: null
  }

  it('adds the quantity of a product and variant that is already there, and drops a choice made for the old units', () => {
    const first = addLine([], { ...base, allocations: { [A]: '1' } })
    expect(first).toHaveLength(1)
    const again = addLine(
      first.map(row => ({ ...row, allocations: { [A]: '1' } })),
      base
    )
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ quantity: '2', allocations: null })
  })

  it('keeps two variants of a product as two lines', () => {
    const lines = addLine(addLine([], base), { ...base, variantId: 'v2' })
    expect(lines).toHaveLength(2)
  })
})

describe('the phones', () => {
  it('start with the national number of the customer, or empty when there is none', () => {
    expect(initialPhones('7123 4567')).toEqual(['71234567'])
    expect(initialPhones(null)).toEqual([''])
  })

  it('keep digits only', () => {
    expect(phoneDigits('+503 7123-4567')).toBe('50371234567')
    expect(RecipientPhones.MAX_COUNT).toBeGreaterThan(1)
  })
})

describe('the warehouses of a line', () => {
  it('plans by priority what the server would plan, null when nothing can serve it', () => {
    expect(plannedAllocations(5, rules)).toEqual([{ warehouseId: A, quantity: 5 }])
    expect(plannedAllocations(50, rules)).toBeNull()
  })

  it('reads the units typed per warehouse and ignores the empty ones', () => {
    expect(chosenAllocations(line({ allocations: { [A]: '2', [B]: '' } }))).toEqual([
      { warehouseId: A, quantity: 2 }
    ])
    expect(chosenAllocations(line())).toBeNull()
  })

  it('says why a choice cannot be served', () => {
    expect(allocationProblem(line({ quantity: '2', allocations: { [A]: '1' } }), rules)).toBe(
      'quantity_mismatch'
    )
    expect(allocationProblem(line({ quantity: '2', allocations: { [A]: '2' } }), rules)).toBeNull()
  })
})

describe('stockRulesOf', () => {
  const warehouses = [
    { id: B, active: true, stores: [{ storeId: 's1', priority: 2 }] },
    {
      id: A,
      active: true,
      stores: [
        { storeId: 's1', priority: 1 },
        { storeId: 's2', priority: 1 }
      ]
    },
    { id: 'off', active: false, stores: [{ storeId: 's1', priority: 3 }] },
    { id: 'foreign', active: true, stores: [{ storeId: 's2', priority: 1 }] }
  ]
  const levels = [
    { variantId: null, warehouseId: A, available: 4 },
    { variantId: 'v1', warehouseId: A, available: 9 },
    { variantId: null, warehouseId: B, available: -2 }
  ]

  it('lists the active warehouses of the store by priority with the stock of the item, 0 where there is no row', () => {
    expect(
      stockRulesOf({
        storeId: 's1',
        variantId: null,
        warehouses,
        levels,
        allowSplitFulfillment: true,
        allowNegativeStock: false
      })
    ).toEqual({
      warehouses: [
        { warehouseId: A, available: 4 },
        { warehouseId: B, available: -2 }
      ],
      allowSplitFulfillment: true,
      allowNegativeStock: false
    })
  })

  it('reads the level of the variant, not the one of the product', () => {
    const rules = stockRulesOf({
      storeId: 's1',
      variantId: 'v1',
      warehouses,
      levels,
      allowSplitFulfillment: false,
      allowNegativeStock: false
    })
    expect(rules.warehouses).toEqual([
      { warehouseId: A, available: 9 },
      { warehouseId: B, available: 0 }
    ])
  })
})
