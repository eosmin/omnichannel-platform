import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  AuthorType,
  ConversationReopenedByReply,
  ConversationStatus,
  type ChannelCapabilityType,
  DeliveryStatus,
  type CursorPage,
  MediaStatus,
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
import {
  CapabilityOfMediaType,
  isOutboundMediaType,
  MediaPurpose,
  mediaMessageTypeOf
} from '@platform/core/storage'

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

import { requireCaptionFits } from './caption-rules'
import { encodeMessageCursor } from './message-cursor'
import type { CreateMessageBody, ListMessagesQuery } from './messages.schemas'
import {
  MESSAGE_SELECT,
  messageView,
  QUOTE_SELECT,
  type QuotedMessage,
  quotedView,
  type MessageView
} from './messages.views'
import {
  type RenderedTemplate,
  type TemplateMetadata,
  templateMetadataSchema
} from './template-metadata'

// Whether the channel of a conversation declares a capability: the plugin registry lives above this
// library, so the route hands the answer in
export type ChannelSupportsFile = (
  channelType: string,
  capability: ChannelCapabilityType
) => boolean

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
  //
  // A template is the one reply a closed messaging window allows. The api checks it with the channel
  // and fills its body before this runs (`rendered`), because the provider is not asked inside a
  // transaction.
  async create(
    storeId: string,
    body: CreateMessageBody,
    viewer: Viewer,
    rendered?: RenderedTemplate,
    supports?: ChannelSupportsFile
  ): Promise<CreatedMessage> {
    const stored = await this.store(storeId, body, viewer, rendered, supports)
    return { ...stored, message: await this.withQuote(storeId, stored.message, viewer) }
  }

  private async store(
    storeId: string,
    body: CreateMessageBody,
    viewer: Viewer,
    rendered?: RenderedTemplate,
    supports?: ChannelSupportsFile
  ): Promise<CreatedMessage> {
    const isNote = body.type === MessageType.INTERNAL_NOTE
    const isTemplate = body.type === MessageType.TEMPLATE
    if (isTemplate && rendered === undefined) {
      throw invalidInput('a template message needs its template checked first')
    }
    requireAnyPermission(viewer.held, [permissionToWrite(body)])
    return this.prisma.transaction(async tx => {
      // The row lock makes two requests with one key take turns: the second finds the first
      const current = await lockConversationForWrite(tx, storeId, body.conversationId, viewer)

      const replayed = await this.findReplay(tx, storeId, body, viewer)
      if (replayed !== null) {
        // The first request may have committed and failed to queue the reply (Redis was down): the
        // retry it provoked is the moment to try again, and the job id makes a second one harmless
        if (replayed.deliveryStatus === DeliveryStatus.QUEUED) {
          this.requeueForChannel(tx, storeId, replayed.id)
        }
        return { message: replayed, created: false }
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
      // Free text goes out only while the channel lets it; a note is the team's and has no window, and
      // a template is what the closed window leaves
      if (!isNote && !isTemplate) await this.window.requireOpen(tx, storeId, body.conversationId)
      const replyToMessageId = isTemplate ? undefined : body.replyToMessageId
      if (replyToMessageId !== undefined) {
        await this.requireReplyTarget(tx, storeId, body.conversationId, replyToMessageId, isNote)
      }
      const mentions = body.type === MessageType.INTERNAL_NOTE ? body.mentions : []
      if (mentions.length > 0) await this.requireMentionable(tx, storeId, mentions, current)
      // Checked under the lock and after the replay: a retry finds its files already linked
      const files = isMediaBody(body)
        ? await this.requireFiles(tx, storeId, body, viewer, supports)
        : null

      // The date is set here, in milliseconds, so that the message and the conversation agree on it
      const now = new Date()
      const row = await tx.message.create({
        data: {
          storeId,
          conversationId: body.conversationId,
          type: body.type,
          content: isTemplate ? (rendered?.content ?? null) : (body.content ?? null),
          authorType: AuthorType.AGENT,
          authorId: viewer.userId,
          idempotencyKey: body.idempotencyKey ?? null,
          replyToMessageId: replyToMessageId ?? null,
          ...(isTemplate ? { metadata: templateMetadataOf(body) } : {}),
          deliveryStatus: isNote ? null : DeliveryStatus.QUEUED,
          mentions,
          createdAt: now
        },
        select: { ...MESSAGE_SELECT }
      })
      // The row above was read before the files were linked: read them again for the answer
      let media = row.media
      if (files !== null) {
        await this.linkFiles(tx, storeId, row.id, files)
        media = await tx.media.findMany({
          where: { messageId: row.id, storeId },
          select: MESSAGE_SELECT.media.select,
          orderBy: MESSAGE_SELECT.media.orderBy
        })
      }
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
      return { message: messageView({ ...row, media }), created: true }
    })
  }

  // "Send again" on a reply that failed: the same message goes back to the channel, so the thread keeps
  // its bubble and its `clientMessageId`. Anyone of the team who may send may ask (MESSAGES_SEND, and
  // MESSAGES_SEND_TEMPLATE for a template, which is not looked up again: the provider refuses one it
  // withdrew and the message fails again with the reason), only for a
  // message that failed and was not deleted, and a text needs the window open again (a closed one
  // answers CHANNEL_WINDOW_EXPIRED, which is when the composer offers a template).
  async resend(storeId: string, messageId: string, viewer: Viewer): Promise<MessageView> {
    const message = await this.prisma.transaction(async tx => {
      const found = await tx.message.findFirst({
        where: { id: messageId, storeId },
        select: { conversationId: true }
      })
      if (found === null) throw resourceNotFound('message')
      const current = await lockConversationForWrite(tx, storeId, found.conversationId, viewer)
      // Read again under the lock: two requests to resend the same message take turns
      const row = await tx.message.findFirst({
        where: { id: messageId, storeId },
        select: { ...MESSAGE_SELECT }
      })
      if (row === null) throw resourceNotFound('message')
      // Who may not send it is not told how it stands
      requireAnyPermission(viewer.held, [
        row.type === String(MessageType.TEMPLATE)
          ? Permissions.MESSAGES_SEND_TEMPLATE
          : Permissions.MESSAGES_SEND
      ])
      const isOurs = row.authorType === String(AuthorType.AGENT)
      if (
        !isOurs ||
        row.type === String(MessageType.INTERNAL_NOTE) ||
        row.deletedAt !== null ||
        row.deliveryStatus !== String(DeliveryStatus.FAILED)
      ) {
        throw resourceConflict('only a reply that failed can be sent again')
      }
      if (statusOf(current.status) === ConversationStatus.SPAM) {
        throw new PlatformException(
          ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION,
          'a spam conversation is not answered: mark it as not spam first',
          HttpStatusCodes.CONFLICT,
          { from: ConversationStatus.SPAM, to: ConversationStatus.OPEN }
        )
      }
      // A template is what the closed window leaves
      if (row.type !== String(MessageType.TEMPLATE)) {
        await this.window.requireOpen(tx, storeId, row.conversationId)
      }
      const now = new Date()
      const updated = await tx.message.update({
        where: { id: messageId, storeId },
        data: { deliveryStatus: DeliveryStatus.QUEUED, deliveryError: null, resentAt: now },
        select: { ...MESSAGE_SELECT, idempotencyKey: true }
      })
      // Answering the customer again is answering them: the conversation moves as it did the first
      // time, and one that was resolved, snoozed or archived since is open again
      await this.conversations.recordReply(tx, storeId, row.conversationId, now)
      if (ConversationReopenedByReply.some(status => status === statusOf(current.status))) {
        await this.conversations.applyStatus(
          tx,
          storeId,
          row.conversationId,
          ConversationStatus.OPEN,
          {
            actor: 'system',
            causedBy: viewer.userId
          }
        )
      }
      this.events.publish(tx, Events.MESSAGE_QUEUED, {
        storeId,
        conversationId: row.conversationId,
        messageId,
        authorId: viewer.userId,
        clientMessageId: updated.idempotencyKey,
        createdAt: row.createdAt.toISOString(),
        // A reply reopens the conversation, so it is in the inbox of whoever sees it
        visibility: { hidden: false, assignedTo: current.assignedTo }
      })
      this.requeueForChannel(tx, storeId, messageId)
      return messageView(updated)
    })
    return this.withQuote(storeId, message, viewer)
  }

  // The job of the failed attempt is still kept under the id of the message: it is removed first, or
  // the new one would be ignored
  private requeueForChannel(tx: PrismaTransaction, storeId: string, messageId: string): void {
    this.prisma.afterCommit(tx, () => {
      this.outbound.requeue({ storeId, messageId }).catch((error: unknown) => {
        this.logger.warn(
          { messageId, errorName: errorName(error) },
          'the reply could not be queued again; the sweep will'
        )
      })
    })
  }

  // The message a repeated key already made, so that a retry is answered with it before the provider is
  // asked about a template again (the template may have changed since, or the provider may be down).
  // Read only: the transaction of `create` has the last word when two requests race.
  async replayOf(
    storeId: string,
    body: CreateMessageBody,
    viewer: Viewer
  ): Promise<MessageView | null> {
    requireAnyPermission(viewer.held, [permissionToWrite(body)])
    if (body.idempotencyKey === undefined) return null
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id: body.conversationId, storeId },
      select: { status: true, assignedTo: true }
    })
    if (conversation === null || !canSee(viewer, conversation)) {
      throw resourceNotFound('conversation')
    }
    const replayed = await this.findReplay(this.prisma.client, storeId, body, viewer)
    if (replayed === null) return null
    // As `create` does for a retry: the first request may have committed without queuing the reply
    if (replayed.deliveryStatus === DeliveryStatus.QUEUED) {
      this.outbound.requeue({ storeId, messageId: replayed.id }).catch((error: unknown) => {
        this.logger.warn(
          { messageId: replayed.id, errorName: errorName(error) },
          'the reply could not be queued; the sweep will'
        )
      })
    }
    return this.withQuote(storeId, replayed, viewer)
  }

  // The quoted message of one answer, for the routes that return a single message: the thread list joins
  // it for a page, and the bubble that replaces an optimistic one must not lose it
  private async withQuote(
    storeId: string,
    message: MessageView,
    viewer: Viewer
  ): Promise<MessageView> {
    if (message.replyToMessageId === null) return message
    const quoted = await this.quotedOf(
      storeId,
      message.conversationId,
      [{ replyToMessageId: message.replyToMessageId }],
      viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE)
    )
    return { ...message, replyTo: quoted.get(message.replyToMessageId) ?? null }
  }

  private async findReplay(
    db: PrismaService['client'],
    storeId: string,
    body: CreateMessageBody,
    viewer: Viewer
  ): Promise<MessageView | null> {
    if (body.idempotencyKey === undefined) return null
    const existing = await db.message.findFirst({
      where: { storeId, conversationId: body.conversationId, idempotencyKey: body.idempotencyKey },
      select: { ...MESSAGE_SELECT }
    })
    if (existing === null) return null
    const message = messageView(existing)
    if (
      message.authorId !== viewer.userId ||
      message.type !== body.type ||
      (body.type === MessageType.TEMPLATE && !sameTemplate(existing.metadata, body)) ||
      (isMediaBody(body) && !(await this.sameFiles(db, storeId, existing.id, body)))
    ) {
      throw resourceConflict('the idempotency key was used for another message')
    }
    return message
  }

  // The files of a media message, checked for who sends them: they exist in this store, this member
  // uploaded them, no message has them yet, they are clean, and each is what the type says (the type
  // decides how the channel sends it). The channel must declare the capability of the type.
  private async requireFiles(
    tx: PrismaTransaction,
    storeId: string,
    body: MediaMessageBody,
    viewer: Viewer,
    supports: ChannelSupportsFile | undefined
  ): Promise<LinkableFiles> {
    const conversation = await tx.conversation.findFirst({
      where: { id: body.conversationId, storeId },
      select: { channelType: true, customerId: true }
    })
    if (conversation === null) throw resourceNotFound('conversation')
    if (supports === undefined)
      throw invalidInput('a media message needs the channel checked first')
    if (!supports(conversation.channelType, CapabilityOfMediaType[body.type])) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
        'the channel of this conversation does not send this kind of file',
        HttpStatusCodes.CONFLICT
      )
    }
    requireCaptionFits(conversation.channelType, body.type, body.content)
    const rows = await tx.media.findMany({
      where: {
        id: { in: body.mediaIds },
        storeId,
        purpose: MediaPurpose.MESSAGE,
        uploadedBy: viewer.userId
      },
      select: { id: true, status: true, contentType: true, messageId: true }
    })
    // Another store's file, another member's upload and a file that does not exist are one answer
    if (rows.length !== body.mediaIds.length) throw resourceNotFound('media')
    for (const row of rows) {
      if (row.messageId !== null)
        throw resourceConflict('the file is already attached to a message')
      if (row.status === String(MediaStatus.INFECTED)) {
        throw new PlatformException(
          ErrorCodes.FILE_INFECTED,
          'File unavailable',
          HttpStatusCodes.FORBIDDEN
        )
      }
      if (row.status !== String(MediaStatus.CLEAN)) {
        throw new PlatformException(
          ErrorCodes.FILE_NOT_READY,
          'File is being scanned',
          HttpStatusCodes.CONFLICT
        )
      }
      if (mediaMessageTypeOf(row.contentType) !== body.type) {
        throw invalidInput('the file is not of the type of the message')
      }
    }
    return { ids: body.mediaIds, customerId: conversation.customerId }
  }

  // Inside the transaction of the message. `messageId: null` in the condition makes a file that two
  // conversations try to attach at once belong to the first; the other one is refused whole.
  private async linkFiles(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    files: LinkableFiles
  ): Promise<void> {
    const linked = await tx.media.updateMany({
      where: { id: { in: [...files.ids] }, storeId, messageId: null },
      data: { messageId, customerId: files.customerId }
    })
    if (linked.count !== files.ids.length) {
      throw resourceConflict('the file is already attached to a message')
    }
  }

  // The key names one message: the same key with other files is another request
  private async sameFiles(
    db: PrismaService['client'],
    storeId: string,
    messageId: string,
    body: MediaMessageBody
  ): Promise<boolean> {
    const linked = await db.media.findMany({
      where: { storeId, messageId },
      select: { id: true }
    })
    return (
      linked.length === body.mediaIds.length && linked.every(row => body.mediaIds.includes(row.id))
    )
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
    const quoted = await this.quotedOf(storeId, conversationId, page, readsNotes)
    return {
      data: page.map(row =>
        messageView(
          row,
          row.replyToMessageId === null ? null : (quoted.get(row.replyToMessageId) ?? null)
        )
      ),
      nextCursor:
        hasMore && last !== undefined
          ? encodeMessageCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      hasMore
    }
  }

  // The messages the page answers, in one read bounded by the page: the bubble quotes them without a
  // request each. One of another conversation cannot be named (the write refuses it), and a note is
  // quoted only to who reads notes.
  private async quotedOf(
    storeId: string,
    conversationId: string,
    page: readonly { replyToMessageId: string | null }[],
    readsNotes: boolean
  ): Promise<Map<string, QuotedMessage>> {
    const ids = [...new Set(page.map(row => row.replyToMessageId))].filter(
      (id): id is string => id !== null
    )
    if (ids.length === 0) return new Map()
    const rows = await this.prisma.client.message.findMany({
      where: {
        id: { in: ids },
        storeId,
        conversationId,
        type: { not: MessageType.SYSTEM },
        ...(readsNotes ? {} : { NOT: { type: MessageType.INTERNAL_NOTE } })
      },
      select: { ...QUOTE_SELECT }
    })
    return new Map(rows.map(row => [row.id, quotedView(row)]))
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

type MediaMessageBody = Extract<CreateMessageBody, { mediaIds: string[] }>

function isMediaBody(body: CreateMessageBody): body is MediaMessageBody {
  return isOutboundMediaType(body.type)
}

interface LinkableFiles {
  ids: readonly string[]
  customerId: string
}

function templateMetadataOf(
  body: Extract<CreateMessageBody, { type: MessageType.TEMPLATE }>
): TemplateMetadata {
  return {
    template: { name: body.templateName, language: body.language, variables: body.variables }
  }
}

// The key names one message: the same key with another template or other values is another request
function sameTemplate(
  stored: unknown,
  body: Extract<CreateMessageBody, { type: MessageType.TEMPLATE }>
): boolean {
  const parsed = templateMetadataSchema.safeParse(stored)
  if (!parsed.success) return false
  const { name, language, variables } = parsed.data.template
  return (
    name === body.templateName &&
    language === body.language &&
    variables.length === body.variables.length &&
    variables.every((value, index) => value === body.variables[index])
  )
}

// What each kind of message needs on top of seeing the conversation
function permissionToWrite(body: CreateMessageBody): Permission {
  switch (body.type) {
    case MessageType.INTERNAL_NOTE:
      return Permissions.MESSAGES_INTERNAL_NOTE
    case MessageType.TEMPLATE:
      return Permissions.MESSAGES_SEND_TEMPLATE
    case MessageType.TEXT:
    case MessageType.IMAGE:
    case MessageType.VIDEO:
    case MessageType.AUDIO:
    case MessageType.DOCUMENT:
      return Permissions.MESSAGES_SEND
  }
}
