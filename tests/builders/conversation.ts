import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import type { ChannelType } from '@platform/core/domain'

// A conversation of a customer through one of their identities, over a connection made for it
export async function createConversation(
  owner: OwnerClient,
  input: {
    storeId: string
    customerId: string
    customerIdentityId: string
    channelType: ChannelType
  }
): Promise<{ id: string }> {
  const connection = await owner.channelConnection.create({
    data: {
      storeId: input.storeId,
      pluginId: input.channelType,
      connectionId: `conn-${randomUUID()}`,
      displayName: 'test connection',
      credentials: Buffer.from('not a secret')
    },
    select: { id: true }
  })
  return owner.conversation.create({
    data: {
      storeId: input.storeId,
      customerId: input.customerId,
      customerIdentityId: input.customerIdentityId,
      channelConnectionId: connection.id,
      channelType: input.channelType
    },
    select: { id: true }
  })
}
