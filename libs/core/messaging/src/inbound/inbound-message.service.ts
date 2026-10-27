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
  ConversationStatus,
  MessageType,
  ConversationStatusReasons
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { type FetchInboundMediaJob, JobNames, QueueNames } from '@platform/core/queues'

import { ChannelConnectionResolver } from '../channels/channel-connection.resolver'
import { ConversationsService } from '../conversations/conversations.service'
import { statusOf } from '../conversations/conversations.support'
import { CustomerIdentityService } from '../customers/customer-identity.service'
import { insertInboundMessage } from '../messages/inbound-messages'
import { RoutingService } from '../routing/routing.service'

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
    private readonly heavyQueue: Queue<FetchInboundMediaJob>,
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

    // The job id is the message: asked twice (a retry after a failure here) it is one job
    if (event.message.media !== undefined) {
      await this.heavyQueue.add(
        JobNames.FETCH_INBOUND_MEDIA,
        {
          messageId: stored.messageId,
          storeId,
          pluginId,
          connectionId: event.connectionId,
          mediaRef: event.message.media.ref,
          contentType: event.message.media.contentType,
          filename: event.message.media.filename
        },
        { jobId: `fetch-media-${stored.messageId}` }
      )
    }
    if (stored.duplicate) return InboundOutcomes.DUPLICATE
    if (stored.needsRouting) {
      await this.route(storeId, stored.conversationId, event, receivedAt)
    }
    return InboundOutcomes.STORED
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
      createdAt: receivedAt
    })
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

    if (placement.created) {
      this.events.publish(tx, Events.CONVERSATION_CREATED, {
        storeId,
        conversationId: placement.conversationId,
        customerId: identity.customerId,
        channelType: identity.channelType,
        firstMessageId: message.id,
        firstMessageContent: event.message.content
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
      receivedAt: receivedAt.toISOString()
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
