import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  AppPaths,
  AuthorType,
  ConversationStatus,
  ConversationStatusReasons,
  CountResourceTypes,
  MembershipStatus,
  ProductResourceTypes
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type ConversationAssignedPayload,
  type ConversationReopenedPayload,
  type ConversationSnoozeExpiredPayload,
  type CountSubmittedPayload,
  type ExportSettledPayload,
  Events,
  type InventoryLowPayload,
  type MessageChangedPayload,
  type MessageMentionPayload,
  type MessageReceivedPayload
} from '@platform/core/events'
import { ExportStatus, ExportTypePermissions, type ExportType } from '@platform/core/exports'
import { conversationReaders, isHiddenStatus } from '@platform/core/messaging'
import { type NotificationType, NotificationTypes } from '@platform/core/notifications'

import { customerNameOf, textForParams } from './notification-params'
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
        select: {
          status: true,
          assignedTo: true,
          customer: { select: { name: true } },
          customerIdentity: { select: { displayName: true, channelIdentity: true } }
        }
      })
      if (conversation === null) return
      const [reader, author] = await Promise.all([
        this.prisma.client.membership.count({
          where: {
            userId: mentionedUserId,
            ...conversationReaders(
              { hidden: isHiddenStatus(conversation.status), assignedTo: conversation.assignedTo },
              { storeId, notes: true }
            )
          }
        }),
        this.nameOfUser(payload.authorId)
      ])
      if (reader === 0) return
      await this.notifications.send({
        userId: mentionedUserId,
        storeId,
        type: NotificationTypes.CONVERSATION_MENTIONED,
        // Who wrote the note and whose conversation it is: the texts say it, in the language of the reader
        // The author is left out when it is not known: the plain text then reads right
        params: {
          ...(author === null ? {} : { author }),
          customer: customerNameOf(conversation)
        },
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

  private async nameOfUser(userId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { name: true }
    })
    return user === null ? null : textForParams(user.name)
  }

  // To the person who is given the conversation, unless they took it themselves. It comes from the
  // api (a person assigns, a rule routes) and from the worker (the round robin of a bulk action)
  @OnEvent(Events.CONVERSATION_ASSIGNED)
  async onAssigned(payload: ConversationAssignedPayload): Promise<void> {
    const { storeId, conversationId, assignedTo, previousAssignee, assignedBy } = payload
    if (assignedTo === null || assignedTo === previousAssignee) return
    if (assignedBy.type === 'user' && assignedBy.id === assignedTo) return
    await this.notifyAssignee(NotificationTypes.CONVERSATION_ASSIGNED, {
      storeId,
      conversationId,
      assignee: assignedTo
    })
  }

  // To the assignee when the snooze of their conversation ran out. Nobody records who snoozed it, so
  // a conversation without an assignee tells nobody here: the unassigned queue is its own notification
  @OnEvent(Events.CONVERSATION_SNOOZE_EXPIRED)
  async onSnoozeExpired(payload: ConversationSnoozeExpiredPayload): Promise<void> {
    const { storeId, conversationId, assignedTo } = payload
    if (assignedTo === null) return
    await this.notifyAssignee(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED, {
      storeId,
      conversationId,
      assignee: assignedTo,
      // Resolved, or snoozed again, since the snooze ran out: there is nothing to tell
      mustBe: ConversationStatus.OPEN
    })
  }

  // A person reopened a conversation that was resolved or archived: its owner is told, unless that
  // person is the owner. A reopening by the customer's own message is not told here: that message is
  // the news (`onMessageReceived`), and telling both would be the same alert twice. One nobody owns
  // goes to the queue of the team (`NotificationsInboxListener`).
  @OnEvent(Events.CONVERSATION_REOPENED)
  async onReopened(payload: ConversationReopenedPayload): Promise<void> {
    const { storeId, conversationId, assignedTo, reason, reopenedBy } = payload
    if (assignedTo === null || reason === ConversationStatusReasons.CUSTOMER_REPLIED) return
    await this.notifyAssignee(NotificationTypes.CONVERSATION_REOPENED, {
      storeId,
      conversationId,
      assignee: assignedTo,
      mustBe: ConversationStatus.OPEN,
      ...(reopenedBy.type === 'user' && reopenedBy.id !== null ? { actorId: reopenedBy.id } : {})
    })
  }

  // To the owner of an open conversation when the customer writes, and only once until they look at
  // it: ten messages in a row are one line in the center, not ten. A conversation nobody owns is the
  // queue's news (`NotificationsInboxListener`), never one per message to everyone. What the team
  // wrote itself (an agent, the owner's phone, the platform) is not news to the team.
  @OnEvent(Events.MESSAGE_RECEIVED)
  async onMessageReceived(payload: MessageReceivedPayload): Promise<void> {
    if (payload.authorType !== AuthorType.CUSTOMER) return
    await this.notifyAssignee(NotificationTypes.MESSAGE_RECEIVED, {
      storeId: payload.storeId,
      conversationId: payload.conversationId,
      assignee: null,
      mustBe: ConversationStatus.OPEN,
      once: true,
      // Given the conversation, woken or reopened for them a moment ago, the message adds nothing
      alsoUnread: [
        NotificationTypes.CONVERSATION_ASSIGNED,
        NotificationTypes.CONVERSATION_SNOOZE_EXPIRED,
        NotificationTypes.CONVERSATION_REOPENED
      ]
    })
  }

  // The row is read now, not trusted from the event: the conversation may have gone to someone else, or
  // out of sight, between the change and this listener. Who is told must still be its assignee and
  // still be able to open it. `assignee: null` means whoever has it now; `actorId` is the person who
  // made the change and knows it already; `once` skips who still has this one unread.
  private async notifyAssignee(
    type:
      | typeof NotificationTypes.CONVERSATION_ASSIGNED
      | typeof NotificationTypes.CONVERSATION_SNOOZE_EXPIRED
      | typeof NotificationTypes.CONVERSATION_REOPENED
      | typeof NotificationTypes.MESSAGE_RECEIVED,
    target: {
      storeId: string
      conversationId: string
      assignee: string | null
      mustBe?: `${ConversationStatus}`
      actorId?: string
      once?: boolean
      alsoUnread?: readonly NotificationType[]
    }
  ): Promise<void> {
    const { storeId, conversationId, mustBe, actorId, once, alsoUnread } = target
    try {
      const conversation = await this.prisma.client.conversation.findFirst({
        where: { id: conversationId, storeId },
        select: { status: true, assignedTo: true }
      })
      if (conversation === null || conversation.assignedTo === null) return
      if (target.assignee !== null && conversation.assignedTo !== target.assignee) return
      const assignee = conversation.assignedTo
      if (assignee === actorId) return
      if (mustBe !== undefined && conversation.status !== mustBe) return
      const reader = await this.prisma.client.membership.count({
        where: {
          userId: assignee,
          ...conversationReaders(
            { hidden: isHiddenStatus(conversation.status), assignedTo: conversation.assignedTo },
            { storeId, notes: false }
          )
        }
      })
      if (reader === 0) return
      const notification = {
        storeId,
        type,
        resourceType: 'conversation',
        resourceId: conversationId,
        actionPath: AppPaths.store.conversation(storeId, conversationId)
      }
      if (once === true) {
        await this.notifications.sendToUsersOnce([assignee], {
          ...notification,
          ...(alsoUnread === undefined ? {} : { alsoUnread })
        })
      } else await this.notifications.send({ ...notification, userId: assignee })
    } catch (error) {
      this.logger.error(
        { conversationId, type, err: String(error) },
        'a conversation notification could not be sent'
      )
    }
  }

  // The available stock of a product fell to its threshold or under it (TDD_16 §4.4). The engine raises the event once for
  // each downward crossing, after the commit, so this tells once too. The members who may see the stock are found now, not
  // when the movement happened, and the product is read under the store of the event: an id of another store tells nobody.
  @OnEvent(Events.INVENTORY_LOW)
  async onInventoryLow(payload: InventoryLowPayload): Promise<void> {
    const { storeId, productId, available, threshold } = payload
    try {
      const product = await this.prisma.client.product.findFirst({
        where: { id: productId, storeId },
        select: { name: true }
      })
      if (product === null) return
      const name = textForParams(product.name)
      await this.notifications.sendToStore({
        storeId,
        type: NotificationTypes.INVENTORY_LOW,
        params: { ...(name === null ? {} : { product: name }), available, threshold },
        resourceType: ProductResourceTypes.PRODUCT,
        resourceId: productId,
        actionPath: AppPaths.store.products(storeId),
        requiredPermission: Permissions.INVENTORY_VIEW
      })
    } catch (error) {
      this.logger.error(
        { productId, err: String(error) },
        'a low stock warning could not be notified'
      )
    }
  }

  // A count went to review (TDD_16 §4.6): the people who may apply it are told. The count belongs to the organization, so
  // they are found among the members of ALL its stores who hold inventory:apply_counts, now and not when the count was
  // submitted. A notification is kept in a store: each person is told once, in the store of the submitter when they
  // belong to it, otherwise in the first store where they hold the permission.
  @OnEvent(Events.COUNT_SUBMITTED)
  async onCountSubmitted(payload: CountSubmittedPayload): Promise<void> {
    const { organizationId, storeId, countId, number } = payload
    try {
      const approvers = await this.prisma.client.membership.findMany({
        where: {
          organizationId,
          status: MembershipStatus.ACTIVE,
          revokedAt: null,
          role: { permissions: { some: { name: Permissions.INVENTORY_APPLY_COUNTS } } }
        },
        select: { userId: true, storeId: true },
        orderBy: [{ storeId: 'asc' }]
      })
      const storeOf = new Map<string, string>()
      for (const member of approvers) {
        const known = storeOf.get(member.userId)
        if (known === undefined || (member.storeId === storeId && known !== storeId)) {
          storeOf.set(member.userId, member.storeId)
        }
      }
      const byStore = new Map<string, string[]>()
      for (const [userId, memberStore] of storeOf) {
        byStore.set(memberStore, [...(byStore.get(memberStore) ?? []), userId])
      }
      // A store that fails does not leave the approvers of the next ones untold
      for (const [memberStore, userIds] of byStore) {
        try {
          // Once: a count sent back and submitted again does not stack a second unread line for the same sheet
          await this.notifications.sendToUsersOnce(userIds, {
            storeId: memberStore,
            type: NotificationTypes.COUNT_AWAITING_APPLY,
            params: { number },
            resourceType: CountResourceTypes.COUNT,
            resourceId: countId,
            actionPath: AppPaths.org.counts
          })
        } catch (error) {
          this.logger.error(
            { countId, storeId: memberStore, err: String(error) },
            'a count awaiting apply could not be notified in a store'
          )
        }
      }
    } catch (error) {
      this.logger.error(
        { countId, err: String(error) },
        'a count awaiting apply could not be notified'
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

  // Same readers as an infected file; the team is told to ask the sender for the file again
  @OnEvent(Events.MEDIA_UNSCANNABLE)
  async onUnscannable(payload: MessageChangedPayload): Promise<void> {
    const { storeId, conversationId, messageId } = payload
    try {
      this.audit.log({
        action: AuditAction.MEDIA_UNSCANNABLE,
        actor: { system: true },
        storeId,
        resourceType: 'message',
        resourceId: messageId
      })
      const readers = await this.prisma.client.membership.findMany({
        where: conversationReaders(payload.visibility, { storeId, notes: payload.internal }),
        select: { userId: true }
      })
      const told = await this.prisma.client.notification.findMany({
        where: { storeId, type: NotificationTypes.MEDIA_UNSCANNABLE, resourceId: messageId },
        select: { userId: true }
      })
      const already = new Set(told.map(row => row.userId))
      await this.notifications.sendToUsers(
        readers.map(reader => reader.userId).filter(userId => !already.has(userId)),
        {
          storeId,
          type: NotificationTypes.MEDIA_UNSCANNABLE,
          resourceType: 'message',
          resourceId: messageId,
          actionPath: AppPaths.store.conversation(storeId, conversationId)
        }
      )
    } catch (error) {
      this.logger.error(
        { messageId, err: String(error) },
        'an unscannable file could not be notified'
      )
    }
  }

  @OnEvent(Events.EXPORT_READY)
  async onExportReady(payload: ExportSettledPayload): Promise<void> {
    await this.notifyExport(payload, NotificationTypes.EXPORT_READY)
  }

  @OnEvent(Events.EXPORT_FAILED)
  async onExportFailed(payload: ExportSettledPayload): Promise<void> {
    await this.notifyExport(payload, NotificationTypes.EXPORT_FAILED)
  }

  // Only to who asked for it, and only while they are an active member whose role still makes this
  // kind of export: the center would show them nothing else (an export is personal data, and a row
  // of a kind the role lost is a 404 there). The state is read from the row, not trusted from the event.
  private async notifyExport(
    payload: ExportSettledPayload,
    type: typeof NotificationTypes.EXPORT_READY | typeof NotificationTypes.EXPORT_FAILED
  ): Promise<void> {
    const { storeId, exportId, requestedBy, exportType } = payload
    try {
      const needed = ExportTypePermissions[exportType as ExportType]
      if (needed === undefined) {
        this.logger.warn(
          { exportId, exportType },
          'an export of a kind nobody may see was not notified'
        )
        return
      }
      const row = await this.prisma.client.export.findFirst({
        where: { id: exportId, storeId, requestedBy },
        select: { status: true, key: true, error: true }
      })
      const expected =
        type === NotificationTypes.EXPORT_READY ? ExportStatus.READY : ExportStatus.FAILED
      if (row === null || row.status !== expected) return
      const member = await this.prisma.client.membership.count({
        where: {
          userId: requestedBy,
          storeId,
          status: MembershipStatus.ACTIVE,
          revokedAt: null,
          AND: needed.map(name => ({ role: { permissions: { some: { name } } } }))
        }
      })
      if (member === 0) return
      const filename = row.key?.split('/').pop() ?? ''
      await this.notifications.send({
        userId: requestedBy,
        storeId,
        type,
        params:
          type === NotificationTypes.EXPORT_READY
            ? { filename, type: exportType }
            : // Why it failed, when the worker said (too large, nothing to export): a code the page draws
              row.error === null || row.error === ErrorCodes.EXPORT_FAILED
              ? { type: exportType }
              : { type: exportType, reason: row.error },
        resourceType: 'export',
        resourceId: exportId,
        actionPath: AppPaths.store.exports(storeId)
      })
    } catch (error) {
      this.logger.error({ exportId, err: String(error) }, 'an export could not be notified')
    }
  }
}
