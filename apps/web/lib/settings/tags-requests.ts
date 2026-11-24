import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Tags: what the api answers about the tags of a store. Kept with the page and not in
// `@platform/api-client`, whose barrel the inbox loads whole.

const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable()
})
export type StoreTagView = z.output<typeof tagSchema>

// `description: null` clears it; a field left out keeps its value
export interface TagInput {
  name: string
  color: string
  description: string | null
}

const enc = encodeURIComponent

export function fetchStoreTags(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<StoreTagView[]> {
  return client.request(ApiRoutes.settings.tags, { schema: z.array(tagSchema), storeId, signal })
}

export function createStoreTag(
  client: ApiClient,
  storeId: string,
  input: TagInput
): Promise<StoreTagView> {
  // The api refuses a null description on create: it is left out
  const { description, ...rest } = input
  return client.request(ApiRoutes.settings.tags, {
    method: 'POST',
    body: description === null ? rest : input,
    schema: tagSchema,
    storeId
  })
}

export function updateStoreTag(
  client: ApiClient,
  storeId: string,
  tagId: string,
  input: Partial<TagInput>
): Promise<StoreTagView> {
  return client.request(ApiRoutes.settings.tagById(enc(tagId)), {
    method: 'PATCH',
    body: input,
    schema: tagSchema,
    storeId
  })
}

export function deleteStoreTag(
  client: ApiClient,
  storeId: string,
  tagId: string
): Promise<undefined> {
  return client.request(ApiRoutes.settings.tagById(enc(tagId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}
