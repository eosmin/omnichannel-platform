import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import {
  lockConversationForWrite,
  requireAnyPermission,
  type Viewer
} from '../conversations/conversations.support'
import { OutboundQueue } from '../outbound/outbound-queue'

import { MessageReactionsService } from './message-reactions.service'

// What a thread of the team is made of and the customer never sees
const NOT_SENT_TO_CHANNEL: readonly string[] = [MessageType.SYSTEM, MessageType.INTERNAL_NOTE]

// An agent reacting to a message of a conversation. The reaction is stored at once, as `queued`, so the
// team sees it; the worker sends it to the channel and settles it as `sent` or `failed`, and the thread
// shows which, so that nobody believes a customer saw what the channel refused.
@Injectable()
export class AgentReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reactions: MessageReactionsService,
    private readonly outbound: OutboundQueue,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AgentReactionsService.name)
  }

  // `supportsReactions` is asked of the channel of the conversation: the plugin registry lives above
  // this library, so the api hands the answer in. Whether the provider takes this particular message
  // (its age, its kind) is the plugin's to say at send time, and shows as a failed reaction.
  async react(
    storeId: string,
    messageId: string,
    emoji: string | null,
    viewer: Viewer,
    supportsReactions: (channelType: string) => boolean
  ): Promise<void> {
    requireAnyPermission(viewer.held, [Permissions.MESSAGES_SEND])
    const target = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: { conversationId: true }
    })
    // The same answer as a conversation that is not seen: the id of a message must not tell that it exists
    if (target === null) throw resourceNotFound('conversation')

    await this.prisma.transaction(async tx => {
      // The conversation row is locked first, as every write to a thread: a conversation the agent may
      // not see is one that does not exist
      await lockConversationForWrite(tx, storeId, target.conversationId, viewer)
      const message = await tx.message.findFirst({
        where: { id: messageId, storeId },
        select: {
          type: true,
          channelMessageId: true,
          conversation: { select: { channelType: true } }
        }
      })
      if (message === null) throw resourceNotFound('conversation')
      if (NOT_SENT_TO_CHANNEL.includes(message.type) || message.channelMessageId === null) {
        throw resourceConflict('the message has no copy in the channel to react to')
      }
      if (!supportsReactions(message.conversation.channelType)) {
        throw new PlatformException(
          ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
          'the channel of this conversation does not take reactions',
          HttpStatusCodes.CONFLICT
        )
      }
      const changedAt = await this.reactions.set(
        tx,
        storeId,
        messageId,
        { authorType: AuthorType.AGENT, userId: viewer.userId },
        emoji,
        DeliveryStatus.QUEUED
      )
      // Only after the commit: the worker reads the reaction and must find it
      if (changedAt !== null) {
        this.prisma.afterCommit(tx, () => {
          this.outbound
            .enqueueReaction({
              storeId,
              messageId,
              userId: viewer.userId,
              version: changedAt.getTime()
            })
            .catch((error: unknown) => {
              this.logger.warn(
                { messageId, errorName: errorName(error) },
                'a reaction could not be queued; it stays queued'
              )
            })
        })
      }
    })
  }
}
