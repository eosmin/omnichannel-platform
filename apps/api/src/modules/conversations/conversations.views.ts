import { Permissions } from '@platform/core/auth'
import type {
  AuthorType,
  ChannelId,
  ConversationStatus,
  CursorPage,
  MessageType
} from '@platform/core/domain'
import {
  AuthorType as AuthorTypes,
  ConversationLimits,
  MessageType as MessageTypes
} from '@platform/core/domain'

import { type Db, enumValueOf, statusOf, type Viewer } from './conversations.support'

// TDD_09 section 2, without `handler` (no AI in the v1.2 MVP)
export interface ConversationListItem {
  id: string
  status: ConversationStatus
  channelType: ChannelId
  assignedTo: string | null
  unreadCount: number
  lastMessageAt: Date | null
  snoozedUntil: Date | null
  customer: { id: string; name: string | null; displayIdentity: string }
  lastMessage: {
    id: string
    authorType: AuthorType
    type: MessageType
    contentPreview: string | null
    createdAt: Date
  } | null
  tags: { id: string; name: string; color: string }[]
}

export interface ConversationDetail extends ConversationListItem {
  lastInboundAt: Date | null
  lastReadAt: Date | null
  resolvedAt: Date | null
  resolutionReason: string | null
  createdAt: Date
}

export type ConversationPage = CursorPage<ConversationListItem>

export interface ConversationCounts {
  all: number
  mine: number
  unassigned: number
  byStatus: Partial<Record<ConversationStatus, number>>
  byChannel: Partial<Record<ChannelId, number>>
  byAgent: { userId: string; count: number }[]
}

export const LIST_SELECT = {
  id: true,
  status: true,
  channelType: true,
  assignedTo: true,
  unreadCount: true,
  lastMessageAt: true,
  snoozedUntil: true,
  customer: { select: { id: true, name: true } },
  customerIdentity: { select: { channelIdentity: true } },
  tags: { select: { id: true, name: true, color: true }, orderBy: { name: 'asc' } }
} as const

export const DETAIL_SELECT = {
  ...LIST_SELECT,
  lastInboundAt: true,
  lastReadAt: true,
  resolvedAt: true,
  resolutionReason: true,
  createdAt: true
} as const

interface ListRow {
  id: string
  status: string
  channelType: string
  assignedTo: string | null
  unreadCount: number
  lastMessageAt: Date | null
  snoozedUntil: Date | null
  customer: { id: string; name: string | null }
  customerIdentity: { channelIdentity: string }
  tags: { id: string; name: string; color: string }[]
}

type LastMessage = NonNullable<ConversationListItem['lastMessage']>

function listItem(row: ListRow, lastMessage: LastMessage | null): ConversationListItem {
  return {
    id: row.id,

    status: statusOf(row.status),

    channelType: row.channelType,
    assignedTo: row.assignedTo,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt,
    snoozedUntil: row.snoozedUntil,
    customer: {
      id: row.customer.id,
      name: row.customer.name,
      displayIdentity: row.customer.name ?? row.customerIdentity.channelIdentity
    },
    lastMessage,
    tags: row.tags
  }
}

// The last message of each conversation of a page, in one query
//
// What the preview shows depends on who asks: without MESSAGES_VIEW there is no last message, and
// without MESSAGES_INTERNAL_NOTE the last message is the last one that is not an internal note.
export async function listItemsOf(
  db: Db,
  storeId: string,
  rows: readonly ListRow[],
  viewer?: Viewer
): Promise<ConversationListItem[]> {
  if (rows.length === 0) return []
  if (viewer !== undefined && !viewer.held.includes(Permissions.MESSAGES_VIEW)) {
    return rows.map(row => listItem(row, null))
  }
  const readsNotes =
    viewer === undefined || viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE)
  // The newest message of each conversation, one probe of the index (conversation, date) per row of
  // the page, however long the threads are, cut to the preview in the database: a thread does not
  // travel whole to be cut here. `left` counts characters, not bytes, so an emoji is never split.
  const messages = await db.$queryRaw<
    {
      id: string
      conversation_id: string
      author_type: string
      type: string
      preview: string | null
      created_at: Date
    }[]
  >`
    SELECT m.id, m.conversation_id, m.author_type, m.type, m.preview, m.created_at
    FROM unnest(${rows.map(row => row.id)}::text[]) AS page(id)
    CROSS JOIN LATERAL (
      SELECT id, conversation_id, author_type, type,
             left(content, ${ConversationLimits.PREVIEW_MAX_LENGTH}) AS preview, created_at
      FROM messages
      WHERE store_id = ${storeId}
        AND conversation_id = page.id
        AND (${readsNotes} OR type <> ${MessageTypes.INTERNAL_NOTE})
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) AS m`
  const last = new Map<string, LastMessage>()
  for (const message of messages) {
    last.set(message.conversation_id, {
      id: message.id,
      authorType: authorOf(message.author_type),
      type: messageTypeOf(message.type),
      contentPreview: message.preview,
      createdAt: message.created_at
    })
  }
  return rows.map(row => listItem(row, last.get(row.id) ?? null))
}

const authorOf = (text: string): AuthorType => enumValueOf(AuthorTypes, text, 'message author')
const messageTypeOf = (text: string): MessageType => enumValueOf(MessageTypes, text, 'message type')
