import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import {
  type StorePreferences,
  storePreferencesSchema,
  type UpdateStorePreferencesBody
} from '@platform/core/store-preferences'

// GET and PUT /settings/preferences (TDD_17 §4.14): the preferences of the store, read with the factory default of each
// key (`storePreferencesSchema` is the one place of those defaults). The pages that draw some of the keys (Inbox behavior,
// Preferences) share this view and this cache entry, and each sends only the keys it changed.
export type PreferencesView = StorePreferences
export type PreferencesInput = UpdateStorePreferencesBody

export function fetchPreferences(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<PreferencesView> {
  return client.request(ApiRoutes.settings.preferences, {
    schema: storePreferencesSchema,
    storeId,
    signal
  })
}

// Only the keys that change are sent: the others keep their value on the api
export function savePreferences(
  client: ApiClient,
  storeId: string,
  input: PreferencesInput
): Promise<PreferencesView> {
  return client.request(ApiRoutes.settings.preferences, {
    method: 'PUT',
    body: input,
    schema: storePreferencesSchema,
    storeId
  })
}
