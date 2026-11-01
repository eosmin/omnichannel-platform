import type { PrismaTransaction } from '@platform/core/database'
import {
  AuthorType,
  ChannelResultMetadata,
  DeliveryStatus,
  UNAVAILABLE_FILES_KEY
} from '@platform/core/domain'

import type { InboundMessage } from '../inbound/inbound-event'

// The keys only the platform writes in the metadata of a message: whatever a channel plugin passes
// through under these names is dropped, so a provider cannot draw a warning in the thread
const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  ChannelResultMetadata.CAPTION_FAILED,
  ChannelResultMetadata.CAPTION_EXTERNAL_ID,
  UNAVAILABLE_FILES_KEY
])

function ownMetadata<T>(metadata: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_METADATA_KEYS.has(key))
  )
}

// The message of a customer, or the one the owner wrote in the provider's own app (it is already
// sent), as a channel delivered it. The unique index of (conversation, channel
// message id) is what makes a delivery that arrives twice harmless; the caller looks before it writes.
export async function insertInboundMessage(
  tx: PrismaTransaction,
  input: {
    storeId: string
    conversationId: string
    message: InboundMessage
    author: typeof AuthorType.CUSTOMER | typeof AuthorType.EXTERNAL
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
      authorType: input.author,
      authorId: null,
      ...(input.author === AuthorType.EXTERNAL ? { deliveryStatus: DeliveryStatus.SENT } : {}),
      channelMessageId: message.externalId,
      replyToMessageId: replyTo?.id ?? null,
      ...(message.metadata === undefined ? {} : { metadata: ownMetadata(message.metadata) }),
      createdAt: input.createdAt
    },
    select: { id: true }
  })
}
