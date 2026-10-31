import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type { CustomerTimelineType, MergeableField, MergeFieldSource } from '@platform/core/domain'

import type { ApiClient } from './api-client'
import {
  type ConversationPageView,
  conversationPageSchema,
  type CustomerDetailView,
  customerAddressSchema,
  type CustomerAddressView,
  customerDetailSchema,
  customerIdentitySchema,
  type CustomerIdentityView,
  customerListPageSchema,
  type CustomerListPageView,
  customerMergePreviewSchema,
  type CustomerMergePreviewView,
  customerNoteSchema,
  type CustomerNoteView,
  customerTagListSchema,
  type TagView,
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

// The customers page: `q` is the search the api takes (name, e-mail, phone), the only filter it has
export function fetchCustomers(
  client: ApiClient,
  storeId: string,
  params: { q: string | undefined; cursor: string | null },
  signal?: AbortSignal
): Promise<CustomerListPageView> {
  const query = pageQuery({
    q: params.q === undefined || params.q === '' ? undefined : params.q,
    cursor: params.cursor ?? undefined
  })
  return client.request(`${ApiRoutes.customers.list}${query}`, {
    schema: customerListPageSchema,
    storeId,
    signal
  })
}

// null clears a field; a field left out stays as it is
export interface CustomerChanges {
  name?: string | null
  email?: string | null
  phone?: string | null
}

export function updateCustomer(
  client: ApiClient,
  storeId: string,
  customerId: string,
  changes: CustomerChanges
): Promise<CustomerDetailView> {
  return client.request(ApiRoutes.customers.byId(customerId), {
    method: 'PATCH',
    body: changes,
    schema: customerDetailSchema,
    storeId
  })
}

export function createCustomerNote(
  client: ApiClient,
  storeId: string,
  customerId: string,
  content: string
): Promise<CustomerNoteView> {
  return client.request(ApiRoutes.customers.notes(customerId), {
    method: 'POST',
    body: { content },
    schema: customerNoteSchema,
    storeId
  })
}

export function deleteCustomerNote(
  client: ApiClient,
  storeId: string,
  customerId: string,
  noteId: string
): Promise<void> {
  return client.request(ApiRoutes.customers.noteById(customerId, noteId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// A new address leaves out what it does not have; it cannot send null
export interface CustomerAddressInput {
  label?: string
  line1: string
  line2?: string
  city: string
  state?: string
  postalCode?: string
  country?: string
  isDefault?: boolean
}

// An edit sends null to clear an optional field
export interface CustomerAddressChanges {
  label?: string | null
  line1?: string
  line2?: string | null
  city?: string
  state?: string | null
  postalCode?: string | null
  country?: string
  isDefault?: boolean
}

export function createCustomerAddress(
  client: ApiClient,
  storeId: string,
  customerId: string,
  address: CustomerAddressInput
): Promise<CustomerAddressView> {
  return client.request(ApiRoutes.customers.addresses(customerId), {
    method: 'POST',
    body: address,
    schema: customerAddressSchema,
    storeId
  })
}

export function updateCustomerAddress(
  client: ApiClient,
  storeId: string,
  customerId: string,
  addressId: string,
  changes: CustomerAddressChanges
): Promise<CustomerAddressView> {
  return client.request(ApiRoutes.customers.addressById(customerId, addressId), {
    method: 'PATCH',
    body: changes,
    schema: customerAddressSchema,
    storeId
  })
}

export function deleteCustomerAddress(
  client: ApiClient,
  storeId: string,
  customerId: string,
  addressId: string
): Promise<void> {
  return client.request(ApiRoutes.customers.addressById(customerId, addressId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// Answers the tags the customer holds after the call
export function attachCustomerTag(
  client: ApiClient,
  storeId: string,
  customerId: string,
  tagId: string
): Promise<TagView[]> {
  return client.request(ApiRoutes.customers.tags(customerId), {
    method: 'POST',
    body: { tagId },
    schema: customerTagListSchema,
    storeId
  })
}

export function detachCustomerTag(
  client: ApiClient,
  storeId: string,
  customerId: string,
  tagId: string
): Promise<void> {
  return client.request(ApiRoutes.customers.tagById(customerId, tagId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// What a merge would do, counted before anyone confirms it
export function fetchCustomerMergePreview(
  client: ApiClient,
  storeId: string,
  survivorId: string,
  absorbedId: string,
  signal?: AbortSignal
): Promise<CustomerMergePreviewView> {
  const query = pageQuery({ absorbedId })
  return client.request(`${ApiRoutes.customers.mergePreview(survivorId)}${query}`, {
    schema: customerMergePreviewSchema,
    storeId,
    signal
  })
}

// Which side keeps each contact field the two customers differ on; a field left out keeps the survivor
export type MergeFieldChoices = Partial<Record<MergeableField, MergeFieldSource>>

// The absorbed customer joins the survivor, who is answered with everything now
export function mergeCustomers(
  client: ApiClient,
  storeId: string,
  survivorId: string,
  absorbedId: string,
  fieldChoices: MergeFieldChoices
): Promise<CustomerDetailView> {
  return client.request(ApiRoutes.customers.merge(survivorId), {
    method: 'POST',
    body: { absorbedId, fieldChoices },
    schema: customerDetailSchema,
    storeId
  })
}

// `mergeId` is the id of the merge entry of the timeline
export function unmergeCustomers(
  client: ApiClient,
  storeId: string,
  survivorId: string,
  mergeId: string
): Promise<CustomerDetailView> {
  return client.request(ApiRoutes.customers.unmerge(survivorId), {
    method: 'POST',
    body: { mergeId },
    schema: customerDetailSchema,
    storeId
  })
}

export interface CustomerIdentityInput {
  channelType: string
  channelIdentity: string
  displayName?: string
}

export function linkCustomerIdentity(
  client: ApiClient,
  storeId: string,
  customerId: string,
  identity: CustomerIdentityInput
): Promise<CustomerIdentityView> {
  return client.request(ApiRoutes.customers.identities(customerId), {
    method: 'POST',
    body: identity,
    schema: customerIdentitySchema,
    storeId
  })
}

export function unlinkCustomerIdentity(
  client: ApiClient,
  storeId: string,
  customerId: string,
  identityId: string
): Promise<void> {
  return client.request(ApiRoutes.customers.identityById(customerId, identityId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}
