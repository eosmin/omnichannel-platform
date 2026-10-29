import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  AuthorType,
  ConversationReopenedByReply,
  ConversationStatus,
  DeliveryStatus,
  type CursorPage,
  MembershipStatus,
  MessageType
} from '@platform/core/domain'
import {
  errorName,
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type ConversationVisibility, Events } from '@platform/core/events'

import { ConversationsService } from '../conversations/conversations.service'
import {
  canSee,
  invalidInput,
  isHiddenStatus,
  type LockedConversation,
  lockConversationForWrite,
  requireAnyPermission,
  statusOf,
  type Viewer
} from '../conversations/conversations.support'
import { MessagingWindowService } from '../messaging-window/messaging-window.service'
import { OutboundQueue } from '../outbound/outbound-queue'

import { encodeMessageCursor } from './message-cursor'
import type { CreateMessageBody, ListMessagesQuery } from './messages.schemas'
import { MESSAGE_SELECT, messageView, type MessageView } from './messages.views'

export interface CreatedMessage {
  message: MessageView
  // false when the key had been used: the message that was already there is returned
  created: boolean
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly window: MessagingWindowService,
    private readonly events: DomainEvents,
    private readonly outbound: OutboundQueue,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MessagesService.name)
  }

  // What the agent writes in a conversation. A reply to the customer is stored as queued and handed to
  // the outbound queue once the transaction commits; if Redis is down at that moment it waits for the
  // sweep of the worker, a couple of minutes at most. Writing to the customer reopens a resolved,
  // snoozed or archived conversation; an internal note changes nothing but the thread.
  async create(storeId: string, body: CreateMessageBody, viewer: Viewer): Promise<CreatedMessage> {
    const isNote = body.type === MessageType.INTERNAL_NOTE
    requireAnyPermission(viewer.held, [
      isNote ? Permissions.MESSAGES_INTERNAL_NOTE : Permissions.MESSAGES_SEND
    ])
    return this.prisma.transaction(async tx => {
      // The row lock makes two requests with one key take turns: the second finds the first
      const current = await lockConversationForWrite(tx, storeId, body.conversationId, viewer)

      if (body.idempotencyKey !== undefined) {
        const existing = await tx.message.findFirst({
          where: {
            storeId,
            conversationId: body.conversationId,
            idempotencyKey: body.idempotencyKey
          },
          select: { ...MESSAGE_SELECT }
        })
        if (existing !== null) {
          const message = messageView(existing)
          if (message.authorId !== viewer.userId || message.type !== body.type) {
            throw resourceConflict('the idempotency key was used for another message')
          }
          // The first request may have committed and failed to queue the reply (Redis was down): the
          // retry it provoked is the moment to try again, and the job id makes a second one harmless
          if (message.deliveryStatus === DeliveryStatus.QUEUED) {
            this.queueForChannel(tx, storeId, message.id)
          }
          return { message, created: false }
        }
      }

      const from = statusOf(current.status)
      // Spam is answered after it is marked as not spam; an internal note can still be written
      if (!isNote && from === ConversationStatus.SPAM) {
        throw new PlatformException(
          ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION,
          'a spam conversation is not answered: mark it as not spam first',
          HttpStatusCodes.CONFLICT,
          { from, to: ConversationStatus.OPEN }
        )
      }
      // Free text goes out only while the channel lets it; a note is the team's and has no window
      if (!isNote) await this.window.requireOpen(tx, storeId, body.conversationId)
      if (body.replyToMessageId !== undefined) {
        await this.requireReplyTarget(
          tx,
          storeId,
          body.conversationId,
          body.replyToMessageId,
          isNote
        )
      }
      const mentions = body.type === MessageType.INTERNAL_NOTE ? body.mentions : []
      if (mentions.length > 0) await this.requireMentionable(tx, storeId, mentions, current)

      // The date is set here, in milliseconds, so that the message and the conversation agree on it
      const now = new Date()
      const row = await tx.message.create({
        data: {
          storeId,
          conversationId: body.conversationId,
          type: body.type,
          content: body.content,
          authorType: AuthorType.AGENT,
          authorId: viewer.userId,
          idempotencyKey: body.idempotencyKey ?? null,
          replyToMessageId: body.replyToMessageId ?? null,
          deliveryStatus: isNote ? null : DeliveryStatus.QUEUED,
          mentions,
          createdAt: now
        },
        select: { ...MESSAGE_SELECT }
      })
      if (!isNote) {
        await this.conversations.recordReply(tx, storeId, body.conversationId, now)
        if (ConversationReopenedByReply.some(status => status === from)) {
          // The permission to reply is the one that was checked: reopening is part of replying
          await this.conversations.applyStatus(
            tx,
            storeId,
            body.conversationId,
            ConversationStatus.OPEN,
            { actor: 'system', causedBy: viewer.userId }
          )
        }
      }
      // A note changes nothing in the conversation; a reply leaves it open (spam was refused above,
      // and an archived one was reopened)
      const visibility = {
        hidden: isNote && isHiddenStatus(current.status),
        assignedTo: current.assignedTo
      }
      this.announce(tx, storeId, viewer, row.id, now, body, mentions, visibility)
      if (!isNote) this.queueForChannel(tx, storeId, row.id)
      return { message: messageView(row), created: true }
    })
  }

  // Only after the commit: the worker reads the message by id and must find it. If Redis fails here
  // the reply stays `queued` with no job, and the sweep of the worker queues it a minute later.
  private queueForChannel(tx: PrismaTransaction, storeId: string, messageId: string): void {
    this.prisma.afterCommit(tx, () => {
      this.outbound.enqueue({ storeId, messageId }).catch((error: unknown) => {
        this.logger.warn(
          { messageId, errorName: errorName(error) },
          'the reply could not be queued; the sweep will'
        )
      })
    })
  }

  // What is announced is ids and dates, never the text: a reply is read through the api, which knows
  // who may see the conversation, and a note is for who may read notes
  private announce(
    tx: PrismaTransaction,
    storeId: string,
    viewer: Viewer,
    messageId: string,
    createdAt: Date,
    body: CreateMessageBody,
    mentions: readonly string[],
    visibility: ConversationVisibility
  ): void {
    const base = {
      storeId,
      conversationId: body.conversationId,
      messageId,
      authorId: viewer.userId
    }
    if (body.type === MessageType.INTERNAL_NOTE) {
      this.events.publish(tx, Events.MESSAGE_NOTE_ADDED, {
        ...base,
        createdAt: createdAt.toISOString(),
        visibility
      })
      for (const mentionedUserId of mentions) {
        // Nobody is told of a mention of themselves
        if (mentionedUserId === viewer.userId) continue
        this.events.publish(tx, Events.MESSAGE_MENTION, { ...base, mentionedUserId })
      }
      return
    }
    this.events.publish(tx, Events.MESSAGE_QUEUED, {
      ...base,
      clientMessageId: body.idempotencyKey ?? null,
      createdAt: createdAt.toISOString(),
      visibility
    })
  }

  // The thread, newest first: the client reverses it to draw it. Internal notes are for who may
  // write them.
  async list(
    storeId: string,
    conversationId: string,
    query: ListMessagesQuery,
    viewer: Viewer
  ): Promise<CursorPage<MessageView>> {
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: { status: true, assignedTo: true }
    })
    if (conversation === null || !canSee(viewer, conversation)) {
      throw resourceNotFound('conversation')
    }
    const readsNotes = viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE)
    const { cursor } = query
    const rows = await this.prisma.client.message.findMany({
      where: {
        storeId,
        conversationId,
        ...(readsNotes ? {} : { type: { not: MessageType.INTERNAL_NOTE } }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: { ...MESSAGE_SELECT },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(messageView),
      nextCursor:
        hasMore && last !== undefined
          ? encodeMessageCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      hasMore
    }
  }

  // A message of the same conversation. What the team wrote among themselves is not quoted in
  // something the customer reads.
  private async requireReplyTarget(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    messageId: string,
    isNote: boolean
  ): Promise<void> {
    const target = await tx.message.count({
      where: {
        id: messageId,
        storeId,
        conversationId,
        // A system line is a divider of the thread: nobody answers it
        type: {
          notIn: isNote ? [MessageType.SYSTEM] : [MessageType.SYSTEM, MessageType.INTERNAL_NOTE]
        }
      }
    })
    if (target === 0) throw resourceNotFound('message')
  }

  // The people who will read the note: members of this store today whose role reads the thread and
  // its notes, and who may open this conversation (archived and spam need ARCHIVE, and one assigned
  // to someone else needs VIEW_ALL unless the mentioned person is the assignee)
  private async requireMentionable(
    tx: PrismaTransaction,
    storeId: string,
    userIds: readonly string[],
    conversation: LockedConversation
  ): Promise<void> {
    const needed: Permission[] = [
      Permissions.CONVERSATIONS_VIEW,
      Permissions.MESSAGES_VIEW,
      Permissions.MESSAGES_INTERNAL_NOTE
    ]
    if (isHiddenStatus(conversation.status)) needed.push(Permissions.CONVERSATIONS_ARCHIVE)
    const members = await tx.membership.count({
      where: {
        storeId,
        userId: { in: [...userIds] },
        status: MembershipStatus.ACTIVE,
        revokedAt: null,
        AND: [
          ...needed.map(name => ({ role: { permissions: { some: { name } } } })),
          conversation.assignedTo === null
            ? {}
            : {
                OR: [
                  { userId: conversation.assignedTo },
                  { role: { permissions: { some: { name: Permissions.CONVERSATIONS_VIEW_ALL } } } }
                ]
              }
        ]
      }
    })
    if (members !== userIds.length) {
      throw invalidInput('a mention names someone who cannot read this note')
    }
  }
}
