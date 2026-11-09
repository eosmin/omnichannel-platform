import { AuthorType } from '@platform/core/domain'
import type { TypingParams } from '@platform/plugins/sdk'

// The message of the customer that a typing indicator answers. A provider may show the indicator through the
// read receipt of the newest message of the customer, so the plugin needs that message; the channels that
// do not need it ignore it. Pure, so that it is tested without the database.

// Inside the store, never by an id the caller sends. A message the customer took back is not offered:
// the provider would refuse the id.
export function lastInboundQuery(
  storeId: string,
  conversationId: string
): {
  where: {
    storeId: string
    conversationId: string
    authorType: typeof AuthorType.CUSTOMER
    deletedAt: null
    channelMessageId: { not: null }
  }
  orderBy: { createdAt: 'desc' }
  select: { channelMessageId: true; createdAt: true }
} {
  return {
    where: {
      storeId,
      conversationId,
      authorType: AuthorType.CUSTOMER,
      deletedAt: null,
      channelMessageId: { not: null }
    },
    orderBy: { createdAt: 'desc' },
    select: { channelMessageId: true, createdAt: true }
  }
}

// `sendReadReceipts` is the switch of the store: the indicator marks the message as read, so a store
// that does not send receipts offers none (a channel that shows the indicator another way ignores it).
export function lastInboundOf(
  row: { channelMessageId: string | null; createdAt: Date } | null,
  sendReadReceipts: boolean
): TypingParams['lastInbound'] {
  if (!sendReadReceipts) return undefined
  if (row?.channelMessageId == null || row.channelMessageId === '') return undefined
  return { externalId: row.channelMessageId, receivedAt: row.createdAt.toISOString() }
}
