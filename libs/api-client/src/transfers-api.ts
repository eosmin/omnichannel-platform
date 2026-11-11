import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { PaginationLimits, TransferShortageAction, TransferStatus } from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The transfers between the warehouses of the organization of the store in X-Store-Id (TDD_16 §4.5, §6). Reading asks
// for inventory:manage_transfers or inventory:receive_transfers; making, editing, dispatching and cancelling for the
// first, receiving and closing for the second. What an answer shows of the lines is the stores the caller belongs to
// (and holds a transfer permission in): a transfer made only of other stores' lines is not in the answers at all.

const warehouseSchema = z.object({ id: z.string(), name: z.string(), code: z.string() })
export type TransferWarehouseView = z.output<typeof warehouseSchema>

const lineSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  productId: z.string(),
  productName: z.string(),
  variantId: z.string().nullable(),
  variantName: z.string().nullable(),
  sku: z.string().nullable(),
  quantity: z.number().int(),
  receivedQuantity: z.number().int(),
  pendingQuantity: z.number().int(),
  shortageAction: z.enum(TransferShortageAction).nullable()
})
export type TransferLineView = z.output<typeof lineSchema>

const headerShape = {
  id: z.string(),
  number: z.string(),
  status: z.enum(TransferStatus),
  fromWarehouse: warehouseSchema,
  toWarehouse: warehouseSchema,
  note: z.string().nullable(),
  createdBy: z.string(),
  dispatchedBy: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
}

const summarySchema = z.object({ ...headerShape, lineCount: z.number().int() })
export type TransferSummaryView = z.output<typeof summarySchema>

const transferSchema = z.object({ ...headerShape, lines: z.array(lineSchema) })
export type TransferView = z.output<typeof transferSchema>

const pageSchema = z.object({
  data: z.array(summarySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type TransferPageView = z.output<typeof pageSchema>

// One item of a draft: the store is the one of the product, never sent
export interface TransferLineInput {
  productId: string
  variantId?: string
  quantity: number
}

export interface CreateTransferInput {
  fromWarehouseId: string
  toWarehouseId: string
  note?: string
  lines?: readonly TransferLineInput[]
}

// A draft is edited whole: the lines sent REPLACE the lines of the stores of the caller; a null note clears it
export interface UpdateTransferInput {
  fromWarehouseId?: string
  toWarehouseId?: string
  note?: string | null
  lines?: readonly TransferLineInput[]
}

// The client's receipt: `receiptKey` is a UUID made once per attempt, so a double click or a retry receives once
export interface ReceiveTransferInput {
  receiptKey: string
  lines: readonly { lineId: string; quantity: number }[]
}

// Every line that did not arrive in full says what is done with the units that are missing
export interface CloseTransferInput {
  lines: readonly { lineId: string; action: TransferShortageAction }[]
}

export interface TransferListParams {
  status?: TransferStatus
  warehouseId?: string
  cursor?: string | null
  limit?: number
}

export function fetchTransferPage(
  client: ApiClient,
  storeId: string,
  params: TransferListParams = {},
  signal?: AbortSignal
): Promise<TransferPageView> {
  const search = new URLSearchParams()
  if (params.status !== undefined) search.set('status', params.status)
  if (params.warehouseId !== undefined) search.set('warehouseId', params.warehouseId)
  if (params.cursor !== undefined && params.cursor !== null) search.set('cursor', params.cursor)
  search.set('limit', String(params.limit ?? PaginationLimits.DEFAULT))
  return client.request(`${ApiRoutes.transfers.list}?${search.toString()}`, {
    schema: pageSchema,
    storeId,
    signal
  })
}

export function fetchTransfer(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.byId(encodeURIComponent(id)), {
    schema: transferSchema,
    storeId,
    signal
  })
}

export function createTransfer(
  client: ApiClient,
  storeId: string,
  input: CreateTransferInput
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.create, {
    method: 'POST',
    body: input,
    schema: transferSchema,
    storeId
  })
}

export function updateTransfer(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateTransferInput
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.byId(encodeURIComponent(id)), {
    method: 'PATCH',
    body: input,
    schema: transferSchema,
    storeId
  })
}

export function dispatchTransfer(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.dispatch(encodeURIComponent(id)), {
    method: 'POST',
    schema: transferSchema,
    storeId
  })
}

export function receiveTransfer(
  client: ApiClient,
  storeId: string,
  id: string,
  input: ReceiveTransferInput
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.receive(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: transferSchema,
    storeId
  })
}

export function closeTransfer(
  client: ApiClient,
  storeId: string,
  id: string,
  input: CloseTransferInput
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.close(encodeURIComponent(id)), {
    method: 'POST',
    body: input,
    schema: transferSchema,
    storeId
  })
}

export function cancelTransfer(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<TransferView> {
  return client.request(ApiRoutes.transfers.cancel(encodeURIComponent(id)), {
    method: 'POST',
    schema: transferSchema,
    storeId
  })
}
