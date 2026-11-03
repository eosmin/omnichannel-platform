import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  AppPaths,
  AuthorType,
  ChannelConnectionStatus,
  ConversationStatus,
  DeliveryStatus,
  MembershipStatus,
  StoreSettingsSections
} from '@platform/core/domain'
import {
  type ActorRef,
  type ChannelDisconnectedPayload,
  ChannelDisconnectedReasons,
  type ConversationAssignedPayload,
  type ConversationReopenedPayload,
  type ConversationSnoozeExpiredPayload,
  type ConversationUnassignedPayload,
  Events,
  type MemberJoinedPayload,
  type MessageFailedPayload
} from '@platform/core/events'
import { conversationReaders, isHiddenStatus } from '@platform/core/messaging'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsService } from './notifications.service'

// The notifications that go to a group or to someone other than the owner of a conversation: the
// queue of the team, a reply that did not go out, a new member, a channel that went down. Ids only in
// the events; who is told is decided here, from the rows as they are now. The ones for the owner of a
// conversation are in NotificationsEventsListener.
@Injectable()
export class NotificationsInboxListener {
  private readonly logger = new Logger(NotificationsInboxListener.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  // Routing finished and nobody got it
  @OnEvent(Events.CONVERSATION_UNASSIGNED)
  async onUnassigned(payload: ConversationUnassignedPayload): Promise<void> {
    await this.notifyQueue(payload.storeId, payload.conversationId, payload.unassignedBy)
  }

  // A person gave the conversation up (assigned it to nobody): who took it from the owner knows
  @OnEvent(Events.CONVERSATION_ASSIGNED)
  async onAssigned(payload: ConversationAssignedPayload): Promise<void> {
    if (payload.assignedTo !== null) return
    await this.notifyQueue(payload.storeId, payload.conversationId, payload.assignedBy)
  }

  // Nothing records who snoozed a conversation nobody owns, so the team is told when it is back
  @OnEvent(Events.CONVERSATION_SNOOZE_EXPIRED)
  async onSnoozeExpired(payload: ConversationSnoozeExpiredPayload): Promise<void> {
    if (payload.assignedTo !== null) return
    await this.notifyQueue(payload.storeId, payload.conversationId, null)
  }

  // A person reopened a conversation nobody owns, by hand (no reason). When the customer's message did
  // it, routing runs next and says it itself if nobody takes it; when a reply did it, the team just
  // answered it and it is not news to the team.
  @OnEvent(Events.CONVERSATION_REOPENED)
  async onReopened(payload: ConversationReopenedPayload): Promise<void> {
    if (payload.assignedTo !== null || payload.reason !== null) return
    await this.notifyQueue(payload.storeId, payload.conversationId, payload.reopenedBy)
  }

  // To who may take it (see it, and take it by resolving or assigning: the rule of `assign`), except
  // the person who just caused it, and once per conversation until they look: a queue that keeps
  // growing must not ring for every line. The row is read now: it has to be open, nobody's, and in
  // sight still.
  private async notifyQueue(
    storeId: string,
    conversationId: string,
    cause: ActorRef | null
  ): Promise<void> {
    try {
      const conversation = await this.prisma.client.conversation.findFirst({
        where: { id: conversationId, storeId },
        select: { status: true, assignedTo: true }
      })
      if (
        conversation === null ||
        conversation.assignedTo !== null ||
        conversation.status !== String(ConversationStatus.OPEN)
      ) {
        return
      }
      const takers = await this.prisma.client.membership.findMany({
        where: {
          AND: [
            conversationReaders({ hidden: false, assignedTo: null }, { storeId, notes: false }),
            {
              role: {
                permissions: {
                  some: {
                    name: {
                      in: [Permissions.CONVERSATIONS_RESOLVE, Permissions.CONVERSATIONS_ASSIGN]
                    }
                  }
                }
              }
            }
          ],
          ...(cause?.type === 'user' && cause.id !== null ? { userId: { not: cause.id } } : {})
        },
        select: { userId: true }
      })
      await this.notifications.sendToUsersOnce(
        takers.map(member => member.userId),
        {
          storeId,
          type: NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE,
          resourceType: 'conversation',
          resourceId: conversationId,
          actionPath: AppPaths.store.conversation(storeId, conversationId)
        }
      )
    } catch (error) {
      this.logger.error(
        { conversationId, err: String(error) },
        'the unassigned queue could not be notified'
      )
    }
  }

  // To who wrote the reply, if they can still open the conversation; a reply nobody on the team wrote
  // (the platform's, an automatic one) goes to the owner of the conversation. The state is read from the
  // row: a reply that went out on the second try is not news.
  @OnEvent(Events.MESSAGE_FAILED)
  async onMessageFailed(payload: MessageFailedPayload): Promise<void> {
    const { storeId, conversationId, messageId } = payload
    try {
      const message = await this.prisma.client.message.findFirst({
        where: { id: messageId, storeId, conversationId },
        select: { authorType: true, authorId: true, deliveryStatus: true }
      })
      // A note has no delivery state, so only a reply can be here
      if (message?.deliveryStatus !== String(DeliveryStatus.FAILED)) return
      const conversation = await this.prisma.client.conversation.findFirst({
        where: { id: conversationId, storeId },
        select: { status: true, assignedTo: true }
      })
      if (conversation === null) return
      const recipient =
        message.authorType === String(AuthorType.AGENT) && message.authorId !== null
          ? message.authorId
          : conversation.assignedTo
      if (recipient === null) return
      const reader = await this.prisma.client.membership.count({
        where: {
          userId: recipient,
          ...conversationReaders(
            { hidden: isHiddenStatus(conversation.status), assignedTo: conversation.assignedTo },
            { storeId, notes: false }
          )
        }
      })
      if (reader === 0) return
      await this.notifications.sendToUsersOnce([recipient], {
        storeId,
        type: NotificationTypes.MESSAGE_FAILED,
        resourceType: 'message',
        resourceId: messageId,
        actionPath: AppPaths.store.conversation(storeId, conversationId)
      })
    } catch (error) {
      this.logger.error({ messageId, err: String(error) }, 'a failed message could not be notified')
    }
  }

  // Two different people need to know: who invited (their invitation worked) and who runs the team
  // (the roster changed). Nobody is told twice, and nobody is told about themselves.
  @OnEvent(Events.MEMBER_JOINED)
  async onMemberJoined(payload: MemberJoinedPayload): Promise<void> {
    const { storeId, userId, invitedBy } = payload
    try {
      const joined = await this.prisma.client.membership.count({
        where: { userId, storeId, status: MembershipStatus.ACTIVE, revokedAt: null }
      })
      if (joined === 0) return
      const actionPath = AppPaths.store.settings(storeId, StoreSettingsSections.TEAM)
      const inviter = await this.prisma.client.membership.count({
        where: { userId: invitedBy, storeId, status: MembershipStatus.ACTIVE, revokedAt: null }
      })
      if (inviter > 0 && invitedBy !== userId) {
        await this.notifications.send({
          userId: invitedBy,
          storeId,
          type: NotificationTypes.INVITATION_ACCEPTED,
          resourceType: 'user',
          resourceId: userId,
          actionPath
        })
      }
      await this.notifications.sendToStore({
        storeId,
        type: NotificationTypes.MEMBER_JOINED,
        resourceType: 'user',
        resourceId: userId,
        actionPath,
        excludeUserIds: [userId, invitedBy],
        requiredPermission: Permissions.TEAM_INVITE
      })
    } catch (error) {
      this.logger.error({ storeId, err: String(error) }, 'a new member could not be notified')
    }
  }

  // Only when the health check took it down (a person who disconnects it knows). To who can set it up
  // again, once per connection until they look; the row must still be in error.
  @OnEvent(Events.CHANNEL_DISCONNECTED)
  async onChannelDisconnected(payload: ChannelDisconnectedPayload): Promise<void> {
    if (payload.reason !== ChannelDisconnectedReasons.ERROR) return
    const { storeId, channelConnectionId } = payload
    try {
      const connection = await this.prisma.client.channelConnection.findFirst({
        where: { id: channelConnectionId, storeId },
        select: { status: true }
      })
      if (connection === null || connection.status !== String(ChannelConnectionStatus.ERROR)) {
        return
      }
      const managers = await this.prisma.client.membership.findMany({
        where: {
          storeId,
          status: MembershipStatus.ACTIVE,
          revokedAt: null,
          role: { permissions: { some: { name: Permissions.SETTINGS_MANAGE_PLUGINS } } }
        },
        select: { userId: true }
      })
      await this.notifications.sendToUsersOnce(
        managers.map(member => member.userId),
        {
          storeId,
          type: NotificationTypes.CHANNEL_DISCONNECTED,
          resourceType: 'channel_connection',
          resourceId: channelConnectionId,
          actionPath: AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS)
        }
      )
    } catch (error) {
      this.logger.error(
        { channelConnectionId, err: String(error) },
        'a disconnected channel could not be notified'
      )
    }
  }
}
