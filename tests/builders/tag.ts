import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'

export interface TagInput {
  storeId: string
  name?: string
}

// Builders write as the owner, so that a suite can put a row in any store: the api cannot, and it
// is the very thing the suite is about
export async function createTag(
  owner: OwnerClient,
  input: TagInput
): Promise<{ id: string; name: string }> {
  return owner.tag.create({
    data: {
      storeId: input.storeId,
      name: input.name ?? `tag-${randomUUID().slice(0, 8)}`,
      color: '#8b5cf6'
    },
    select: { id: true, name: true }
  })
}
