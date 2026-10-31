import { ApiRoutes } from '@platform/core/api'
import type { CustomerTimelineType } from '@platform/core/domain'

import type { ApiClient } from './api-client'
import {
  type ConversationPageView,
  conversationPageSchema,
  type CustomerDetailView,
  customerDetailSchema,
  type CustomerTimelinePageView,
  customerTimelinePageSchema
} from './api-schemas'

function pageQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value)
  }
  const text = query.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchCustomer(
  client: ApiClient,
  storeId: string,
  customerId: string,
  signal?: AbortSignal
): Promise<CustomerDetailView> {
  return client.request(ApiRoutes.customers.byId(customerId), {
    schema: customerDetailSchema,
    storeId,
    signal
  })
}

// The activity of the customer, the newest first; `type` narrows it to one kind
export function fetchCustomerTimeline(
  client: ApiClient,
  storeId: string,
  customerId: string,
  type: CustomerTimelineType | undefined,
  cursor: string | null,
  signal?: AbortSignal
): Promise<CustomerTimelinePageView> {
  const query = pageQuery({ type, cursor: cursor ?? undefined })
  return client.request(`${ApiRoutes.customers.timeline(customerId)}${query}`, {
    schema: customerTimelinePageSchema,
    storeId,
    signal
  })
}

// The page of GET /conversations for one customer. `limit` is the page size (the server caps it).
export function fetchCustomerConversations(
  client: ApiClient,
  storeId: string,
  customerId: string,
  limit: number,
  signal?: AbortSignal
): Promise<ConversationPageView> {
  const query = pageQuery({ limit: String(limit) })
  return client.request(`${ApiRoutes.customers.conversations(customerId)}${query}`, {
    schema: conversationPageSchema,
    storeId,
    signal
  })
}
