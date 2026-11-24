import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Deletes a conversation with its messages and its files for good (`DELETE /conversations/:id`, conversations:delete).
// Kept out of `@platform/api-client`, whose barrel the inbox loads whole: only an administrator ever calls it.
export function deleteConversation(
  client: ApiClient,
  storeId: string,
  conversationId: string
): Promise<undefined> {
  return client.request(ApiRoutes.conversations.byId(encodeURIComponent(conversationId)), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}
