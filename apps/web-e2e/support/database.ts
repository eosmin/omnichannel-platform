import { createOwnerClient, type OwnerClient } from '@platform/core/database-testing'

// The e2e cases build their rows with the builders of the suites in tests/
// eslint-disable-next-line no-restricted-imports -- the only deep relative import, to a folder no alias covers
import { createConversationOf } from '../../../tests/builders'

import { databaseUrls } from './env'

// What a case needs in the database that no screen creates yet (the inbox is Step 3.2): reads and
// writes as the owner role, which is the one that sees every store
export async function withOwner<T>(run: (owner: OwnerClient) => Promise<T>): Promise<T> {
  const owner = createOwnerClient(databaseUrls.owner)
  try {
    return await run(owner)
  } finally {
    await owner.$disconnect()
  }
}

export function newConversationIn(storeId: string): Promise<string> {
  return withOwner(async owner => (await createConversationOf(owner, { storeId })).id)
}

export function messagesOf(
  conversationId: string
): Promise<{ content: string | null; idempotencyKey: string | null }[]> {
  return withOwner(owner =>
    owner.message.findMany({
      where: { conversationId },
      select: { content: true, idempotencyKey: true }
    })
  )
}

export async function storeIdNamed(name: string): Promise<string> {
  const store = await withOwner(owner => owner.store.findFirst({ where: { name } }))
  if (store === null) throw new Error(`no store named ${name}`)
  return store.id
}

export async function userIdOf(email: string): Promise<string> {
  const user = await withOwner(owner => owner.user.findUnique({ where: { email } }))
  if (user === null) throw new Error(`no user with the address ${email}`)
  return user.id
}
