import { ErrorCodes } from './errors/error-codes'
import {
  applyExchangeCredit,
  canMoveReturn,
  checkReturnableOrder,
  checkReturnLines,
  coversEveryUnit,
  defaultRestockWarehouse,
  EXCHANGE_CREDIT_REASON_PREFIX,
  exchangeCreditCents,
  exchangeCreditReason,
  hasReceivedUnits,
  holdsUnits,
  movementsOfReceipt,
  refundRoom,
  returnMovementKey,
  unitsHeld
} from './return-rules'
import {
  InventoryAdjustmentReason,
  InventoryMovementType,
  OrderReturnCondition,
  OrderReturnStatus,
  OrderStatus,
  ShipmentStatus
} from './status-enums'

const items = [
  { id: 'a', quantity: 3 },
  { id: 'b', quantity: 1 }
]

describe('which orders can be returned', () => {
  it('takes a delivered order, and a shipped one only with a guide that is coming or came back', () => {
    expect(
      checkReturnableOrder({ orderStatus: OrderStatus.DELIVERED, outboundStatuses: [] })
    ).toEqual({ ok: true })
    for (const status of [ShipmentStatus.RETURNING, ShipmentStatus.RETURNED]) {
      expect(
        checkReturnableOrder({ orderStatus: OrderStatus.SHIPPED, outboundStatuses: [status] }).ok
      ).toBe(true)
    }
    // A shipped order is returnable from its guides: with none, or with none coming back, it is not; with one of several guides
    // coming back it is (the units are counted when they arrive, never before)
    expect(
      checkReturnableOrder({ orderStatus: OrderStatus.SHIPPED, outboundStatuses: [] }).ok
    ).toBe(false)
    expect(
      checkReturnableOrder({
        orderStatus: OrderStatus.SHIPPED,
        outboundStatuses: [ShipmentStatus.RETURNING, ShipmentStatus.IN_TRANSIT]
      }).ok
    ).toBe(true)
    for (const orderStatus of [
      OrderStatus.SHIPPED,
      OrderStatus.CONFIRMED,
      OrderStatus.CANCELLED,
      OrderStatus.RETURNED
    ]) {
      expect(
        checkReturnableOrder({ orderStatus, outboundStatuses: [ShipmentStatus.IN_TRANSIT] })
      ).toEqual({ ok: false, code: ErrorCodes.RETURN_ORDER_NOT_DELIVERED })
    }
  })
})

describe('the quantities of a return', () => {
  const held = unitsHeld([
    { status: OrderReturnStatus.APPROVED, lines: [{ orderItemId: 'a', quantity: 2 }] },
    { status: OrderReturnStatus.REJECTED, lines: [{ orderItemId: 'a', quantity: 1 }] },
    { status: OrderReturnStatus.CANCELLED, lines: [{ orderItemId: 'b', quantity: 1 }] },
    { status: OrderReturnStatus.COMPLETED, lines: [{ orderItemId: 'b', quantity: 0 }] }
  ])

  it('counts what the returns that still hold units take, and none that were rejected or cancelled', () => {
    expect(held.get('a')).toBe(2)
    expect(held.get('b')).toBe(0)
    expect(holdsUnits(OrderReturnStatus.REJECTED)).toBe(false)
    expect(holdsUnits(OrderReturnStatus.CANCELLED)).toBe(false)
    expect(holdsUnits(OrderReturnStatus.REQUESTED)).toBe(true)
  })

  it('refuses more than what is left of an item, and accepts exactly what is left', () => {
    expect(checkReturnLines({ items, held, lines: [{ orderItemId: 'a', quantity: 1 }] })).toEqual({
      ok: true
    })
    expect(checkReturnLines({ items, held, lines: [{ orderItemId: 'a', quantity: 2 }] })).toEqual({
      ok: false,
      code: ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED,
      orderItemId: 'a'
    })
  })

  it('refuses an item that is not of the order, a repeated one and a quantity below one', () => {
    for (const lines of [
      [{ orderItemId: 'z', quantity: 1 }],
      [
        { orderItemId: 'b', quantity: 1 },
        { orderItemId: 'b', quantity: 1 }
      ],
      [{ orderItemId: 'b', quantity: 0 }]
    ]) {
      const verdict = checkReturnLines({ items, held: new Map(), lines })
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.code).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
    }
  })
})

describe('when the order is returned', () => {
  it('needs the units that are back to cover every unit of every item', () => {
    const back = (status: OrderReturnStatus, a: number, b: number) => ({
      status,
      lines: [
        { orderItemId: 'a', quantity: a },
        { orderItemId: 'b', quantity: b }
      ]
    })
    expect(coversEveryUnit(items, [back(OrderReturnStatus.RECEIVED, 3, 1)])).toBe(true)
    expect(coversEveryUnit(items, [back(OrderReturnStatus.RECEIVED, 2, 1)])).toBe(false)
    expect(
      coversEveryUnit(items, [
        back(OrderReturnStatus.RECEIVED, 2, 0),
        back(OrderReturnStatus.COMPLETED, 1, 1)
      ])
    ).toBe(true)
    // What is only approved or on its way is not back
    expect(coversEveryUnit(items, [back(OrderReturnStatus.IN_TRANSIT, 3, 1)])).toBe(false)
    expect(coversEveryUnit([], [])).toBe(false)
    expect(hasReceivedUnits(OrderReturnStatus.APPROVED)).toBe(false)
  })
})

describe('the stock of a receipt', () => {
  it('adds a resellable unit back', () => {
    expect(movementsOfReceipt(OrderReturnCondition.RESELLABLE)).toEqual([
      { movement: 'return_in', type: InventoryMovementType.RETURN_IN, reason: null }
    ])
  })

  it('adds a defective or damaged unit and discards it at once, so the net stock is unchanged', () => {
    for (const condition of [OrderReturnCondition.DEFECTIVE, OrderReturnCondition.DAMAGED]) {
      expect(movementsOfReceipt(condition)).toEqual([
        { movement: 'return_in', type: InventoryMovementType.RETURN_IN, reason: null },
        {
          movement: 'discard',
          type: InventoryMovementType.ADJUSTMENT_OUT,
          reason: InventoryAdjustmentReason.DAMAGED
        }
      ])
    }
  })

  it('gives each movement its own key, the same one on a retry', () => {
    expect(returnMovementKey('r1', 'i1', 'return_in')).toBe('return:r1:i1:return_in')
    expect(returnMovementKey('r1', 'i1', 'discard')).not.toBe(
      returnMovementKey('r1', 'i1', 'return_in')
    )
  })
})

describe('the warehouse the units go back to', () => {
  it('is the one that sent most of them, the smaller id on a tie, and none for an item with no allocation', () => {
    expect(
      defaultRestockWarehouse([
        { warehouseId: 'w2', quantity: 1 },
        { warehouseId: 'w1', quantity: 3 }
      ])
    ).toBe('w1')
    expect(
      defaultRestockWarehouse([
        { warehouseId: 'w2', quantity: 2 },
        { warehouseId: 'w1', quantity: 2 }
      ])
    ).toBe('w1')
    expect(defaultRestockWarehouse([])).toBeNull()
  })
})

describe('the machine and the refund', () => {
  it('follows the table of TDD_17 §3', () => {
    expect(canMoveReturn(OrderReturnStatus.REQUESTED, OrderReturnStatus.APPROVED)).toBe(true)
    expect(canMoveReturn(OrderReturnStatus.APPROVED, OrderReturnStatus.RECEIVED)).toBe(true)
    expect(canMoveReturn(OrderReturnStatus.REQUESTED, OrderReturnStatus.RECEIVED)).toBe(false)
    expect(canMoveReturn(OrderReturnStatus.COMPLETED, OrderReturnStatus.REQUESTED)).toBe(false)
  })

  it('leaves no room for a refund above what the customer paid', () => {
    expect(refundRoom({ orderTotalCents: 5000, alreadyRefundedCents: 2000 })).toBe(3000)
    expect(refundRoom({ orderTotalCents: 5000, alreadyRefundedCents: 6000 })).toBe(0)
    // All of it already given back leaves none, and nothing given back leaves the whole total
    expect(refundRoom({ orderTotalCents: 5000, alreadyRefundedCents: 5000 })).toBe(0)
    expect(refundRoom({ orderTotalCents: 5000, alreadyRefundedCents: 0 })).toBe(5000)
  })
})

describe('exchangeCreditCents', () => {
  const order = { subtotalCents: 6000, discountCents: 0 }

  it('is the price each unit was sold at times the units that come back', () => {
    expect(
      exchangeCreditCents(
        [
          { unitPriceCents: 1500, quantity: 2 },
          { unitPriceCents: 999, quantity: 1 }
        ],
        order
      )
    ).toBe(3999)
    expect(exchangeCreditCents([], order)).toBe(0)
  })

  it('takes the share of the discount of the order that the returned units carried', () => {
    // 100.00 of products with a 30.00 discount: the customer paid 70.00, and one unit of 40.00 is worth 28.00
    expect(
      exchangeCreditCents([{ unitPriceCents: 4000, quantity: 1 }], {
        subtotalCents: 10000,
        discountCents: 3000
      })
    ).toBe(2800)
  })

  it('rounds down, never gives more than was paid, and has nothing for an order with no products', () => {
    expect(
      exchangeCreditCents([{ unitPriceCents: 333, quantity: 1 }], {
        subtotalCents: 1000,
        discountCents: 1
      })
    ).toBe(332)
    expect(
      exchangeCreditCents([{ unitPriceCents: 1000, quantity: 1 }], {
        subtotalCents: 1000,
        discountCents: 1000
      })
    ).toBe(0)
    expect(
      exchangeCreditCents([{ unitPriceCents: 1000, quantity: 1 }], {
        subtotalCents: 0,
        discountCents: 0
      })
    ).toBe(0)
  })
})

describe('applyExchangeCredit', () => {
  it('leaves the price difference to pay when the replacement costs more than what came back', () => {
    expect(applyExchangeCredit({ subtotalCents: 5000, creditCents: 3000 })).toEqual({
      discountCents: 3000,
      excessCents: 0
    })
  })

  it('takes the whole credit and nothing left over when the values are equal', () => {
    expect(applyExchangeCredit({ subtotalCents: 3000, creditCents: 3000 })).toEqual({
      discountCents: 3000,
      excessCents: 0
    })
  })

  it('never takes more than the replacement is worth and keeps the rest as the refund of the owner', () => {
    expect(applyExchangeCredit({ subtotalCents: 2000, creditCents: 3000 })).toEqual({
      discountCents: 2000,
      excessCents: 1000
    })
  })
})

describe('exchangeCreditReason', () => {
  it('names the return that made the credit', () => {
    expect(exchangeCreditReason('r-1')).toBe(`${EXCHANGE_CREDIT_REASON_PREFIX}r-1`)
  })
})
