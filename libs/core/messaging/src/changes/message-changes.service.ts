import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import {
  canSee,
  enumValueOf,
  invalidInput,
  lockConversationForWrite,
  requireAnyPermission,
  type Viewer
} from '../conversations/conversations.support'
import type { EditMessageBody } from '../messages/messages.schemas'
import { MESSAGE_SELECT, messageView, type MessageView } from '../messages/messages.views'
import { OutboundQueue } from '../outbound/outbound-queue'

import { lockMessageRow, publishMessageChanged } from './message-changed'
import { addRevision } from './message-revisions'

// One earlier text of a message and who changed it into the next one
export interface RevisionView {
  version: number
  content: string | null
  editedByType: AuthorType
  editedById: string | null
  createdAt: Date
}

// Asked of the channel of the conversation: the plugin registry lives above this library, so the api
// hands the answer in
export type ChannelSupports = (channelType: string) => boolean

interface Target {
  conversationId: string
  type: string
  authorType: string
  authorId: string | null
  content: string | null
  version: number
  channelMessageId: string | null
  deletedAt: Date | null
  editStatus: string | null
  deleteStatus: string | null
  conversation: { channelType: string; status: string; assignedTo: string | null }
}

const TARGET_SELECT = {
  conversationId: true,
  type: true,
  authorType: true,
  authorId: true,
  content: true,
  version: true,
  channelMessageId: true,
  deletedAt: true,
  editStatus: true,
  deleteStatus: true,
  conversation: { select: { channelType: true, status: true, assignedTo: true } }
} as const

const denied = (): PlatformException =>
  new PlatformException(
    ErrorCodes.PERMISSION_DENIED,
    'the caller may not change this message',
    HttpStatusCodes.FORBIDDEN
  )

const unsupported = (what: string): PlatformException =>
  new PlatformException(
    ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
    `the channel of this conversation does not ${what}`,
    HttpStatusCodes.CONFLICT
  )

// What an agent does to a message after it is written: edit its text and delete it. A note is the team's
// own, so the change is made here. A reply that reached the customer changes only when the channel
// takes the change: the request is stored as queued, the worker asks the plugin, and the thread shows
// whether it was taken. The message of a customer is never changed from here.
@Injectable()
export class MessageChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly outbound: OutboundQueue,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MessageChangesService.name)
  }

  async edit(
    storeId: string,
    messageId: string,
    body: EditMessageBody,
    viewer: Viewer,
    supportsEdit: ChannelSupports
  ): Promise<MessageView> {
    const conversationId = await this.conversationOf(storeId, messageId)
    return this.prisma.transaction(async tx => {
      const message = await this.lockTarget(tx, storeId, messageId, conversationId, viewer)
      await lockMessageRow(tx, messageId)
      if (message.deletedAt !== null || message.deleteStatus === DeliveryStatus.QUEUED.valueOf()) {
        throw resourceConflict('the message is deleted')
      }
      if (isNote(message)) {
        await this.editNote(tx, storeId, messageId, message, body, viewer)
      } else if (message.type === MessageType.TEXT.valueOf() && isReplyOfTeam(message)) {
        await this.requestEdit(tx, storeId, messageId, message, body, viewer, supportsEdit)
      } else {
        throw resourceConflict('only a note or a reply of the team can be edited')
      }
      const row = await tx.message.findFirstOrThrow({
        where: { id: messageId, storeId },
        select: MESSAGE_SELECT
      })
      return messageView(row)
    })
  }

  async remove(
    storeId: string,
    messageId: string,
    viewer: Viewer,
    supportsDelete: ChannelSupports
  ): Promise<void> {
    const conversationId = await this.conversationOf(storeId, messageId)
    await this.prisma.transaction(async tx => {
      const message = await this.lockTarget(tx, storeId, messageId, conversationId, viewer)
      // Who may not delete it is told so whether or not it is deleted already
      if (isNote(message)) requireMayDeleteNote(message, viewer)
      else if (isReplyOfTeam(message)) requireMayDeleteReply(message, viewer)
      // Nobody deletes the message of a customer: it becomes a tombstone when the customer deletes it
      else throw resourceConflict('only a note or a reply of the team can be deleted')
      await lockMessageRow(tx, messageId)
      // Deleting twice is deleting once; one already on its way to the channel is left to it
      if (message.deletedAt !== null || message.deleteStatus === DeliveryStatus.QUEUED.valueOf()) {
        return
      }
      // One request at a time for a message, so that each settles on its own
      if (message.editStatus === DeliveryStatus.QUEUED.valueOf()) {
        throw resourceConflict('an edit of this message is on its way')
      }
      if (isNote(message)) {
        await tx.message.update({
          where: { id: messageId },
          data: {
            deletedAt: new Date(),
            deletedByType: AuthorType.AGENT,
            deletedById: viewer.userId
          }
        })
        await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, messageId)
      } else {
        await this.requestDeletion(tx, storeId, messageId, message, viewer, supportsDelete)
      }
    })
  }

  // The text of a message the customer deleted, while it is kept. The caller audits the read.
  async deletedContent(
    storeId: string,
    messageId: string,
    viewer: Viewer
  ): Promise<{ content: string | null }> {
    requireAnyPermission(viewer.held, [Permissions.MESSAGES_VIEW_DELETED])
    const message = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: {
        type: true,
        content: true,
        deletedAt: true,
        contentPurgedAt: true,
        conversation: { select: { status: true, assignedTo: true } }
      }
    })
    // The same answer for a message that does not exist, one in a conversation the viewer may not see,
    // one that was not deleted, a note the viewer may not read and one whose text is gone
    if (
      message === null ||
      !canSee(viewer, message.conversation) ||
      message.deletedAt === null ||
      message.contentPurgedAt !== null ||
      (message.type === MessageType.INTERNAL_NOTE.valueOf() &&
        !viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE))
    ) {
      throw resourceNotFound('deleted message')
    }
    return { content: message.content }
  }

  // The texts a message had before each edit, newest first. A note's are for who may read notes. The
  // text of a message that was deleted is not given here, whoever asks: it has one route, with its own
  // permission and its audit (`deletedContent`).
  async revisions(storeId: string, messageId: string, viewer: Viewer): Promise<RevisionView[]> {
    const message = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: {
        type: true,
        deletedAt: true,
        conversation: { select: { status: true, assignedTo: true } }
      }
    })
    // The same answer for a message that does not exist, one in a conversation the viewer may not see
    // and a note the viewer may not read
    if (
      message === null ||
      !canSee(viewer, message.conversation) ||
      (message.type === MessageType.INTERNAL_NOTE.valueOf() &&
        !viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE))
    ) {
      throw resourceNotFound('message')
    }
    const rows = await this.prisma.client.messageRevision.findMany({
      where: { storeId, messageId },
      select: {
        version: true,
        content: true,
        editedByType: true,
        editedById: true,
        createdAt: true
      },
      orderBy: { version: 'desc' }
    })
    return rows.map(row => ({
      version: row.version,
      content: message.deletedAt === null ? row.content : null,
      editedByType: enumValueOf(AuthorType, row.editedByType, 'revision editor'),
      editedById: row.editedById,
      createdAt: row.createdAt
    }))
  }

  // The same answer as a conversation that is not seen: the id of a message must not tell that it exists
  private async conversationOf(storeId: string, messageId: string): Promise<string> {
    const found = await this.prisma.client.message.findFirst({
      where: { id: messageId, storeId },
      select: { conversationId: true }
    })
    if (found === null) throw resourceNotFound('conversation')
    return found.conversationId
  }

  // The conversation row is locked first, as every write to a thread, and the message is read under it
  private async lockTarget(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    conversationId: string,
    viewer: Viewer
  ): Promise<Target> {
    await lockConversationForWrite(tx, storeId, conversationId, viewer)
    const message = await tx.message.findFirst({
      where: { id: messageId, storeId },
      select: TARGET_SELECT
    })
    if (message === null) throw resourceNotFound('conversation')
    return message
  }

  private async editNote(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    message: Target,
    body: EditMessageBody,
    viewer: Viewer
  ): Promise<void> {
    // Anyone who reads notes can edit one: they are working data of the team
    requireAnyPermission(viewer.held, [Permissions.MESSAGES_INTERNAL_NOTE])
    if (body.version === undefined)
      throw invalidInput('editing a note needs the version it was read at')
    if (body.version !== message.version) {
      throw resourceConflict('the note changed since it was read', {
        current: { content: message.content, version: message.version }
      })
    }
    if (body.content === message.content) return
    await addRevision(tx, {
      storeId,
      messageId,
      content: message.content,
      editedByType: AuthorType.AGENT,
      editedById: viewer.userId
    })
    await tx.message.update({
      where: { id: messageId },
      data: {
        content: body.content,
        version: { increment: 1 },
        editedAt: new Date(),
        editedByType: AuthorType.AGENT,
        editedById: viewer.userId
      }
    })
    await publishMessageChanged(this.events, tx, Events.MESSAGE_EDITED, storeId, messageId)
  }

  // The edit of a reply the customer has: nothing changes in the thread until the channel takes it
  private async requestEdit(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    message: Target,
    body: EditMessageBody,
    viewer: Viewer,
    supportsEdit: ChannelSupports
  ): Promise<void> {
    requireAnyPermission(viewer.held, [Permissions.MESSAGES_SEND])
    // Nobody edits the message of another person: a correction is a new message
    if (message.authorId !== viewer.userId) throw denied()
    if (message.channelMessageId === null) {
      throw resourceConflict('the message has no copy in the channel to edit')
    }
    if (!supportsEdit(message.conversation.channelType)) throw unsupported('take edits')
    if (message.editStatus === DeliveryStatus.QUEUED.valueOf()) {
      throw resourceConflict('an edit of this message is already on its way')
    }
    if (body.content === message.content) return
    const version = message.version + 1
    await tx.message.update({
      where: { id: messageId },
      data: {
        pendingContent: body.content,
        editStatus: DeliveryStatus.QUEUED,
        editError: null,
        changeRequestedAt: new Date(),
        version
      }
    })
    await publishMessageChanged(this.events, tx, Events.MESSAGE_EDITED, storeId, messageId)
    // Only after the commit: the worker reads the request and must find it
    this.prisma.afterCommit(tx, () => {
      this.outbound.enqueueEdit({ storeId, messageId, version }).catch((error: unknown) => {
        this.logger.warn(
          { messageId, errorName: errorName(error) },
          'an edit could not be queued; the sweep gives it up'
        )
      })
    })
  }

  // The deletion for everyone of a reply the customer has: the message stays shown until the channel
  // takes it. Its author deletes it with MESSAGES_SEND, and MESSAGES_DELETE deletes the reply of anyone.
  private async requestDeletion(
    tx: PrismaTransaction,
    storeId: string,
    messageId: string,
    message: Target,
    viewer: Viewer,
    supportsDelete: ChannelSupports
  ): Promise<void> {
    if (message.channelMessageId === null) {
      throw resourceConflict('the message has no copy in the channel to delete')
    }
    if (!supportsDelete(message.conversation.channelType)) throw unsupported('delete messages')
    const version = message.version + 1
    await tx.message.update({
      where: { id: messageId },
      data: {
        deleteStatus: DeliveryStatus.QUEUED,
        deleteError: null,
        deletedByType: AuthorType.AGENT,
        deletedById: viewer.userId,
        changeRequestedAt: new Date(),
        version
      }
    })
    await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, messageId)
    this.prisma.afterCommit(tx, () => {
      this.outbound.enqueueDelete({ storeId, messageId, version }).catch((error: unknown) => {
        this.logger.warn(
          { messageId, errorName: errorName(error) },
          'a deletion could not be queued; the sweep gives it up'
        )
      })
    })
  }
}

// Who may delete a note: its author, or who holds MESSAGES_DELETE; seeing notes is required either way
function requireMayDeleteNote(message: Target, viewer: Viewer): void {
  requireAnyPermission(viewer.held, [Permissions.MESSAGES_INTERNAL_NOTE])
  if (message.authorId !== viewer.userId && !holds(viewer.held, Permissions.MESSAGES_DELETE)) {
    throw denied()
  }
}

// A note is for the team only; its row has the type of the enum, as text
const isNote = (message: Target): boolean => message.type === MessageType.INTERNAL_NOTE.valueOf()

// Who may delete a reply the customer has: its author, with MESSAGES_SEND, or who holds MESSAGES_DELETE
function requireMayDeleteReply(message: Target, viewer: Viewer): void {
  const own = message.authorId === viewer.userId && holds(viewer.held, Permissions.MESSAGES_SEND)
  if (!own && !holds(viewer.held, Permissions.MESSAGES_DELETE)) throw denied()
}

const holds = (held: readonly Permission[], permission: Permission): boolean =>
  held.includes(permission)

// A reply written by an agent of the platform, the only kind that goes out to a customer
const isReplyOfTeam = (message: Target): boolean =>
  message.authorType === AuthorType.AGENT.valueOf() && message.type !== MessageType.SYSTEM.valueOf()
