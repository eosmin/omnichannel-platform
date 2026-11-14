import { createHash, randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { Events } from '@platform/core/events'

// A webhook written as the owner, with a secret nobody can open: the suites that deliver one seal a real one themselves
export async function createWebhook(
  owner: OwnerClient,
  input: { storeId: string; url?: string; events?: string[] }
): Promise<{ id: string }> {
  return owner.webhook.create({
    data: {
      storeId: input.storeId,
      url: input.url ?? 'https://8.8.8.8/hook',
      events: input.events ?? [Events.ORDER_CREATED],
      secret: Buffer.from('not-a-sealed-secret'),
      createdBy: randomUUID() // A plain column, not a foreign key
    },
    select: { id: true }
  })
}

// A key written as the owner: the hash of a random text, so no request can ever present it
export async function createApiKey(
  owner: OwnerClient,
  input: { storeId: string; scopes?: string[] }
): Promise<{ id: string }> {
  const token = randomUUID()
  return owner.apiKey.create({
    data: {
      storeId: input.storeId,
      name: 'Integration',
      keyPrefix: 'pk_live_xxxx',
      keyHash: createHash('sha256').update(token).digest('hex'),
      scopes: input.scopes ?? ['customers:view'],
      createdBy: randomUUID() // A plain column, not a foreign key
    },
    select: { id: true }
  })
}
