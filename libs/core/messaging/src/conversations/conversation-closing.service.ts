import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  ResolveUndo
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { CLOSING_MESSAGE_METADATA } from '../messages/closing-message'
import { MessagingWindowService } from '../messaging-window/messaging-window.service'
import { OutboundQueue } from '../outbound/outbound-queue'

import { ConversationsService, type StatusOptions } from './conversations.service'
import {
  isHiddenStatus,
  lockConversationForWrite,
  requireAnyPermission,
  type Viewer
} from './conversations.support'
import type { ConversationDetail } from './conversations.views'

// Resolving with a closing message (the saved reply of the resolve dialog). The conversation is
// resolved at once; the message is stored as queued and handed to the outbound queue with the time of
// the Undo, and the worker sends it only if the conversation is still resolved by this resolution
// (`OutboundSender`). It does not go through `MessagesService.create`, because that reopens a
// resolved conversation.
@Injectable()
export class ConversationClosingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly window: MessagingWindowService,
    private readonly events: DomainEvents,
    private readonly outbound: OutboundQueue,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ConversationClosingService.name)
  }

  // A closing message the conversation cannot take (the messaging window is closed, or the saved reply
  // was deleted since the agent chose it) is left out, and the conversation is resolved all the same:
  // it is a courtesy, not the point of the action.
  async resolve(
    storeId: string,
    conversationId: string,
    snippetId: string,
    options: StatusOptions & { actor: Viewer }
  ): Promise<ConversationDetail> {
    const { actor } = options
    // Asked for, so refused when not allowed: the resolve does not happen without it
    requireAnyPermission(actor.held, [Permissions.MESSAGES_SEND])
    await this.prisma.transaction(async tx => {
      await this.conversations.applyStatus(
        tx,
        storeId,
        conversationId,
        ConversationStatus.RESOLVED,
        options
      )
      const current = await lockConversationForWrite(tx, storeId, conversationId, actor)
      const snippet = await tx.snippet.findFirst({
        where: { id: snippetId, storeId },
        select: { content: true }
      })
      if (snippet === null) return
      if (!(await this.window.isOpen(tx, storeId, conversationId))) return

      // After the status change, so that the message is never older than the resolution it belongs to
      const now = new Date()
      const row = await tx.message.create({
        data: {
          storeId,
          conversationId,
          type: MessageType.TEXT,
          content: snippet.content,
          authorType: AuthorType.AGENT,
          authorId: actor.userId,
          metadata: CLOSING_MESSAGE_METADATA,
          deliveryStatus: DeliveryStatus.QUEUED,
          createdAt: now
        },
        select: { id: true }
      })
      this.events.publish(tx, Events.MESSAGE_QUEUED, {
        storeId,
        conversationId,
        messageId: row.id,
        authorId: actor.userId,
        clientMessageId: null,
        createdAt: now.toISOString(),
        visibility: { hidden: isHiddenStatus(current.status), assignedTo: current.assignedTo }
      })
      this.prisma.afterCommit(tx, () => {
        this.outbound
          .enqueue(
            { storeId, messageId: row.id },
            ResolveUndo.DURATION_MS + ResolveUndo.CLOSING_GRACE_MS
          )
          .catch((error: unknown) => {
            this.logger.warn(
              { messageId: row.id, errorName: errorName(error) },
              'the closing message could not be queued; the sweep will'
            )
          })
      })
    })
    return this.conversations.get(storeId, conversationId, actor, true)
  }
}
