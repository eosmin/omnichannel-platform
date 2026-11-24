import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The Pickups screen (TDD_17 §4.10, §6): the pickups of the store, the guides each one holds, and what a person does with it.
// Reading and the manifest ask for shipping:view; every change, for shipping:manage_pickups. A state or a reason stays text: a
// value this page does not know (a newer server) must still draw. The request itself (`requestPickup`) is in `shipping-api`.

const pickupSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  carrierId: z.string(),
  // 'YYYY-MM-DD', in the timezone of the store
  pickupDate: z.string(),
  status: z.string(),
  packageCount: z.number().int(),
  revision: z.number().int(),
  providerPickupId: z.string().nullable(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  requestedBy: z.string(),
  // A name the screen translates, or the carrier's own line, bounded
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type PickupView = z.output<typeof pickupSchema>

const pickupPageSchema = z.object({
  data: z.array(pickupSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type PickupPageView = z.output<typeof pickupPageSchema>

// `from` and `to` are days ('YYYY-MM-DD')
export interface PickupListFilter {
  status?: string
  connectionId?: string
  from?: string
  to?: string
}

export function fetchPickups(
  client: ApiClient,
  storeId: string,
  filter: PickupListFilter & { cursor?: string | null },
  signal?: AbortSignal
): Promise<PickupPageView> {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  for (const key of ['status', 'connectionId', 'from', 'to'] as const) {
    const value = filter[key]
    if (value !== undefined && value !== '') search.set(key, value)
  }
  if (filter.cursor !== undefined && filter.cursor !== null) search.set('cursor', filter.cursor)
  return client.request(`${ApiRoutes.pickups.list}?${search.toString()}`, {
    schema: pickupPageSchema,
    storeId,
    signal
  })
}

const pickupRequestSchema = z.object({
  pickup: pickupSchema,
  created: z.boolean(),
  joined: z.array(z.string()),
  waiting: z.array(z.object({ shipmentId: z.string(), reason: z.string() }))
})
export type PickupChangeView = z.output<typeof pickupRequestSchema>

// Put guides in a pickup that exists. `confirmAfterCutoff` is the answer to the dialog of a change after the cutoff of the day.
// What could not join is in `waiting`, with its reason.
export function addPickupShipments(
  client: ApiClient,
  storeId: string,
  pickupId: string,
  input: { shipmentIds: readonly string[]; confirmAfterCutoff?: boolean }
): Promise<PickupChangeView> {
  return client.request(ApiRoutes.pickups.shipments(pickupId), {
    method: 'POST',
    body: input,
    schema: pickupRequestSchema,
    storeId
  })
}

export function removePickupShipment(
  client: ApiClient,
  storeId: string,
  pickupId: string,
  shipmentId: string
): Promise<PickupView> {
  return client.request(ApiRoutes.pickups.shipmentById(pickupId, shipmentId), {
    method: 'DELETE',
    schema: pickupSchema,
    storeId
  })
}

// The agent asked the carrier by hand (a pickup the platform cannot request, or one it could not settle)
export function confirmPickup(
  client: ApiClient,
  storeId: string,
  pickupId: string
): Promise<PickupView> {
  return client.request(ApiRoutes.pickups.confirm(pickupId), {
    method: 'POST',
    schema: pickupSchema,
    storeId
  })
}

export function cancelPickup(
  client: ApiClient,
  storeId: string,
  pickupId: string
): Promise<PickupView> {
  return client.request(ApiRoutes.pickups.cancel(pickupId), {
    method: 'POST',
    schema: pickupSchema,
    storeId
  })
}

const manifestSchema = z.object({
  pickupId: z.string(),
  connectionName: z.string(),
  pickupDate: z.string(),
  status: z.string(),
  packageCount: z.number().int(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  lines: z.array(
    z.object({
      shipmentId: z.string(),
      guideNumber: z.string().nullable(),
      recipient: z.string(),
      orderNumber: z.string(),
      packageCount: z.number().int()
    })
  )
})
export type PickupManifestView = z.output<typeof manifestSchema>

// The list the agent prints for the courier: it names customers, so it is read when asked and never kept
export function fetchPickupManifest(
  client: ApiClient,
  storeId: string,
  pickupId: string,
  signal?: AbortSignal
): Promise<PickupManifestView> {
  return client.request(ApiRoutes.pickups.manifest(pickupId), {
    schema: manifestSchema,
    storeId,
    signal
  })
}
