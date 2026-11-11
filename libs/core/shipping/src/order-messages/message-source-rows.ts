import { orderShippingAddressSchema } from '@platform/core/domain'

import type { OrderMessageSource } from './message-values'

// What the service reads from the database to say something about an order: plain values, so that the assembly below is a
// function with no database (the service owns the selects). `shippingAddress` is the JSON column as it was stored.
export interface OrderMessageRows {
  orderNumber: string
  totalCents: number
  currency: string
  shippingAddress: unknown
  scheduledDeliveryDate: Date | null
  // The tracking number the order holds when its package has no guide of its own
  trackingNumber: string | null
  storeName: string
  customerName: string | null
  items: readonly {
    productName: string
    variantName: string | null
    quantity: number
    unitPriceCents: number
  }[]
  // The package the message is about, when there is one
  shipment: {
    carrierName: string
    guideNumber: string | null
    trackingUrl: string | null
    failedAttempts: number
    maxDeliveryAttempts: number
    codAmountCents: number | null
  } | null
}

const filled = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === '' ? null : value

// The values an order can fill a message with, as the preview and the sender both read them (TDD_17 §4.7). A value the order
// does not have stays null, and the variable that needs it makes the message not be sent instead of leaving a hole in it.
export function orderMessageSourceOf(rows: OrderMessageRows): OrderMessageSource {
  // An address stored in a shape the schema no longer accepts is a missing value, not a failure of the whole message
  const address = orderShippingAddressSchema.safeParse(rows.shippingAddress)
  const { shipment } = rows
  return {
    customerName: rows.customerName,
    orderNumber: rows.orderNumber,
    items: rows.items.map(item => ({
      name: item.productName,
      variantLabel: item.variantName,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents
    })),
    totalCents: rows.totalCents,
    currency: rows.currency,
    shippingAddress: address.success ? address.data : null,
    carrierName: shipment?.carrierName ?? null,
    // A guide that is blank is no guide: the number the order holds, or none, so the variable is missing and not empty
    trackingNumber: filled(shipment?.guideNumber) ?? filled(rows.trackingNumber),
    trackingUrl: shipment?.trackingUrl ?? null,
    storeName: rows.storeName,
    codAmountCents: shipment?.codAmountCents ?? null,
    failedAttempts: shipment?.failedAttempts ?? null,
    maxAttempts: shipment?.maxDeliveryAttempts ?? null,
    scheduledDeliveryDate: rows.scheduledDeliveryDate
  }
}
