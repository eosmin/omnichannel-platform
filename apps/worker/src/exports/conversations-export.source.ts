import { Permissions } from '@platform/core/auth'
import type { PrismaService } from '@platform/core/database'
import { MessageType } from '@platform/core/domain'
import { ExportLimits } from '@platform/core/exports'
import {
  assignedFilter,
  type ConversationsExportFilters,
  conversationFilterWhere,
  visibleTo
} from '@platform/core/messaging'

import type { CsvSource } from './csv-export-writer'

export const CONVERSATION_COLUMNS = [
  'conversation_id',
  'message_id',
  'sent_at',
  'channel',
  'conversation_status',
  'customer_id',
  'customer_name',
  'author',
  'type',
  'content',
  'delivery_status',
  'deleted'
] as const

// A line the platform wrote and a note only the team reads are not part of what the customer and the
// store said to each other: neither goes into a file that leaves the platform
const LEFT_OUT_TYPES = [MessageType.SYSTEM, MessageType.INTERNAL_NOTE]

// One row per message of the conversations the member could see when they asked, oldest first inside
// each conversation. The text of a deleted message, or one already purged, is never written.
export function conversationsExportSource(
  prisma: PrismaService,
  storeId: string,
  filters: ConversationsExportFilters
): CsvSource {
  const viewer = {
    userId: filters.viewer.userId,
    held: filters.viewer.held,
    canViewAll: filters.viewer.held.includes(Permissions.CONVERSATIONS_VIEW_ALL)
  }
  const where = {
    ...conversationFilterWhere(storeId, filters.filter, viewer),
    AND: [visibleTo(viewer), assignedFilter(filters.filter.assigned, viewer)]
  }
  return {
    columns: CONVERSATION_COLUMNS,
    rows: async function* () {
      let afterConversation: string | undefined
      for (;;) {
        const conversations = await prisma.client.conversation.findMany({
          where:
            afterConversation === undefined
              ? where
              : { AND: [where, { id: { gt: afterConversation } }] },
          orderBy: { id: 'asc' },
          take: ExportLimits.ROW_PAGE_SIZE,
          ...(afterConversation === undefined
            ? {}
            : { cursor: { id: afterConversation }, skip: 1 }),
          select: {
            id: true,
            channelType: true,
            status: true,
            customer: { select: { id: true, name: true } }
          }
        })
        const lastConversation = conversations.at(-1)
        if (lastConversation === undefined) return
        afterConversation = lastConversation.id

        for (const conversation of conversations) {
          let afterMessage: { createdAt: Date; id: string } | undefined
          for (;;) {
            const messages = await prisma.client.message.findMany({
              where: {
                storeId,
                conversationId: conversation.id,
                type: { notIn: LEFT_OUT_TYPES },
                ...(afterMessage === undefined
                  ? {}
                  : {
                      OR: [
                        { createdAt: { gt: afterMessage.createdAt } },
                        { createdAt: afterMessage.createdAt, id: { gt: afterMessage.id } }
                      ]
                    })
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: ExportLimits.ROW_PAGE_SIZE,
              select: {
                id: true,
                createdAt: true,
                authorType: true,
                type: true,
                content: true,
                deliveryStatus: true,
                deletedAt: true,
                contentPurgedAt: true
              }
            })
            const lastMessage = messages.at(-1)
            if (lastMessage === undefined) break
            afterMessage = { createdAt: lastMessage.createdAt, id: lastMessage.id }
            for (const message of messages) {
              const hidden = message.deletedAt !== null || message.contentPurgedAt !== null
              yield [
                conversation.id,
                message.id,
                message.createdAt,
                conversation.channelType,
                conversation.status,
                conversation.customer.id,
                conversation.customer.name,
                message.authorType,
                message.type,
                hidden ? null : message.content,
                message.deliveryStatus,
                message.deletedAt !== null
              ]
            }
          }
        }
      }
    }
  }
}
