import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutesSettings } from '@platform/core/api'

// Settings → API keys: what the api answers about the keys of a store. Kept with the page and not in `@platform/api-client`,
// whose barrel the inbox loads whole. A status this page does not know stays as the text it came as.

const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  // The only part of a key that is shown again: it tells two keys apart
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  status: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable()
})
export type ApiKeyView = z.output<typeof apiKeySchema>

// The answer that makes a key: the only time the key itself leaves the platform
const apiKeyWithTokenSchema = apiKeySchema.extend({ key: z.string() })
export type ApiKeyWithTokenView = z.output<typeof apiKeyWithTokenSchema>

export interface CreateApiKeyInput {
  name: string
  scopes: string[]
  // An instant (ISO 8601); left out, the key lasts until it is revoked
  expiresAt?: string
}

export function fetchApiKeys(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<ApiKeyView[]> {
  return client.request(ApiRoutesSettings.apiKeys, {
    schema: z.array(apiKeySchema),
    storeId,
    signal
  })
}

export function createApiKey(
  client: ApiClient,
  storeId: string,
  input: CreateApiKeyInput
): Promise<ApiKeyWithTokenView> {
  return client.request(ApiRoutesSettings.apiKeys, {
    method: 'POST',
    body: input,
    schema: apiKeyWithTokenSchema,
    storeId
  })
}

// The row stays, as revoked: it is the history of who held the key
export function revokeApiKey(
  client: ApiClient,
  storeId: string,
  keyId: string
): Promise<ApiKeyView> {
  return client.request(ApiRoutesSettings.apiKeyById(encodeURIComponent(keyId)), {
    method: 'DELETE',
    schema: apiKeySchema,
    storeId
  })
}
