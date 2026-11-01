import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  AuthorType,
  ConversationLimits,
  ConversationReopenedByReply,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  OutboundLimits,
  OriginKinds,
  OriginMediaSlots,
  OriginMediaTypes,
  ConversationStatusReasons
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  type FetchInboundMediaJob,
  type FetchOriginMediaJob,
  JobNames,
  originMediaJobId,
  QueueNames
} from '@platform/core/queues'

import { ChannelConnectionResolver } from '../channels/channel-connection.resolver'
import { ConversationsService } from '../conversations/conversations.service'
import { statusOf, visibilityOf } from '../conversations/conversations.support'
import { CustomerIdentityService } from '../customers/customer-identity.service'
import { insertInboundMessage } from '../messages/inbound-messages'
import { RoutingService } from '../routing/routing.service'

import { recordOrigin } from './conversation-origin'
import { type InboundEvent, type InboundOutcome, InboundOutcomes } from './inbound-event'
import { receivedTime } from './inbound-time'

const DAY_MS = 24 * 60 * 60 * 1000

// A conversation that a customer message continues, or starts: what the transaction decided
interface Placement {
  conversationId: string
  created: boolean
  // Nobody has it, so the routing rules look at it once the transaction is committed
  needsRouting: boolean
}

// The part of the inbound pipeline (TDD_10 §4) that is the same for every channel. The worker calls it
// with an event that the plugin returned and the schema checked.
@Injectable()
export class InboundMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ChannelConnectionResolver,
    private readonly identities: CustomerIdentityService,
    private readonly conversations: ConversationsService,
    private readonly routing: RoutingService,
    private readonly events: DomainEvents,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<FetchInboundMediaJob | FetchOriginMediaJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InboundMessageService.name)
  }

  // `now` is when the webhook was received: the bounds of a provider's date are measured against it
  async handleMessageReceived(
    pluginId: string,
    event: InboundEvent,
    now: Date = new Date()
  ): Promise<InboundOutcome> {
    const connection = await this.connections.resolve(pluginId, event.connectionId)
    if (connection === null || !connection.active) {
      this.logger.warn(
        { pluginId, connectionId: event.connectionId },
        'event for an unknown connection'
      )
      return InboundOutcomes.UNKNOWN_CONNECTION
    }
    const { storeId } = connection

    // Own transactions: the handle may be new, and two events for it at once end in one customer
    const { identityId } = await this.identities.findOrCreateByIdentity({
      storeId,
      channelType: pluginId,
      channelIdentity: event.channelIdentity,
      profile: event.channelProfile
    })

    const receivedAt = receivedTime(event.message.timestamp, now)
    const stored = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The events of one handle take turns, so that two first messages do not open two conversations
      // and a duplicate is seen as one. Not a row lock: a merge holds the customer while it moves the
      // identities, and waiting for each other in opposite orders would be a deadlock.
      await lockStoreScope(tx, storeId, `inbound-${identityId}`)
      return this.store(
        tx,
        { storeId, connectionRowId: connection.id, identityId },
        event,
        receivedAt
      )
    })

    await this.queueMediaFetches(pluginId, storeId, event, stored.messageId)
    if (event.message.origin !== undefined) await this.queueOriginFetches(storeId, stored.messageId)
    if (stored.duplicate) return InboundOutcomes.DUPLICATE
    if (stored.needsRouting) {
      await this.route(storeId, stored.conversationId, event, receivedAt)
    }
    return InboundOutcomes.STORED
  }

  // The owner wrote to the customer from the provider's own app and the provider echoes it to us. It is
  // stored as a sent message of an external author, in the thread of that handle on that connection,
  // and it leaves the rest alone: no messaging window (the customer did not write), no unread count, no
  // routing. A resolved, snoozed or archived thread is reopened, as a reply of an agent does. A message the platform sent comes
  // back the same way, and is found by its provider id.
  async handleMessageEcho(
    pluginId: string,
    event: InboundEvent,
    isLastAttempt: boolean,
    now: Date = new Date()
  ): Promise<InboundOutcome> {
    const connection = await this.connections.resolve(pluginId, event.connectionId)
    if (connection === null || !connection.active) {
      this.logger.warn(
        { pluginId, connectionId: event.connectionId },
        'echo for an unknown connection'
      )
      return InboundOutcomes.UNKNOWN_CONNECTION
    }
    const { storeId } = connection
    const { identityId } = await this.identities.findOrCreateByIdentity({
      storeId,
      channelType: pluginId,
      channelIdentity: event.channelIdentity,
      profile: event.channelProfile
    })
    const receivedAt = receivedTime(event.message.timestamp, now)
    const stored = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, `inbound-${identityId}`)
      return this.storeEcho(
        tx,
        { storeId, connectionRowId: connection.id, identityId },
        event,
        receivedAt,
        isLastAttempt
      )
    })
    // A message of the platform that comes back has its files already; the owner's is fetched, again
    // after a failure here (the job id makes it one)
    if (stored.fetchMedia) await this.queueMediaFetches(pluginId, storeId, event, stored.messageId)
    return stored.duplicate ? InboundOutcomes.DUPLICATE : InboundOutcomes.STORED
  }

  private async storeEcho(
    tx: PrismaTransaction,
    where: { storeId: string; connectionRowId: string; identityId: string },
    event: InboundEvent,
    receivedAt: Date,
    isLastAttempt: boolean
  ): Promise<{ messageId: string; duplicate: boolean; fetchMedia: boolean }> {
    const { storeId, connectionRowId, identityId } = where
    const identity = await tx.customerIdentity.findFirst({
      where: { id: identityId, storeId },
      select: { customerId: true, channelType: true }
    })
    if (identity === null) throw resourceNotFound('customer identity')

    const conversations = await tx.conversation.findMany({
      where: { storeId, customerIdentityId: identityId, channelConnectionId: connectionRowId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true }
    })
    // The provider echoes what the platform sent too: that message has its provider id by now, in
    // whatever thread it went to
    const conversationIds = conversations.map(conversation => conversation.id)
    const known =
      (await tx.message.findFirst({
        where: {
          conversationId: { in: conversationIds },
          channelMessageId: event.message.externalId
        },
        select: { id: true, authorType: true }
      })) ??
      // Instagram and Messenger send the caption of a file as a message of its own: the platform
      // kept its id in the message of the file, and the echo of it is that message, not a new one
      (await tx.message.findFirst({
        where: {
          conversationId: { in: conversationIds },
          captionChannelMessageId: event.message.externalId
        },
        select: { id: true, authorType: true }
      }))
    if (known !== null) {
      return {
        messageId: known.id,
        duplicate: true,
        // The files of the owner's own message, if a failed first try left some out
        fetchMedia:
          known.authorType === String(AuthorType.EXTERNAL) &&
          (await tx.media.count({ where: { storeId, messageId: known.id } })) <
            (event.message.media?.length ?? 0)
      }
    }
    // A reply of this connection that was queued a moment ago has no provider id yet, and may be the
    // one the echo is about: try again once it is written. The last attempt stores it as the owner's.
    if (
      !isLastAttempt &&
      (await this.mayBeWaitingForItsId(
        tx,
        storeId,
        conversations.map(item => item.id)
      ))
    ) {
      throw new Error('the echo came before the provider id of our own message was written')
    }

    const latest = conversations[0]
    const conversationId =
      latest?.id ??
      (await this.conversations.createIn(tx, storeId, {
        customerId: identity.customerId,
        customerIdentityId: identityId,
        channelConnectionId: connectionRowId
      }))
    const message = await insertInboundMessage(tx, {
      storeId,
      conversationId,
      message: event.message,
      author: AuthorType.EXTERNAL,
      createdAt: receivedAt
    })
    await this.conversations.recordMessageAt(tx, storeId, conversationId, receivedAt)
    if (latest === undefined) {
      // Not routed: the owner is already answering it from the phone
      this.events.publish(tx, Events.CONVERSATION_CREATED, {
        storeId,
        conversationId,
        customerId: identity.customerId,
        channelType: identity.channelType,
        firstMessageId: message.id,
        firstMessageContent: event.message.content,
        visibility: visibilityOf({ status: ConversationStatus.OPEN, assignedTo: null })
      })
    }
    // The owner is answering the customer, like an agent does: what a reply of an agent brings back to
    // work comes back here too
    if (
      latest !== undefined &&
      ConversationReopenedByReply.some(status => String(status) === latest.status)
    ) {
      await this.conversations.applyStatus(tx, storeId, conversationId, ConversationStatus.OPEN, {
        actor: 'system'
      })
    }
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: { status: true, assignedTo: true }
    })
    if (conversation !== null) {
      this.events.publish(tx, Events.MESSAGE_SENT, {
        storeId,
        conversationId,
        messageId: message.id,
        visibility: visibilityOf(conversation)
      })
    }
    return { messageId: message.id, duplicate: false, fetchMedia: true }
  }

  private async mayBeWaitingForItsId(
    tx: PrismaTransaction,
    storeId: string,
    conversationIds: string[]
  ): Promise<boolean> {
    const waiting = await tx.message.count({
      where: {
        storeId,
        conversationId: { in: conversationIds },
        deliveryStatus: DeliveryStatus.QUEUED,
        authorType: AuthorType.AGENT,
        createdAt: { gt: new Date(Date.now() - OutboundLimits.RECEIPT_WAIT_MS) }
      }
    })
    return waiting > 0
  }

  // One round trip for the whole album. The job id is the message and the place of the file in it:
  // asked twice (a retry after a failure here) it is one job each.
  private async queueMediaFetches(
    pluginId: string,
    storeId: string,
    event: InboundEvent,
    messageId: string
  ): Promise<void> {
    const files = event.message.media ?? []
    if (files.length === 0) return
    await this.heavyQueue.addBulk(
      files.map((media, index) => ({
        name: JobNames.FETCH_INBOUND_MEDIA,
        data: {
          messageId,
          index,
          storeId,
          pluginId,
          connectionId: event.connectionId,
          mediaRef: media.ref,
          contentType: media.contentType,
          filename: media.filename
        },
        opts: { jobId: `fetch-media-${messageId}-${index}` }
      }))
    )
  }

  // The pictures of the ad this message opened, if it opened one (the same ad as the latest origin
  // makes no row). The job reads the links from the row; its id is the origin and the slot, so a
  // retry of the event queues nothing twice.
  private async queueOriginFetches(storeId: string, messageId: string): Promise<void> {
    const origin = await this.prisma.client.conversationOrigin.findFirst({
      where: { storeId, messageId },
      select: { id: true, mediaType: true, mediaUrl: true, thumbnailUrl: true }
    })
    if (origin === null) return
    const slots = [
      ...(origin.thumbnailUrl === null ? [] : [OriginMediaSlots.THUMBNAIL]),
      // The media only when it is an image of its own: a video is not kept, and the same link as the
      // thumbnail would be a second copy of one file
      ...(origin.mediaUrl === null ||
      origin.mediaType !== OriginMediaTypes.IMAGE ||
      origin.mediaUrl === origin.thumbnailUrl
        ? []
        : [OriginMediaSlots.MEDIA])
    ]
    if (slots.length === 0) return
    await this.heavyQueue.addBulk(
      slots.map(slot => ({
        name: JobNames.FETCH_ORIGIN_MEDIA,
        data: { storeId, originId: origin.id, slot },
        opts: { jobId: originMediaJobId(origin.id, slot) }
      }))
    )
  }

  private async store(
    tx: PrismaTransaction,
    where: { storeId: string; connectionRowId: string; identityId: string },
    event: InboundEvent,
    receivedAt: Date
  ): Promise<{
    messageId: string
    conversationId: string
    duplicate: boolean
    needsRouting: boolean
  }> {
    const { storeId, connectionRowId, identityId } = where
    // Read after the lock: a merge may have moved the identity to another customer meanwhile
    const identity = await tx.customerIdentity.findFirst({
      where: { id: identityId, storeId },
      select: { customerId: true, channelType: true }
    })
    // Deleted since it was resolved: the job runs again and the handle makes a new one
    if (identity === null) throw resourceNotFound('customer identity')

    const conversations = await tx.conversation.findMany({
      where: { storeId, customerIdentityId: identityId, channelConnectionId: connectionRowId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, assignedTo: true, lastMessageAt: true, createdAt: true }
    })
    const latest = conversations[0] ?? null
    // The unique index is per conversation: a redelivery that finds a newer conversation (after the
    // quiet days, or one an agent started) must still be seen as the message it is
    const known = await tx.message.findFirst({
      where: {
        conversationId: { in: conversations.map(conversation => conversation.id) },
        channelMessageId: event.message.externalId
      },
      select: { id: true, conversationId: true }
    })
    if (known !== null) {
      return {
        messageId: known.id,
        conversationId: known.conversationId,
        duplicate: true,
        needsRouting: false
      }
    }

    const placement = await this.place(tx, storeId, latest, {
      customerId: identity.customerId,
      customerIdentityId: identityId,
      channelConnectionId: connectionRowId,
      receivedAt
    })

    const message = await insertInboundMessage(tx, {
      storeId,
      conversationId: placement.conversationId,
      message: event.message,
      author: AuthorType.CUSTOMER,
      createdAt: receivedAt
    })
    if (event.message.origin !== undefined) {
      await recordOrigin(tx, {
        storeId,
        conversationId: placement.conversationId,
        messageId: message.id,
        origin: event.message.origin,
        createdAt: receivedAt
      })
    }
    await this.conversations.recordInbound(tx, storeId, placement.conversationId, receivedAt)
    // Opens the messaging window of the customer on this channel
    await tx.customerIdentity.updateMany({
      where: {
        id: identityId,
        storeId,
        OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: receivedAt } }]
      },
      data: { lastInboundAt: receivedAt }
    })
    // A referral comes only with the first message after a click, so every one of an ad is a click, the
    // same ad again included: it opens the longer window of the channels that have one, counted from this
    // message. It only moves forward.
    if (event.message.origin?.kind === OriginKinds.AD) {
      await tx.customerIdentity.updateMany({
        where: {
          id: identityId,
          storeId,
          OR: [{ adWindowOpenedAt: null }, { adWindowOpenedAt: { lt: receivedAt } }]
        },
        data: { adWindowOpenedAt: receivedAt }
      })
    }

    // The row as it is now, after the reopening and the count: the status and the assignee that the
    // events carry are what decides who hears them
    const visibility = visibilityOf(
      await tx.conversation.findFirstOrThrow({
        where: { id: placement.conversationId, storeId },
        select: { status: true, assignedTo: true }
      })
    )
    if (placement.created) {
      this.events.publish(tx, Events.CONVERSATION_CREATED, {
        storeId,
        conversationId: placement.conversationId,
        customerId: identity.customerId,
        channelType: identity.channelType,
        firstMessageId: message.id,
        firstMessageContent: event.message.content,
        visibility
      })
    }
    this.events.publish(tx, Events.MESSAGE_RECEIVED, {
      storeId,
      conversationId: placement.conversationId,
      messageId: message.id,
      customerId: identity.customerId,
      channelType: identity.channelType,
      authorType: AuthorType.CUSTOMER,
      contentPreview: preview(event.message.content),
      receivedAt: receivedAt.toISOString(),
      visibility
    })
    return {
      messageId: message.id,
      conversationId: placement.conversationId,
      duplicate: false,
      needsRouting: placement.needsRouting
    }
  }

  // One continuous thread for each handle on each connection, like a chat: a message of the customer
  // wakes a snoozed conversation and reopens a resolved or an archived one, and the previous assignee
  // keeps it. A conversation marked as spam stays spam (the message is stored, nothing reopens). A new
  // one is started only when there is none, or when the store asked for it after some quiet days.
  private async place(
    tx: PrismaTransaction,
    storeId: string,
    latest: {
      id: string
      status: string
      assignedTo: string | null
      lastMessageAt: Date | null
      createdAt: Date
    } | null,
    input: {
      customerId: string
      customerIdentityId: string
      channelConnectionId: string
      receivedAt: Date
    }
  ): Promise<Placement> {
    const start = async (): Promise<Placement> => ({
      conversationId: await this.conversations.createIn(tx, storeId, input),
      created: true,
      needsRouting: true
    })
    if (latest === null) return start()
    if (await this.quietFor(tx, storeId, latest, input.receivedAt)) return start()

    const status = statusOf(latest.status)
    // PENDING waits for the customer: the answer ends the wait
    if (
      status === ConversationStatus.SNOOZED ||
      status === ConversationStatus.RESOLVED ||
      status === ConversationStatus.ARCHIVED ||
      status === ConversationStatus.PENDING
    ) {
      await this.conversations.applyStatus(tx, storeId, latest.id, ConversationStatus.OPEN, {
        actor: 'system',
        reason: ConversationStatusReasons.CUSTOMER_REPLIED
      })
      return { conversationId: latest.id, created: false, needsRouting: latest.assignedTo === null }
    }
    return { conversationId: latest.id, created: false, needsRouting: false }
  }

  // The store may ask for a new conversation after some quiet days (null, the default, never)
  private async quietFor(
    tx: PrismaTransaction,
    storeId: string,
    latest: { lastMessageAt: Date | null; createdAt: Date; status: string },
    now: Date
  ): Promise<boolean> {
    if (statusOf(latest.status) === ConversationStatus.SPAM) return false
    const settings = await tx.storeSettings.findUnique({
      where: { storeId },
      select: { reopenWindowDays: true }
    })
    const days = settings?.reopenWindowDays ?? null
    if (days === null) return false
    const since = latest.lastMessageAt ?? latest.createdAt
    return now.getTime() - since.getTime() > days * DAY_MS
  }

  // The rules run in a transaction of their own, after the message is committed: a rule that fails
  // must never cost the message. The conversation stays unassigned, in the queue of the team.
  private async route(
    storeId: string,
    conversationId: string,
    event: InboundEvent,
    receivedAt: Date
  ): Promise<void> {
    try {
      await this.routing.apply(storeId, conversationId, {
        text: event.message.type === MessageType.TEXT ? event.message.content : null,
        receivedAt
      })
    } catch (error) {
      this.logger.error({ err: error, storeId, conversationId }, 'routing failed, left unassigned')
    }
  }
}

// The first characters, counted as characters and not as code units
function preview(content: string | null): string | null {
  if (content === null) return null
  return Array.from(content).slice(0, ConversationLimits.PREVIEW_MAX_LENGTH).join('')
}
