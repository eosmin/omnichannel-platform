import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// Settings → Carriers (TDD_17 §6, §4.17): the carrier connections of the store in X-Store-Id and the mapping of each
// connection's status codes. Reading asks for shipping:view; connecting, editing, testing, rotating the secret,
// disconnecting and changing a mapping, for settings:manage_carriers. Nothing secret is ever read: the credentials and
// the secret of the webhook only say they exist, and the secret is shown once, in the answer that made it.

const serviceSchema = z.object({ code: z.string(), label: z.string(), active: z.boolean() })
export type CarrierServiceView = z.output<typeof serviceSchema>

const connectionSchema = z.object({
  id: z.string(),
  carrierId: z.string(),
  carrierName: z.string(),
  displayName: z.string(),
  status: z.string(),
  hasCredentials: z.boolean(),
  hasWebhookSecret: z.boolean(),
  webhookUrl: z.string().nullable(),
  capabilities: z.array(z.string()),
  isDefault: z.boolean(),
  defaultServiceCode: z.string().nullable(),
  defaultShippingPayer: z.string(),
  labelFormat: z.string(),
  contact: z.record(z.string(), z.unknown()).nullable(),
  guidePrefix: z.string().nullable(),
  services: z.array(serviceSchema),
  pickupEnabled: z.boolean(),
  pickupDays: z.array(z.number().int()),
  pickupCutoffTime: z.string().nullable(),
  autoPickup: z.boolean(),
  autoPickupTime: z.string().nullable(),
  pickupReminderMinutes: z.number().int(),
  pollIntervalMinutes: z.number().int().nullable(),
  maxDeliveryAttempts: z.number().int(),
  defaultShippingFeeCents: z.number().int().nullable(),
  minShippingFeeCents: z.number().int().nullable(),
  maxShippingFeeCents: z.number().int().nullable(),
  remittanceDeductsFee: z.boolean(),
  // What a disconnect leaves without a carrier to ask
  openShipments: z.number().int(),
  openPickups: z.number().int(),
  lastHealthyAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CarrierConnectionView = z.output<typeof connectionSchema>

// The connect call adds the secret the carrier signs its webhook with, once
const connectedSchema = connectionSchema.extend({ webhookSecret: z.string().nullable() })
export type ConnectedCarrierView = z.output<typeof connectedSchema>

// One field of the connect form a carrier declares (the registry's copy): the form is drawn from the list, and `credentials[key]` is sent
// back. The label is a message key of the app or the plugin's own text in each language; `secret` fields are drawn masked
const connectFieldSchema = z.object({
  key: z.string(),
  labelKey: z.string().nullable(),
  label: z.object({ es: z.string(), en: z.string() }).nullable(),
  helpKey: z.string().nullable(),
  secret: z.boolean(),
  required: z.boolean(),
  multiple: z.boolean()
})
export type CarrierConnectFieldView = z.output<typeof connectFieldSchema>

const registryEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()),
  shipmentCreation: z.string(),
  maxBatchSize: z.number().int().nullable(),
  hasCredentials: z.boolean(),
  services: z.array(z.object({ code: z.string(), label: z.string() })),
  // Empty: the carrier draws no form of its own and its credentials are the free JSON it reads
  connectFields: z.array(connectFieldSchema)
})
export type CarrierRegistryEntryView = z.output<typeof registryEntrySchema>

// A place a carrier lists for the address of a guide
const locationSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable()
})
export type CarrierLocationView = z.output<typeof locationSchema>

// A code of the carrier's status catalog and the row the connection holds for it (`hasMapping` false: none yet, and a put makes it)
const statusCatalogEntrySchema = z.object({
  providerCode: z.string(),
  label: z.string(),
  defaultStatus: z.string().nullable(),
  hasMapping: z.boolean(),
  mappedStatus: z.string().nullable(),
  source: z.string().nullable()
})
export type CarrierStatusCatalogEntryView = z.output<typeof statusCatalogEntrySchema>

const testResultSchema = z.object({
  healthy: z.boolean(),
  checkedAt: z.string(),
  reason: z.string().nullable()
})
export type CarrierTestResultView = z.output<typeof testResultSchema>

const mappingSchema = z.object({
  providerCode: z.string(),
  label: z.string().nullable(),
  // null: the owner chose to ignore the code on purpose
  status: z.string().nullable(),
  source: z.string(),
  updatedAt: z.string()
})
export type StatusMappingView = z.output<typeof mappingSchema>

const unmappedSchema = z.object({
  providerCode: z.string(),
  sampleRawStatus: z.string(),
  occurrences: z.number().int(),
  shipmentsWaiting: z.number().int(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
})
export type UnmappedStatusView = z.output<typeof unmappedSchema>

function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() })
}
const connectionPageSchema = pageOf(connectionSchema)
const mappingPageSchema = pageOf(mappingSchema)
const unmappedPageSchema = pageOf(unmappedSchema)
export type CarrierConnectionPageView = z.output<typeof connectionPageSchema>
export type StatusMappingPageView = z.output<typeof mappingPageSchema>
export type UnmappedStatusPageView = z.output<typeof unmappedPageSchema>

// The settings both calls take; every one is optional and only what changes is sent
export interface CarrierSettingsInput {
  defaultServiceCode?: string
  defaultShippingPayer?: string
  labelFormat?: string
  pickupEnabled?: boolean
  pickupDays?: number[]
  pickupCutoffTime?: string | null
  autoPickup?: boolean
  autoPickupTime?: string | null
  pickupReminderMinutes?: number
  pollIntervalMinutes?: number | null
  maxDeliveryAttempts?: number
  defaultShippingFeeCents?: number | null
  minShippingFeeCents?: number | null
  maxShippingFeeCents?: number | null
  remittanceDeductsFee?: boolean
  isDefault?: boolean
}

export interface ConnectCarrierInput extends CarrierSettingsInput {
  carrierId: string
  credentials: Record<string, unknown>
  displayName?: string
}

export interface UpdateCarrierInput extends CarrierSettingsInput {
  displayName?: string
  credentials?: Record<string, unknown>
  services?: { code: string; label?: string; active?: boolean }[]
}

const enc = encodeURIComponent

// An account holds at most 50 connections (CarrierConnectionLimits.MAX_PER_STORE): the pages are followed up to the
// bound the api keeps, never further, so a cursor that never ends cannot loop
const MAX_PAGES = 10

export function fetchCarrierRegistry(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<CarrierRegistryEntryView[]> {
  return client.request(ApiRoutes.carriers.registry, {
    schema: z.array(registryEntrySchema),
    storeId,
    signal
  })
}

export async function fetchAllCarrierConnections(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<CarrierConnectionView[]> {
  const found: CarrierConnectionView[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const params = new URLSearchParams({ limit: String(PaginationLimits.MAX) })
    if (cursor !== null) params.set('cursor', cursor)
    const page: CarrierConnectionPageView = await client.request(
      `${ApiRoutes.carriers.list}?${params.toString()}`,
      { schema: connectionPageSchema, storeId, signal }
    )
    found.push(...page.data)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return found
}

export function connectCarrier(
  client: ApiClient,
  storeId: string,
  input: ConnectCarrierInput
): Promise<ConnectedCarrierView> {
  return client.request(ApiRoutes.carriers.create, {
    method: 'POST',
    body: input,
    schema: connectedSchema,
    storeId
  })
}

export function updateCarrier(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateCarrierInput
): Promise<CarrierConnectionView> {
  return client.request(ApiRoutes.carriers.byId(enc(id)), {
    method: 'PATCH',
    body: input,
    schema: connectionSchema,
    storeId
  })
}

export function testCarrier(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<CarrierTestResultView> {
  return client.request(ApiRoutes.carriers.test(enc(id)), {
    method: 'POST',
    schema: testResultSchema,
    storeId
  })
}

// The answer holds the new secret, once: the page keeps it in memory only while its dialog is open
export function rotateCarrierWebhookSecret(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<{ webhookSecret: string }> {
  return client.request(ApiRoutes.carriers.webhookSecret(enc(id)), {
    method: 'POST',
    schema: z.object({ webhookSecret: z.string() }),
    storeId
  })
}

export function disconnectCarrier(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<CarrierConnectionView> {
  return client.request(ApiRoutes.carriers.disconnect(enc(id)), {
    method: 'POST',
    schema: connectionSchema,
    storeId
  })
}

export function fetchStatusMappings(
  client: ApiClient,
  storeId: string,
  id: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<StatusMappingPageView> {
  const params = new URLSearchParams({ limit: String(PaginationLimits.MAX) })
  if (cursor !== null) params.set('cursor', cursor)
  return client.request(`${ApiRoutes.carriers.statusMappings(enc(id))}?${params.toString()}`, {
    schema: mappingPageSchema,
    storeId,
    signal
  })
}

export function fetchUnmappedStatuses(
  client: ApiClient,
  storeId: string,
  id: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<UnmappedStatusPageView> {
  const params = new URLSearchParams({ limit: String(PaginationLimits.MAX) })
  if (cursor !== null) params.set('cursor', cursor)
  return client.request(`${ApiRoutes.carriers.unmappedStatuses(enc(id))}?${params.toString()}`, {
    schema: unmappedPageSchema,
    storeId,
    signal
  })
}

// `status: null` ignores the code on purpose; the code is the one the list gave, encoded for the address
export function putStatusMapping(
  client: ApiClient,
  storeId: string,
  id: string,
  providerCode: string,
  status: string | null
): Promise<StatusMappingView> {
  return client.request(ApiRoutes.carriers.statusMappingByCode(enc(id), enc(providerCode)), {
    method: 'PUT',
    body: { status },
    schema: mappingSchema,
    storeId
  })
}

// Back to the plugin's default for the code (or no row, for a code the plugin does not know)
export function removeStatusMapping(
  client: ApiClient,
  storeId: string,
  id: string,
  providerCode: string
): Promise<void> {
  return client.request(ApiRoutes.carriers.statusMappingByCode(enc(id), enc(providerCode)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// The places under one parent (none: the top level), optionally narrowed by a part of the name. The api keeps the list of a parent
// for a day, so asking again while someone types is cheap. Needs shipping:view; a carrier that lists no places answers 409.
export function fetchCarrierLocations(
  client: ApiClient,
  storeId: string,
  id: string,
  query: { parentId?: string; search?: string } = {},
  signal?: AbortSignal
): Promise<CarrierLocationView[]> {
  const params = new URLSearchParams()
  if (query.parentId !== undefined) params.set('parentId', query.parentId)
  if (query.search !== undefined && query.search.trim() !== '') params.set('search', query.search)
  const suffix = params.size === 0 ? '' : `?${params.toString()}`
  return client.request(`${ApiRoutes.carriers.locations(enc(id))}${suffix}`, {
    schema: z.array(locationSchema),
    storeId,
    signal
  })
}

// Every code the carrier's plugin knows, with the row the connection holds for it: what the mapping table offers to add
export function fetchCarrierStatusCatalog(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<CarrierStatusCatalogEntryView[]> {
  return client.request(ApiRoutes.carriers.statusCatalog(enc(id)), {
    schema: z.array(statusCatalogEntrySchema),
    storeId,
    signal
  })
}
