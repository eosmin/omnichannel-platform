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
