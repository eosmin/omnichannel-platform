import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  AppPaths,
  AuthorType,
  BulkLabelJobStatus,
  CarrierResourceTypes,
  ConversationStatus,
  ConversationStatusReasons,
  CountResourceTypes,
  MembershipStatus,
  OrderResourceTypes,
  OrderStatus,
  PackingNoteNotice,
  PickupResourceTypes,
  ProductResourceTypes,
  ReturnResourceTypes,
  ShipmentResourceTypes,
  ShipmentStatus,
  StoreSettingsSections,
  TransferResourceTypes
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type BulkLabelsDonePayload,
  type ConversationAssignedPayload,
  type ConversationReopenedPayload,
  type ConversationSnoozeExpiredPayload,
  type CarrierStatusUnmappedPayload,
  type RemittanceOverduePayload,
  type CountSubmittedPayload,
  type ExportSettledPayload,
  Events,
  type InventoryLowPayload,
  type MessageChangedPayload,
  type MessageMentionPayload,
  type MessageReceivedPayload,
  type OrderCreatedPayload,
  type OrderEventPayload,
  type OrderMessageNotSentPayload,
  type OrderStatusChangedPayload,
  type PickupCutoffApproachingPayload,
  type PickupManualRequiredPayload,
  type ReturnEventPayload,
  type ShipmentEventPayload,
  type ShipmentStatusChangedPayload,
  type TransferChangedPayload
} from '@platform/core/events'
import { ExportStatus, ExportTypePermissions, type ExportType } from '@platform/core/exports'
import { conversationReaders, isHiddenStatus } from '@platform/core/messaging'
import { type NotificationType, NotificationTypes } from '@platform/core/notifications'
import { readOrderPreferences } from '@platform/core/store-preferences'

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
        actionPath: AppPaths.store.inventoryLow(storeId),
        requiredPermission: Permissions.INVENTORY_VIEW
      })
    } catch (error) {
      this.logger.error(
        { productId, err: String(error) },
        'a low stock warning could not be notified'
      )
    }
  }

  // A carrier sent a status nobody has mapped, and it is the first time (TDD_17 §4.17): until the owner maps it the shipment
  // updates under that code are kept and not applied, so the people who manage carriers are told once. The connection is read
  // under the store of the event (an id of another store tells nobody) and who may be told is decided now.
  @OnEvent(Events.CARRIER_STATUS_UNMAPPED)
  async onCarrierStatusUnmapped(payload: CarrierStatusUnmappedPayload): Promise<void> {
    const { storeId, connectionId, providerCode } = payload
    try {
      const connection = await this.prisma.client.carrierConnection.findFirst({
        where: { id: connectionId, storeId },
        select: { displayName: true }
      })
      const carrier = connection === null ? null : textForParams(connection.displayName)
      const code = textForParams(providerCode)
      // A connection that is gone, or names that are only control characters: there is nothing to say
      if (carrier === null || code === null) return
      await this.notifications.sendToStore({
        storeId,
        type: NotificationTypes.CARRIER_STATUS_UNMAPPED,
        params: { carrier, code },
        resourceType: CarrierResourceTypes.CARRIER_CONNECTION,
        resourceId: connectionId,
        actionPath: AppPaths.store.settings(storeId, StoreSettingsSections.CARRIERS),
        requiredPermission: Permissions.SETTINGS_MANAGE_CARRIERS
      })
    } catch (error) {
      this.logger.error(
        { connectionId, err: String(error) },
        'an unmapped carrier status could not be notified'
      )
    }
  }

  // A carrier has kept the cash on delivery of delivered packages for longer than the store allows (TDD_17 §4.15). The worker's
  // daily check raises it at most once a week for each connection; the people who settle remittances are told, and only while
  // they still hold the permission. The connection is read under the store of the event: an id of another store tells nobody.
  @OnEvent(Events.REMITTANCE_OVERDUE)
  async onRemittanceOverdue(payload: RemittanceOverduePayload): Promise<void> {
    const { storeId, connectionId, count, overdueAfterDays } = payload
    try {
      const connection = await this.prisma.client.carrierConnection.findFirst({
        where: { id: connectionId, storeId },
        select: { displayName: true }
      })
      const carrier = connection === null ? null : textForParams(connection.displayName)
      if (carrier === null) {
        // Said, because the daily check will raise it again until somebody looks at the connection
        this.logger.warn(
          { connectionId },
          'an overdue remittance names a connection that cannot be told'
        )
        return
      }
      await this.notifications.sendToStore({
        storeId,
        type: NotificationTypes.REMITTANCE_OVERDUE,
        params: { carrier, count, days: overdueAfterDays },
        resourceType: CarrierResourceTypes.CARRIER_CONNECTION,
        resourceId: connectionId,
        actionPath: AppPaths.store.remittances(storeId),
        requiredPermission: Permissions.REMITTANCES_MANAGE
      })
    } catch (error) {
      this.logger.error(
        { connectionId, err: String(error) },
        'an overdue remittance could not be notified'
      )
    }
  }

  // A bulk run of labels made its file (TDD_17 §4.6): the person who asked is told it can be downloaded, and only while they are an
  // active member who still prints guides (the labels carry customer data). What happened is read from the run, not from the event:
  // a run that failed, or that made no file, has nothing to download and is not announced here (the screen shows it).
  @OnEvent(Events.BULK_LABELS_DONE)
  async onBulkLabelsDone(payload: BulkLabelsDonePayload): Promise<void> {
    const { storeId, jobId, requestedBy } = payload
    try {
      const job = await this.prisma.client.bulkLabelJob.findFirst({
        where: { id: jobId, storeId, requestedBy },
        select: { status: true, mergedMediaId: true }
      })
      const finished =
        job?.status === String(BulkLabelJobStatus.COMPLETED) ||
        job?.status === String(BulkLabelJobStatus.COMPLETED_WITH_ERRORS)
      if (job === null || !finished || job.mergedMediaId === null) return
      const member = await this.prisma.client.membership.count({
        where: {
          userId: requestedBy,
          storeId,
          status: MembershipStatus.ACTIVE,
          revokedAt: null,
          role: { permissions: { some: { name: Permissions.SHIPPING_MANAGE } } }
        }
      })
      if (member === 0) return
      await this.notifications.send({
        userId: requestedBy,
        storeId,
        type: NotificationTypes.BULK_LABELS_READY,
        resourceType: ShipmentResourceTypes.BULK_LABEL_JOB,
        resourceId: jobId,
        actionPath: AppPaths.store.orders(storeId)
      })
    } catch (error) {
      this.logger.error({ jobId, err: String(error) }, 'a bulk run of labels could not be notified')
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

  // A transfer left its source (TDD_16 §4.5): the members who may receive it are told, store by store, and each store is
  // one whose products travel in it (they are the ones who can see its lines). The warehouse is read under the
  // organization of the event: an id of another organization tells nobody.
  @OnEvent(Events.TRANSFER_DISPATCHED)
  async onTransferDispatched(payload: TransferChangedPayload): Promise<void> {
    const { organizationId, transferId, number, toWarehouseId, storeIds } = payload
    let name: string | null
    try {
      const warehouse = await this.prisma.client.warehouse.findFirst({
        where: { id: toWarehouseId, organizationId },
        select: { name: true }
      })
      if (warehouse === null) return
      name = textForParams(warehouse.name)
    } catch (error) {
      this.logger.error(
        { transferId, err: String(error) },
        'a dispatched transfer could not be notified'
      )
      return
    }
    // A store whose members cannot be told does not keep the others from being told
    for (const storeId of storeIds) {
      try {
        await this.notifications.sendToStore({
          storeId,
          type: NotificationTypes.TRANSFER_DISPATCHED,
          params: { number, ...(name === null ? {} : { warehouse: name }) },
          resourceType: TransferResourceTypes.TRANSFER,
          resourceId: transferId,
          actionPath: AppPaths.org.transfers,
          requiredPermission: Permissions.INVENTORY_RECEIVE_TRANSFERS
        })
      } catch (error) {
        this.logger.error(
          { transferId, storeId, err: String(error) },
          'a dispatched transfer could not be notified to a store'
        )
      }
    }
  }

  // A delivery attempt failed (TDD_17 §4.9): every failure tells the members who manage shipments, so three attempts on three
  // days are three notifications. What the customer is told is `orders.failedAttemptMessages` (Step 4.9 sends it).
  @OnEvent(Events.SHIPMENT_STATUS_CHANGED)
  async onShipmentStatusChanged(payload: ShipmentStatusChangedPayload): Promise<void> {
    if (payload.to !== ShipmentStatus.FAILED_ATTEMPT) return
    // A failed attempt read again after the owner mapped its code is told in the center only: it may have happened days ago
    await this.tellShipmentManagers(
      payload,
      NotificationTypes.SHIPMENT_FAILED_ATTEMPT,
      payload.replay === true
    )
  }

  // A shipment, or what the order should do because of it, needs a person (TDD_17 §4.9)
  @OnEvent(Events.SHIPMENT_REQUIRES_REVIEW)
  async onShipmentRequiresReview(payload: ShipmentEventPayload): Promise<void> {
    await this.tellShipmentManagers(payload, NotificationTypes.SHIPMENT_REQUIRES_REVIEW)
  }

  // The carrier could not void a guide, or has no way to (TDD_17 §4.8): the order is cancelled and its stock released either way,
  // and the agent voids the guide at the carrier and presses "mark as voided"
  @OnEvent(Events.SHIPMENT_CANCEL_FAILED)
  async onShipmentCancelFailed(payload: ShipmentEventPayload): Promise<void> {
    await this.tellShipmentManagers(payload, NotificationTypes.SHIPMENT_CANCEL_FAILED)
  }

  // A pickup that a person has to arrange with the carrier (TDD_17 §4.10): the carrier has no pickup API, or did not take the
  // request. The members who manage pickups are told once per pickup while the earlier warning is unread (a pickup that
  // is asked again and fails again is one line); a store with several failing connections gets one line for each. The event carries ids and the count, never what the carrier said.
  @OnEvent(Events.PICKUP_MANUAL_REQUIRED)
  async onPickupManualRequired(payload: PickupManualRequiredPayload): Promise<void> {
    const { storeId, pickupId } = payload
    try {
      const members = await this.membersWith(storeId, [Permissions.SHIPPING_MANAGE_PICKUPS], null)
      await this.notifications.sendToUsersOnce(members, {
        storeId,
        type: NotificationTypes.PICKUP_MANUAL_REQUIRED,
        params: { count: payload.packageCount, date: payload.pickupDate },
        resourceType: PickupResourceTypes.PICKUP,
        resourceId: pickupId,
        actionPath: AppPaths.store.pickups(storeId)
      })
    } catch (error) {
      this.logger.error({ pickupId, err: String(error) }, 'a pickup warning could not be notified')
    }
  }

  // The cutoff of a pickup day is near and guides still wait (TDD_17 §4.10): the members who manage pickups are told. The scheduler
  // raises it once per connection and day, so this adds no memory of its own; a line still unread is not repeated.
  @OnEvent(Events.PICKUP_CUTOFF_APPROACHING)
  async onPickupCutoffApproaching(payload: PickupCutoffApproachingPayload): Promise<void> {
    const { storeId, connectionId } = payload
    try {
      const members = await this.membersWith(storeId, [Permissions.SHIPPING_MANAGE_PICKUPS], null)
      await this.notifications.sendToUsersOnce(members, {
        storeId,
        type: NotificationTypes.PICKUP_CUTOFF_APPROACHING,
        params: { count: payload.waiting, date: payload.pickupDate, minutes: payload.minutesLeft },
        resourceType: CarrierResourceTypes.CARRIER_CONNECTION,
        resourceId: connectionId,
        actionPath: AppPaths.store.pickups(storeId)
      })
    } catch (error) {
      this.logger.error(
        { connectionId, err: String(error) },
        'a pickup cutoff warning could not be notified'
      )
    }
  }

  private async tellShipmentManagers(
    payload: ShipmentEventPayload,
    type:
      | typeof NotificationTypes.SHIPMENT_FAILED_ATTEMPT
      | typeof NotificationTypes.SHIPMENT_REQUIRES_REVIEW
      | typeof NotificationTypes.SHIPMENT_CANCEL_FAILED,
    inAppOnly = false
  ): Promise<void> {
    const { storeId, shipmentId, orderId, orderNumber } = payload
    try {
      const members = await this.membersWith(storeId, [Permissions.SHIPPING_MANAGE], null)
      const notice = {
        storeId,
        type,
        params: { orderNumber },
        resourceType: ShipmentResourceTypes.SHIPMENT,
        resourceId: shipmentId,
        actionPath: AppPaths.store.order(storeId, orderId),
        ...(inAppOnly ? { inAppOnly } : {})
      }
      // Every failed attempt is told (three attempts are three lines); a shipment that needs review, or whose void failed, is told
      // while the earlier warning is unread, so a package that keeps failing is one line
      if (type !== NotificationTypes.SHIPMENT_FAILED_ATTEMPT) {
        await this.notifications.sendToUsersOnce(members, notice)
      } else {
        await this.notifications.sendToUsers(members, notice)
      }
    } catch (error) {
      this.logger.error(
        { shipmentId, type, err: String(error) },
        'a shipment could not be notified'
      )
    }
  }

  // The packing note of an order that is already confirmed changed (owner, 2026-11-10): the members who may prepare or ship
  // orders of the store are told, except who changed it. They are found now, not when the note was written. The event
  // carries ids only: the note itself is read in the order, by whoever may read orders.
  @OnEvent(Events.ORDER_PACKING_NOTE_CHANGED)
  async onPackingNoteChanged(payload: OrderEventPayload): Promise<void> {
    const { storeId, orderId, orderNumber, actor } = payload
    try {
      const members = await this.membersWith(storeId, PackingNoteNotice.PERMISSIONS, actor.id)
      // Told once per order while the earlier warning is unread: a note edited three times is one line in the center
      await this.notifications.sendToUsersOnce(members, {
        storeId,
        type: NotificationTypes.ORDER_PACKING_NOTE_CHANGED,
        params: { orderNumber },
        resourceType: OrderResourceTypes.ORDER,
        resourceId: orderId,
        actionPath: AppPaths.store.order(storeId, orderId)
      })
    } catch (error) {
      this.logger.error(
        { orderId, err: String(error) },
        'a packing note warning could not be notified'
      )
    }
  }

  // The goods of a return are on their way back (TDD_17 §4.11): the members who receive returns are told, except who marked it. A
  // return that is one of several waiting is one line each (the order number says which); the event carries ids only.
  @OnEvent(Events.RETURN_IN_TRANSIT)
  async onReturnInTransit(payload: ReturnEventPayload): Promise<void> {
    const { storeId, returnId, orderNumber, actor } = payload
    try {
      // The notice links to the returns screen, not to an order: who receives returns need not read orders
      const members = await this.membersWith(
        storeId,
        [Permissions.RETURNS_MANAGE],
        actor.id,
        Permissions.RETURNS_VIEW
      )
      await this.notifications.sendToUsers(members, {
        storeId,
        type: NotificationTypes.RETURN_AWAITING_RECEIPT,
        params: { orderNumber },
        resourceType: ReturnResourceTypes.RETURN,
        resourceId: returnId,
        actionPath: AppPaths.store.returns(storeId)
      })
    } catch (error) {
      this.logger.error(
        { returnId, err: String(error) },
        'a return awaiting receipt could not be notified'
      )
    }
  }

  // A message about an order was due and did not go (TDD_17 §4.7, Step 4.9): the members who may send order messages are told,
  // so a customer is never left uninformed without somebody knowing. The event carries the kind and the reason, never the text.
  // Once per order while the earlier warning is unread: three packages that cannot be told about are one line in the center.
  @OnEvent(Events.ORDER_MESSAGE_NOT_SENT)
  async onOrderMessageNotSent(payload: OrderMessageNotSentPayload): Promise<void> {
    const { storeId, orderId, orderNumber, kind, reason, actor } = payload
    try {
      // Not the member who pressed "send": the answer of their request already told them (the id is null for the system)
      const members = await this.membersWith(storeId, [Permissions.ORDERS_SEND_MESSAGES], actor.id)
      await this.notifications.sendToUsersOnce(members, {
        storeId,
        type: NotificationTypes.ORDER_MESSAGE_NOT_SENT,
        params: { orderNumber, kind, reason },
        resourceType: OrderResourceTypes.ORDER,
        resourceId: orderId,
        actionPath: AppPaths.store.order(storeId, orderId)
      })
    } catch (error) {
      this.logger.error(
        { orderId, err: String(error) },
        'an unsent order message could not be notified'
      )
    }
  }

  // The orders raise four notices more (Step 4.3): who is told is decided here, when the notice is made, never by the
  // event, which carries ids only. The one who did the change is never told about it.
  private async membersWith(
    storeId: string,
    permissions: readonly Permission[],
    exceptUserId: string | null,
    // The notice links to a screen, so it goes to who may read it: orders by default, another screen says which permission
    readPermission: Permission = Permissions.ORDERS_VIEW
  ): Promise<string[]> {
    const members = await this.prisma.client.membership.findMany({
      where: {
        storeId,
        status: MembershipStatus.ACTIVE,
        revokedAt: null,
        ...(exceptUserId === null ? {} : { userId: { not: exceptUserId } }),
        // Who holds one of the permissions AND may read orders: the notice carries a link to the order
        AND: [
          { role: { permissions: { some: { name: { in: [...permissions] } } } } },
          { role: { permissions: { some: { name: readPermission } } } }
        ]
      },
      select: { userId: true }
    })
    return members.map(member => member.userId)
  }

  private async tellAboutOrder(
    payload: OrderEventPayload,
    type: NotificationType,
    recipients: readonly string[]
  ): Promise<void> {
    await this.notifications.sendToUsers(recipients, {
      storeId: payload.storeId,
      type,
      params: { orderNumber: payload.orderNumber },
      resourceType: OrderResourceTypes.ORDER,
      resourceId: payload.orderId,
      actionPath: AppPaths.store.order(payload.storeId, payload.orderId)
    })
  }

  // A new order that waits for its confirmation goes to who may confirm it; one created already confirmed waits for nobody
  @OnEvent(Events.ORDER_CREATED)
  async onOrderCreated(payload: OrderCreatedPayload): Promise<void> {
    try {
      const order = await this.prisma.client.order.findFirst({
        where: { id: payload.orderId, storeId: payload.storeId },
        select: { status: true }
      })
      if (order?.status !== OrderStatus.PENDING_CONFIRMATION) return
      await this.tellAboutOrder(
        payload,
        NotificationTypes.ORDER_CREATED,
        await this.membersWith(payload.storeId, [Permissions.ORDERS_CONFIRM], payload.actor.id)
      )
    } catch (error) {
      this.logger.error(
        { orderId: payload.orderId, err: String(error) },
        'an order notice could not be sent'
      )
    }
  }

  // The status of an order changed: the member who made the order is told, unless they made the change, and only while
  // they are still a member of the store
  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderStatusChanged(payload: OrderStatusChangedPayload): Promise<void> {
    try {
      const order = await this.prisma.client.order.findFirst({
        where: { id: payload.orderId, storeId: payload.storeId },
        select: { createdBy: true }
      })
      if (order === null || order.createdBy === payload.actor.id) return
      // Only while they are still a member who may read orders: a role that lost the permission is told nothing
      const readers = await this.membersWith(
        payload.storeId,
        [Permissions.ORDERS_VIEW],
        payload.actor.id
      )
      if (!readers.includes(order.createdBy)) return
      await this.tellAboutOrder(payload, NotificationTypes.ORDER_STATUS_CHANGED, [order.createdBy])
    } catch (error) {
      this.logger.error(
        { orderId: payload.orderId, err: String(error) },
        'an order notice could not be sent'
      )
    }
  }

  // An agent asked for the approval of a price: whoever may approve is told, but the one who asked
  @OnEvent(Events.ORDER_PRICE_APPROVAL_REQUESTED)
  async onPriceApprovalRequested(payload: OrderEventPayload): Promise<void> {
    try {
      await this.tellAboutOrder(
        payload,
        NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED,
        await this.membersWith(
          payload.storeId,
          [Permissions.ORDERS_APPROVE_PRICE],
          payload.actor.id
        )
      )
    } catch (error) {
      this.logger.error(
        { orderId: payload.orderId, err: String(error) },
        'an order notice could not be sent'
      )
    }
  }

  // A price was set by a member with the override: the approvers are told when the store keeps `notifyOnPriceOverride` on
  @OnEvent(Events.ORDER_PRICE_OVERRIDDEN)
  async onPriceOverridden(payload: OrderEventPayload): Promise<void> {
    try {
      const settings = await this.prisma.client.storeSettings.findUnique({
        where: { storeId: payload.storeId },
        select: { preferences: true }
      })
      if (!readOrderPreferences(settings?.preferences).notifyOnPriceOverride) return
      await this.tellAboutOrder(
        payload,
        NotificationTypes.ORDER_PRICE_OVERRIDDEN,
        await this.membersWith(
          payload.storeId,
          [Permissions.ORDERS_APPROVE_PRICE],
          payload.actor.id
        )
      )
    } catch (error) {
      this.logger.error(
        { orderId: payload.orderId, err: String(error) },
        'an order notice could not be sent'
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
