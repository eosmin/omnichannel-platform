import type { PrismaTransaction } from '@platform/core/database'
import { MessageType } from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import { type Events } from '@platform/core/events'

import { isHiddenStatus } from '../conversations/conversations.support'

// Tells the team that a message was edited or deleted, or that a file of it was scanned: ids only, the text is read through the api, which
// knows who may see the conversation. A note is announced as one, so that only who may read notes hears
// of it. The one place that builds this payload, for the api, the inbound pipeline and the worker.
export async function publishMessageChanged(
  events: DomainEvents,
  tx: PrismaTransaction,
  event:
    | typeof Events.MESSAGE_EDITED
    | typeof Events.MESSAGE_DELETED
    | typeof Events.MEDIA_PROCESSED
    | typeof Events.MEDIA_INFECTED
    | typeof Events.MEDIA_UNAVAILABLE,
  storeId: string,
  messageId: string
): Promise<void> {
  const message = await tx.message.findFirst({
    where: { id: messageId, storeId },
    select: {
      conversationId: true,
      type: true,
      conversation: { select: { status: true, assignedTo: true } }
    }
  })
  if (message === null) return
  events.publish(tx, event, {
    storeId,
    conversationId: message.conversationId,
    messageId,
    internal: message.type === MessageType.INTERNAL_NOTE.valueOf(),
    visibility: {
      hidden: isHiddenStatus(message.conversation.status),
      assignedTo: message.conversation.assignedTo
    }
  })
}

// Takes turns with whoever else writes this message (an agent, the inbound pipeline, the worker that
// settles a request): they hold different locks of the conversation, and all of them hold this one
// before they read what they change
export async function lockMessageRow(tx: PrismaTransaction, messageId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM messages WHERE id = ${messageId} FOR UPDATE`
}
