import { AttentionReasons, ChannelIds, ConversationStatus } from '@platform/core/domain'
import type { ConversationCounts, ConversationDetail } from '@platform/core/messaging'

import { detailForKey, pageForKey, withoutAgentLoad } from './plugin-conversations.views'

// Every field of the customer and of the mark carries a sentinel, so a field that reaches a key without `customers:read` shows in the text
const SENTINELS = {
  name: 'SENTINEL-NAME',
  handle: 'SENTINEL-HANDLE',
  username: 'SENTINEL-USERNAME',
  avatar: 'https://cdn.example.com/SENTINEL-AVATAR.jpg',
  note: 'SENTINEL-NOTE',
  reason: 'SENTINEL-REASON'
}

const detail: ConversationDetail = {
  id: 'conversation-1',
  status: ConversationStatus.OPEN,
  channelType: ChannelIds.INSTAGRAM,
  assignedTo: 'member-1',
  unreadCount: 2,
  lastMessageAt: new Date('2026-11-16T10:00:00Z'),
  snoozedUntil: null,
  attention: {
    reason: AttentionReasons.SNOOZE_WOKE,
    at: new Date('2026-11-16T09:00:00Z'),
    note: SENTINELS.note
  },
  customer: {
    id: 'customer-1',
    name: SENTINELS.name,
    displayIdentity: SENTINELS.handle,
    username: SENTINELS.username,
    avatarUrl: SENTINELS.avatar,
    isCaution: true,
    isErased: false
  },
  lastMessage: null,
  tags: [{ id: 'tag-1', name: 'vip', color: '#ffffff' }],
  channelConnectionId: 'connection-1',
  lastInboundAt: new Date('2026-11-16T08:00:00Z'),
  lastReadAt: null,
  resolvedAt: null,
  resolutionReason: SENTINELS.reason,
  createdAt: new Date('2026-11-15T08:00:00Z')
}

describe('what a conversation says of its customer to a key', () => {
  it('tells a key without customers:read the id of the customer and nothing that names them', () => {
    const told = detailForKey(detail, false)

    expect(told.customer).toEqual({ id: 'customer-1' })
    expect(told.attention).toEqual({
      reason: AttentionReasons.SNOOZE_WOKE,
      at: detail.attention?.at
    })
    const text = JSON.stringify(told)
    for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel)
  })

  it('keeps everything else of the conversation, so a plugin can still work it', () => {
    expect(detailForKey(detail, false)).toMatchObject({
      id: detail.id,
      status: detail.status,
      channelType: detail.channelType,
      assignedTo: detail.assignedTo,
      unreadCount: detail.unreadCount,
      lastMessageAt: detail.lastMessageAt,
      snoozedUntil: detail.snoozedUntil,
      lastMessage: detail.lastMessage,
      tags: detail.tags,
      channelConnectionId: detail.channelConnectionId,
      lastInboundAt: detail.lastInboundAt,
      lastReadAt: detail.lastReadAt,
      resolvedAt: detail.resolvedAt,
      resolutionReason: null,
      createdAt: detail.createdAt
    })
  })

  it('tells a key that holds customers:read the conversation as it is', () => {
    expect(detailForKey(detail, true)).toBe(detail)
  })

  it('treats every row of a page alike', () => {
    const page = pageForKey({ data: [detail, detail], nextCursor: null, hasMore: false }, false)

    for (const row of page.data) expect(row.customer).toEqual({ id: 'customer-1' })
  })

  it('leaves the load of each member of the team out of the numbers', () => {
    const counts: ConversationCounts = {
      all: 3,
      mine: 0,
      unassigned: 1,
      byStatus: { [ConversationStatus.OPEN]: 3 },
      byChannel: { [ChannelIds.INSTAGRAM]: 3 },
      byAgent: [{ userId: 'member-1', count: 2 }],
      activeByAgent: [{ userId: 'member-1', count: 2 }]
    }

    const told = withoutAgentLoad(counts)

    expect(told).toEqual({
      all: 3,
      mine: 0,
      unassigned: 1,
      byStatus: { [ConversationStatus.OPEN]: 3 },
      byChannel: { [ChannelIds.INSTAGRAM]: 3 }
    })
    expect(JSON.stringify(told)).not.toContain('member-1')
  })
})
