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
  COD_AMOUNT: 'codAmount'
} as const
export type OrderMessageVariable =
  (typeof OrderMessageVariables)[keyof typeof OrderMessageVariables]
