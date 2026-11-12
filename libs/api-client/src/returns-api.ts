import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import {
  type ApproveReturnBody,
  type CompleteReturnBody,
  type CreateReturnBody,
  type CreateReturnShipmentBody,
  OrderReturnCondition,
  OrderReturnStatus,
  OrderReturnType,
  type ReceiveReturnBody,
  type ReturnDecisionBody,
  ShippingPayer
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the return routes answer (TDD_17 §4.11, §6). Quantities are whole units and amounts whole USD cents.
const returnLineSchema = z.object({
  id: z.string(),
  orderItemId: z.string(),
  productName: z.string(),
  variantName: z.string().nullable(),
  quantity: z.number().int(),
  // Set on receipt
  condition: z.enum(OrderReturnCondition).nullable(),
  restockWarehouseId: z.string().nullable()
})

const returnSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  type: z.enum(OrderReturnType),
  // The key of the reason (`DEFECTIVE`): the screen translates it
  reason: z.string(),
  status: z.enum(OrderReturnStatus),
  shippingPayer: z.enum(ShippingPayer),
  replacementOrderId: z.string().nullable(),
  returnShipmentId: z.string().nullable(),
  refundAmountCents: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  receivedAt: z.string().nullable(),
  lines: z.array(returnLineSchema)
})
export type ReturnView = z.output<typeof returnSchema>
export type ReturnLineView = z.output<typeof returnLineSchema>

const returnPageSchema = z.object({
  data: z.array(returnSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ReturnPageView = z.output<typeof returnPageSchema>

export interface ListReturnsParams {
  cursor?: string | null
  limit?: number
  status?: OrderReturnStatus
  orderId?: string
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchReturns(
  client: ApiClient,
  storeId: string,
  params: ListReturnsParams = {},
  signal?: AbortSignal
): Promise<ReturnPageView> {
  const search = query({
    cursor: params.cursor ?? undefined,
    limit: params.limit === undefined ? undefined : String(params.limit),
    status: params.status,
    orderId: params.orderId
  })
  return client.request(`${ApiRoutes.returns.list}${search}`, {
    schema: returnPageSchema,
    storeId,
    signal
  })
}

export function fetchReturn(
  client: ApiClient,
  storeId: string,
  returnId: string,
  signal?: AbortSignal
): Promise<ReturnView> {
  return client.request(ApiRoutes.returns.byId(returnId), {
    schema: returnSchema,
    storeId,
    signal
  })
}

export function createReturn(
  client: ApiClient,
  storeId: string,
  input: CreateReturnBody
): Promise<ReturnView> {
  return client.request(ApiRoutes.returns.create, {
    method: 'POST',
    body: input,
    schema: returnSchema,
    storeId
  })
}

function move(
  route: (id: string) => string
): (client: ApiClient, storeId: string, returnId: string) => Promise<ReturnView> {
  return (client, storeId, returnId) =>
    client.request(route(returnId), { method: 'POST', schema: returnSchema, storeId })
}

function moveWith<Body>(
  route: (id: string) => string
): (client: ApiClient, storeId: string, returnId: string, body: Body) => Promise<ReturnView> {
  return (client, storeId, returnId, body) =>
    client.request(route(returnId), { method: 'POST', body, schema: returnSchema, storeId })
}

// Requested → approved: the agent checked the reason and the evidence. An exchange names its replacement order, which the
// server makes in the same step (already confirmed, its discount the value of what comes back); a refund names none
export function approveReturn(
  client: ApiClient,
  storeId: string,
  returnId: string,
  body: ApproveReturnBody = {}
): Promise<ReturnView> {
  return client.request(ApiRoutes.returns.approve(returnId), {
    method: 'POST',
    body,
    schema: returnSchema,
    storeId
  })
}
// Approved → in transit: the goods are on their way back (the people who receive them are told)
export const markReturnInTransit = move(ApiRoutes.returns.inTransit)
export const rejectReturn = moveWith<ReturnDecisionBody>(ApiRoutes.returns.reject)
export const cancelReturn = moveWith<ReturnDecisionBody>(ApiRoutes.returns.cancel)
// Approved or in transit → received: the condition of every line, and the stock moves with it
export const receiveReturn = moveWith<ReceiveReturnBody>(ApiRoutes.returns.receive)
// Received → completed: a refund records the money given back by hand
export const completeReturn = moveWith<CompleteReturnBody>(ApiRoutes.returns.complete)

// The guide of the way back, as much of it as the return screen needs (the guide has its own screen and routes, Step 4.14)
export const returnShipmentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  returnId: z.string().nullable(),
  connectionId: z.string(),
  kind: z.string(),
  status: z.string(),
  guideNumber: z.string().nullable(),
  trackingUrl: z.string().nullable(),
  hasLabel: z.boolean()
})
export type ReturnShipmentView = z.output<typeof returnShipmentSchema>

// Approved → the guide of the way back (customer to warehouse), for a connection whose carrier can make it. The payer is the one
// of the return, and the guide is never cash on delivery
export function createReturnShipment(
  client: ApiClient,
  storeId: string,
  returnId: string,
  body: CreateReturnShipmentBody
): Promise<ReturnShipmentView> {
  return client.request(ApiRoutes.returns.returnShipment(returnId), {
    method: 'POST',
    body,
    schema: returnShipmentSchema,
    storeId
  })
}

// Settings → Returns (TDD_17 §4.11): who pays the return leg and the shipping of a replacement when a return does not say
export const returnSettingsSchema = z.strictObject({ returnShippingPayer: z.enum(ShippingPayer) })
export type ReturnSettingsView = z.output<typeof returnSettingsSchema>

export function fetchReturnSettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<ReturnSettingsView> {
  return client.request(ApiRoutes.settings.returns, {
    schema: returnSettingsSchema,
    storeId,
    signal
  })
}

export function updateReturnSettings(
  client: ApiClient,
  storeId: string,
  body: { returnShippingPayer?: ShippingPayer }
): Promise<ReturnSettingsView> {
  return client.request(ApiRoutes.settings.returns, {
    method: 'PATCH',
    body,
    schema: returnSettingsSchema,
    storeId
  })
}
