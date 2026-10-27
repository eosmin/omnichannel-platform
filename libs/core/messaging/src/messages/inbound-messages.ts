import type { PrismaTransaction } from '@platform/core/database'
import { AuthorType } from '@platform/core/domain'

import type { InboundMessage } from '../inbound/inbound-event'

// The message of a customer, as a channel delivered it. The unique index of (conversation, channel
// message id) is what makes a delivery that arrives twice harmless; the caller looks before it writes.
export async function insertInboundMessage(
  tx: PrismaTransaction,
  input: {
    storeId: string
    conversationId: string
    message: InboundMessage
    createdAt: Date
  }
): Promise<{ id: string }> {
  const { storeId, conversationId, message } = input
  // The message it answers, if the thread has it: a provider id that is not known is just not linked
  const replyTo =
    message.replyToExternalId === undefined
      ? null
      : await tx.message.findFirst({
          where: { storeId, conversationId, channelMessageId: message.replyToExternalId },
          select: { id: true }
        })
  return tx.message.create({
    data: {
      storeId,
      conversationId,
      type: message.type,
      content: message.content,
      authorType: AuthorType.CUSTOMER,
      authorId: null,
      channelMessageId: message.externalId,
      replyToMessageId: replyTo?.id ?? null,
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
      createdAt: input.createdAt
    },
    select: { id: true }
  })
}
