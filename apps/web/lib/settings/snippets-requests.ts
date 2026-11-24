import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Snippets: what the api answers about the saved replies of a store (see tags-requests.ts
// for why it lives here).

const snippetSchema = z.object({
  id: z.string(),
  shortcut: z.string(),
  title: z.string(),
  content: z.string(),
  updatedAt: z.string()
})
export type StoreSnippetView = z.output<typeof snippetSchema>

export interface SnippetInput {
  shortcut: string
  title: string
  content: string
}

const enc = encodeURIComponent

export function fetchStoreSnippets(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<StoreSnippetView[]> {
  return client.request(ApiRoutes.settings.snippets, {
    schema: z.array(snippetSchema),
    storeId,
    signal
  })
}

export function createStoreSnippet(
  client: ApiClient,
  storeId: string,
  input: SnippetInput
): Promise<StoreSnippetView> {
  return client.request(ApiRoutes.settings.snippets, {
    method: 'POST',
    body: input,
    schema: snippetSchema,
    storeId
  })
}

export function updateStoreSnippet(
  client: ApiClient,
  storeId: string,
  snippetId: string,
  input: Partial<SnippetInput>
): Promise<StoreSnippetView> {
  return client.request(ApiRoutes.settings.snippetById(enc(snippetId)), {
    method: 'PATCH',
    body: input,
    schema: snippetSchema,
    storeId
  })
}

export function deleteStoreSnippet(
  client: ApiClient,
  storeId: string,
  snippetId: string
): Promise<undefined> {
  return client.request(ApiRoutes.settings.snippetById(enc(snippetId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}
