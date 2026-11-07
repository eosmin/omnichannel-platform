import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AuthorType,
  AwayReply,
  ConversationStatus,
  DeliveryStatus,
  isWithinSchedule,
  lastOpenBefore,
  MessageType,
  type WeekSchedule,
  weekScheduleSchema
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { ConversationsService } from '../conversations/conversations.service'
import { isHiddenStatus, lockConversationForWrite } from '../conversations/conversations.support'
import { AWAY_REPLY_KEY, AWAY_REPLY_METADATA, AWAY_REPLY_VALUE } from '../messages/away-reply'
import { MessagingWindowService } from '../messaging-window/messaging-window.service'
import { OutboundQueue } from '../outbound/outbound-queue'

// The saved reply (`awayMessageSnippetId` of the business hours) that a store sends to a customer who
// writes while it is closed. The rules, which keep it from becoming noise or a loop:
// - once for each closed stretch of the conversation: it is not sent again if the store, the owner
//   from the provider's app or an earlier run of this already answered since the store was last open;
// - never for a conversation marked as spam or hidden, nor with the messaging window closed;
// - only a message of a customer reaches this (the inbound pipeline calls it for those), so neither a
//   system line, an echo of what the platform sent nor the reply itself can set it off;
// - it is not a reply of the team: it does not set the first response, the last outbound date or
//   reopen anything, and it is stored apart (`AuthorType.SYSTEM`, `metadata.autoReply`).
// A store that set no hours, or hours that cannot be read, is never closed.
@Injectable()
export class AwayReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly window: MessagingWindowService,
    private readonly events: DomainEvents,
    private readonly outbound: OutboundQueue,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AwayReplyService.name)
  }

  // Never throws: a courtesy that fails must not fail the message that set it off, which is stored
  async replyIfClosed(storeId: string, conversationId: string, at: Date): Promise<boolean> {
    try {
      return await this.prisma.transaction(tx => this.run(tx, storeId, conversationId, at))
    } catch (error) {
      this.logger.error(
        { storeId, conversationId, errorName: errorName(error) },
        'the away reply could not be sent'
      )
      return false
    }
  }

  private async run(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    at: Date
  ): Promise<boolean> {
    const hours = await tx.businessHours.findUnique({
      where: { storeId },
      select: { timezone: true, schedule: true, awayMessageSnippetId: true }
    })
    if (hours === null || hours.awayMessageSnippetId === null) return false
    const schedule = weekScheduleSchema.safeParse(hours.schedule)
    if (!schedule.success) return false
    // Closed when the customer wrote and closed now: a message that a webhook retry delivers late is
    // not answered "we are closed" in the middle of the working day
    if (!isClosedAt(schedule.data, hours.timezone, [at, new Date()])) return false

    const current = await lockConversationForWrite(tx, storeId, conversationId)
    if (current.status === String(ConversationStatus.SPAM) || isHiddenStatus(current.status)) {
      return false
    }
    // The latest answer of this conversation (the team, the owner, or this reply). It counts only if
    // the store has not been open since: a new closed stretch is answered again
    const latest = await tx.message.findFirst({
      where: {
        storeId,
        conversationId,
        // A reply that was thrown away never reached the customer: it is no answer
        discardedAt: null,
        createdAt: { gte: new Date(at.getTime() - AwayReply.LOOKBACK_MS) },
        OR: [
          {
            authorType: { in: [AuthorType.AGENT, AuthorType.EXTERNAL] },
            type: { not: MessageType.INTERNAL_NOTE }
          },
          { metadata: { path: [AWAY_REPLY_KEY], equals: AWAY_REPLY_VALUE } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true }
    })
    if (
      latest !== null &&
      lastOpenBefore(schedule.data, hours.timezone, at, latest.createdAt) === null
    ) {
      return false
    }

    const snippet = await tx.snippet.findFirst({
      where: { id: hours.awayMessageSnippetId, storeId },
      select: { content: true }
    })
    if (snippet === null) return false
    if (!(await this.window.isOpen(tx, storeId, conversationId))) return false

    // After the message that set it off, so that the thread reads in order
    const now = new Date(Math.max(Date.now(), at.getTime() + 1))
    const row = await tx.message.create({
      data: {
        storeId,
        conversationId,
        type: MessageType.TEXT,
        content: snippet.content,
        authorType: AuthorType.SYSTEM,
        metadata: AWAY_REPLY_METADATA,
        deliveryStatus: DeliveryStatus.QUEUED,
        createdAt: now
      },
      select: { id: true }
    })
    await this.conversations.recordMessageAt(tx, storeId, conversationId, now)
    this.events.publish(tx, Events.MESSAGE_QUEUED, {
      storeId,
      conversationId,
      messageId: row.id,
      authorId: null,
      clientMessageId: null,
      createdAt: now.toISOString(),
      visibility: { hidden: false, assignedTo: current.assignedTo }
    })
    this.prisma.afterCommit(tx, () => {
      this.outbound.enqueue({ storeId, messageId: row.id }).catch((error: unknown) => {
        this.logger.warn(
          { messageId: row.id, errorName: errorName(error) },
          'the away reply could not be queued; the sweep will'
        )
      })
    })
    return true
  }
}

// Closed at every one of the moments. Hours that cannot be evaluated (a time zone this runtime does not
// know) count as open: such a store is never closed, and nothing is thrown at every message.
function isClosedAt(schedule: WeekSchedule, timezone: string, moments: readonly Date[]): boolean {
  try {
    return moments.every(moment => !isWithinSchedule(schedule, timezone, moment))
  } catch {
    return false
  }
}
