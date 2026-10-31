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
  CustomerLimits,
  httpUrl,
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
  // `username` and `avatarUrl` are what the channel keeps for the person (capability CUSTOMER_PROFILE),
  // null until a job reads them. The photo is a link a plugin chose and that expires: untrusted.
  customer: {
    id: string
    name: string | null
    displayIdentity: string
    username: string | null
    avatarUrl: string | null
  }
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
  // The account of the channel that serves it: the templates of a plugin belong to the account
  channelConnectionId: string
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
  // `byAgent` without the resolved ones: the conversations an agent still has to work (open or
  // pending), which is their load
  activeByAgent: { userId: string; count: number }[]
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
  customerIdentity: { select: { channelIdentity: true, username: true, avatarUrl: true } },
  tags: { select: { id: true, name: true, color: true }, orderBy: { name: 'asc' } }
} as const

export const DETAIL_SELECT = {
  ...LIST_SELECT,
  channelConnectionId: true,
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
  customerIdentity: { channelIdentity: string; username: string | null; avatarUrl: string | null }
  tags: { id: string; name: string; color: string }[]
}

type LastMessage = NonNullable<ConversationListItem['lastMessage']>

// A plugin chose the photo link: only a plain http(s) link leaves, as with any link from outside
const avatarLink = httpUrl(CustomerLimits.AVATAR_URL_MAX_LENGTH)
const avatarUrlOf = (url: string | null): string | null => avatarLink.safeParse(url).data ?? null

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
      displayIdentity: row.customer.name ?? row.customerIdentity.channelIdentity,
      username: row.customerIdentity.username,
      avatarUrl: avatarUrlOf(row.customerIdentity.avatarUrl)
    },
    lastMessage,
    tags: row.tags
  }
}

// The last message of each conversation of a page, in one query
//
// What the preview shows depends on who asks: without MESSAGES_VIEW there is no last message, and
// without MESSAGES_INTERNAL_NOTE the last message is the last one that is not an internal note. A
// system line is never the last message: it is a divider of the thread, not something said.
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
             left(CASE WHEN deleted_at IS NULL THEN content END, ${ConversationLimits.PREVIEW_MAX_LENGTH}) AS preview,
             created_at
      FROM messages
      WHERE store_id = ${storeId}
        AND conversation_id = page.id
        AND type <> ${MessageTypes.SYSTEM}
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
