import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import {
  type OrganizationView,
  organizationViewSchema,
  type StoreView,
  storeViewSchema
} from './api-schemas'

// The organization is always the one of the store in X-Store-Id: no call names another one.

export interface StoreFields {
  timezone?: string
  currency?: string
  defaultLocale?: string
}

export interface CreateStoreInput extends StoreFields {
  name: string
}

export interface StorePatch extends StoreFields {
  name?: string
}

export function fetchOrganization(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<OrganizationView> {
  return client.request(ApiRoutes.organizations.current, {
    schema: organizationViewSchema,
    storeId,
    signal
  })
}

export function renameOrganization(
  client: ApiClient,
  storeId: string,
  name: string
): Promise<OrganizationView> {
  return client.request(ApiRoutes.organizations.current, {
    method: 'PATCH',
    body: { name },
    schema: organizationViewSchema,
    storeId
  })
}

export function fetchOrganizationStore(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<StoreView> {
  return client.request(ApiRoutes.organizations.storeById(encodeURIComponent(id)), {
    schema: storeViewSchema,
    storeId,
    signal
  })
}

export function createOrganizationStore(
  client: ApiClient,
  storeId: string,
  input: CreateStoreInput
): Promise<StoreView> {
  return client.request(ApiRoutes.organizations.stores, {
    method: 'POST',
    body: input,
    schema: storeViewSchema,
    storeId
  })
}

export function updateOrganizationStore(
  client: ApiClient,
  storeId: string,
  id: string,
  patch: StorePatch
): Promise<StoreView> {
  return client.request(ApiRoutes.organizations.storeById(encodeURIComponent(id)), {
    method: 'PATCH',
    body: patch,
    schema: storeViewSchema,
    storeId
  })
}

// The api asks for what the person typed to confirm: the name of the store (ORG-03)
export function deleteOrganizationStore(
  client: ApiClient,
  storeId: string,
  id: string,
  confirmation: string
): Promise<void> {
  return client.request(ApiRoutes.organizations.storeById(encodeURIComponent(id)), {
    method: 'DELETE',
    body: { confirmation },
    schema: z.undefined(),
    storeId
  })
}
