import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { BulkLabelLimits, PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the orders page asks of shipping (TDD_17 §4.6, §4.10, §6): the guides of the rows it draws, the connections of the
// store (to name a carrier and to know what it can do), a bulk run of labels, the print of labels that exist and a pickup.
// A state, a code or a capability stays text: a value this page does not know (a newer server) must still draw, and the
// screens map the ones they know.

const shipmentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  kind: z.string(),
  status: z.string(),
  guideNumber: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  hasLabel: z.boolean(),
  pickupId: z.string().nullable(),
  createdAt: z.string()
})
export type ShipmentSummaryView = z.output<typeof shipmentSchema>

const shipmentPageSchema = z.object({
  data: z.array(shipmentSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ShipmentPageView = z.output<typeof shipmentPageSchema>

// The shipments of the orders on the screen: the orders go in requests of at most a run's worth (the api takes no more) and
// each request follows its cursor to the end, so no order with a guide looks guide-less because the list was cut
export async function fetchShipmentsForOrders(
  client: ApiClient,
  storeId: string,
  orderIds: readonly string[],
  signal?: AbortSignal
): Promise<ShipmentPageView> {
  const data: ShipmentSummaryView[] = []
  for (let start = 0; start < orderIds.length; start += BulkLabelLimits.MAX_ORDERS) {
    const ids = orderIds.slice(start, start + BulkLabelLimits.MAX_ORDERS).join(',')
    let cursor: string | null = null
    do {
      const search = new URLSearchParams({ orderIds: ids, limit: String(PaginationLimits.MAX) })
      if (cursor !== null) search.set('cursor', cursor)
      const page: ShipmentPageView = await client.request(
        `${ApiRoutes.shipments.list}?${search.toString()}`,
        { schema: shipmentPageSchema, storeId, signal }
      )
      data.push(...page.data)
      cursor = page.hasMore ? page.nextCursor : null
    } while (cursor !== null)
  }
  return { data, nextCursor: null, hasMore: false }
}

const fileLinkSchema = z.object({ url: z.string(), filename: z.string() })

const bulkEntrySchema = z.object({
  orderId: z.string(),
  outcome: z.string(),
  shipmentId: z.string().optional(),
  shipmentIds: z.array(z.string()).optional(),
  errorCode: z.string().optional(),
  reason: z.string().optional()
})
export type BulkLabelEntryView = z.output<typeof bulkEntrySchema>

const bulkJobSchema = z.object({
  id: z.string(),
  status: z.string(),
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  results: z.array(bulkEntrySchema).nullable(),
  download: fileLinkSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable()
})
export type BulkLabelJobView = z.output<typeof bulkJobSchema>

// The run is queued and answers 202: its state is read with `fetchBulkLabelJob`. `connectionId` makes every order of the run
// use that connection; left out, each order follows its planned carrier. `locationIds` are the places a carrier that asks for them
// needs, chosen once for the whole run, and only go with a `connectionId`.
export function startBulkLabels(
  client: ApiClient,
  storeId: string,
  input: {
    orderIds: readonly string[]
    connectionId?: string
    locationIds?: { departmentId: string; municipalityId: string }
  }
): Promise<BulkLabelJobView> {
  return client.request(ApiRoutes.shipments.bulk, {
    method: 'POST',
    body: input,
    schema: bulkJobSchema,
    storeId
  })
}

export function fetchBulkLabelJob(
  client: ApiClient,
  storeId: string,
  jobId: string,
  signal?: AbortSignal
): Promise<BulkLabelJobView> {
  return client.request(ApiRoutes.shipments.bulkJob(jobId), {
    schema: bulkJobSchema,
    storeId,
    signal
  })
}

const mergeSchema = z.object({
  download: fileLinkSchema.nullable(),
  merged: z.array(z.string()),
  leftOut: z.array(z.object({ shipmentId: z.string(), reason: z.string() })),
  pageCount: z.number().int(),
  mixedSizes: z.boolean()
})
export type LabelMergeView = z.output<typeof mergeSchema>

// "Print labels" of guides that exist: no carrier is called
export function mergeLabels(
  client: ApiClient,
  storeId: string,
  shipmentIds: readonly string[]
): Promise<LabelMergeView> {
  return client.request(ApiRoutes.shipments.mergeLabels, {
    method: 'POST',
    body: { shipmentIds },
    schema: mergeSchema,
    storeId
  })
}

const pickupSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  pickupDate: z.string(),
  status: z.string(),
  packageCount: z.number().int()
})
const pickupRequestSchema = z.object({
  pickup: pickupSchema,
  created: z.boolean(),
  joined: z.array(z.string()),
  waiting: z.array(z.object({ shipmentId: z.string(), reason: z.string() }))
})
export type PickupRequestView = z.output<typeof pickupRequestSchema>

// Ask the carrier to come for the guides named (or, without any, for every guide of the connection that is waiting).
// `confirmAfterCutoff` is the answer to the dialog of a request after the cutoff of the day.
export function requestPickup(
  client: ApiClient,
  storeId: string,
  input: {
    connectionId: string
    shipmentIds?: readonly string[]
    confirmAfterCutoff?: boolean
  }
): Promise<PickupRequestView> {
  return client.request(ApiRoutes.pickups.create, {
    method: 'POST',
    body: input,
    schema: pickupRequestSchema,
    storeId
  })
}

// What "send the summary" over one order answers: sent, or why it was not (a value of OrderMessageNotSentReasons)
const messageOutcomeSchema = z.object({
  status: z.string(),
  reason: z.string().nullable().optional()
})
export type OrderMessageOutcomeView = z.output<typeof messageOutcomeSchema>

// What a preview answers: the text the customer would read, or why the message cannot be made (with the variables that have no value)
const messagePreviewSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string(), locale: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string(), missing: z.array(z.string()) })
])
export type OrderMessagePreviewView = z.output<typeof messagePreviewSchema>

// The message as the customer would read it, from the real order; nothing is sent and nothing is written
export function previewOrderMessage(
  client: ApiClient,
  storeId: string,
  orderId: string,
  kind: string
): Promise<OrderMessagePreviewView> {
  return client.request(`${ApiRoutes.orders.messages(orderId)}?preview=true`, {
    method: 'POST',
    body: { kind },
    schema: messagePreviewSchema,
    storeId
  })
}

// One press of the button is one key: the order is sent once even when the answer is lost and the press is repeated
export function sendOrderMessage(
  client: ApiClient,
  storeId: string,
  orderId: string,
  input: { kind: string; idempotencyKey: string }
): Promise<OrderMessageOutcomeView> {
  return client.request(ApiRoutes.orders.messages(orderId), {
    method: 'POST',
    body: input,
    schema: messageOutcomeSchema,
    storeId
  })
}

// One message about an order that was asked for (the history of the Messages panel): where it went, or why it did not. The text of
// the message is not part of it. States, routes, kinds and reasons stay text, as above.
const messageHistoryItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  trigger: z.string(),
  route: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  locale: z.string().nullable(),
  shipmentId: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
  deliveryError: z.string().nullable(),
  requestedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string()
})
export type OrderMessageHistoryItemView = z.output<typeof messageHistoryItemSchema>

const messageHistoryPageSchema = z.object({
  data: z.array(messageHistoryItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type OrderMessageHistoryPageView = z.output<typeof messageHistoryPageSchema>

// A page of the history, newest first; the cursor of the last page asks for the next one
export function fetchOrderMessages(
  client: ApiClient,
  storeId: string,
  orderId: string,
  cursor?: string,
  signal?: AbortSignal
): Promise<OrderMessageHistoryPageView> {
  const search = new URLSearchParams()
  if (cursor !== undefined) search.set('cursor', cursor)
  const query = search.size === 0 ? '' : `?${search.toString()}`
  return client.request(`${ApiRoutes.orders.messages(orderId)}${query}`, {
    schema: messageHistoryPageSchema,
    storeId,
    signal
  })
}
