import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The Shipments screen (TDD_17 §4.6, §4.8, §6): the guides of the store with their filters, one guide with its history and
// what a person may do with it. Reading asks for shipping:view; every change and the label, for shipping:manage. A state, a
// payer or a code stays text: a value this page does not know (a newer server) must still draw.

const shipmentRowSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  carrierId: z.string(),
  kind: z.string(),
  returnId: z.string().nullable(),
  status: z.string(),
  serviceCode: z.string(),
  shippingPayer: z.string(),
  codAmountCents: z.number().int().nullable(),
  codStatus: z.string(),
  currency: z.string(),
  packageCount: z.number().int(),
  failedAttempts: z.number().int(),
  guideNumber: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  hasLabel: z.boolean(),
  carrierCostCents: z.number().int().nullable(),
  refundStatus: z.string(),
  pickupId: z.string().nullable(),
  // A name of a closed list, or one line the carrier said when it refused
  lastError: z.string().nullable(),
  cancelRequestedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type ShipmentRowView = z.output<typeof shipmentRowSchema>

const shipmentPageSchema = z.object({
  data: z.array(shipmentRowSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ShipmentRowPageView = z.output<typeof shipmentPageSchema>

// The filters of the list: a state, a connection, an order and a range of days. `from` and `to` are moments (ISO).
export interface ShipmentListFilter {
  status?: string
  connectionId?: string
  orderId?: string
  from?: string
  to?: string
}

export function fetchShipmentList(
  client: ApiClient,
  storeId: string,
  filter: ShipmentListFilter & { cursor?: string | null },
  signal?: AbortSignal
): Promise<ShipmentRowPageView> {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  for (const key of ['status', 'connectionId', 'orderId', 'from', 'to'] as const) {
    const value = filter[key]
    if (value !== undefined && value !== '') search.set(key, value)
  }
  if (filter.cursor !== undefined && filter.cursor !== null) search.set('cursor', filter.cursor)
  return client.request(`${ApiRoutes.shipments.list}?${search.toString()}`, {
    schema: shipmentPageSchema,
    storeId,
    signal
  })
}

// One line of a guide's history. A line with no `status` is a carrier's status that no mapping knows: `rawStatus` is what it
// said (never its description, which can carry a name or an address), and the owner maps it in Settings → Carriers.
const eventSchema = z.object({
  id: z.string(),
  status: z.string().nullable(),
  rawStatus: z.string().nullable(),
  description: z.string().nullable(),
  occurredAt: z.string(),
  source: z.string()
})
export type ShipmentEventView = z.output<typeof eventSchema>

const shipmentDetailSchema = shipmentRowSchema.extend({ events: z.array(eventSchema) })
export type ShipmentDetailView = z.output<typeof shipmentDetailSchema>

export function fetchShipment(
  client: ApiClient,
  storeId: string,
  shipmentId: string,
  signal?: AbortSignal
): Promise<ShipmentDetailView> {
  return client.request(ApiRoutes.shipments.byId(shipmentId), {
    schema: shipmentDetailSchema,
    storeId,
    signal
  })
}

// Void the guide: at its carrier when the carrier can, and the answer says where it stands (`cancelled`, or `cancel_pending`
// while the carrier is asked, or `cancel_failed` when it could not be)
export function cancelShipment(
  client: ApiClient,
  storeId: string,
  shipmentId: string
): Promise<ShipmentRowView> {
  return client.request(ApiRoutes.shipments.cancel(shipmentId), {
    method: 'POST',
    schema: shipmentRowSchema,
    storeId
  })
}

// "Mark as voided": the agent voided it with the carrier by hand (the last step of `cancel_failed`)
export function markShipmentVoided(
  client: ApiClient,
  storeId: string,
  shipmentId: string
): Promise<ShipmentRowView> {
  return client.request(ApiRoutes.shipments.markVoided(shipmentId), {
    method: 'POST',
    schema: shipmentRowSchema,
    storeId
  })
}

const checkResultSchema = z.object({ found: z.boolean(), shipment: shipmentRowSchema })
export type ShipmentCheckResultView = z.output<typeof checkResultSchema>

// Ask the carrier whether it has the guide (a guide of unknown outcome): `found` says what it answered
export function checkShipmentWithCarrier(
  client: ApiClient,
  storeId: string,
  shipmentId: string
): Promise<ShipmentCheckResultView> {
  return client.request(ApiRoutes.shipments.check(shipmentId), {
    method: 'POST',
    schema: checkResultSchema,
    storeId
  })
}

// A status set by hand (a manual event): the table of transitions decides from where. A guide number goes with
// `label_created` for a guide that was found at the carrier after an unknown outcome.
export function setShipmentStatus(
  client: ApiClient,
  storeId: string,
  shipmentId: string,
  input: { status: string; guideNumber?: string; description?: string }
): Promise<ShipmentRowView> {
  return client.request(ApiRoutes.shipments.status(shipmentId), {
    method: 'POST',
    body: input,
    schema: shipmentRowSchema,
    storeId
  })
}
