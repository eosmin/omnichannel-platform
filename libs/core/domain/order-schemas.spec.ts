import { ORDER_MAX_AMOUNT_CENTS, OrderLimits, RecipientPhones } from './order-constants'
import {
  changeOrderStatusSchema,
  createOrderSchema,
  orderFieldsOfEdit,
  orderScheduleFiltersAreConsistent,
  orderScheduleFilterShape,
  recipientPhonesSchema,
  recordOrderPaymentSchema,
  updateOrderSchema
} from './order-schemas'
import { OrderConfirmationChannel, OrderStatus, PaymentMethod, PaymentStatus } from './status-enums'

const ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const ID2 = '1c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e'

const valid = {
  customerId: ID,
  items: [{ productId: ID, quantity: 2 }],
  paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
  recipientPhones: ['7123 4567']
}

describe('the price of a line', () => {
  it('is the catalog price unless a price and its reason are named', () => {
    const parsed = createOrderSchema.parse({
      ...valid,
      items: [{ productId: ID, quantity: 1, unitPriceCents: 900, priceReason: '  loyal customer ' }]
    })
    expect(parsed.items[0]).toEqual({
      productId: ID,
      quantity: 1,
      unitPriceCents: 900,
      priceReason: 'loyal customer'
    })
  })

  it('refuses a fraction of a cent, a negative price and one over the ceiling', () => {
    for (const unitPriceCents of [0.5, -1, ORDER_MAX_AMOUNT_CENTS + 1]) {
      expect(
        createOrderSchema.safeParse({
          ...valid,
          items: [{ productId: ID, quantity: 1, unitPriceCents }]
        }).success
      ).toBe(false)
    }
  })

  it('still refuses any other price field a client invents', () => {
    expect(
      createOrderSchema.safeParse({
        ...valid,
        items: [{ productId: ID, quantity: 1, totalCents: 1 }]
      }).success
    ).toBe(false)
  })
})

describe('recipientPhonesSchema', () => {
  it('keeps the digits: spaces, plus signs and dashes are stripped', () => {
    expect(recipientPhonesSchema.parse(['7123-4567', '+(503) 22 12 34 56'])).toEqual([
      '71234567',
      '50322123456'
    ])
  })

  it('needs at least one phone and takes no more than the maximum', () => {
    expect(recipientPhonesSchema.safeParse([]).success).toBe(false)
    const many = Array.from({ length: RecipientPhones.MAX_COUNT + 1 }, (_, i) => `7000000${i}`)
    expect(recipientPhonesSchema.safeParse(many).success).toBe(false)
    expect(recipientPhonesSchema.safeParse(many.slice(0, RecipientPhones.MAX_COUNT)).success).toBe(
      true
    )
  })

  it('refuses a phone with no digits or with more than 15', () => {
    expect(recipientPhonesSchema.safeParse(['abc']).success).toBe(false)
    expect(recipientPhonesSchema.safeParse(['']).success).toBe(false)
    // Too short to be a phone, however it is typed
    expect(recipientPhonesSchema.safeParse(['12345']).success).toBe(false)
    expect(recipientPhonesSchema.safeParse(['123456']).success).toBe(true)
    expect(recipientPhonesSchema.safeParse(['1'.repeat(16)]).success).toBe(false)
    expect(recipientPhonesSchema.safeParse(['1'.repeat(15)]).success).toBe(true)
  })

  it('refuses text in the number instead of merging it: an extension is not part of the phone', () => {
    expect(recipientPhonesSchema.safeParse(['555-1234 ext 12']).success).toBe(false)
    expect(recipientPhonesSchema.safeParse(['7123 4567 x2']).success).toBe(false)
    expect(recipientPhonesSchema.safeParse(['+503 (7123) 4567.']).success).toBe(true)
  })

  it('refuses a plus inside the digits, and strips the one that opens the number', () => {
    expect(recipientPhonesSchema.safeParse(['123+456789']).success).toBe(false)
    expect(recipientPhonesSchema.parse(['+7123 4567'])).toEqual(['71234567'])
  })

  it('refuses a repeated number even when it is typed differently', () => {
    expect(recipientPhonesSchema.safeParse(['7123 4567', '7123-4567']).success).toBe(false)
  })
})

describe('createOrderSchema', () => {
  it('takes a minimal order and fills the defaults', () => {
    expect(createOrderSchema.parse(valid)).toEqual({
      ...valid,
      recipientPhones: ['71234567'],
      shippingCents: 0,
      discountCents: 0,
      scheduledDeliveryDate: null,
      confirmOnCreate: false,
      sendConfirmationMessage: true
    })
  })

  it('refuses any price, total or status that comes from the client', () => {
    for (const forged of [
      { unitPriceCents: 1 },
      { totalCents: 1 },
      { subtotalCents: 1 },
      { status: OrderStatus.CONFIRMED },
      { storeId: ID },
      { priceApprovalStatus: 'approved' },
      { freeShipping: true }
    ]) {
      expect(createOrderSchema.safeParse({ ...valid, ...forged }).success).toBe(false)
    }
    // A line may carry the override of ORDERS_OVERRIDE_PRICE: the schema cannot know who asks, so the service refuses it
    // from anybody else (tests/api/orders.spec.ts)
    expect(
      createOrderSchema.safeParse({
        ...valid,
        items: [{ productId: ID, quantity: 1, totalCents: 1 }]
      }).success
    ).toBe(false)
  })

  it('needs a line, a quantity of at least one and no more lines than the limit', () => {
    expect(createOrderSchema.safeParse({ ...valid, items: [] }).success).toBe(false)
    expect(
      createOrderSchema.safeParse({ ...valid, items: [{ productId: ID, quantity: 0 }] }).success
    ).toBe(false)
    expect(
      createOrderSchema.safeParse({
        ...valid,
        items: [{ productId: ID, quantity: OrderLimits.MAX_QUANTITY_PER_LINE + 1 }]
      }).success
    ).toBe(false)
    const lines = Array.from({ length: OrderLimits.MAX_LINES + 1 }, (_, i) => ({
      productId: ID,
      variantId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      quantity: 1
    }))
    expect(createOrderSchema.safeParse({ ...valid, items: lines }).success).toBe(false)
    expect(
      createOrderSchema.safeParse({ ...valid, items: lines.slice(0, OrderLimits.MAX_LINES) })
        .success
    ).toBe(true)
  })

  it('refuses the same product and variant twice, and takes the same product with two variants', () => {
    expect(
      createOrderSchema.safeParse({
        ...valid,
        items: [
          { productId: ID, quantity: 1 },
          { productId: ID, quantity: 1 }
        ]
      }).success
    ).toBe(false)
    expect(
      createOrderSchema.safeParse({
        ...valid,
        items: [
          { productId: ID, variantId: ID2, quantity: 1 },
          { productId: ID, variantId: ID, quantity: 1 }
        ]
      }).success
    ).toBe(true)
  })

  it('sees the same product twice even when its id is written in two cases', () => {
    expect(
      createOrderSchema.safeParse({
        ...valid,
        items: [
          { productId: ID, quantity: 1 },
          { productId: ID.toUpperCase(), quantity: 1 }
        ]
      }).success
    ).toBe(false)
  })

  it('keeps the shipping fee and the discount to whole cents inside the column', () => {
    for (const bad of [-1, 1.5, ORDER_MAX_AMOUNT_CENTS + 1, Number.NaN]) {
      expect(createOrderSchema.safeParse({ ...valid, shippingCents: bad }).success).toBe(false)
      expect(createOrderSchema.safeParse({ ...valid, discountCents: bad }).success).toBe(false)
    }
    expect(
      createOrderSchema.safeParse({ ...valid, discountCents: ORDER_MAX_AMOUNT_CENTS }).success
    ).toBe(true)
  })

  it('takes a payment method of the enum only', () => {
    expect(createOrderSchema.safeParse({ ...valid, paymentMethod: 'BITCOIN' }).success).toBe(false)
    expect(
      createOrderSchema.safeParse({ ...valid, paymentMethod: PaymentMethod.TRANSFER }).success
    ).toBe(true)
  })

  it('takes an address, with the country in capitals and El Salvador by default', () => {
    const parsed = createOrderSchema.parse({
      ...valid,
      shippingAddress: { line1: 'Col. Escalon', city: 'San Salvador' }
    })
    expect(parsed.shippingAddress?.country).toBe('SV')
    expect(
      createOrderSchema.parse({
        ...valid,
        shippingAddress: { line1: 'x', city: 'y', country: 'mx' }
      }).shippingAddress?.country
    ).toBe('MX')
    expect(
      createOrderSchema.safeParse({ ...valid, shippingAddress: { line1: '', city: 'y' } }).success
    ).toBe(false)
    expect(
      createOrderSchema.safeParse({
        ...valid,
        shippingAddress: { line1: 'x', city: 'y', country: 'SLV' }
      }).success
    ).toBe(false)
    expect(
      createOrderSchema.safeParse({
        ...valid,
        shippingAddress: { line1: 'x', city: 'y', extra: 1 }
      }).success
    ).toBe(false)
  })

  it('takes the three notes, each with its own ceiling, and refuses a NUL character', () => {
    expect(
      createOrderSchema.safeParse({
        ...valid,
        customerNotes: 'a'.repeat(OrderLimits.CUSTOMER_NOTES_MAX_LENGTH),
        internalNotes: 'b'.repeat(OrderLimits.INTERNAL_NOTES_MAX_LENGTH),
        packingNotes: 'c'.repeat(OrderLimits.PACKING_NOTES_MAX_LENGTH)
      }).success
    ).toBe(true)
    for (const key of ['customerNotes', 'internalNotes', 'packingNotes'] as const) {
      expect(createOrderSchema.safeParse({ ...valid, [key]: 'a'.repeat(1001) }).success).toBe(false)
      expect(createOrderSchema.safeParse({ ...valid, [key]: 'a\0b' }).success).toBe(false)
    }
    expect(createOrderSchema.parse({ ...valid, packingNotes: '  wrap it  ' }).packingNotes).toBe(
      'wrap it'
    )
  })

  it('reads a blank note or reason as none', () => {
    const parsed = createOrderSchema.parse({
      ...valid,
      customerNotes: '   ',
      internalNotes: '',
      packingNotes: ' ',
      discountReason: ' '
    })
    expect(parsed.customerNotes).toBeNull()
    expect(parsed.internalNotes).toBeNull()
    expect(parsed.packingNotes).toBeNull()
    expect(parsed.discountReason).toBeNull()
    expect(updateOrderSchema.parse({ packingNotes: '  ' }).packingNotes).toBeNull()
  })

  it('takes a scheduled day as a calendar date, a past one included, or none', () => {
    expect(
      createOrderSchema.parse({ ...valid, scheduledDeliveryDate: '2020-01-31' })
        .scheduledDeliveryDate
    ).toBe('2020-01-31')
    expect(
      createOrderSchema.parse({ ...valid, scheduledDeliveryDate: null }).scheduledDeliveryDate
    ).toBeNull()
    for (const bad of ['2026-02-30', '2026-11-10T00:00:00Z', '10/11/2026', 'tomorrow']) {
      expect(createOrderSchema.safeParse({ ...valid, scheduledDeliveryDate: bad }).success).toBe(
        false
      )
    }
  })

  it('takes the reason of a discount', () => {
    expect(createOrderSchema.parse({ ...valid, discountReason: ' promo ' }).discountReason).toBe(
      'promo'
    )
    expect(
      createOrderSchema.safeParse({
        ...valid,
        discountReason: 'a'.repeat(OrderLimits.PRICE_REASON_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
  })
})

describe('updateOrderSchema', () => {
  it('refuses an edit that changes nothing, and a field it does not know', () => {
    expect(updateOrderSchema.safeParse({}).success).toBe(false)
    expect(updateOrderSchema.safeParse({ customerNotes: 'x', totalCents: 1 }).success).toBe(false)
    expect(updateOrderSchema.safeParse({ unitPriceCents: 1 }).success).toBe(false)
  })

  it('clears a note, the address, the day and the tracking number with null', () => {
    const parsed = updateOrderSchema.parse({
      customerNotes: null,
      internalNotes: null,
      packingNotes: null,
      shippingAddress: null,
      scheduledDeliveryDate: null,
      trackingNumber: null
    })
    expect(parsed.packingNotes).toBeNull()
    expect(parsed.trackingNumber).toBeNull()
  })

  it('takes a reason only with a price', () => {
    expect(updateOrderSchema.safeParse({ discountReason: 'promo' }).success).toBe(false)
    expect(
      updateOrderSchema.safeParse({ discountReason: 'promo', discountCents: 10 }).success
    ).toBe(true)
    expect(
      updateOrderSchema.safeParse({ discountReason: 'route', shippingCents: 10 }).success
    ).toBe(true)
    expect(
      updateOrderSchema.safeParse({
        discountReason: 'repriced',
        items: [{ productId: ID, quantity: 1 }]
      }).success
    ).toBe(true)
    expect(updateOrderSchema.safeParse({ discountReason: null, discountCents: 0 }).success).toBe(
      true
    )
    // A discount cannot lose its reason in the same edit
    expect(updateOrderSchema.safeParse({ discountReason: null, discountCents: 300 }).success).toBe(
      false
    )
    // A blank reason is no reason
    expect(updateOrderSchema.safeParse({ discountReason: '  ', discountCents: 300 }).success).toBe(
      false
    )
    expect(updateOrderSchema.safeParse({ discountReason: null, shippingCents: 300 }).success).toBe(
      true
    )
  })

  it('takes the same rules for phones, lines and amounts as the creation', () => {
    expect(updateOrderSchema.safeParse({ recipientPhones: [] }).success).toBe(false)
    expect(updateOrderSchema.safeParse({ items: [] }).success).toBe(false)
    expect(updateOrderSchema.safeParse({ shippingCents: -1 }).success).toBe(false)
    expect(updateOrderSchema.safeParse({ trackingNumber: '' }).success).toBe(false)
  })

  it('names the editable fields an edit touches', () => {
    expect(
      orderFieldsOfEdit(
        updateOrderSchema.parse({
          items: [{ productId: ID, quantity: 1 }],
          shippingCents: 1,
          discountCents: 1,
          discountReason: 'x',
          shippingAddress: null,
          recipientPhones: ['7123 4567'],
          scheduledDeliveryDate: null,
          paymentMethod: PaymentMethod.CARD,
          customerNotes: null,
          internalNotes: null,
          packingNotes: null,
          trackingNumber: '123'
        })
      )
    ).toEqual([
      'items',
      'shipping',
      'discount',
      'address',
      'recipientPhones',
      'scheduledDeliveryDate',
      'paymentMethod',
      'customerNotes',
      'internalNotes',
      'packingNotes',
      'trackingNumber'
    ])
    expect(orderFieldsOfEdit(updateOrderSchema.parse({ packingNotes: 'x' }))).toEqual([
      'packingNotes'
    ])
    expect(orderFieldsOfEdit(updateOrderSchema.parse({ customerNotes: 'x' }))).toEqual([
      'customerNotes'
    ])
  })
})

describe('changeOrderStatusSchema', () => {
  it('needs a reason to cancel, and a blank one is none', () => {
    expect(changeOrderStatusSchema.safeParse({ status: OrderStatus.CANCELLED }).success).toBe(false)
    expect(
      changeOrderStatusSchema.safeParse({ status: OrderStatus.CANCELLED, cancellationReason: '  ' })
        .success
    ).toBe(false)
    expect(
      changeOrderStatusSchema.safeParse({
        status: OrderStatus.CANCELLED,
        cancellationReason: 'orders.cancellationReason.duplicate'
      }).success
    ).toBe(true)
  })

  it('takes a reason only to cancel', () => {
    expect(
      changeOrderStatusSchema.safeParse({ status: OrderStatus.CONFIRMED, cancellationReason: 'x' })
        .success
    ).toBe(false)
  })

  it('takes the proof and the moment of delivery only to deliver', () => {
    expect(
      changeOrderStatusSchema.safeParse({
        status: OrderStatus.DELIVERED,
        proofOfDeliveryMediaId: ID,
        deliveredAt: '2026-11-10T18:00:00-06:00'
      }).success
    ).toBe(true)
    expect(
      changeOrderStatusSchema.safeParse({ status: OrderStatus.SHIPPED, proofOfDeliveryMediaId: ID })
        .success
    ).toBe(false)
    expect(
      changeOrderStatusSchema.safeParse({
        status: OrderStatus.SHIPPED,
        deliveredAt: '2026-11-10T18:00:00Z'
      }).success
    ).toBe(false)
    expect(
      changeOrderStatusSchema.safeParse({ status: OrderStatus.DELIVERED, deliveredAt: 'yesterday' })
        .success
    ).toBe(false)
  })

  it('takes the restock choice only to return', () => {
    expect(
      changeOrderStatusSchema.safeParse({ status: OrderStatus.RETURNED, restock: true }).success
    ).toBe(true)
    expect(
      changeOrderStatusSchema.safeParse({ status: OrderStatus.DELIVERED, restock: true }).success
    ).toBe(false)
  })

  it('takes how the customer confirmed only to confirm, and never the moment of creation', () => {
    expect(
      changeOrderStatusSchema.safeParse({
        status: OrderStatus.CONFIRMED,
        confirmedVia: OrderConfirmationChannel.CALL
      }).success
    ).toBe(true)
    expect(
      changeOrderStatusSchema.safeParse({
        status: OrderStatus.PREPARING,
        confirmedVia: OrderConfirmationChannel.CALL
      }).success
    ).toBe(false)
    expect(
      changeOrderStatusSchema.safeParse({
        status: OrderStatus.CONFIRMED,
        confirmedVia: OrderConfirmationChannel.AT_CREATION
      }).success
    ).toBe(false)
  })

  it('takes a plain status change and refuses a status that does not exist', () => {
    expect(changeOrderStatusSchema.safeParse({ status: OrderStatus.PREPARING }).success).toBe(true)
    expect(changeOrderStatusSchema.safeParse({ status: 'LOST' }).success).toBe(false)
  })
})

describe('recordOrderPaymentSchema', () => {
  it('takes the method, the status, a reference and a receipt', () => {
    expect(
      recordOrderPaymentSchema.parse({
        method: PaymentMethod.TRANSFER,
        status: PaymentStatus.COMPLETED,
        reference: ' 00123 ',
        proofMediaId: ID
      })
    ).toEqual({
      method: PaymentMethod.TRANSFER,
      status: PaymentStatus.COMPLETED,
      reference: '00123',
      proofMediaId: ID
    })
    expect(
      recordOrderPaymentSchema.safeParse({
        method: PaymentMethod.CASH,
        status: PaymentStatus.PENDING
      }).success
    ).toBe(true)
  })

  it('refuses an unknown method or status, a blank reference, a long one and any other field', () => {
    const base = { method: PaymentMethod.CARD, status: PaymentStatus.COMPLETED }
    expect(recordOrderPaymentSchema.safeParse({ ...base, method: 'BITCOIN' }).success).toBe(false)
    expect(recordOrderPaymentSchema.safeParse({ ...base, status: 'PAID' }).success).toBe(false)
    expect(recordOrderPaymentSchema.safeParse({ ...base, reference: '  ' }).success).toBe(false)
    expect(
      recordOrderPaymentSchema.safeParse({
        ...base,
        reference: 'x'.repeat(OrderLimits.PAYMENT_REFERENCE_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(recordOrderPaymentSchema.safeParse({ ...base, amountCents: 1 }).success).toBe(false)
    expect(
      recordOrderPaymentSchema.safeParse({ ...base, proofMediaId: 'not-a-uuid' }).success
    ).toBe(false)
  })
})

describe('the scheduled delivery filters', () => {
  it('names the three keys and the sort of the list', () => {
    expect(Object.keys(orderScheduleFilterShape)).toEqual([
      'scheduledDeliveryFrom',
      'scheduledDeliveryTo',
      'scheduledDeliveryOn',
      'sort'
    ])
  })

  it('accepts days, a shortcut and the sort by delivery day, and refuses anything else', () => {
    const { scheduledDeliveryOn, scheduledDeliveryFrom, sort } = orderScheduleFilterShape
    expect(scheduledDeliveryOn.safeParse('today').success).toBe(true)
    expect(scheduledDeliveryOn.safeParse('tomorrow').success).toBe(true)
    expect(scheduledDeliveryOn.safeParse('yesterday').success).toBe(false)
    expect(scheduledDeliveryFrom.safeParse('2026-11-10').success).toBe(true)
    expect(scheduledDeliveryFrom.safeParse('2026-13-10').success).toBe(false)
    expect(sort.safeParse('scheduled_delivery').success).toBe(true)
    expect(sort.safeParse('price').success).toBe(false)
  })

  it('keeps from before to, inclusive, and a shortcut apart from days', () => {
    expect(orderScheduleFiltersAreConsistent({})).toBe(true)
    expect(orderScheduleFiltersAreConsistent({ scheduledDeliveryFrom: '2026-11-10' })).toBe(true)
    expect(orderScheduleFiltersAreConsistent({ scheduledDeliveryTo: '2026-11-10' })).toBe(true)
    expect(
      orderScheduleFiltersAreConsistent({
        scheduledDeliveryFrom: '2026-11-10',
        scheduledDeliveryTo: '2026-11-10'
      })
    ).toBe(true)
    expect(
      orderScheduleFiltersAreConsistent({
        scheduledDeliveryFrom: '2026-11-11',
        scheduledDeliveryTo: '2026-11-10'
      })
    ).toBe(false)
    expect(orderScheduleFiltersAreConsistent({ scheduledDeliveryOn: 'today' })).toBe(true)
    expect(
      orderScheduleFiltersAreConsistent({
        scheduledDeliveryOn: 'today',
        scheduledDeliveryFrom: '2026-11-10'
      })
    ).toBe(false)
    expect(
      orderScheduleFiltersAreConsistent({
        scheduledDeliveryOn: 'today',
        scheduledDeliveryTo: '2026-11-10'
      })
    ).toBe(false)
  })
})
