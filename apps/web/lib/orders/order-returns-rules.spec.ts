import {
  OrderReturnCondition,
  OrderReturnReasonKeys,
  OrderReturnStatus,
  OrderReturnType,
  OrderStatus,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'

import {
  approveBody,
  asReturnReasonKey,
  asReturnStatus,
  canStartReturn,
  completeBody,
  createReturnBody,
  EMPTY_RETURN_DRAFT,
  offeredReturnActions,
  receiveBody,
  remainingUnits,
  ReturnActions,
  unitsOf
} from './order-returns-rules'

const items = [
  { id: 'i1', quantity: 3 },
  { id: 'i2', quantity: 1 }
]
const returns = [
  { status: OrderReturnStatus.REQUESTED, lines: [{ orderItemId: 'i1', quantity: 2 }] },
  { status: OrderReturnStatus.REJECTED, lines: [{ orderItemId: 'i2', quantity: 1 }] }
]

describe('offeredReturnActions', () => {
  const offer = (
    status: OrderReturnStatus,
    extra: Partial<Parameters<typeof offeredReturnActions>[0]> = {}
  ): string[] =>
    offeredReturnActions({
      status,
      returnShipmentId: null,
      mayManage: true,
      canMakeReturnGuide: true,
      ...extra
    })

  it('offers nothing without returns:manage', () => {
    expect(offer(OrderReturnStatus.REQUESTED, { mayManage: false })).toEqual([])
  })

  it('follows the transitions of the api', () => {
    expect(offer(OrderReturnStatus.REQUESTED)).toEqual([
      ReturnActions.APPROVE,
      ReturnActions.REJECT,
      ReturnActions.CANCEL
    ])
    expect(offer(OrderReturnStatus.IN_TRANSIT)).toEqual([ReturnActions.RECEIVE])
    expect(offer(OrderReturnStatus.RECEIVED)).toEqual([ReturnActions.COMPLETE])
    expect(offer(OrderReturnStatus.COMPLETED)).toEqual([])
    expect(offer(OrderReturnStatus.REJECTED)).toEqual([])
  })

  it('offers the guide of the way back only to an approved return with none, when a connection can make it', () => {
    expect(offer(OrderReturnStatus.APPROVED)).toContain(ReturnActions.RETURN_GUIDE)
    expect(offer(OrderReturnStatus.APPROVED, { returnShipmentId: 's1' })).not.toContain(
      ReturnActions.RETURN_GUIDE
    )
    expect(offer(OrderReturnStatus.APPROVED, { canMakeReturnGuide: false })).not.toContain(
      ReturnActions.RETURN_GUIDE
    )
    expect(offer(OrderReturnStatus.IN_TRANSIT)).not.toContain(ReturnActions.RETURN_GUIDE)
  })
})

describe('known values', () => {
  it('names a status and a reason it knows, and nothing else', () => {
    expect(asReturnStatus('received')).toBe(OrderReturnStatus.RECEIVED)
    expect(asReturnStatus('mystery')).toBeNull()
    expect(asReturnReasonKey('DEFECTIVE')).toBe('DEFECTIVE')
    expect(asReturnReasonKey('defective')).toBeNull()
  })
})

describe('remainingUnits and canStartReturn', () => {
  it('leaves out what the returns that hold units take', () => {
    expect(remainingUnits(items, returns)).toEqual(
      new Map([
        ['i1', 1],
        ['i2', 1]
      ])
    )
  })

  it('starts on a delivered order with units left', () => {
    const base = { items, returns, outboundStatuses: [] as string[] }
    expect(canStartReturn({ ...base, orderStatus: OrderStatus.DELIVERED })).toBe(true)
    expect(canStartReturn({ ...base, orderStatus: OrderStatus.PENDING_CONFIRMATION })).toBe(false)
    expect(canStartReturn({ ...base, orderStatus: 'unknown' })).toBe(false)
  })

  it('starts on a shipped order only when its guide is coming back', () => {
    const base = { items, returns, orderStatus: OrderStatus.SHIPPED }
    expect(canStartReturn({ ...base, outboundStatuses: [ShipmentStatus.IN_TRANSIT] })).toBe(false)
    expect(canStartReturn({ ...base, outboundStatuses: [ShipmentStatus.RETURNING] })).toBe(true)
  })

  it('does not start when every unit is already in a return', () => {
    const all = [
      { status: OrderReturnStatus.APPROVED, lines: [{ orderItemId: 'i1', quantity: 3 }] }
    ]
    expect(
      canStartReturn({
        orderStatus: OrderStatus.DELIVERED,
        outboundStatuses: [],
        items: [items[0] as (typeof items)[number]],
        returns: all
      })
    ).toBe(false)
  })
})

describe('createReturnBody', () => {
  const left = remainingUnits(items, returns)
  const draft = {
    ...EMPTY_RETURN_DRAFT,
    reason: OrderReturnReasonKeys[0] as (typeof OrderReturnReasonKeys)[number],
    quantities: { i1: '1' }
  }

  it('builds the body from the units typed', () => {
    expect(createReturnBody('o1', draft, left)).toEqual({
      orderId: 'o1',
      type: OrderReturnType.REFUND,
      reason: OrderReturnReasonKeys[0],
      lines: [{ orderItemId: 'i1', quantity: 1 }]
    })
  })

  it('sends the payer and the notes only when they were chosen', () => {
    const body = createReturnBody(
      'o1',
      { ...draft, payer: ShippingPayer.SENDER, notes: ' box open ' },
      left
    )
    expect(body).toMatchObject({ shippingPayer: ShippingPayer.SENDER, notes: 'box open' })
  })

  it('refuses no reason, no units, and units past what is left', () => {
    expect(createReturnBody('o1', { ...draft, reason: '' }, left)).toBeNull()
    expect(createReturnBody('o1', { ...draft, quantities: {} }, left)).toBeNull()
    expect(createReturnBody('o1', { ...draft, quantities: { i1: '2' } }, left)).toBeNull()
    expect(createReturnBody('o1', { ...draft, quantities: { i1: '1.5' } }, left)).toBeNull()
  })

  it('reads an empty text as zero units', () => {
    expect(unitsOf('', 4)).toBe(0)
    expect(unitsOf(' 3 ', 4)).toBe(3)
    expect(unitsOf('5', 4)).toBeNull()
    expect(unitsOf('-1', 4)).toBeNull()
  })
})

describe('approveBody', () => {
  const order = {
    paymentMethod: 'cash_on_delivery',
    shippingAddress: { line1: 'Calle 1', city: 'San Salvador', country: 'SV' },
    recipientPhones: ['70001111']
  }
  const line = {
    key: 'k',
    productId: 'p1',
    variantId: null,
    productName: 'Shirt',
    variantName: null,
    quantity: '2'
  }

  it('approves a refund with nothing', () => {
    expect(approveBody(OrderReturnType.REFUND, { lines: [], shipping: '' }, order)).toEqual({})
  })

  it('makes the replacement of an exchange from the order and the picks', () => {
    const body = approveBody(OrderReturnType.EXCHANGE, { lines: [line], shipping: '2.50' }, order)
    expect(body?.replacement).toMatchObject({
      items: [{ productId: 'p1', quantity: 2 }],
      shippingCents: 250,
      paymentMethod: 'cash_on_delivery',
      recipientPhones: ['70001111'],
      shippingAddress: { line1: 'Calle 1', city: 'San Salvador' }
    })
  })

  it('refuses an exchange with no products, a bad quantity or a bad fee', () => {
    expect(approveBody(OrderReturnType.EXCHANGE, { lines: [], shipping: '' }, order)).toBeNull()
    expect(
      approveBody(
        OrderReturnType.EXCHANGE,
        { lines: [{ ...line, quantity: '0' }], shipping: '' },
        order
      )
    ).toBeNull()
    expect(
      approveBody(OrderReturnType.EXCHANGE, { lines: [line], shipping: '1.234' }, order)
    ).toBeNull()
  })
})

describe('receiveBody', () => {
  const lines = [{ orderItemId: 'i1' }, { orderItemId: 'i2' }]

  it('needs the condition of every line', () => {
    expect(
      receiveBody(lines, { i1: { condition: OrderReturnCondition.DAMAGED, warehouseId: '' } })
    ).toBeNull()
  })

  it('asks a warehouse only of a resellable line', () => {
    expect(
      receiveBody(lines, {
        i1: { condition: OrderReturnCondition.RESELLABLE, warehouseId: 'w1' },
        i2: { condition: OrderReturnCondition.DAMAGED, warehouseId: 'w1' }
      })
    ).toEqual({
      lines: [
        { orderItemId: 'i1', condition: OrderReturnCondition.RESELLABLE, restockWarehouseId: 'w1' },
        { orderItemId: 'i2', condition: OrderReturnCondition.DAMAGED }
      ]
    })
  })
})

describe('completeBody', () => {
  it('records the refund of a refund return and nothing for an exchange', () => {
    expect(completeBody(OrderReturnType.REFUND, '12.5', '')).toEqual({ refundAmountCents: 1250 })
    expect(completeBody(OrderReturnType.REFUND, '', ' ok ')).toEqual({ notes: 'ok' })
    expect(completeBody(OrderReturnType.EXCHANGE, '12.5', '')).toEqual({})
  })

  it('refuses an amount that is not money', () => {
    expect(completeBody(OrderReturnType.REFUND, 'abc', '')).toBeNull()
  })
})
