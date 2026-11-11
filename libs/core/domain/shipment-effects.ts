import { z } from 'zod'

import {
  FailedAttemptMessagePolicy,
  OrderMessageVariables,
  type FailedAttemptMessagePolicyType,
  OrderMessageKind,
  type OrderMessageKindType
} from './order-constants'
import { CarrierPolling, ShipmentLeftStatuses } from './shipping-constants'
import { OrderStatus, ShipmentStatus } from './status-enums'

// What a shipment does to its order (TDD_17 §4.9), as pure rules: the service of the api reads and writes, this only says
// what is due. The answer depends on the status the shipment holds NOW and the one the order holds, never on the event
// that announced the change, so an event heard twice (or out of order, or lost and healed by the next one) does the same.

export interface OrderFollowInput {
  orderStatus: OrderStatus
  // The status of every outbound shipment of the order that is not over (not cancelled, failed or returned)
  liveShipments: readonly ShipmentStatus[]
}

export interface OrderFollowPlan {
  // The order becomes SHIPPED, with the stock issue
  ship: boolean
  // The order becomes DELIVERED (and a cash-on-delivery payment completes)
  deliver: boolean
  // A package left for an order that cannot follow it: a person decides (SHIPMENT_REQUIRES_REVIEW)
  review: boolean
}

const NOTHING: OrderFollowPlan = { ship: false, deliver: false, review: false }

// The order is judged by all its live packages, whichever one announced the change: a package that came back or was cancelled
// after the others arrived is what finishes the delivery
export function planOrderFollow(input: OrderFollowInput): OrderFollowPlan {
  const { orderStatus, liveShipments } = input
  const left = liveShipments.some(status => ShipmentLeftStatuses.includes(status))
  if (!left) return NOTHING
  switch (orderStatus) {
    case OrderStatus.RETURNED:
      return NOTHING
    // A package left for an order that was cancelled, or that nobody confirmed: the platform does not move it
    case OrderStatus.CANCELLED:
    case OrderStatus.PENDING_CONFIRMATION:
      return { ...NOTHING, review: true }
    case OrderStatus.CONFIRMED:
    case OrderStatus.PREPARING:
    case OrderStatus.SHIPPED:
    case OrderStatus.DELIVERED:
      break
  }
  const alreadyShipped =
    orderStatus === OrderStatus.SHIPPED || orderStatus === OrderStatus.DELIVERED
  // With split fulfillment the order is delivered when its last live package is
  const allDelivered = liveShipments.every(status => status === ShipmentStatus.DELIVERED)
  return {
    ship: !alreadyShipped,
    deliver: allDelivered && orderStatus !== OrderStatus.DELIVERED,
    review: false
  }
}

// Whether the customer is told about this failed attempt (TDD_17 §4.7): `failedAttempts` already counts the one that
// has just failed
export function isFailedAttemptMessageDue(
  policy: FailedAttemptMessagePolicyType,
  failedAttempts: number
): boolean {
  switch (policy) {
    case FailedAttemptMessagePolicy.EVERY_ATTEMPT:
      return failedAttempts >= 1
    case FailedAttemptMessagePolicy.FIRST_ONLY:
      return failedAttempts === 1
    case FailedAttemptMessagePolicy.NONE:
      return false
  }
}

// Kinds whose automatic sending is decided by a store preference, not by the `autoSend` of a template (TDD_17 §4.7): the
// summary follows `orders.sendSummaryOnCreate` and the failed attempt `orders.failedAttemptMessages`
export const OrderMessageKindsWithoutAutoSend: readonly OrderMessageKindType[] = [
  OrderMessageKind.ORDER_SUMMARY,
  OrderMessageKind.ORDER_FAILED_ATTEMPT
]

// The `autoSend` a template starts with when the owner does not say (TDD_17 §4.7): the shipment-progress messages and the
// cancellation go by themselves, the rest (returns, exchanges) only when someone sends them, and the two kinds a store
// preference decides never do. A Record, so that a new kind cannot be added without deciding it.
export const OrderMessageAutoSendDefaults: Record<OrderMessageKindType, boolean> = {
  [OrderMessageKind.ORDER_SUMMARY]: false,
  [OrderMessageKind.ORDER_SHIPPED]: true,
  [OrderMessageKind.ORDER_OUT_FOR_DELIVERY]: true,
  [OrderMessageKind.ORDER_DELIVERED]: true,
  [OrderMessageKind.ORDER_FAILED_ATTEMPT]: false,
  [OrderMessageKind.ORDER_CANCELLED]: true,
  [OrderMessageKind.RETURN_APPROVED]: false,
  [OrderMessageKind.EXCHANGE_SHIPPED]: false
}

export function defaultAutoSend(kind: OrderMessageKindType): boolean {
  return OrderMessageAutoSendDefaults[kind]
}

export const orderMessageAutoSendSchema = z
  .object({ kind: z.enum(OrderMessageKind), autoSend: z.boolean() })
  .refine(
    template => !(template.autoSend && OrderMessageKindsWithoutAutoSend.includes(template.kind)),
    { message: 'this kind follows a store preference, not autoSend', path: ['autoSend'] }
  )

// The values of the two variables of a failed-attempt template (TDD_17 §4.7): the attempt that has just failed, of how many
export function failedAttemptVariables(input: {
  failedAttempts: number
  maxDeliveryAttempts: number
}): Record<
  typeof OrderMessageVariables.ATTEMPT_NUMBER | typeof OrderMessageVariables.MAX_ATTEMPTS,
  string
> {
  return {
    [OrderMessageVariables.ATTEMPT_NUMBER]: String(input.failedAttempts),
    [OrderMessageVariables.MAX_ATTEMPTS]: String(input.maxDeliveryAttempts)
  }
}

// How often a connection is polled (TDD_17 §4.9): its own interval, never below the minimum; one the carrier also pushes to is
// asked only as a safety net
export function carrierPollInterval(input: { configured: number | null; pushed: boolean }): number {
  const own = Math.max(
    CarrierPolling.MIN_INTERVAL_MINUTES,
    input.configured ?? CarrierPolling.DEFAULT_INTERVAL_MINUTES
  )
  return input.pushed ? Math.max(own, CarrierPolling.WEBHOOK_SAFETY_NET_MINUTES) : own
}
