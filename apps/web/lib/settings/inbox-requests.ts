import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Inbox behavior: how resolving and reopening work in a store, and the one switch of the
// store preferences that Step 3.1 reads. `requestCsat` is in the answer and is neither drawn nor sent:
// the MVP has no CSAT.

const inboxSchema = z.object({
  reopenWindowDays: z.number().int().nullable(),
  autoArchiveAfterDays: z.number().int(),
  resolveShowOptions: z.boolean(),
  sendClosingMessage: z.boolean(),
  closingSnippetId: z.string().nullable(),
  agentLoadThreshold: z.number().int()
})
export type InboxSettingsView = z.output<typeof inboxSchema>
export type InboxSettingsInput = Partial<InboxSettingsView>

export function fetchInboxSettings(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<InboxSettingsView> {
  return client.request(ApiRoutes.settings.inbox, { schema: inboxSchema, storeId, signal })
}

export function saveInboxSettings(
  client: ApiClient,
  storeId: string,
  input: InboxSettingsInput
): Promise<InboxSettingsView> {
  return client.request(ApiRoutes.settings.inbox, {
    method: 'PATCH',
    body: input,
    schema: inboxSchema,
    storeId
  })
}

// The preferences moved to their own file, which the Preferences page shares
export { fetchPreferences, type PreferencesView, savePreferences } from './preferences-requests'
