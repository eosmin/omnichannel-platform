import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'

export interface PushRegistration {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
}

// Tells the api which browser to push to for the person who is signed in. Both calls answer 204.
// The routes belong to the member and need the store of the header, like the rest of notifications.
export function registerPushSubscription(
  client: ApiClient,
  storeId: string,
  registration: PushRegistration
): Promise<void> {
  return client.request(ApiRoutes.notifications.pushSubscription, {
    method: 'POST',
    body: registration,
    schema: z.undefined(),
    storeId
  })
}

export function removePushSubscription(
  client: ApiClient,
  storeId: string,
  endpoint: string
): Promise<void> {
  return client.request(ApiRoutes.notifications.pushSubscriptionRemove, {
    method: 'POST',
    body: { endpoint },
    schema: z.undefined(),
    storeId
  })
}
