import { z } from 'zod'

import {
  ApiRoutesPurchaseOrders,
  ApiRoutesSupplierPaymentReturns,
  ApiRoutesSupplierPayments,
  ApiRoutesSuppliers
} from '@platform/core/api'
import {
  type closePurchaseOrderSchema,
  type createPurchaseOrderSchema,
  type createSupplierSchema,
  PaginationLimits,
  PurchaseOrderStatus,
  type receivePurchaseOrderSchema,
  type recordPaymentReturnSchema,
  type recordPaymentSchema,
  type updatePurchaseOrderSchema,
  type updateSupplierSchema,
  type voidPaymentReturnSchema,
  type voidPaymentSchema
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// Suppliers, purchase orders, bills and payments to suppliers (TDD_18 §2.7, §12, Step 4B.9a-4). Money is whole USD cents (the api keeps
// every one of these inside 2^31, so a number is exact); a date is a day ('YYYY-MM-DD'). The bodies are typed by the very schemas the api
// validates with, so a form that compiles sends what the api takes.

const supplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  taxId: z.string().nullable(),
  contactName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  paymentTermsDays: z.number().int(),
  defaultPayableAccountId: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string()
})
export type SupplierView = z.output<typeof supplierSchema>

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() })

const supplierPageSchema = pageOf(supplierSchema)
export type SupplierPageView = z.output<typeof supplierPageSchema>

const orderLineSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  lineNo: z.number().int(),
  productId: z.string(),
  variantId: z.string().nullable(),
  quantity: z.number().int(),
  receivedQuantity: z.number().int(),
  unitCostCents: z.number().int(),
  taxRateId: z.string().nullable()
})
export type PurchaseOrderLineView = z.output<typeof orderLineSchema>

const receiptLineSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  receiptId: z.string(),
  orderLineId: z.string(),
  quantity: z.number().int(),
  unitCostCents: z.number().int(),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  movementId: z.string()
})

const receiptSchema = z.object({
  id: z.string(),
  purchaseOrderId: z.string(),
  supplierId: z.string(),
  receivedOn: z.string(),
  dueOn: z.string(),
  supplierDocumentNumber: z.string().nullable(),
  taxCreditable: z.boolean(),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
  entryId: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  lines: z.array(receiptLineSchema)
})
export type PurchaseReceiptView = z.output<typeof receiptSchema>

const orderSchema = z.object({
  id: z.string(),
  number: z.string(),
  supplierId: z.string(),
  warehouseId: z.string(),
  status: z.enum(PurchaseOrderStatus),
  orderedOn: z.string().nullable(),
  expectedOn: z.string().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  lines: z.array(orderLineSchema),
  receipts: z.array(receiptSchema)
})
export type PurchaseOrderView = z.output<typeof orderSchema>

const orderPageSchema = pageOf(orderSchema)
export type PurchaseOrderPageView = z.output<typeof orderPageSchema>

const paymentSchema = z.object({
  id: z.string(),
  supplierId: z.string(),
  purchaseReceiptId: z.string().nullable(),
  paidFromAccountId: z.string(),
  amountCents: z.number().int(),
  paidOn: z.string(),
  reference: z.string().nullable(),
  entryId: z.string(),
  voidedByEntryId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string()
})
export type SupplierPaymentView = z.output<typeof paymentSchema>

const paymentPageSchema = pageOf(paymentSchema)
export type SupplierPaymentPageView = z.output<typeof paymentPageSchema>

// What a supplier gave back of one payment (TDD_18 §4.2 E11b): the bank returned it or it bounced
const paymentReturnSchema = z.object({
  id: z.string(),
  supplierId: z.string(),
  supplierPaymentId: z.string(),
  receivedIntoAccountId: z.string(),
  amountCents: z.number().int(),
  returnedOn: z.string(),
  reference: z.string().nullable(),
  entryId: z.string(),
  voidedByEntryId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string()
})
export type SupplierPaymentReturnView = z.output<typeof paymentReturnSchema>

const paymentReturnPageSchema = pageOf(paymentReturnSchema)
export type SupplierPaymentReturnPageView = z.output<typeof paymentReturnPageSchema>

const balanceSchema = z.object({
  supplierId: z.string(),
  billedCents: z.number().int(),
  paidCents: z.number().int(),
  openCents: z.number().int(),
  overdueCents: z.number().int()
})
export type SupplierBalanceView = z.output<typeof balanceSchema>

const payableBillSchema = z.object({
  receiptId: z.string(),
  purchaseOrderId: z.string(),
  supplierId: z.string(),
  supplierDocumentNumber: z.string().nullable(),
  receivedOn: z.string(),
  dueOn: z.string(),
  totalCents: z.number().int(),
  openCents: z.number().int(),
  overdue: z.boolean(),
  daysOverdue: z.number().int().min(0)
})
export type PayableBillView = z.output<typeof payableBillSchema>

const payablesSchema = z.object({
  bills: z.array(payableBillSchema),
  suppliers: z.array(balanceSchema)
})
export type PayablesView = z.output<typeof payablesSchema>

// The bodies, as the api's schemas take them (what goes in: `z.input`, so a field with a default may be left out)
export type CreateSupplierInput = z.input<typeof createSupplierSchema>
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>
export type CreatePurchaseOrderInput = z.input<typeof createPurchaseOrderSchema>
export type UpdatePurchaseOrderInput = z.input<typeof updatePurchaseOrderSchema>
export type ReceivePurchaseOrderInput = z.input<typeof receivePurchaseOrderSchema>
export type ClosePurchaseOrderInput = z.input<typeof closePurchaseOrderSchema>
export type RecordSupplierPaymentInput = z.input<typeof recordPaymentSchema>
export type VoidSupplierPaymentInput = z.input<typeof voidPaymentSchema>
export type RecordPaymentReturnInput = z.input<typeof recordPaymentReturnSchema>
export type VoidPaymentReturnInput = z.input<typeof voidPaymentReturnSchema>

// The pages are followed up to the bound the api itself keeps, never further: a list that is still not over at the bound is a failure,
// never a shorter list that looks complete (5000 suppliers per organization, 100 per page).
const MAX_PAGES = 60

const withQuery = (path: string, search: URLSearchParams): string => {
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

const enc = encodeURIComponent

export interface SupplierListParams {
  cursor?: string | null
  q?: string
  includeInactive?: boolean
}

export function fetchSupplierPage(
  client: ApiClient,
  storeId: string,
  params: SupplierListParams,
  signal?: AbortSignal
): Promise<SupplierPageView> {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  if (params.cursor !== undefined && params.cursor !== null) search.set('cursor', params.cursor)
  if (params.q !== undefined && params.q !== '') search.set('q', params.q)
  if (params.includeInactive === true) search.set('includeInactive', 'true')
  return client.request(withQuery(ApiRoutesSuppliers.list, search), {
    schema: supplierPageSchema,
    storeId,
    signal
  })
}

// Every supplier, the ones switched off too (an order or a bill of one still needs its name); a select hides them itself
export async function fetchAllSuppliers(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<SupplierView[]> {
  const found: SupplierView[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page: SupplierPageView = await client.request(
      withQuery(
        ApiRoutesSuppliers.list,
        new URLSearchParams({
          limit: String(PaginationLimits.MAX),
          includeInactive: 'true',
          ...(cursor === null ? {} : { cursor })
        })
      ),
      { schema: supplierPageSchema, storeId, signal }
    )
    found.push(...page.data)
    if (!page.hasMore || page.nextCursor === null) return found
    cursor = page.nextCursor
  }
  throw new Error('the suppliers did not end within the pages the api keeps')
}

export function fetchSupplier(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<SupplierView> {
  return client.request(ApiRoutesSuppliers.byId(enc(id)), {
    schema: supplierSchema,
    storeId,
    signal
  })
}

export function createSupplier(
  client: ApiClient,
  storeId: string,
  input: CreateSupplierInput
): Promise<SupplierView> {
  return client.request(ApiRoutesSuppliers.create, {
    method: 'POST',
    body: input,
    schema: supplierSchema,
    storeId
  })
}

export function updateSupplier(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateSupplierInput
): Promise<SupplierView> {
  return client.request(ApiRoutesSuppliers.update(enc(id)), {
    method: 'PATCH',
    body: input,
    schema: supplierSchema,
    storeId
  })
}

export function fetchSupplierBalance(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<SupplierBalanceView> {
  return client.request(ApiRoutesSuppliers.balance(enc(id)), {
    schema: balanceSchema,
    storeId,
    signal
  })
}

export function fetchPayables(
  client: ApiClient,
  storeId: string,
  params: { supplierId?: string; overdueOnly?: boolean },
  signal?: AbortSignal
): Promise<PayablesView> {
  const search = new URLSearchParams()
  if (params.supplierId !== undefined && params.supplierId !== '') {
    search.set('supplierId', params.supplierId)
  }
  if (params.overdueOnly === true) search.set('overdueOnly', 'true')
  return client.request(withQuery(ApiRoutesSuppliers.payables, search), {
    schema: payablesSchema,
    storeId,
    signal
  })
}

const paymentQuery = (cursor: string | null): URLSearchParams => {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  if (cursor !== null) search.set('cursor', cursor)
  return search
}

export function fetchSupplierPayments(
  client: ApiClient,
  storeId: string,
  id: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<SupplierPaymentPageView> {
  return client.request(withQuery(ApiRoutesSuppliers.payments(enc(id)), paymentQuery(cursor)), {
    schema: paymentPageSchema,
    storeId,
    signal
  })
}

export function recordSupplierPayment(
  client: ApiClient,
  storeId: string,
  supplierId: string,
  input: RecordSupplierPaymentInput
): Promise<SupplierPaymentView> {
  return client.request(ApiRoutesSuppliers.recordPayment(enc(supplierId)), {
    method: 'POST',
    body: input,
    schema: paymentSchema,
    storeId
  })
}

// HIGH tier of the destructive actions: the screen asks first. The reason is the memo of the reversal in the books.
export function voidSupplierPayment(
  client: ApiClient,
  storeId: string,
  paymentId: string,
  input: VoidSupplierPaymentInput
): Promise<SupplierPaymentView> {
  return client.request(ApiRoutesSupplierPayments.void(enc(paymentId)), {
    method: 'POST',
    body: input,
    schema: paymentSchema,
    storeId
  })
}

export function fetchSupplierPaymentReturns(
  client: ApiClient,
  storeId: string,
  paymentId: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<SupplierPaymentReturnPageView> {
  return client.request(
    withQuery(ApiRoutesSupplierPayments.returns(enc(paymentId)), paymentQuery(cursor)),
    { schema: paymentReturnPageSchema, storeId, signal }
  )
}

export function recordSupplierPaymentReturn(
  client: ApiClient,
  storeId: string,
  paymentId: string,
  input: RecordPaymentReturnInput
): Promise<SupplierPaymentReturnView> {
  return client.request(ApiRoutesSupplierPayments.returns(enc(paymentId)), {
    method: 'POST',
    body: input,
    schema: paymentReturnSchema,
    storeId
  })
}

// HIGH tier of the destructive actions: the screen asks first. The reason is the memo of the reversal in the books.
export function voidSupplierPaymentReturn(
  client: ApiClient,
  storeId: string,
  returnId: string,
  input: VoidPaymentReturnInput
): Promise<SupplierPaymentReturnView> {
  return client.request(ApiRoutesSupplierPaymentReturns.void(enc(returnId)), {
    method: 'POST',
    body: input,
    schema: paymentReturnSchema,
    storeId
  })
}

export interface PurchaseOrderListParams {
  cursor?: string | null
  status?: PurchaseOrderStatus
  supplierId?: string
}

export function fetchPurchaseOrderPage(
  client: ApiClient,
  storeId: string,
  params: PurchaseOrderListParams,
  signal?: AbortSignal
): Promise<PurchaseOrderPageView> {
  const search = new URLSearchParams({ limit: String(PaginationLimits.DEFAULT) })
  if (params.cursor !== undefined && params.cursor !== null) search.set('cursor', params.cursor)
  if (params.status !== undefined) search.set('status', params.status)
  if (params.supplierId !== undefined && params.supplierId !== '') {
    search.set('supplierId', params.supplierId)
  }
  return client.request(withQuery(ApiRoutesPurchaseOrders.list, search), {
    schema: orderPageSchema,
    storeId,
    signal
  })
}

export function fetchPurchaseOrder(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.byId(enc(id)), {
    schema: orderSchema,
    storeId,
    signal
  })
}

export function createPurchaseOrder(
  client: ApiClient,
  storeId: string,
  input: CreatePurchaseOrderInput
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.create, {
    method: 'POST',
    body: input,
    schema: orderSchema,
    storeId
  })
}

export function updatePurchaseOrder(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdatePurchaseOrderInput
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.update(enc(id)), {
    method: 'PATCH',
    body: input,
    schema: orderSchema,
    storeId
  })
}

// Marks a draft as ordered: its lines are what was asked of the supplier from then on
export function orderPurchaseOrder(
  client: ApiClient,
  storeId: string,
  id: string
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.order(enc(id)), {
    method: 'POST',
    schema: orderSchema,
    storeId
  })
}

export function receivePurchaseOrder(
  client: ApiClient,
  storeId: string,
  id: string,
  input: ReceivePurchaseOrderInput
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.receive(enc(id)), {
    method: 'POST',
    body: input,
    schema: orderSchema,
    storeId
  })
}

export function closePurchaseOrder(
  client: ApiClient,
  storeId: string,
  id: string,
  input: ClosePurchaseOrderInput
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.close(enc(id)), {
    method: 'POST',
    body: input,
    schema: orderSchema,
    storeId
  })
}

export function cancelPurchaseOrder(
  client: ApiClient,
  storeId: string,
  id: string,
  input: ClosePurchaseOrderInput
): Promise<PurchaseOrderView> {
  return client.request(ApiRoutesPurchaseOrders.cancel(enc(id)), {
    method: 'POST',
    body: input,
    schema: orderSchema,
    storeId
  })
}

export function fetchPurchaseOrderPayments(
  client: ApiClient,
  storeId: string,
  id: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<SupplierPaymentPageView> {
  return client.request(
    withQuery(ApiRoutesPurchaseOrders.payments(enc(id)), paymentQuery(cursor)),
    { schema: paymentPageSchema, storeId, signal }
  )
}

export function recordPurchaseOrderPayment(
  client: ApiClient,
  storeId: string,
  orderId: string,
  input: RecordSupplierPaymentInput
): Promise<SupplierPaymentView> {
  return client.request(ApiRoutesPurchaseOrders.recordPayment(enc(orderId)), {
    method: 'POST',
    body: input,
    schema: paymentSchema,
    storeId
  })
}
