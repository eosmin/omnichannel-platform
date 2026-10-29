import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import { acceptedSchema, type AccountProfile, accountProfileSchema } from './api-schemas'

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
