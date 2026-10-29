import { Injectable } from '@nestjs/common'

import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'

import { ChannelConnectionResolver } from '../channels/channel-connection.resolver'
import { parseChannelIdentity } from '../customers/identity'

export interface InboundTargetEvent {
  connectionId: string
  channelIdentity: string
  targetExternalId: string
}

export interface InboundTarget {
  storeId: string
  customerIdentityId: string
  messageId: string
}

// Finds the stored message that an event of a channel is about (a reaction, an edit, a deletion): the
// message with that provider id, in a thread of that customer on that connection. None of these events
// opens a customer or a conversation, so what has nothing to attach to is dropped.
//
// The message, or the customer, may not be stored yet (the events of a handle are not ordered): until
// the last attempt it throws, so that the queue tries again.
@Injectable()
export class InboundMessageTargets {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ChannelConnectionResolver
  ) {}

  // Runs `apply` inside the transaction that holds the locks of the store and of the handle, and
  // returns whether it ran
  async apply(
    pluginId: string,
    event: InboundTargetEvent,
    what: string,
    isLastAttempt: boolean,
    apply: (tx: PrismaTransaction, target: InboundTarget) => Promise<void>
  ): Promise<boolean> {
    const connection = await this.connections.resolve(pluginId, event.connectionId)
    if (connection === null || !connection.active) return false
    const { storeId } = connection
    const parsed = parseChannelIdentity(pluginId, event.channelIdentity, { fromChannel: true })
    if (parsed === null) return false
    const identity = await this.prisma.client.customerIdentity.findFirst({
      where: { storeId, channelType: pluginId, channelIdentity: parsed.identity },
      select: { id: true }
    })
    if (identity === null) {
      // The message of that customer may be being stored right now, and makes the identity
      if (!isLastAttempt) throw new Error(`the ${what} came before the customer it is from`)
      return false
    }
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Takes turns with the messages of the same handle: the event may follow its message closely
      await lockStoreScope(tx, storeId, `inbound-${identity.id}`)
      const target = await tx.message.findFirst({
        where: {
          storeId,
          channelMessageId: event.targetExternalId,
          conversation: { customerIdentityId: identity.id, channelConnectionId: connection.id }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true }
      })
      if (target === null) {
        if (!isLastAttempt) throw new Error(`the ${what} came before the message it points at`)
        return false
      }
      await apply(tx, { storeId, customerIdentityId: identity.id, messageId: target.id })
      return true
    })
  }
}
