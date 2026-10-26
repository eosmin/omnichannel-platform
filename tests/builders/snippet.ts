import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'

export interface SnippetInput {
  storeId: string
  shortcut?: string
}

export async function createSnippet(
  owner: OwnerClient,
  input: SnippetInput
): Promise<{ id: string; shortcut: string }> {
  return owner.snippet.create({
    data: {
      storeId: input.storeId,
      shortcut: input.shortcut ?? `s-${randomUUID().slice(0, 8)}`,
      title: 'Greeting',
      content: 'Hello!',
      createdBy: randomUUID() // A plain column, not a foreign key
    },
    select: { id: true, shortcut: true }
  })
}
