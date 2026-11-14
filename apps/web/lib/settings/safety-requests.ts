import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import {
  type SafetySettings,
  safetySettingsSchema,
  type UpdateSafetySettingsBody
} from '@platform/core/domain'

// Settings → Safety and confirmations: what a store asks before a destructive action (TDD_09 §11.2). Kept with the page and
// not in `@platform/api-client`, whose barrel the inbox loads whole. The api answers the stored settings with a missing or
// damaged key already read as its default, and the schema of the domain holds the answer to the same rule.
export type SafetyView = SafetySettings
export type SafetyInput = UpdateSafetySettingsBody

export function fetchSafety(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<SafetyView> {
  return client.request(ApiRoutes.settings.safety, {
    schema: safetySettingsSchema,
    storeId,
    signal
  })
}

// The keys named change and the rest keep their value; the answer is the whole settings
export function saveSafety(
  client: ApiClient,
  storeId: string,
  input: SafetyInput
): Promise<SafetyView> {
  return client.request(ApiRoutes.settings.safety, {
    method: 'PUT',
    body: input,
    schema: safetySettingsSchema,
    storeId
  })
}
