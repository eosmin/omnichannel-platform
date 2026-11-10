import { OrderStatus } from './status-enums'

export const OrderMessageKind = {
  ORDER_SUMMARY: 'order_summary',
  ORDER_SHIPPED: 'order_shipped',
  ORDER_OUT_FOR_DELIVERY: 'order_out_for_delivery',
  ORDER_DELIVERED: 'order_delivered',
  ORDER_FAILED_ATTEMPT: 'order_failed_attempt',
  ORDER_CANCELLED: 'order_cancelled',
  RETURN_APPROVED: 'return_approved',
  EXCHANGE_SHIPPED: 'exchange_shipped'
} as const
export type OrderMessageKindType = (typeof OrderMessageKind)[keyof typeof OrderMessageKind]

// The only placeholders an order message template may use (TDD_17 §4.7).
export const OrderMessageVariables = {
  CUSTOMER_NAME: 'customerName',
  ORDER_NUMBER: 'orderNumber',
  ITEMS_LIST: 'itemsList',
  TOTAL: 'total',
  SHIPPING_ADDRESS: 'shippingAddress',
  CARRIER_NAME: 'carrierName',
  TRACKING_NUMBER: 'trackingNumber',
  TRACKING_URL: 'trackingUrl',
  STORE_NAME: 'storeName',
  COD_AMOUNT: 'codAmount',
  ATTEMPT_NUMBER: 'attemptNumber', // The shipment's failedAttempts (TDD_17 §4.7)
  MAX_ATTEMPTS: 'maxAttempts' // The connection's maxDeliveryAttempts
} as const
export type OrderMessageVariable =
  (typeof OrderMessageVariables)[keyof typeof OrderMessageVariables]

// How often the customer is told that a delivery attempt failed: the preference
// orders.failedAttemptMessages (TDD_17 §4.14). It replaces autoSend for ORDER_FAILED_ATTEMPT.
export const FailedAttemptMessagePolicy = {
  EVERY_ATTEMPT: 'every_attempt',
  FIRST_ONLY: 'first_only',
  NONE: 'none'
} as const
export type FailedAttemptMessagePolicyType =
  (typeof FailedAttemptMessagePolicy)[keyof typeof FailedAttemptMessagePolicy]

// GET /orders/:id/print/:doc (TDD_09 §5.4). The order summary is the PDF that can travel with the
// summary message (TDD_17 §4.7).
export const OrderPrintDocuments = {
  PACKING_SLIP: 'packing_slip', // For the warehouse
  INVOICE: 'invoice', // For the customer
  SHIPPING_LABEL: 'shipping_label', // For the courier: the carrier's stored label
  ORDER_SUMMARY: 'order_summary'
} as const
export type OrderPrintDocument = (typeof OrderPrintDocuments)[keyof typeof OrderPrintDocuments]

// Factory cancellation reasons (TDD_09 §5.3): the seed of the per-store list in the preference
// orders.cancellationReasons (TDD_17 §4.14). Each value is an i18n key; a store adds, renames or
// removes entries in Settings → Preferences without code, a custom entry carrying its own label.
export const OrderCancellationReasons = {
  CUSTOMER_REQUEST: 'orders.cancellationReason.customerRequest',
  OUT_OF_STOCK: 'orders.cancellationReason.outOfStock',
  PAYMENT_FAILED: 'orders.cancellationReason.paymentFailed',
  UNDELIVERABLE_ADDRESS: 'orders.cancellationReason.undeliverableAddress',
  DUPLICATE: 'orders.cancellationReason.duplicate',
  OTHER: 'orders.cancellationReason.other'
} as const
export type OrderCancellationReason =
  (typeof OrderCancellationReasons)[keyof typeof OrderCancellationReasons]

// Order.recipientPhones (TDD_02 §13): the numbers the carriers receive, as national digits with no country code.
// A carrier adapter and the `local` label join them with LIST_SEPARATOR through formatPhoneList.
export const RecipientPhones = {
  MAX_COUNT: 3,
  // The shortest number a person can dial anywhere the stores sell: fewer digits is a typo, not a phone
  MIN_DIGITS: 6,
  // E.164 allows 15 digits in all, the country code included, so no national number is longer
  MAX_DIGITS: 15,
  LIST_SEPARATOR: ' / '
} as const

export function formatPhoneList(phones: readonly string[]): string {
  return phones.join(RecipientPhones.LIST_SEPARATOR)
}

// Money is whole USD cents (TDD_02 §13); the totals are Int columns of 32 bits
export const ORDER_MAX_AMOUNT_CENTS = 2_147_483_647

export const OrderLimits = {
  // Lines of one order; a cart longer than this is a purchase order, which this module does not take
  MAX_LINES: 100,
  MAX_QUANTITY_PER_LINE: 10_000,
  CUSTOMER_NOTES_MAX_LENGTH: 1000,
  // The same ceiling as the customer's notes (owner, 2026-11-10)
  INTERNAL_NOTES_MAX_LENGTH: 1000,
  PACKING_NOTES_MAX_LENGTH: 1000,
  // The reason of a discount, of a fee outside its range, and of a price change
  PRICE_REASON_MAX_LENGTH: 500,
  CANCELLATION_REASON_MAX_LENGTH: 500,
  PAYMENT_REFERENCE_MAX_LENGTH: 100,
  TRACKING_NUMBER_MAX_LENGTH: 100
} as const

// orders.freeShippingRule (TDD_17 §4.13, §4.14): when an order counts as free shipping
export const OrderFreeShippingRules = {
  ALL_ITEMS: 'all_items',
  ANY_ITEM: 'any_item'
} as const
export type OrderFreeShippingRule =
  (typeof OrderFreeShippingRules)[keyof typeof OrderFreeShippingRules]

// GET /orders, scheduled delivery (decision D18): inclusive days from and to, or one shortcut resolved with the
// timezone of the store. The names are the query keys; nobody writes them inline.
export const OrderScheduleFilters = {
  FROM: 'scheduledDeliveryFrom',
  TO: 'scheduledDeliveryTo',
  ON: 'scheduledDeliveryOn'
} as const

export const OrderScheduledDeliveryShortcuts = {
  TODAY: 'today',
  TOMORROW: 'tomorrow'
} as const
export type OrderScheduledDeliveryShortcut =
  (typeof OrderScheduledDeliveryShortcuts)[keyof typeof OrderScheduledDeliveryShortcuts]

// The orders of GET /orders come newest first unless the caller asks for the days of delivery, soonest first
export const OrderSorts = {
  NEWEST: 'newest',
  SCHEDULED_DELIVERY: 'scheduled_delivery'
} as const
export type OrderSort = (typeof OrderSorts)[keyof typeof OrderSorts]

// Who is told when the packing note changes on an order that is already confirmed: the members who may prepare or
// ship orders of the store (the permissions are named in libs/core/domain/auth/permissions.ts)
export const PackingNoteNotice = {
  // The statuses in which a change of the note warns the warehouse (a PENDING_CONFIRMATION order is not packed yet)
  STATUSES: [OrderStatus.CONFIRMED, OrderStatus.PREPARING] as readonly OrderStatus[]
} as const
