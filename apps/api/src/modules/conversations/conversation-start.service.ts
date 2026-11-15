import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, OfActiveInstallation } from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import {
  type ConversationDetail,
  ConversationsService,
  RoutingService,
  type Viewer
} from '@platform/core/messaging'

export interface StartedConversation {
  // false when the thread of that handle on that connection already existed: there is one continuous thread for each
  created: boolean
  conversation: ConversationDetail
}

// Starts the conversation of a customer's handle on one of the store's channel accounts, from outside the inbox (a plugin: the
// first route of the product that does). There is one continuous thread for each handle on each connection, as the inbound
// pipeline keeps it, so a handle that already has one gets that one back and nothing is created. No message is written: the
// first message is the plugin's to send (`POST /plugin-api/messages`). A new thread goes through the routing rules once, as the
// thread of a message with no text does (the rules that look at a text do not match), and when no rule takes it the team is told
// it waits in the queue, because the reply of the customer finds the thread already open and is not routed again. The thread of a handle that was archived or marked as spam is not given back to a caller that may not see it.
@Injectable()
export class ConversationStartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly routing: RoutingService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ConversationStartService.name)
  }

  async start(
    storeId: string,
    input: { customerIdentityId: string; channelConnectionId: string },
    viewer: Viewer
  ): Promise<StartedConversation> {
    const placed = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The same lock the inbound pipeline takes for a handle, so that a message of the customer and this call do not open two threads
      await lockStoreScope(tx, storeId, `inbound-${input.customerIdentityId}`)
      const identity = await tx.customerIdentity.findFirst({
        where: { id: input.customerIdentityId, storeId },
        select: { customerId: true, channelType: true, customer: { select: { erasedAt: true } } }
      })
      if (identity === null) throw resourceNotFound('customer identity')
      // A person who asked to be erased is not written to again
      if (identity.customer.erasedAt !== null) throw resourceConflict('the customer was erased')
      // The account must be one of the store's that works (connected, on an active installation), and of the channel of the handle, whether the thread exists or not
      const connection = await tx.channelConnection.findFirst({
        where: {
          id: input.channelConnectionId,
          storeId,
          status: ChannelConnectionStatus.ACTIVE,
          ...OfActiveInstallation
        },
        select: { pluginId: true }
      })
      if (connection === null) throw resourceNotFound('channel connection')
      if (connection.pluginId !== identity.channelType) {
        throw resourceConflict('the identity and the connection are of different channels')
      }
      const existing = await tx.conversation.findFirst({
        where: {
          storeId,
          customerIdentityId: input.customerIdentityId,
          channelConnectionId: input.channelConnectionId
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true }
      })
      if (existing !== null) return { id: existing.id, created: false }
      const id = await this.conversations.createIn(tx, storeId, {
        customerId: identity.customerId,
        customerIdentityId: input.customerIdentityId,
        channelConnectionId: input.channelConnectionId
      })
      return { id, created: true }
    })
    if (placed.created) await this.route(storeId, placed.id)
    // Read as the caller sees it: a hidden thread (archived, spam) is a 404 for who may not see those
    const conversation = await this.conversations.get(storeId, placed.id, viewer)
    return { created: placed.created, conversation }
  }

  // After the thread is committed, in a transaction of its own: a rule that fails must never cost the conversation
  private async route(storeId: string, conversationId: string): Promise<void> {
    try {
      await this.routing.apply(storeId, conversationId, { text: null, receivedAt: new Date() })
    } catch (error) {
      this.logger.error({ err: error, storeId, conversationId }, 'routing failed, left unassigned')
      await this.routing.announceQueue(storeId, conversationId)
    }
  }
}
