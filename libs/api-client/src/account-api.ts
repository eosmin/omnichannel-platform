import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import {
  type AccountPreferences,
  accountPreferencesSchema,
  type ActiveSession,
  activeSessionSchema,
  type OwnProfile,
  ownProfileSchema
} from './api-schemas'

// The person's own account. None of these routes takes a store or a user id: the access token says
// whose account it is.

export interface ProfilePatch {
  name?: string
  // The id of a picture the person uploaded for the purpose avatar; null takes the picture away
  avatarMediaId?: string | null
}

export interface AccountPreferencesPatch {
  locale?: string
  // null goes back to the time zone of the browser
  timezone?: string | null
  density?: string
}

export function fetchOwnProfile(client: ApiClient, signal?: AbortSignal): Promise<OwnProfile> {
  return client.request(ApiRoutes.account.profile, { schema: ownProfileSchema, signal })
}

export function updateOwnProfile(client: ApiClient, patch: ProfilePatch): Promise<OwnProfile> {
  return client.request(ApiRoutes.account.profile, {
    method: 'PATCH',
    body: patch,
    schema: ownProfileSchema
  })
}

export function fetchAccountPreferences(
  client: ApiClient,
  signal?: AbortSignal
): Promise<AccountPreferences> {
  return client.request(ApiRoutes.account.preferences, {
    schema: accountPreferencesSchema,
    signal
  })
}

export function updateAccountPreferences(
  client: ApiClient,
  patch: AccountPreferencesPatch
): Promise<AccountPreferences> {
  return client.request(ApiRoutes.account.preferences, {
    method: 'PATCH',
    body: patch,
    schema: accountPreferencesSchema
  })
}

export function fetchActiveSessions(
  client: ApiClient,
  signal?: AbortSignal
): Promise<ActiveSession[]> {
  return client.request(ApiRoutes.auth.sessions, {
    schema: z.array(activeSessionSchema),
    signal
  })
}

export function revokeSession(client: ApiClient, sessionId: string): Promise<void> {
  return client.request(ApiRoutes.auth.sessionById(encodeURIComponent(sessionId)), {
    method: 'DELETE',
    schema: z.undefined()
  })
}
