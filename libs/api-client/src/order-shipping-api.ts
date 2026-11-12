import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type { CreateShipmentBody, OrderMessageKindType } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the order detail reads of the guides of one order (TDD_17 §6): the screen of shipments has its own, wider view. Every field
// is one the api answers for `shipping:view`; the label is stored once and printed from there (`hasLabel` says it is ready).
const orderShipmentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  kind: z.string(),
  returnId: z.string().nullable(),
  status: z.string(),
  serviceCode: z.string(),
  shippingPayer: z.string(),
  codAmountCents: z.number().int().nullable(),
  guideNumber: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  hasLabel: z.boolean(),
  pickupId: z.string().nullable(),
  failedAttempts: z.number().int(),
  // A name of a closed list, or one line the carrier said when it refused
  lastError: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string()
})
export type OrderShipmentView = z.output<typeof orderShipmentSchema>

const orderShipmentPageSchema = z.object({
  data: z.array(orderShipmentSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})

// An order has a handful of guides (the ones that were voided and remade): one page of the most the api gives holds them all
const ORDER_SHIPMENTS_LIMIT = 100

export function fetchOrderShipments(
  client: ApiClient,
  storeId: string,
  orderId: string,
  signal?: AbortSignal
): Promise<OrderShipmentView[]> {
  const search = new URLSearchParams({ orderId, limit: String(ORDER_SHIPMENTS_LIMIT) })
  return client
    .request(`${ApiRoutes.shipments.list}?${search.toString()}`, {
      schema: orderShipmentPageSchema,
      storeId,
      signal
    })
    .then(page => page.data)
}

// Makes the guide of an order. The answer is the guide as the carrier left it (a pickup-bound carrier answers it after the pickup)
export function createOrderShipment(
  client: ApiClient,
  storeId: string,
  orderId: string,
  body: CreateShipmentBody
): Promise<OrderShipmentView> {
  return client.request(ApiRoutes.shipments.forOrder(orderId), {
    method: 'POST',
    body,
    schema: orderShipmentSchema,
    storeId
  })
}

// Asks the carrier to cancel the guide: the answer is `cancel_pending` until it says yes, `cancelled`, or `cancel_failed`
export function cancelOrderShipment(
  client: ApiClient,
  storeId: string,
  shipmentId: string
): Promise<OrderShipmentView> {
  return client.request(ApiRoutes.shipments.cancel(shipmentId), {
    method: 'POST',
    schema: orderShipmentSchema,
    storeId
  })
}

// Voids a guide by hand when the carrier cannot cancel it (the guide is dead on our side; whoever made it tells the carrier)
export function markOrderShipmentVoided(
  client: ApiClient,
  storeId: string,
  shipmentId: string
): Promise<OrderShipmentView> {
  return client.request(ApiRoutes.shipments.markVoided(shipmentId), {
    method: 'POST',
    schema: orderShipmentSchema,
    storeId
  })
}

const labelLinkSchema = z.object({ url: z.string(), filename: z.string() })
export type ShipmentLabelLinkView = z.output<typeof labelLinkSchema>

// A link good for minutes: it is opened right away and kept nowhere
export function fetchShipmentLabelLink(
  client: ApiClient,
  storeId: string,
  shipmentId: string
): Promise<ShipmentLabelLinkView> {
  return client.request(ApiRoutes.shipments.label(shipmentId), {
    schema: labelLinkSchema,
    storeId
  })
}

// What a message of a kind would say about the order, with nothing sent (`?preview=true`): the text, or what is missing for it
const previewSchema = z.discriminatedUnion('ok', [
  z.object({ preview: z.literal(true), ok: z.literal(true), text: z.string(), locale: z.string() }),
  z.object({
    preview: z.literal(true),
    ok: z.literal(false),
    reason: z.string(),
    missing: z.array(z.string())
  })
])
export type OrderMessagePreviewView = z.output<typeof previewSchema>

export function previewOrderMessage(
  client: ApiClient,
  storeId: string,
  orderId: string,
  kind: OrderMessageKindType,
  shipmentId?: string
): Promise<OrderMessagePreviewView> {
  return client.request(`${ApiRoutes.orders.messages(orderId)}?preview=true`, {
    method: 'POST',
    body: { kind, ...(shipmentId === undefined ? {} : { shipmentId }) },
    schema: previewSchema,
    storeId
  })
}
