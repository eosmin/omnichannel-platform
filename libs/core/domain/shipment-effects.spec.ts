import {
  FailedAttemptMessagePolicy,
  OrderMessageKind,
  OrderStatusMessageKinds
} from './order-constants'
import {
  carrierPollInterval,
  customerMessageOfShipment,
  defaultAutoSend,
  failedAttemptVariables,
  isFailedAttemptMessageDue,
  ShipmentStatusesTold,
  orderMessageAutoSendSchema,
  planOrderFollow
} from './shipment-effects'
import { OrderStatus, ShipmentStatus } from './status-enums'

// The packages of the order that are not over, the one that announced the change among them
const plan = (orderStatus: OrderStatus, ...liveShipments: ShipmentStatus[]) =>
  planOrderFollow({ orderStatus, liveShipments })

describe('planOrderFollow (TDD_17 §4.9)', () => {
  const none = { ship: false, deliver: false, review: false }

  it.each([
    ShipmentStatus.CREATING,
    ShipmentStatus.REQUIRES_REVIEW,
    ShipmentStatus.LABEL_CREATED,
    ShipmentStatus.CANCEL_PENDING,
    ShipmentStatus.CANCEL_FAILED,
    ShipmentStatus.RETURNING
  ])('does nothing to the order while the package has not left, or is coming back (%s)', status => {
    expect(plan(OrderStatus.PREPARING, status)).toEqual(none)
  })

  it.each([
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.FAILED_ATTEMPT
  ])('ships a confirmed or preparing order once the package left (%s)', status => {
    for (const order of [OrderStatus.CONFIRMED, OrderStatus.PREPARING]) {
      expect(plan(order, status)).toEqual({ ship: true, deliver: false, review: false })
    }
  })

  it('ships and delivers in one go when the first event heard is the delivery', () => {
    expect(plan(OrderStatus.PREPARING, ShipmentStatus.DELIVERED)).toEqual({
      ship: true,
      deliver: true,
      review: false
    })
  })

  it('delivers a shipped order, and does it once', () => {
    expect(plan(OrderStatus.SHIPPED, ShipmentStatus.DELIVERED)).toEqual({
      ship: false,
      deliver: true,
      review: false
    })
    expect(plan(OrderStatus.DELIVERED, ShipmentStatus.DELIVERED)).toEqual(none)
  })

  it('does not ship an order twice when another status of the same package arrives', () => {
    expect(plan(OrderStatus.SHIPPED, ShipmentStatus.OUT_FOR_DELIVERY)).toEqual(none)
  })

  it('waits for the last package of a split order, and the one that finishes it may be a package that came back', () => {
    expect(
      plan(OrderStatus.SHIPPED, ShipmentStatus.DELIVERED, ShipmentStatus.IN_TRANSIT).deliver
    ).toBe(false)
    expect(
      plan(OrderStatus.SHIPPED, ShipmentStatus.DELIVERED, ShipmentStatus.DELIVERED).deliver
    ).toBe(true)
    // The other package was returned or cancelled (it is not live any more): the one delivered is all that is left
    expect(plan(OrderStatus.SHIPPED, ShipmentStatus.DELIVERED).deliver).toBe(true)
  })

  it.each([OrderStatus.CANCELLED, OrderStatus.PENDING_CONFIRMATION])(
    'asks a person when a package left for an order that is %s',
    order => {
      expect(plan(order, ShipmentStatus.PICKED_UP)).toEqual({
        ship: false,
        deliver: false,
        review: true
      })
    }
  )

  it('leaves a returned order alone, and an order with no live package', () => {
    expect(plan(OrderStatus.RETURNED, ShipmentStatus.DELIVERED)).toEqual(none)
    expect(plan(OrderStatus.SHIPPED)).toEqual(none)
  })
})

describe('isFailedAttemptMessageDue (TDD_17 §4.7)', () => {
  it('tells the customer of every attempt, of the first one only, or of none', () => {
    const every = FailedAttemptMessagePolicy.EVERY_ATTEMPT
    const first = FailedAttemptMessagePolicy.FIRST_ONLY
    const none = FailedAttemptMessagePolicy.NONE
    expect([1, 2, 3].map(n => isFailedAttemptMessageDue(every, n))).toEqual([true, true, true])
    expect([1, 2, 3].map(n => isFailedAttemptMessageDue(first, n))).toEqual([true, false, false])
    expect([1, 2, 3].map(n => isFailedAttemptMessageDue(none, n))).toEqual([false, false, false])
    expect(isFailedAttemptMessageDue(every, 0)).toBe(false)
  })
})

describe('orderMessageAutoSendSchema (TDD_17 §4.7)', () => {
  it('refuses autoSend for the two kinds that follow a store preference', () => {
    for (const kind of [OrderMessageKind.ORDER_SUMMARY, OrderMessageKind.ORDER_FAILED_ATTEMPT]) {
      expect(orderMessageAutoSendSchema.safeParse({ kind, autoSend: true }).success).toBe(false)
      expect(orderMessageAutoSendSchema.safeParse({ kind, autoSend: false }).success).toBe(true)
    }
  })

  it('accepts autoSend for the progress messages', () => {
    for (const kind of [
      OrderMessageKind.ORDER_SHIPPED,
      OrderMessageKind.ORDER_OUT_FOR_DELIVERY,
      OrderMessageKind.ORDER_DELIVERED,
      OrderMessageKind.ORDER_CANCELLED
    ]) {
      expect(orderMessageAutoSendSchema.safeParse({ kind, autoSend: true }).success).toBe(true)
    }
  })
})

describe('defaultAutoSend (TDD_17 §4.7)', () => {
  it('starts the shipment-progress messages and the cancellation automatic, and nothing else', () => {
    const automatic = Object.values(OrderMessageKind).filter(defaultAutoSend)
    expect(automatic).toEqual([
      OrderMessageKind.ORDER_SHIPPED,
      OrderMessageKind.ORDER_OUT_FOR_DELIVERY,
      OrderMessageKind.ORDER_DELIVERED,
      OrderMessageKind.ORDER_CANCELLED
    ])
  })

  it('never starts automatic a kind that a store preference decides', () => {
    for (const kind of Object.values(OrderMessageKind)) {
      expect(
        orderMessageAutoSendSchema.safeParse({ kind, autoSend: defaultAutoSend(kind) }).success
      ).toBe(true)
    }
  })
})

describe('failedAttemptVariables', () => {
  it('names the attempt that failed and how many the carrier makes', () => {
    expect(failedAttemptVariables({ failedAttempts: 2, maxDeliveryAttempts: 3 })).toEqual({
      attemptNumber: '2',
      maxAttempts: '3'
    })
  })
})

describe('carrierPollInterval (TDD_17 §4.9)', () => {
  it('uses the interval of the connection, the default when it has none, and never less than five minutes', () => {
    expect(carrierPollInterval({ configured: 30, pushed: false })).toBe(30)
    expect(carrierPollInterval({ configured: null, pushed: false })).toBe(15)
    expect(carrierPollInterval({ configured: 1, pushed: false })).toBe(5)
  })

  it('asks a connection the carrier pushes to only as a safety net, an hour apart or its own if longer', () => {
    expect(carrierPollInterval({ configured: 10, pushed: true })).toBe(60)
    expect(carrierPollInterval({ configured: 120, pushed: true })).toBe(120)
  })
})

describe('customerMessageOfShipment (TDD_17 §4.9)', () => {
  const every = FailedAttemptMessagePolicy.EVERY_ATTEMPT
  const of = (to: ShipmentStatus, failedAttempts = 0, policy = every) =>
    customerMessageOfShipment({ to, failedAttempts, policy })

  it('tells that the package left once, whichever of picked up and in transit comes first', () => {
    const shipped = { kind: OrderMessageKind.ORDER_SHIPPED, status: ShipmentStatus.PICKED_UP }
    expect(of(ShipmentStatus.PICKED_UP)).toEqual(shipped)
    expect(of(ShipmentStatus.IN_TRANSIT)).toEqual(shipped)
  })

  it('tells that it is out for delivery and that it was delivered', () => {
    expect(of(ShipmentStatus.OUT_FOR_DELIVERY)).toEqual({
      kind: OrderMessageKind.ORDER_OUT_FOR_DELIVERY,
      status: ShipmentStatus.OUT_FOR_DELIVERY
    })
    expect(of(ShipmentStatus.DELIVERED)).toEqual({
      kind: OrderMessageKind.ORDER_DELIVERED,
      status: ShipmentStatus.DELIVERED
    })
  })

  it('tells each failed attempt, with its number, as the preference allows', () => {
    expect(of(ShipmentStatus.FAILED_ATTEMPT, 2)).toEqual({
      kind: OrderMessageKind.ORDER_FAILED_ATTEMPT,
      status: ShipmentStatus.FAILED_ATTEMPT,
      attempt: 2
    })
    expect(of(ShipmentStatus.FAILED_ATTEMPT, 2, FailedAttemptMessagePolicy.FIRST_ONLY)).toBeNull()
    expect(
      of(ShipmentStatus.FAILED_ATTEMPT, 1, FailedAttemptMessagePolicy.FIRST_ONLY)
    ).not.toBeNull()
    expect(of(ShipmentStatus.FAILED_ATTEMPT, 1, FailedAttemptMessagePolicy.NONE)).toBeNull()
  })

  it('looks at exactly the five statuses that can tell the customer something', () => {
    expect([...ShipmentStatusesTold].sort()).toEqual(
      [
        ShipmentStatus.PICKED_UP,
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.OUT_FOR_DELIVERY,
        ShipmentStatus.FAILED_ATTEMPT,
        ShipmentStatus.DELIVERED
      ].sort()
    )
  })

  it('is silent exactly for the statuses that are not in the list the listener looks at', () => {
    for (const status of Object.values(ShipmentStatus)) {
      const told = ShipmentStatusesTold.includes(status)
      expect(of(status, 1) !== null).toBe(told)
    }
  })

  it.each([
    ShipmentStatus.CREATING,
    ShipmentStatus.LABEL_CREATED,
    ShipmentStatus.RETURNING,
    ShipmentStatus.RETURNED,
    ShipmentStatus.CANCEL_PENDING,
    ShipmentStatus.CANCELLED,
    ShipmentStatus.CANCEL_FAILED,
    ShipmentStatus.REQUIRES_REVIEW,
    ShipmentStatus.FAILED
  ])('says nothing to the customer for %s', status => {
    expect(of(status)).toBeNull()
  })
})

describe('OrderStatusMessageKinds (TDD_09 §5.3)', () => {
  it('names the message of the three statuses a person can set that the customer is told about', () => {
    expect(OrderStatusMessageKinds).toEqual({
      [OrderStatus.SHIPPED]: OrderMessageKind.ORDER_SHIPPED,
      [OrderStatus.DELIVERED]: OrderMessageKind.ORDER_DELIVERED,
      [OrderStatus.CANCELLED]: OrderMessageKind.ORDER_CANCELLED
    })
  })
})
