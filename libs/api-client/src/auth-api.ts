import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import {
  acceptedSchema,
  type AccountProfile,
  accountProfileSchema,
  type InvitationPreview,
  invitationPreviewSchema,
  type StoreView,
  storeViewSchema
} from './api-schemas'

// Same answer for any address, known or not: the page says "check your email" either way
export function requestMagicLink(client: ApiClient, email: string): Promise<{ accepted: true }> {
  return client.request(ApiRoutes.auth.magicLinkRequest, {
    method: 'POST',
    body: { email },
    schema: acceptedSchema,
    authenticated: false
  })
}

export function fetchAccountProfile(
  client: ApiClient,
  signal?: AbortSignal
): Promise<AccountProfile> {
  return client.request(ApiRoutes.auth.me, { schema: accountProfileSchema, signal })
}

// What the link of an invitation is for. Public: the token in the path is the credential
export function fetchInvitationPreview(
  client: ApiClient,
  token: string,
  signal?: AbortSignal
): Promise<InvitationPreview> {
  return client.request(ApiRoutes.invitations.byToken(encodeURIComponent(token)), {
    schema: invitationPreviewSchema,
    authenticated: false,
    signal
  })
}

// The stores of the organization of the store in storeId (needs ORG_MANAGE_STORES there)
export function fetchOrganizationStores(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<StoreView[]> {
  return client.request(ApiRoutes.organizations.stores, {
    schema: z.array(storeViewSchema),
    storeId,
    signal
  })
}
