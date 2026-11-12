import { ClientPermissions, type Permission } from '@platform/core/auth'
import {
  canCancelOrder,
  canTransitionOrder,
  checkPaymentChange,
  editableOrderFields,
  isPriceApprovalBlocking,
  OrderEditablePriceStatuses,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentStatusTransitions,
  PriceApprovalStatus,
  type OrderEditableField
} from '@platform/core/domain'

// What the detail page of an order offers, decided from the rules the api enforces (the state machine, the editable fields,
// the payment rules) and from what the member holds. The api still decides every request: these only keep the screen from
// offering what it would refuse, so a refusal that does come is a race and not a button that was never going to work.

// The permissions are passed in as a check, so this file reads no module of the browser and a spec can run it as it is
export type CanDo = (permission: Permission) => boolean

// The names are the ones of the buttons; a value is never written inline
export const OrderFlows = {
  CONFIRM: 'confirm',
  PREPARE: 'prepare',
  SHIP: 'ship',
  DELIVER: 'deliver',
  RETURN: 'return',
  CANCEL: 'cancel',
  APPROVE_PRICE: 'approve_price',
  REJECT_PRICE: 'reject_price'
} as const
export type OrderFlow = (typeof OrderFlows)[keyof typeof OrderFlows]

// The statuses the detail knows; a value of a newer server is not one of them and gets no buttons
const KNOWN_STATUSES: readonly string[] = Object.values(OrderStatus)

export function asOrderStatus(value: string): OrderStatus | null {
  return KNOWN_STATUSES.includes(value) ? (value as OrderStatus) : null
}

const KNOWN_APPROVALS: readonly string[] = Object.values(PriceApprovalStatus)

export function asPriceApprovalStatus(value: string): PriceApprovalStatus | null {
  return KNOWN_APPROVALS.includes(value) ? (value as PriceApprovalStatus) : null
}

const KNOWN_PAYMENT_STATUSES: readonly string[] = Object.values(PaymentStatus)

export function asPaymentStatus(value: string): PaymentStatus | null {
  return KNOWN_PAYMENT_STATUSES.includes(value) ? (value as PaymentStatus) : null
}

const KNOWN_PAYMENT_METHODS: readonly string[] = Object.values(PaymentMethod)

export function asPaymentMethod(value: string): PaymentMethod | null {
  return KNOWN_PAYMENT_METHODS.includes(value) ? (value as PaymentMethod) : null
}

export interface OrderFlowInput {
  status: string
  priceApprovalStatus: string
  // Who asked for the price that waits for approval: nobody approves their own request
  priceApprovalRequestedBy: string | null
}

export interface FlowOffer {
  flow: OrderFlow
  // True when the button is drawn but cannot be used yet: the reason is the `blockedBy`
  disabled: boolean
  blockedBy: 'price_approval' | null
}

// The buttons of the status flows, in the order of the life of an order. A flow whose transition the table does not list is
// not offered at all; one the table allows but that waits for something (a price approval) is drawn disabled with its reason.
export function offeredFlows(
  order: OrderFlowInput,
  can: CanDo,
  userId: string | null
): FlowOffer[] {
  const status = asOrderStatus(order.status)
  const approval = asPriceApprovalStatus(order.priceApprovalStatus)
  if (status === null || approval === null) return []
  const blocked = isPriceApprovalBlocking(approval)
  const offers: FlowOffer[] = []
  const offer = (flow: OrderFlow, held: boolean, waitsForPrice: boolean): void => {
    if (!held) return
    offers.push({
      flow,
      disabled: waitsForPrice && blocked,
      blockedBy: waitsForPrice && blocked ? 'price_approval' : null
    })
  }
  // The route of the status asks for orders:change_status; confirming and cancelling have their own permission, and a
  // member who holds the specific one without the generic one uses the route made for it (the api checks the target)
  if (canTransitionOrder(status, OrderStatus.CONFIRMED)) {
    offer(OrderFlows.CONFIRM, can(ClientPermissions.ORDERS_CONFIRM), true)
  }
  if (canTransitionOrder(status, OrderStatus.PREPARING)) {
    offer(OrderFlows.PREPARE, can(ClientPermissions.ORDERS_CHANGE_STATUS), true)
  }
  if (canTransitionOrder(status, OrderStatus.SHIPPED)) {
    offer(OrderFlows.SHIP, can(ClientPermissions.ORDERS_CHANGE_STATUS), true)
  }
  if (canTransitionOrder(status, OrderStatus.DELIVERED)) {
    offer(OrderFlows.DELIVER, can(ClientPermissions.ORDERS_CHANGE_STATUS), false)
  }
  if (canTransitionOrder(status, OrderStatus.RETURNED)) {
    offer(OrderFlows.RETURN, can(ClientPermissions.ORDERS_CHANGE_STATUS), false)
  }
  if (canCancelOrder(status)) {
    offer(OrderFlows.CANCEL, can(ClientPermissions.ORDERS_CANCEL), false)
  }
  // A price waiting for a decision: the member who holds the permission decides, never the one who asked for it
  if (
    approval === PriceApprovalStatus.PENDING &&
    OrderEditablePriceStatuses.includes(status) &&
    can(ClientPermissions.ORDERS_APPROVE_PRICE)
  ) {
    // Who is signed in is not known yet (the profile is loading or failed): nothing is approved on a guess
    const own = userId === null || order.priceApprovalRequestedBy === userId
    if (!own) offers.push({ flow: OrderFlows.APPROVE_PRICE, disabled: false, blockedBy: null })
    offers.push({ flow: OrderFlows.REJECT_PRICE, disabled: false, blockedBy: null })
  }
  return offers
}

// The fields of the detail the order accepts in its status: the api's table. While a guide is live the tracking number is the
// carrier's and nobody types over it (`hasActiveShipment`, from the guides the Shipping panel reads).
export function editableFieldsOf(
  status: string,
  hasActiveShipment = false
): readonly OrderEditableField[] {
  const known = asOrderStatus(status)
  return known === null ? [] : editableOrderFields(known, { hasActiveShipment })
}

export function canEditField(
  status: string,
  field: OrderEditableField,
  can: CanDo,
  hasActiveShipment = false
): boolean {
  return (
    can(ClientPermissions.ORDERS_EDIT) &&
    editableFieldsOf(status, hasActiveShipment).includes(field)
  )
}

// The payment states a record may move to from the current one (the same one is allowed: a reference added later), as the api
// checks them: the table of the payment, the cancelled order, the cash on delivery that waits for the delivery, and the price
// that waits for an approval not being taken as paid
export function paymentTargets(order: {
  status: string
  paymentStatus: string
  paymentMethod: string
  priceApprovalStatus: string
}): PaymentStatus[] {
  const status = asOrderStatus(order.status)
  const from = asPaymentStatus(order.paymentStatus)
  const method = asPaymentMethod(order.paymentMethod)
  const approval = asPriceApprovalStatus(order.priceApprovalStatus)
  if (status === null || from === null || method === null || approval === null) return []
  const candidates = [from, ...PaymentStatusTransitions[from]]
  return candidates.filter(to => {
    if (to === PaymentStatus.COMPLETED && isPriceApprovalBlocking(approval)) return false
    return checkPaymentChange({ orderStatus: status, orderPaymentMethod: method, from, to }).ok
  })
}
