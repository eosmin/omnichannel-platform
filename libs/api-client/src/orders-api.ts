import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type {
  ChangeOrderStatusInput,
  CreateOrderInput,
  RecordOrderPaymentInput,
  UpdateOrderInput
} from '@platform/core/domain'

import type { ApiClient } from './api-client'
import { type ExportView, exportSchema } from './exports-api'

// What GET /orders and /orders/:id answer. Money is whole cents of the order currency, never a float. A state or a
// method stays text: a value this page does not know (a newer server) must still draw, and the screens map the ones they
// know. The days are 'YYYY-MM-DD' (the scheduled delivery is a day of the store, never a moment).
const orderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  customerId: z.string(),
  // The name only: the contact data of the customer is in the detail. A customer without a name is null.
  customer: z.object({ id: z.string(), name: z.string().nullable(), isCaution: z.boolean() }),
  status: z.string(),
  subtotalCents: z.number().int(),
  shippingCents: z.number().int(),
  discountCents: z.number().int(),
  totalCents: z.number().int(),
  currency: z.string(),
  paymentMethod: z.string(),
  paymentStatus: z.string(),
  priceApprovalStatus: z.string(),
  freeShipping: z.boolean(),
  scheduledDeliveryDate: z.string().nullable(),
  // True when a line was sold at a price other than the catalog's
  priceModified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type OrderSummaryView = z.output<typeof orderSummarySchema>

export const orderPageSchema = z.object({
  data: z.array(orderSummarySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type OrderPageView = z.output<typeof orderPageSchema>

const orderItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  productName: z.string(),
  variantName: z.string().nullable(),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  originalUnitPriceCents: z.number().int().nullable(),
  priceOverrideReason: z.string().nullable(),
  priceOverriddenBy: z.string().nullable(),
  freeShipping: z.boolean(),
  allocations: z.array(z.object({ warehouseId: z.string(), quantity: z.number().int() }))
})
export type OrderItemView = z.output<typeof orderItemSchema>

// The api leaves out what the caller may not read (the contact data of the customer, the address, the phones, the
// payment reference and the notes): those arrive null or empty, and the internal notes may be missing altogether.
// The screens hide what is not there.
export const orderDetailSchema = orderSummarySchema
  .omit({ customer: true, priceModified: true })
  .extend({
    conversationId: z.string().nullable(),
    paymentReference: z.string().nullable(),
    paymentProofMediaId: z.string().nullable(),
    shippingAddress: z.unknown(),
    customerNotes: z.string().nullable(),
    internalNotes: z.string().nullable().optional(),
    packingNotes: z.string().nullable().optional(),
    recipientPhones: z.array(z.string()),
    trackingNumber: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    cancelledBy: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    proofOfDeliveryMediaId: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    confirmedBy: z.string().nullable(),
    confirmedVia: z.string().nullable(),
    // The order it was copied from; left out by a server that does not say
    copiedFromOrderId: z.string().nullable().optional(),
    discountReason: z.string().nullable(),
    priceApprovalRequestedBy: z.string().nullable(),
    priceApprovedBy: z.string().nullable(),
    priceApprovedAt: z.string().nullable(),
    priceApprovedDiscountCents: z.number().int().nullable(),
    priceApprovedShippingCents: z.number().int().nullable(),
    createdBy: z.string(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    customer: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      // The phone without its country code, for the recipient phones of the form
      nationalPhone: z.string().nullable(),
      // Informs and never blocks (TDD_17 §4.16); null when the caller may not read the customer. The reason is in
      // the customer detail.
      isCaution: z.boolean().nullable()
    }),
    items: z.array(orderItemSchema),
    priceModified: z.boolean()
  })
export type OrderDetailView = z.output<typeof orderDetailSchema>

const createdOrderSchema = z.object({
  order: orderDetailSchema,
  // What the server did not do that the request asked for (a value of OrderNotices)
  notices: z.array(z.string())
})
export type CreatedOrderView = z.output<typeof createdOrderSchema>

// The filters of the list, which are also those of the export: everything is optional, and an empty text is no filter.
// The keys are the names of the query (OrderListFilters and OrderScheduleFilters).
export interface OrderListFilter {
  q?: string
  status?: string
  paymentStatus?: string
  priceApprovalStatus?: string
  customerId?: string
  createdFrom?: string
  createdTo?: string
  scheduledDeliveryFrom?: string
  scheduledDeliveryTo?: string
  scheduledDeliveryOn?: string
}

export interface OrderListParams extends OrderListFilter {
  // 'newest' (the default) or 'scheduled_delivery'
  sort?: string
  cursor?: string | null
  limit?: number
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text !== '') search.set(key, text)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchOrders(
  client: ApiClient,
  storeId: string,
  params: OrderListParams,
  signal?: AbortSignal
): Promise<OrderPageView> {
  return client.request(`${ApiRoutes.orders.list}${query({ ...params })}`, {
    schema: orderPageSchema,
    storeId,
    signal
  })
}

export function fetchOrder(
  client: ApiClient,
  storeId: string,
  orderId: string,
  signal?: AbortSignal
): Promise<OrderDetailView> {
  return client.request(ApiRoutes.orders.byId(orderId), {
    schema: orderDetailSchema,
    storeId,
    signal
  })
}

// "Export CSV" of the orders page: queues the file for the filters the page shows and answers with its row (the
// exports center follows it)
export function requestOrdersExport(
  client: ApiClient,
  storeId: string,
  filter: OrderListFilter
): Promise<ExportView> {
  return client.request(`${ApiRoutes.orders.export}${query({ ...filter })}`, {
    schema: exportSchema,
    storeId
  })
}

export function createOrder(
  client: ApiClient,
  storeId: string,
  input: CreateOrderInput
): Promise<CreatedOrderView> {
  return client.request(ApiRoutes.orders.create, {
    method: 'POST',
    body: input,
    schema: createdOrderSchema,
    storeId
  })
}

export function updateOrder(
  client: ApiClient,
  storeId: string,
  orderId: string,
  changes: UpdateOrderInput
): Promise<OrderDetailView> {
  return client.request(ApiRoutes.orders.byId(orderId), {
    method: 'PATCH',
    body: changes,
    schema: orderDetailSchema,
    storeId
  })
}

export function changeOrderStatus(
  client: ApiClient,
  storeId: string,
  orderId: string,
  input: ChangeOrderStatusInput
): Promise<OrderDetailView> {
  return client.request(ApiRoutes.orders.status(orderId), {
    method: 'POST',
    body: input,
    schema: orderDetailSchema,
    storeId
  })
}

// The way the customer confirmed (a value of OrderConfirmationChannel)
export function confirmOrder(
  client: ApiClient,
  storeId: string,
  orderId: string,
  via: string
): Promise<OrderDetailView> {
  return client.request(ApiRoutes.orders.confirm(orderId), {
    method: 'POST',
    body: { via },
    schema: orderDetailSchema,
    storeId
  })
}

// What "mark as confirmed" over a selection answers: the orders that changed and, for the others, our code for the reason
const bulkConfirmSchema = z.object({
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), code: z.string() }))
})
export type BulkConfirmResult = z.infer<typeof bulkConfirmSchema>

export function confirmOrdersBulk(
  client: ApiClient,
  storeId: string,
  ids: readonly string[],
  via: string
): Promise<BulkConfirmResult> {
  return client.request(ApiRoutes.orders.confirmBulk, {
    method: 'POST',
    body: { ids, via },
    schema: bulkConfirmSchema,
    storeId
  })
}

// The draft of "Copy order": shaped as the body of the create route, with today's catalog prices on the side and a
// warning per line the catalog no longer sells as it was. A code of a warning stays text, like a state.
const orderCopySchema = z.object({
  draft: z.object({
    customerId: z.string(),
    items: z.array(
      z.object({
        productId: z.string(),
        variantId: z.string().optional(),
        quantity: z.number().int()
      })
    ),
    shippingCents: z.number().int(),
    paymentMethod: z.string(),
    recipientPhones: z.array(z.string()),
    shippingAddress: z
      .object({
        line1: z.string(),
        line2: z.string().optional(),
        city: z.string(),
        state: z.string().optional(),
        postalCode: z.string().optional(),
        country: z.string()
      })
      .optional(),
    customerNotes: z.string().optional(),
    internalNotes: z.string().optional(),
    packingNotes: z.string().optional(),
    copiedFromOrderId: z.string()
  }),
  lines: z.array(
    z.object({
      productId: z.string(),
      variantId: z.string().nullable(),
      productName: z.string(),
      variantName: z.string().nullable(),
      quantity: z.number().int(),
      unitPriceCents: z.number().int().nullable(),
      previousUnitPriceCents: z.number().int()
    })
  ),
  warnings: z.array(
    z.object({
      code: z.string(),
      itemIndex: z.number().int(),
      productId: z.string(),
      variantId: z.string().nullable()
    })
  )
})
export type OrderCopyView = z.infer<typeof orderCopySchema>

export function getOrderCopy(
  client: ApiClient,
  storeId: string,
  orderId: string
): Promise<OrderCopyView> {
  return client.request(ApiRoutes.orders.copy(orderId), { schema: orderCopySchema, storeId })
}

export function cancelOrder(
  client: ApiClient,
  storeId: string,
  orderId: string,
  cancellationReason: string
): Promise<OrderDetailView> {
  return client.request(ApiRoutes.orders.cancel(orderId), {
    method: 'POST',
    body: { cancellationReason },
    schema: orderDetailSchema,
    storeId
  })
}

// A payment recorded by hand: it never changes how the order was sold
export function recordOrderPayment(
  client: ApiClient,
  storeId: string,
  orderId: string,
  input: RecordOrderPaymentInput
): Promise<OrderDetailView> {
  return client.request(ApiRoutes.orders.payment(orderId), {
    method: 'POST',
    body: input,
    schema: orderDetailSchema,
    storeId
  })
}

// Approving or rejecting a price held for approval; the reason is optional and goes to the audit entry
export function decideOrderPrice(
  client: ApiClient,
  storeId: string,
  orderId: string,
  decision: 'approve' | 'reject',
  reason?: string
): Promise<OrderDetailView> {
  const path =
    decision === 'approve'
      ? ApiRoutes.orders.priceApprovalApprove(orderId)
      : ApiRoutes.orders.priceApprovalReject(orderId)
  return client.request(path, {
    method: 'POST',
    body: reason === undefined ? {} : { reason },
    schema: orderDetailSchema,
    storeId
  })
}

// What the create-order drawer reads of the `orders` block of GET /settings/preferences (which needs `settings:view`): the
// initial state of its two checkboxes and the discount limit. The factory defaults live on the api, in one place.
const orderPreferencesSchema = z.object({
  orders: z.object({
    confirmOnCreate: z.boolean(),
    sendSummaryOnCreate: z.boolean(),
    discountLimitPercent: z.number().int()
  })
})
export type OrderPreferencesView = z.infer<typeof orderPreferencesSchema>['orders']

export async function fetchOrderPreferences(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<OrderPreferencesView> {
  const view = await client.request(ApiRoutes.settings.preferences, {
    schema: orderPreferencesSchema,
    storeId,
    signal
  })
  return view.orders
}
