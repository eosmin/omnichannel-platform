import { ClientPermissions, type Permission } from '@platform/core/auth'
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PriceApprovalStatus
} from '@platform/core/domain'

import {
  canEditField,
  editableFieldsOf,
  type OrderFlowInput,
  OrderFlows,
  offeredFlows,
  paymentTargets
} from './order-detail-rules'

const everything = (): boolean => true
const nothing = (): boolean => false
const only =
  (...held: Permission[]) =>
  (permission: Permission): boolean =>
    held.includes(permission)

function order(
  status: string,
  approval: string = PriceApprovalStatus.NOT_REQUIRED
): OrderFlowInput {
  return { status, priceApprovalStatus: approval, priceApprovalRequestedBy: null }
}

function flowsOf(
  input: OrderFlowInput,
  can: (p: Permission) => boolean,
  user: string | null = 'u1'
) {
  return offeredFlows(input, can, user).map(offer => offer.flow)
}

describe('offeredFlows', () => {
  it('does not offer shipped or delivered while a guide is live: the guide moves the order (the api refuses it)', () => {
    const live = (status: OrderStatus) =>
      offeredFlows(order(status), everything, 'u1', true).map(offer => offer.flow)
    // Prepare, return and cancel are still the member's: the api lets them through with a live guide
    expect(live(OrderStatus.CONFIRMED)).toEqual([OrderFlows.PREPARE, OrderFlows.CANCEL])
    expect(live(OrderStatus.PREPARING)).toEqual([OrderFlows.CANCEL])
    expect(live(OrderStatus.SHIPPED)).toEqual([OrderFlows.RETURN])
    // Without a live guide nothing changes
    expect(
      offeredFlows(order(OrderStatus.CONFIRMED), everything, 'u1', false).map(o => o.flow)
    ).toEqual([OrderFlows.PREPARE, OrderFlows.SHIP, OrderFlows.CANCEL])
  })

  it('offers confirm, cancel and nothing that skips a state to a pending order', () => {
    expect(flowsOf(order(OrderStatus.PENDING_CONFIRMATION), everything)).toEqual([
      OrderFlows.CONFIRM,
      OrderFlows.CANCEL
    ])
  })

  it('offers prepare, ship and cancel to a confirmed order', () => {
    expect(flowsOf(order(OrderStatus.CONFIRMED), everything)).toEqual([
      OrderFlows.PREPARE,
      OrderFlows.SHIP,
      OrderFlows.CANCEL
    ])
  })

  it('offers deliver and return to a shipped order, and no cancel', () => {
    expect(flowsOf(order(OrderStatus.SHIPPED), everything)).toEqual([
      OrderFlows.DELIVER,
      OrderFlows.RETURN
    ])
  })

  it('offers only a return to a delivered order, and nothing to a closed one', () => {
    expect(flowsOf(order(OrderStatus.DELIVERED), everything)).toEqual([OrderFlows.RETURN])
    expect(flowsOf(order(OrderStatus.CANCELLED), everything)).toEqual([])
    expect(flowsOf(order(OrderStatus.RETURNED), everything)).toEqual([])
  })

  it('offers nothing to a member with no permission', () => {
    expect(flowsOf(order(OrderStatus.CONFIRMED), nothing)).toEqual([])
  })

  it('asks for the permission of each target: confirm and cancel have their own', () => {
    const confirmOnly = only(ClientPermissions.ORDERS_CONFIRM)
    expect(flowsOf(order(OrderStatus.PENDING_CONFIRMATION), confirmOnly)).toEqual([
      OrderFlows.CONFIRM
    ])
    const cancelOnly = only(ClientPermissions.ORDERS_CANCEL)
    expect(flowsOf(order(OrderStatus.PENDING_CONFIRMATION), cancelOnly)).toEqual([
      OrderFlows.CANCEL
    ])
    const statusOnly = only(ClientPermissions.ORDERS_CHANGE_STATUS)
    expect(flowsOf(order(OrderStatus.PENDING_CONFIRMATION), statusOnly)).toEqual([])
  })

  it('draws confirm, prepare and ship disabled while a price waits for approval, never deliver or cancel', () => {
    const waiting = order(OrderStatus.CONFIRMED, PriceApprovalStatus.PENDING)
    const offers = offeredFlows(waiting, everything, 'u1')
    const byFlow = Object.fromEntries(offers.map(offer => [offer.flow, offer]))
    expect(byFlow[OrderFlows.PREPARE]).toMatchObject({
      disabled: true,
      blockedBy: 'price_approval'
    })
    expect(byFlow[OrderFlows.SHIP]).toMatchObject({ disabled: true, blockedBy: 'price_approval' })
    expect(byFlow[OrderFlows.CANCEL]).toMatchObject({ disabled: false, blockedBy: null })
    const pending = offeredFlows(
      order(OrderStatus.PENDING_CONFIRMATION, PriceApprovalStatus.PENDING),
      everything,
      'u1'
    )
    expect(pending.find(offer => offer.flow === OrderFlows.CONFIRM)).toMatchObject({
      disabled: true
    })
  })

  it('treats a rejected price like a pending one for the buttons that move the goods', () => {
    const offers = offeredFlows(
      order(OrderStatus.CONFIRMED, PriceApprovalStatus.REJECTED),
      everything,
      'u1'
    )
    expect(offers.find(offer => offer.flow === OrderFlows.SHIP)?.disabled).toBe(true)
    // Nothing to decide: the request was already answered
    expect(offers.map(offer => offer.flow)).not.toContain(OrderFlows.APPROVE_PRICE)
  })

  it('offers the price decision to who holds the permission, and hides the approval from who asked for it', () => {
    const input = {
      ...order(OrderStatus.PENDING_CONFIRMATION, PriceApprovalStatus.PENDING),
      priceApprovalRequestedBy: 'u1'
    }
    const approver = only(ClientPermissions.ORDERS_APPROVE_PRICE)
    expect(flowsOf(input, approver, 'u1')).toEqual([OrderFlows.REJECT_PRICE])
    expect(flowsOf(input, approver, 'u2')).toEqual([
      OrderFlows.APPROVE_PRICE,
      OrderFlows.REJECT_PRICE
    ])
    expect(flowsOf(input, nothing, 'u2')).toEqual([])
    // Who is signed in is not known yet: nothing is approved on a guess
    expect(flowsOf(input, approver, null)).toEqual([OrderFlows.REJECT_PRICE])
  })

  it('offers nothing for a status or an approval of a newer server', () => {
    expect(flowsOf(order('ON_THE_MOON'), everything)).toEqual([])
    expect(flowsOf(order(OrderStatus.CONFIRMED, 'maybe'), everything)).toEqual([])
  })
})

describe('editable fields', () => {
  it('follows the table of the api by status', () => {
    expect(editableFieldsOf(OrderStatus.PENDING_CONFIRMATION)).toContain('items')
    expect(editableFieldsOf(OrderStatus.PREPARING)).not.toContain('items')
    expect(editableFieldsOf(OrderStatus.SHIPPED)).toContain('trackingNumber')
    // The tracking number is the carrier's while a guide is live
    expect(editableFieldsOf(OrderStatus.SHIPPED, true)).not.toContain('trackingNumber')
    expect(editableFieldsOf(OrderStatus.SHIPPED)).not.toContain('packingNotes')
    expect(editableFieldsOf(OrderStatus.DELIVERED)).toEqual(['customerNotes', 'internalNotes'])
    expect(editableFieldsOf(OrderStatus.CANCELLED)).not.toContain('items')
    expect(editableFieldsOf('ON_THE_MOON')).toEqual([])
  })

  it('needs orders:edit as well', () => {
    expect(canEditField(OrderStatus.CONFIRMED, 'packingNotes', everything)).toBe(true)
    expect(canEditField(OrderStatus.CONFIRMED, 'packingNotes', nothing)).toBe(false)
    expect(canEditField(OrderStatus.SHIPPED, 'packingNotes', everything)).toBe(false)
  })
})

describe('paymentTargets', () => {
  const base = {
    status: OrderStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PENDING,
    paymentMethod: PaymentMethod.TRANSFER,
    priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED
  }

  it('lists the same state and the ones the table allows', () => {
    expect(paymentTargets(base)).toEqual([
      PaymentStatus.PENDING,
      PaymentStatus.COMPLETED,
      PaymentStatus.FAILED
    ])
  })

  it('leaves a refunded payment with only itself', () => {
    expect(paymentTargets({ ...base, paymentStatus: PaymentStatus.REFUNDED })).toEqual([
      PaymentStatus.REFUNDED
    ])
  })

  it('does not take as paid a price that waits for approval', () => {
    expect(
      paymentTargets({ ...base, priceApprovalStatus: PriceApprovalStatus.PENDING })
    ).not.toContain(PaymentStatus.COMPLETED)
  })

  it('waits for the delivery to take cash on delivery as paid', () => {
    const cod = { ...base, paymentMethod: PaymentMethod.CASH_ON_DELIVERY }
    expect(paymentTargets(cod)).not.toContain(PaymentStatus.COMPLETED)
    expect(paymentTargets({ ...cod, status: OrderStatus.DELIVERED })).toContain(
      PaymentStatus.COMPLETED
    )
  })

  it('only allows a refund of a cancelled order', () => {
    expect(
      paymentTargets({
        ...base,
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.COMPLETED
      })
    ).toEqual([PaymentStatus.REFUNDED])
  })

  it('returns nothing for a value of a newer server', () => {
    expect(paymentTargets({ ...base, paymentStatus: 'WEIRD' })).toEqual([])
  })
})
