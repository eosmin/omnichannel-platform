import { z } from 'zod'

import type { PrismaTransaction } from '@platform/core/database'
import {
  AuthorType,
  ConversationStatus,
  MessageType,
  type SystemMessageEvent,
  SystemMessageEvents,
  uuidSchema
} from '@platform/core/domain'

const statusSchema = z.enum(ConversationStatus)

// What a system line keeps of the change: the event, the people and the dates. It has no text: the
// thread writes it in the language of who reads it. Every key is there, null when it does not apply.
export const systemLineMetadataSchema = z.strictObject({
  event: z.enum(SystemMessageEvents),
  // Who did it: a person, or the system
  actor: z.strictObject({ type: z.enum(['user', 'system']), id: uuidSchema.nullable() }),
  // The person whose message made the system do it (a reply reopens the conversation)
  causedBy: uuidSchema.nullable(),
  from: statusSchema.nullable(),
  to: statusSchema.nullable(),
  reason: z.string().nullable(),
  snoozedUntil: z.iso.datetime().nullable(),
  assignedTo: uuidSchema.nullable(),
  previousAssignee: uuidSchema.nullable()
})
export type SystemLineMetadata = z.output<typeof systemLineMetadataSchema>

// The changes of status that people care about. Moving between OPEN and PENDING is not one of them.
export function systemEventFor(
  from: ConversationStatus,
  to: ConversationStatus
): SystemMessageEvent | null {
  switch (to) {
    case ConversationStatus.RESOLVED:
      return SystemMessageEvents.RESOLVED
    case ConversationStatus.ARCHIVED:
      return SystemMessageEvents.ARCHIVED
    case ConversationStatus.SPAM:
      return SystemMessageEvents.MARKED_SPAM
    case ConversationStatus.SNOOZED:
      return SystemMessageEvents.SNOOZED
    case ConversationStatus.OPEN:
      if (from === ConversationStatus.SNOOZED) return SystemMessageEvents.WOKEN
      if (from === ConversationStatus.SPAM) return SystemMessageEvents.UNMARKED_SPAM
      if (from === ConversationStatus.RESOLVED || from === ConversationStatus.ARCHIVED) {
        return SystemMessageEvents.REOPENED
      }
      return null
    default:
      return null
  }
}

export type SystemLineInput = Pick<SystemLineMetadata, 'event' | 'actor'> &
  Partial<Omit<SystemLineMetadata, 'event' | 'actor'>>

// Written in the transaction of the change, so the thread and the status never disagree. It does not
// touch the conversation: a system line is not the last message, does not move `lastMessageAt` and
// does not raise `unreadCount`.
export async function writeSystemLine(
  tx: PrismaTransaction,
  storeId: string,
  conversationId: string,
  line: SystemLineInput
): Promise<void> {
  const metadata: SystemLineMetadata = {
    causedBy: null,
    from: null,
    to: null,
    reason: null,
    snoozedUntil: null,
    assignedTo: null,
    previousAssignee: null,
    ...line
  }
  await tx.message.create({
    data: {
      storeId,
      conversationId,
      type: MessageType.SYSTEM,
      authorType: AuthorType.SYSTEM,
      content: null,
      metadata
    }
  })
}
