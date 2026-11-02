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
import { type UploadFileInfo, uploadUrlSchema, type UploadUrlView } from './media-api'

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

// The picture of the person: three steps like a file of a message, on routes that need no store
// (and so no permission: a Viewer has a picture too). Attaching it is `updateOwnProfile`.
const confirmedAvatarSchema = z.object({ mediaId: z.string(), status: z.string() })
export type ConfirmedAvatar = z.output<typeof confirmedAvatarSchema>

export function requestAvatarUploadUrl(
  client: ApiClient,
  file: UploadFileInfo
): Promise<UploadUrlView> {
  return client.request(ApiRoutes.account.avatarUploadUrl, {
    method: 'POST',
    body: file,
    schema: uploadUrlSchema
  })
}

export function confirmAvatarUpload(
  client: ApiClient,
  input: UploadFileInfo & { mediaId: string; key: string }
): Promise<ConfirmedAvatar> {
  return client.request(ApiRoutes.account.avatarConfirm, {
    method: 'POST',
    body: input,
    schema: confirmedAvatarSchema
  })
}

export function removeAvatar(client: ApiClient): Promise<OwnProfile> {
  return client.request(ApiRoutes.account.avatar, { method: 'DELETE', schema: ownProfileSchema })
}
