import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'

// What the profile of a customer shows of an order (GET /customers/:id/orders): the number, the state, the total and
// how many lines. Never a note, the address or a phone: the order has its own route and its own permission. A state
// stays text so a value of a newer server still draws; money is whole cents of the order currency.
const customerOrderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: z.string(),
  paymentStatus: z.string(),
  totalCents: z.number().int(),
  currency: z.string(),
  itemCount: z.number().int(),
  createdAt: z.string()
})
export type CustomerOrderView = z.output<typeof customerOrderSchema>

// Over every order that counts (CustomerFigureOrderStatuses), not only the page. Null on a page past the first one.
const customerOrderFiguresSchema = z.object({
  orders: z.number().int(),
  totalSpentCents: z.number().int(),
  averageOrderCents: z.number().int().nullable(),
  firstOrderAt: z.string().nullable(),
  lastOrderAt: z.string().nullable()
})
export type CustomerOrderFiguresView = z.output<typeof customerOrderFiguresSchema>

export const customerOrdersPageSchema = z.object({
  data: z.array(customerOrderSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  figures: customerOrderFiguresSchema.nullable()
})
export type CustomerOrdersPageView = z.output<typeof customerOrdersPageSchema>

// The orders of a customer, the newest first; `status` narrows the page (the figures do not follow it)
export function fetchCustomerOrders(
  client: ApiClient,
  storeId: string,
  customerId: string,
  status: string | undefined,
  cursor: string | null,
  signal?: AbortSignal
): Promise<CustomerOrdersPageView> {
  const query = new URLSearchParams()
  if (status !== undefined) query.set('status', status)
  if (cursor !== null) query.set('cursor', cursor)
  const text = query.toString()
  return client.request(
    `${ApiRoutes.customers.orders(customerId)}${text === '' ? '' : `?${text}`}`,
    {
      schema: customerOrdersPageSchema,
      storeId,
      signal
    }
  )
}
