import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { AppPaths } from '@platform/core/domain'
import {
  Events,
  type MessageChangedPayload,
  type MessageMentionPayload
} from '@platform/core/events'
import { conversationReaders, isHiddenStatus } from '@platform/core/messaging'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsService } from './notifications.service'

// Domain events to notifications. The events carry ids only, and who may be told is decided here,
// when the notification is made, not when the event was raised: a role may have changed in between.
// MEDIA_INFECTED comes from the worker through the bridge, so this runs on one api instance only.
@Injectable()
export class NotificationsEventsListener {
  private readonly logger = new Logger(NotificationsEventsListener.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService
  ) {}

  // Only to the person mentioned, and only if they may still open the conversation and read its notes
  @OnEvent(Events.MESSAGE_MENTION)
  async onMention(payload: MessageMentionPayload): Promise<void> {
    try {
      const { storeId, conversationId, messageId, mentionedUserId } = payload
      const conversation = await this.prisma.client.conversation.findFirst({
        where: { id: conversationId, storeId },
        select: { status: true, assignedTo: true }
      })
      if (conversation === null) return
      const reader = await this.prisma.client.membership.count({
        where: {
          userId: mentionedUserId,
          ...conversationReaders(
            { hidden: isHiddenStatus(conversation.status), assignedTo: conversation.assignedTo },
            { storeId, notes: true }
          )
        }
      })
      if (reader === 0) return
      await this.notifications.send({
        userId: mentionedUserId,
        storeId,
        type: NotificationTypes.CONVERSATION_MENTIONED,
        resourceType: 'message',
        resourceId: messageId,
        actionPath: AppPaths.store.conversation(storeId, conversationId)
      })
    } catch (error) {
      this.logger.error(
        { messageId: payload.messageId, err: String(error) },
        'a mention could not be notified'
      )
    }
  }

  // To who may read the conversation of the message (its notes too, when it is a note), and the audit
  // entry of the block. A file that belongs to no message has no event: the composer shows its state.
  @OnEvent(Events.MEDIA_INFECTED)
  async onInfected(payload: MessageChangedPayload): Promise<void> {
    const { storeId, conversationId, messageId } = payload
    try {
      this.audit.log({
        action: AuditAction.MEDIA_INFECTED,
        actor: { system: true },
        storeId,
        resourceType: 'message',
        resourceId: messageId
      })
      const readers = await this.prisma.client.membership.findMany({
        where: conversationReaders(payload.visibility, { storeId, notes: payload.internal }),
        select: { userId: true }
      })
      // Announced once per infected file: a message with two of them must not tell anyone twice
      const told = await this.prisma.client.notification.findMany({
        where: { storeId, type: NotificationTypes.MEDIA_INFECTED, resourceId: messageId },
        select: { userId: true }
      })
      const already = new Set(told.map(row => row.userId))
      await this.notifications.sendToUsers(
        readers.map(reader => reader.userId).filter(userId => !already.has(userId)),
        {
          storeId,
          type: NotificationTypes.MEDIA_INFECTED,
          resourceType: 'message',
          resourceId: messageId,
          actionPath: AppPaths.store.conversation(storeId, conversationId)
        }
      )
    } catch (error) {
      this.logger.error({ messageId, err: String(error) }, 'an infected file could not be notified')
    }
  }
}
