import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import {
  OrderReturnCondition,
  ReceptionBatchStatus,
  ReceptionItemOutcome,
  ReceptionScanResults,
  type ScanCodeBody,
  ShipmentKind,
  ShipmentStatus,
  type UpdateReceptionItemBody
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// What the reception routes answer (TDD_17 §4.16): a batch of packages scanned at the warehouse and what each one decided.
// `customerIsCaution` says only whether the customer is flagged; the reason of the flag reaches who may flag or read customers.

const receptionLineSchema = z.object({
  orderItemId: z.string(),
  quantity: z.number().int(),
  condition: z.enum(OrderReturnCondition),
  restockWarehouseId: z.string().optional()
})

const receptionItemSchema = z.object({
  id: z.string(),
  shipmentId: z.string(),
  guideNumber: z.string().nullable(),
  shipmentStatus: z.enum(ShipmentStatus),
  orderId: z.string(),
  orderNumber: z.string(),
  orderItems: z.array(
    z.object({
      id: z.string(),
      productName: z.string(),
      variantName: z.string().nullable(),
      quantity: z.number().int()
    })
  ),
  customerIsCaution: z.boolean(),
  // The key of the reason (`DELIVERY_FAILED`): the screen translates it
  reason: z.string(),
  condition: z.enum(OrderReturnCondition),
  note: z.string().nullable(),
  // Empty: every unit of the order that is not in a return yet, in `condition`
  lines: z.array(receptionLineSchema),
  flagCustomer: z.boolean(),
  flagReason: z.string().nullable(),
  // The agent confirmed that a package whose guide is DELIVERED came back anyway
  confirmDelivered: z.boolean(),
  outcome: z.enum(ReceptionItemOutcome).nullable(),
  // The code of the error: the screen translates it
  errorCode: z.string().nullable(),
  returnId: z.string().nullable(),
  flagApplied: z.boolean(),
  scannedAt: z.string()
})
export type ReceptionItemView = z.output<typeof receptionItemSchema>

const receptionCountsSchema = z.object({
  total: z.number().int(),
  received: z.number().int(),
  failed: z.number().int(),
  pending: z.number().int()
})

const receptionBatchSummarySchema = z.object({
  id: z.string(),
  status: z.enum(ReceptionBatchStatus),
  createdBy: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  counts: receptionCountsSchema
})
export type ReceptionBatchSummaryView = z.output<typeof receptionBatchSummarySchema>

const receptionBatchSchema = receptionBatchSummarySchema.extend({
  // A refusal ticks the flag by itself for this reader: the editor shows it ticked, as the api will apply it
  cautionPreselected: z.boolean(),
  items: z.array(receptionItemSchema)
})
export type ReceptionBatchView = z.output<typeof receptionBatchSchema>

const scanCandidateSchema = z.object({
  shipmentId: z.string(),
  guideNumber: z.string().nullable(),
  orderNumber: z.string(),
  status: z.enum(ShipmentStatus),
  kind: z.enum(ShipmentKind)
})

const scanResultSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal(ReceptionScanResults.ADDED), item: receptionItemSchema }),
  z.object({ result: z.literal(ReceptionScanResults.NOT_FOUND) }),
  z.object({
    result: z.literal(ReceptionScanResults.AMBIGUOUS),
    candidates: z.array(scanCandidateSchema)
  }),
  // The guide is DELIVERED: the scan is sent again with `confirmDelivered` once the agent confirms
  z.object({
    result: z.literal(ReceptionScanResults.NEEDS_CONFIRMATION),
    candidate: scanCandidateSchema
  })
])
export type ScanResultView = z.output<typeof scanResultSchema>

export function fetchReceptionBatches(
  client: ApiClient,
  storeId: string,
  status?: ReceptionBatchStatus,
  signal?: AbortSignal
): Promise<ReceptionBatchSummaryView[]> {
  const search = status === undefined ? '' : `?${new URLSearchParams({ status }).toString()}`
  return client.request(`${ApiRoutes.returns.reception.batches}${search}`, {
    schema: z.array(receptionBatchSummarySchema),
    storeId,
    signal
  })
}

export function createReceptionBatch(
  client: ApiClient,
  storeId: string
): Promise<ReceptionBatchView> {
  return client.request(ApiRoutes.returns.reception.batches, {
    method: 'POST',
    schema: receptionBatchSchema,
    storeId
  })
}

export function fetchReceptionBatch(
  client: ApiClient,
  storeId: string,
  batchId: string,
  signal?: AbortSignal
): Promise<ReceptionBatchView> {
  return client.request(ApiRoutes.returns.reception.batchById(batchId), {
    schema: receptionBatchSchema,
    storeId,
    signal
  })
}

// A code from the reader: found (the package joins the batch), not found (nothing changes), ambiguous (the agent picks one and
// scans again with its `shipmentId`) or delivered (the agent confirms and scans again with `confirmDelivered`)
export function scanReceptionCode(
  client: ApiClient,
  storeId: string,
  batchId: string,
  body: ScanCodeBody
): Promise<ScanResultView> {
  return client.request(ApiRoutes.returns.reception.scan(batchId), {
    method: 'POST',
    body,
    schema: scanResultSchema,
    storeId
  })
}

export function updateReceptionItem(
  client: ApiClient,
  storeId: string,
  batchId: string,
  itemId: string,
  body: UpdateReceptionItemBody
): Promise<ReceptionItemView> {
  return client.request(ApiRoutes.returns.reception.itemById(batchId, itemId), {
    method: 'PATCH',
    body,
    schema: receptionItemSchema,
    storeId
  })
}

export function removeReceptionItem(
  client: ApiClient,
  storeId: string,
  batchId: string,
  itemId: string
): Promise<void> {
  return client.request(ApiRoutes.returns.reception.itemById(batchId, itemId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// Receives every package that is not received yet, each in its own transaction. A package that fails keeps its error code and the
// batch ends as `completed_with_errors`; calling it again retries what failed.
export function completeReceptionBatch(
  client: ApiClient,
  storeId: string,
  batchId: string
): Promise<ReceptionBatchView> {
  return client.request(ApiRoutes.returns.reception.complete(batchId), {
    method: 'POST',
    schema: receptionBatchSchema,
    storeId
  })
}
