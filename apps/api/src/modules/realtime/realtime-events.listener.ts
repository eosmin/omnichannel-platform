import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { Permissions } from '@platform/core/auth'
import {
  type BridgedPayloads,
  type ConversationAssignedPayload,
  type ConversationReadPayload,
  type ConversationStatusChangedPayload,
  type ConversationVisibility,
  Events,
  type MessageChangedPayload,
  type MessageFailedPayload,
  type MessageNoteAddedPayload,
  type MessageQueuedPayload,
  type MessageStatusPayload
} from '@platform/core/events'
import { canSeeConversation, isHiddenStatus, viewerOf } from '@platform/core/messaging'
import { RealtimeEvents } from '@platform/core/realtime'

import { RealtimeService } from './realtime.service'
import type { SocketData } from './realtime.types'
import { SocketAccessService } from './socket-access.service'

// Reading what is said in a conversation takes the right to read messages as well
const mayRead = (socket: SocketData): boolean => socket.held.includes(Permissions.MESSAGES_VIEW)

// Runs both and waits for both: the eviction must not depend on the notification having worked
async function together(...work: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(work)
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
  }
}

const mayAny = (socket: SocketData, states: readonly ConversationVisibility[]): boolean => {
  const viewer = viewerOf(socket.userId, socket.held)
  return states.some(state => canSeeConversation(viewer, state))
}

// Who hears about a message: who may read messages and may see its conversation
const mayHear =
  (payload: { visibility: ConversationVisibility }) =>
  (socket: SocketData): boolean =>
    mayRead(socket) && mayAny(socket, [payload.visibility])

// Domain events to what the browsers hear. What goes out is ids and dates, never text: the client
// reads a message through the REST api, which applies who may see it. An event about a conversation
// goes only to the sockets whose user may see the conversation, with the same rule as the inbox.
@Injectable()
export class RealtimeEventsListener {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly access: SocketAccessService
  ) {}

  // A socket is taken out of the room if what the event says is that it may not stay, and if the
  // conversation, read again, says the same: events are not ordered, and an old one must not evict
  // someone who was let in after it. If the conversation cannot be read the socket leaves: the client
  // joins again when it can be.
  private mayStay(
    conversationId: string,
    states: readonly ConversationVisibility[]
  ): (socket: SocketData) => Promise<boolean> {
    return async socket =>
      (mayRead(socket) && mayAny(socket, states)) ||
      (await this.access.mayJoin(socket, conversationId).catch(() => false))
  }

  // The union of who could see the conversation before and after: who loses sight of it must hear
  // that it left, to drop it from the screen
  @OnEvent(Events.CONVERSATION_STATUS_CHANGED)
  async onStatusChanged(payload: ConversationStatusChangedPayload): Promise<void> {
    const after = { hidden: isHiddenStatus(payload.status), assignedTo: payload.assignedTo }
    const states = [
      { hidden: isHiddenStatus(payload.previousStatus), assignedTo: payload.assignedTo },
      after
    ]
    await together(
      this.realtime.toStoreWhere(
        payload.storeId,
        RealtimeEvents.CONVERSATION_STATUS_CHANGED,
        {
          conversationId: payload.conversationId,
          status: payload.status,
          previousStatus: payload.previousStatus
        },
        socket => mayAny(socket, states)
      ),
      this.realtime.evictFromConversation(
        payload.conversationId,
        this.mayStay(payload.conversationId, [after])
      )
    )
  }

  // The same, for the assignee: the one who had it and the one who has it both hear
  @OnEvent(Events.CONVERSATION_ASSIGNED)
  async onAssigned(payload: ConversationAssignedPayload): Promise<void> {
    const states = [
      { hidden: payload.visibility.hidden, assignedTo: payload.previousAssignee },
      payload.visibility
    ]
    await together(
      this.realtime.toStoreWhere(
        payload.storeId,
        RealtimeEvents.CONVERSATION_ASSIGNED,
        {
          conversationId: payload.conversationId,
          assignedTo: payload.assignedTo,
          assignedBy: payload.assignedBy.id
        },
        socket => mayAny(socket, states)
      ),
      this.realtime.evictFromConversation(
        payload.conversationId,
        this.mayStay(payload.conversationId, [payload.visibility])
      )
    )
  }

  // What a user has read is theirs alone: their other tabs of this store hear it, nobody else
  @OnEvent(Events.CONVERSATION_READ)
  onRead(payload: ConversationReadPayload): void {
    this.realtime.toStoreUser(payload.storeId, payload.userId, RealtimeEvents.CONVERSATION_READ, {
      conversationId: payload.conversationId,
      userId: payload.userId
    })
  }

  // A conversation the customer started: who may see it hears it, as for any change of one
  @OnEvent(Events.CONVERSATION_CREATED)
  onCreated(payload: BridgedPayloads[typeof Events.CONVERSATION_CREATED]): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.CONVERSATION_CREATED,
      {
        conversationId: payload.conversationId,
        customerId: payload.customerId,
        channelType: payload.channelType
      },
      socket => mayAny(socket, [payload.visibility])
    )
  }

  // A message of the customer: ids and the date, the text is read through the api
  @OnEvent(Events.MESSAGE_RECEIVED)
  onReceived(payload: BridgedPayloads[typeof Events.MESSAGE_RECEIVED]): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_RECEIVED,
      {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        authorType: payload.authorType,
        createdAt: payload.receivedAt
      },
      mayHear(payload)
    )
  }

  // A reply that waits for its channel carries the key of the client that wrote it, so that its
  // optimistic bubble matches; the one the channel took has no client to match
  @OnEvent(Events.MESSAGE_QUEUED)
  onQueued(payload: MessageQueuedPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_QUEUED,
      {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        clientMessageId: payload.clientMessageId
      },
      mayHear(payload)
    )
  }

  @OnEvent(Events.MESSAGE_SENT)
  onSent(payload: MessageStatusPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_SENT,
      { conversationId: payload.conversationId, messageId: payload.messageId },
      mayHear(payload)
    )
  }

  @OnEvent(Events.MESSAGE_DELIVERED)
  onDelivered(payload: MessageStatusPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_DELIVERED,
      { conversationId: payload.conversationId, messageId: payload.messageId },
      mayHear(payload)
    )
  }

  @OnEvent(Events.MESSAGE_READ)
  onMessageRead(payload: MessageStatusPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_READ,
      { conversationId: payload.conversationId, messageId: payload.messageId },
      mayHear(payload)
    )
  }

  @OnEvent(Events.MESSAGE_REACTION)
  onMessageReaction(payload: MessageStatusPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_REACTION,
      { conversationId: payload.conversationId, messageId: payload.messageId },
      mayHear(payload)
    )
  }

  @OnEvent(Events.MESSAGE_EDITED)
  onMessageEdited(payload: MessageChangedPayload): Promise<void> {
    return this.toWhoMayRead(payload, RealtimeEvents.MESSAGE_EDITED)
  }

  @OnEvent(Events.MESSAGE_DELETED)
  onMessageDeleted(payload: MessageChangedPayload): Promise<void> {
    return this.toWhoMayRead(payload, RealtimeEvents.MESSAGE_DELETED)
  }

  // A note that changed is for who may read notes; any other message, for who hears of its conversation
  private toWhoMayRead(
    payload: MessageChangedPayload,
    event: typeof RealtimeEvents.MESSAGE_EDITED | typeof RealtimeEvents.MESSAGE_DELETED
  ): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      event,
      { conversationId: payload.conversationId, messageId: payload.messageId },
      socket =>
        mayHear(payload)(socket) &&
        (!payload.internal || socket.held.includes(Permissions.MESSAGES_INTERNAL_NOTE))
    )
  }

  @OnEvent(Events.MESSAGE_FAILED)
  onFailed(payload: MessageFailedPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_FAILED,
      {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        errorCode: payload.errorCode
      },
      mayHear(payload)
    )
  }

  // A note is for who may read notes, and may see the conversation
  @OnEvent(Events.MESSAGE_NOTE_ADDED)
  onNoteAdded(payload: MessageNoteAddedPayload): Promise<void> {
    return this.realtime.toStoreWhere(
      payload.storeId,
      RealtimeEvents.MESSAGE_NOTE_ADDED,
      {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        createdAt: payload.createdAt
      },
      socket =>
        socket.held.includes(Permissions.MESSAGES_INTERNAL_NOTE) &&
        mayRead(socket) &&
        mayAny(socket, [payload.visibility])
    )
  }
}
